const { db } = require('../config/firebase');
const { retryTransaction } = require('../utils/retryTransaction');

class CancelError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function cancelOrder(orderId, uid) {
  const orderRef = db.ref(`orders/${orderId}`);
  const snap = await orderRef.once('value');

  if (!snap.exists()) {
    throw new CancelError('NOT_FOUND', 'Order tidak ditemukan.');
  }

  const order = snap.val();

  if (order.user_id !== uid) {
    throw new CancelError('FORBIDDEN', 'Akses ditolak.');
  }

  if (!['WAITING_OTP', 'OTP_REQUESTED', 'EXPIRED'].includes(order.status)) {
    throw new CancelError('INVALID_STATUS', 'Order tidak dapat dibatalkan pada status ini.');
  }

  const price = order.price || 0;
  const stockKey = order.stock_key;

  await retryTransaction(async () => {
    // 1. Update order status
    await orderRef.update({
      status: 'CANCELLED',
      is_refunded: true,
    });

    // 2. Restore user balance
    await db.ref(`users/${uid}/balance`).transaction((bal) => {
      if (bal === null) return null;
      return (Number(bal) || 0) + price;
    });

    // 3. Return stock to AVAILABLE so the number can be reused
    if (stockKey) {
      await db.ref(`phone_stocks/${stockKey}/status`).set('AVAILABLE');
    }
  });

  return { refundedAmount: price };
}

module.exports = { cancelOrder, CancelError };
