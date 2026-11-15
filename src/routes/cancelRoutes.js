const express = require('express');
const router = express.Router();
const authUser = require('../middleware/authUser');
const authAdmin = require('../middleware/authAdmin');
const { db } = require('../config/firebase');
const { cancelOrder, CancelError } = require('../services/cancelService');

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
    const order = snap.val();
    if (['COMPLETED','CANCELLED'].includes(order.status)) {
      return res.status(409).json({ error: 'INVALID_STATUS', message: 'Order sudah selesai atau dibatalkan.' });
    }

    const price    = order.price || 0;
    const uid      = order.user_id;
    const stockKey = order.stock_key;

    // Refund balance
    if (price && uid) {
      await db.ref(`users/${uid}/balance`).transaction(bal => (Number(bal) || 0) + price);
    }
    // Return stock
    if (stockKey) {
      await db.ref(`phone_stocks/${stockKey}/status`).set('AVAILABLE');
    }
    // Update order
    await db.ref(`orders/${orderId}`).update({ status: 'CANCELLED', is_refunded: true });

    return res.status(200).json({ success: true, refunded_amount: price });
  } catch (err) {
    console.error('[cancelRoutes] admin-cancel error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
