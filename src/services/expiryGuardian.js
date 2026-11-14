const { db } = require('../config/firebase');
const { retryTransaction } = require('../utils/retryTransaction');

const GUARDIAN_INTERVAL_MS = 30000;

async function processExpiredOrder(orderId, order) {
  await retryTransaction(async () => {
    // Mark order as EXPIRED
    await db.ref(`orders/${orderId}`).update({ status: 'EXPIRED' });

    // Return stock to AVAILABLE so it can be reused
    if (order.stock_key) {
      await db.ref(`phone_stocks/${order.stock_key}/status`).set('AVAILABLE');
    }

    // Refund balance if not already refunded
    if (!order.is_refunded && order.price && order.user_id) {
      await db.ref(`users/${order.user_id}/balance`).transaction((bal) => {
        return (Number(bal) || 0) + order.price;
      });
      await db.ref(`orders/${orderId}/is_refunded`).set(true);
    }
  }, 3).catch((err) => {
    console.error('[ExpiryGuardian] Transaction failed after 3 retries:', {
      order_id: orderId,
      error: err.message,
    });
  });
}

async function runGuardianTick() {
  const now = Date.now();
  try {
    const snap = await db.ref('orders').once('value');
    if (!snap.exists()) return;

    const tasks = [];
    snap.forEach((child) => {
      const order = child.val();
    const isExpirable =
        (order.status === 'WAITING_OTP' || order.status === 'OTP_REQUESTED') &&
        order.expires_at < now &&
        (!order.otp_code || order.otp_code.length === 0); // jangan cancel kalau OTP sudah ada
      if (isExpirable) {
        tasks.push(processExpiredOrder(child.key, order));
      }
    });

    if (tasks.length > 0) {
      console.log(`[ExpiryGuardian] Processing ${tasks.length} expired order(s)...`);
      await Promise.allSettled(tasks);
    }
  } catch (err) {
    console.error('[ExpiryGuardian] Tick error:', err.message);
  }
}

function startExpiryGuardian() {
  console.log('[ExpiryGuardian] Started. Interval: 30s');
  runGuardianTick();
  return setInterval(runGuardianTick, GUARDIAN_INTERVAL_MS);
}

module.exports = { startExpiryGuardian, runGuardianTick };
