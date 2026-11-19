const { db } = require('../config/firebase');
const { retryTransaction } = require('../utils/retryTransaction');
const { refundOrderBalance } = require('./balanceService');

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
  if (order.is_refunded) {
    throw new CancelError('INVALID_STATUS', 'Saldo order ini sudah dikembalikan.');
  }

  // Kalau OTP sudah dikirim admin, user tidak bisa cancel — harus admin
  if (order.otp_code && order.otp_code.length > 0) {
    throw new CancelError('OTP_RECEIVED', 'OTP sudah diterima. Pembatalan hanya bisa dilakukan oleh admin.');
  }

  const price = order.price || 0;
  const stockKey = order.stock_key;

  await retryTransaction(async () => {
    // 1. Update order status
    await orderRef.update({
      status: 'CANCELLED',
      is_refunded: true,
    });

    // 2. Restore the same balance portions used by the purchase
    const userRef = db.ref(`users/${uid}`);
    const refundResult = await userRef.transaction(user => {
      if (user === null) return null;
      if (!user || typeof user !== 'object' || Array.isArray(user)) return;
      refundOrderBalance(user, orderId, order);
      return user;
    });
    if (!refundResult.snapshot.child(`order_refunds/${orderId}`).exists()) {
      throw new Error(`Could not refund order ${orderId}`);
    }

    // 3. Return stock to AVAILABLE so the number can be reused
    if (stockKey) {
      await db.ref(`phone_stocks/${stockKey}/status`).set('AVAILABLE');
    }
  });

  return { refundedAmount: price };
}

module.exports = { cancelOrder, CancelError };
