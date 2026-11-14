const { db } = require('../config/firebase');
const { retryTransaction } = require('../utils/retryTransaction');
const { sendNotification } = require('./telegramService');

class OrderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Validate OTP code: must be 4-8 digits only.
 */
function validateOtp(otp) {
  return /^\d{4,8}$/.test(otp);
}

/**
 * Request OTP for an order.
 * Updates status to OTP_REQUESTED and sends Telegram notification.
 */
async function requestOtp(orderId, uid) {
  const orderRef = db.ref(`orders/${orderId}`);
  const snap = await orderRef.once('value');

  if (!snap.exists()) {
    throw new OrderError('NOT_FOUND', 'Order tidak ditemukan.');
  }

  const order = snap.val();

  if (order.user_id !== uid) {
    throw new OrderError('FORBIDDEN', 'Akses ditolak.');
  }

  if (order.status !== 'WAITING_OTP') {
    throw new OrderError('INVALID_STATUS', 'Status order tidak valid untuk aksi ini.');
  }

  await orderRef.update({ status: 'OTP_REQUESTED' });

  // Send Telegram notification (non-blocking on failure)
  await sendNotification('OTP_REQUESTED', {
    order_id: orderId,
    username: order.username,
    phone_number: order.phone_number,
    country_name: order.country_name,
  });
}

/**
 * Resend OTP for an order.
 * Increments resend_count then sends Telegram notification.
 */
async function resendOtp(orderId, uid) {
  const orderRef = db.ref(`orders/${orderId}`);
  const snap = await orderRef.once('value');

  if (!snap.exists()) {
    throw new OrderError('NOT_FOUND', 'Order tidak ditemukan.');
  }

  const order = snap.val();

  if (order.user_id !== uid) {
    throw new OrderError('FORBIDDEN', 'Akses ditolak.');
  }

  if (order.status !== 'OTP_REQUESTED') {
    throw new OrderError('INVALID_STATUS', 'Status order tidak valid untuk kirim ulang OTP.');
  }

  // Atomically increment resend_count
  let newCount;
  await db.ref(`orders/${orderId}/resend_count`).transaction((count) => {
    newCount = (count || 0) + 1;
    return newCount;
  });

  // Send Telegram notification
  await sendNotification('RESEND_OTP', {
    order_id: orderId,
    username: order.username,
    phone_number: order.phone_number,
    country_name: order.country_name,
    resend_count: newCount,
  });
}

/**
 * Submit OTP code for an order (admin action).
 * Validates and writes otp_code to Firebase.
 */
async function submitOtp(orderId, otpCode) {
  if (!validateOtp(otpCode)) {
    throw new OrderError('INVALID_OTP', 'Kode OTP harus berupa 4-8 digit angka.');
  }

  const orderRef = db.ref(`orders/${orderId}`);
  const snap = await orderRef.once('value');

  if (!snap.exists()) {
    throw new OrderError('NOT_FOUND', 'Order tidak ditemukan.');
  }

  await orderRef.update({ otp_code: otpCode });
}

/**
 * Complete an order (admin action).
 * Sets status to COMPLETED and burns the phone stock.
 */
async function completeOrder(orderId) {
  const orderRef = db.ref(`orders/${orderId}`);
  const snap = await orderRef.once('value');

  if (!snap.exists()) {
    throw new OrderError('NOT_FOUND', 'Order tidak ditemukan.');
  }

  const order = snap.val();

  if (order.status === 'COMPLETED') {
    throw new OrderError('ALREADY_COMPLETED', 'Order sudah selesai sebelumnya.');
  }

  await orderRef.update({ status: 'COMPLETED' });

  // Burn the stock
  if (order.stock_key) {
    try {
      await db.ref(`phone_stocks/${order.stock_key}/status`).set('BURNED');
    } catch (err) {
      console.error('[completeOrder] Failed to burn stock:', {
        order_id: orderId,
        stock_key: order.stock_key,
        error: err.message,
      });
      // Order stays COMPLETED even if stock burn fails
    }
  }
}

module.exports = { requestOtp, resendOtp, submitOtp, completeOrder, validateOtp, OrderError };
