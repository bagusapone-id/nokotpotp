const express = require('express');
const router = express.Router();
const authUser = require('../middleware/authUser');
const { cancelOrder, CancelError } = require('../services/cancelService');

/**
 * POST /api/orders/:id/cancel
 * User: cancel an expired/timed-out order and get refund
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
      const statusMap = { NOT_FOUND: 404, FORBIDDEN: 403, INVALID_STATUS: 409 };
      return res.status(statusMap[err.code] || 400).json({ error: err.code, message: err.message });
    }
    console.error('[cancelRoutes] Error:', err.message);
    return res.status(500).json({ error: 'CANCEL_FAILED', message: 'Pembatalan gagal, hubungi support.' });
  }
});

module.exports = router;
