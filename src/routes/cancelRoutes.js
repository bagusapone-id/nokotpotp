const express = require('express');
const router = express.Router();
const authUser = require('../middleware/authUser');
const authAdmin = require('../middleware/authAdmin');
const { db } = require('../config/firebase');
const { cancelOrder, CancelError } = require('../services/cancelService');
const { refundOrderBalance } = require('../services/balanceService');
const { installAdminAudit } = require('../services/adminAuditService');

installAdminAudit(router);

async function refundOrderToUser(uid, orderId, order) {
  const userRef = db.ref(`users/${uid}`);
  const result = await userRef.transaction(user => {
    if (user === null) return null;
    if (!user || typeof user !== 'object' || Array.isArray(user)) return;
    refundOrderBalance(user, orderId, order);
    return user;
  });
  if (!result.snapshot.child(`order_refunds/${orderId}`).exists()) {
    throw new Error(`Could not refund order ${orderId}`);
  }
}

async function adminCancelOrder(orderId, allowedStatuses) {
  const orderRef = db.ref(`orders/${orderId}`);
  const snap = await orderRef.once('value');
  if (!snap.exists()) return { cancelled: false };

  const order = snap.val();
  if (allowedStatuses && !allowedStatuses.includes(order.status)) {
    return { cancelled: false };
  }
  if (['COMPLETED', 'CANCELLED'].includes(order.status) || order.is_refunded) {
    return { cancelled: false };
  }

  const price = Number(order.price || 0);
  if (!Number.isSafeInteger(price) || price < 0 || (price > 0 && !order.user_id)) {
    throw new Error(`Order ${orderId} has invalid refund data`);
  }

  if (price > 0) await refundOrderToUser(order.user_id, orderId, order);
  if (order.stock_key) {
    // Admin cancel: nomor sudah dipakai / ampas → hapus permanen dari stok
    await db.ref(`phone_stocks/${order.stock_key}`).remove();
  }
  await orderRef.update({ status: 'CANCELLED', is_refunded: true });

  return { cancelled: true, refundedAmount: price };
}

/**
 * POST /api/orders/:id/cancel
 * User: cancel an order and get refund
 */
router.post('/:id/cancel', authUser, async (req, res) => {
  try {
    const result = await cancelOrder(req.params.id, req.user.uid);
    return res.status(200).json({
      success: true,
      refunded_amount: result.refundedAmount,
    });
  } catch (err) {
    if (err instanceof CancelError) {
      const statusMap = { NOT_FOUND: 404, FORBIDDEN: 403, INVALID_STATUS: 409, OTP_RECEIVED: 403 };
      return res.status(statusMap[err.code] || 400).json({ error: err.code, message: err.message });
    }
    console.error('[cancelRoutes] Error:', err.message);
    return res.status(500).json({ error: 'CANCEL_FAILED', message: 'Pembatalan gagal.' });
  }
});

/**
 * POST /api/orders/:id/auto-cancel
 * Auto-cancel when timer expires (30 min) — called by frontend timer
 * Bypasses OTP check since 30 min has passed
 */
router.post('/:id/auto-cancel', authUser, async (req, res) => {
  const orderId = req.params.id;
  const uid = req.user.uid;
  try {
    const snap = await db.ref(`orders/${orderId}`).once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'NOT_FOUND' });
    const order = snap.val();

    if (order.user_id !== uid) return res.status(403).json({ error: 'FORBIDDEN' });
    if (['COMPLETED','CANCELLED'].includes(order.status) || order.is_refunded) {
      return res.status(409).json({ error: 'INVALID_STATUS', message: 'Order sudah selesai.' });
    }
    // Verify timer actually expired
    if (order.expires_at > Date.now()) {
      return res.status(403).json({ error: 'NOT_EXPIRED', message: 'Order belum expired.' });
    }

    const price    = order.price || 0;
    const stockKey = order.stock_key;

    if (price) await refundOrderToUser(uid, orderId, order);
    if (stockKey) await db.ref(`phone_stocks/${stockKey}/status`).set('AVAILABLE');
    await db.ref(`orders/${orderId}`).update({ status: 'CANCELLED', is_refunded: true });

    return res.status(200).json({ success: true, refunded_amount: price });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * POST /api/orders/:id/admin-cancel
 * Admin: force cancel any order regardless of status/otp
 */
router.post('/:id/admin-cancel', authAdmin, async (req, res) => {
  const orderId = req.params.id;
  try {
    const snap = await db.ref(`orders/${orderId}`).once('value');
    if (!snap.exists()) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Order tidak ditemukan.' });
    }
    const result = await adminCancelOrder(orderId);
    if (!result.cancelled) {
      return res.status(409).json({ error: 'INVALID_STATUS', message: 'Order sudah selesai atau dibatalkan.' });
    }

    return res.status(200).json({ success: true, refunded_amount: result.refundedAmount });
  } catch (err) {
    console.error('[cancelRoutes] admin-cancel error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * POST /api/orders/admin-cancel-active
 * Admin: cancel and refund every active order shown in the admin panel.
 */
router.post('/admin-cancel-active', authAdmin, async (req, res) => {
  const activeStatuses = ['WAITING_OTP', 'OTP_REQUESTED'];
  try {
    const snap = await db.ref('orders').once('value');
    const orderIds = [];
    if (snap.exists()) {
      snap.forEach(child => {
        const order = child.val();
        if (order && activeStatuses.includes(order.status)) orderIds.push(child.key);
      });
    }

    let cancelled = 0;
    let skipped = 0;
    const failed = [];

    for (const orderId of orderIds) {
      try {
        const result = await adminCancelOrder(orderId, activeStatuses);
        if (result.cancelled) cancelled++;
        else skipped++;
      } catch (err) {
        failed.push(orderId);
        console.error('[cancelRoutes] bulk admin-cancel error:', {
          order_id: orderId,
          error: err.message,
        });
      }
    }

    return res.status(200).json({
      success: failed.length === 0,
      total: orderIds.length,
      cancelled,
      skipped,
      failed,
    });
  } catch (err) {
    console.error('[cancelRoutes] bulk admin-cancel error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal memproses pembatalan order aktif.' });
  }
});

module.exports = router;
