const express = require('express');
const router = express.Router();
const authUser = require('../middleware/authUser');
const authAdmin = require('../middleware/authAdmin');
const { requestOtp, resendOtp, submitOtp, completeOrder, OrderError } = require('../services/orderService');

/**
 * POST /api/orders/:id/request-otp
 * User: signals they have requested OTP from WhatsApp
 */
router.post('/:id/request-otp', authUser, async (req, res) => {
  try {
    await requestOtp(req.params.id, req.user.uid);
    return res.status(200).json({ success: true });
  } catch (err) {
    if (err instanceof OrderError) {
      const statusMap = { NOT_FOUND: 404, FORBIDDEN: 403, INVALID_STATUS: 409 };
      return res.status(statusMap[err.code] || 400).json({ error: err.code, message: err.message });
    }
    console.error('[orderRoutes] request-otp error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Terjadi kesalahan server.' });
  }
});

/**
 * POST /api/orders/:id/resend-otp
 * User: requests resend of OTP
 */
router.post('/:id/resend-otp', authUser, async (req, res) => {
  try {
    await resendOtp(req.params.id, req.user.uid);
    return res.status(200).json({ success: true });
  } catch (err) {
    if (err instanceof OrderError) {
      const statusMap = { NOT_FOUND: 404, FORBIDDEN: 403, INVALID_STATUS: 409 };
      return res.status(statusMap[err.code] || 400).json({ error: err.code, message: err.message });
    }
    console.error('[orderRoutes] resend-otp error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Terjadi kesalahan server.' });
  }
});

/**
 * POST /api/orders/:id/submit-otp
 * Admin: submit OTP code for the order
 * Body: { otp_code: string }
 */
router.post('/:id/submit-otp', authAdmin, async (req, res) => {
  const { otp_code } = req.body;

  if (!otp_code && otp_code !== 0) {
    return res.status(400).json({ error: 'INVALID_OTP', message: 'Kode OTP diperlukan.' });
  }

  try {
    await submitOtp(req.params.id, String(otp_code).trim());
    return res.status(200).json({ success: true });
  } catch (err) {
    if (err instanceof OrderError) {
      if (err.code === 'INVALID_OTP') {
        return res.status(400).json({ error: err.code, message: err.message });
      }
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: err.code, message: err.message });
      }
    }
    console.error('[orderRoutes] submit-otp error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal menyimpan OTP.' });
  }
});

/**
 * POST /api/orders/:id/complete
 * Admin: mark order as completed
 */
router.post('/:id/complete', authAdmin, async (req, res) => {
  try {
    await completeOrder(req.params.id);
    return res.status(200).json({ success: true });
  } catch (err) {
    if (err instanceof OrderError) {
      if (err.code === 'ALREADY_COMPLETED') {
        return res.status(409).json({ error: err.code, message: err.message });
      }
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: err.code, message: err.message });
      }
    }
    console.error('[orderRoutes] complete error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Terjadi kesalahan server.' });
  }
});

module.exports = router;
