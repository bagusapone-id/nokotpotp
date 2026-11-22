'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Rate limiter untuk POST /api/register
 * Max 5 request per 15 menit per IP.
 * Mencegah flood pembuatan akun.
 */
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: 'TOO_MANY_REQUESTS',
      message: 'Terlalu banyak percobaan pendaftaran. Coba lagi dalam 15 menit.',
    });
  },
});

/**
 * Rate limiter untuk POST /api/deposit/create
 * Max 10 request per 10 menit per user (uid dari token).
 * Fallback ke IP jika token belum ada (authUser belum jalan).
 * authUser dipasang sebelum limiter ini di route, jadi req.user selalu ada.
 */
const depositCreateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 menit
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user && req.user.uid) || req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: 'TOO_MANY_REQUESTS',
      message: 'Terlalu banyak permintaan deposit. Coba lagi dalam 10 menit.',
    });
  },
});

module.exports = { registerLimiter, depositCreateLimiter };
