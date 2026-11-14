const express = require('express');
const router = express.Router();
const authUser = require('../middleware/authUser');
const { purchase, PurchaseError } = require('../services/purchaseService');
const { db } = require('../config/firebase');

/**
 * POST /api/purchase
 * Body: { country_key: string }
 */
router.post('/', authUser, async (req, res) => {
  const { country_key } = req.body;

  if (!country_key) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'country_key diperlukan.' });
  }

  const uid = req.user.uid;

  // Get username from DB, fallback to token display name or email
  let username = req.user.name || req.user.email || uid;
  try {
    const userSnap = await db.ref(`users/${uid}/username`).once('value');
    if (userSnap.exists()) username = userSnap.val();
  } catch (_) { /* use fallback */ }

  try {
    const result = await purchase(uid, username, country_key);
    return res.status(200).json({
      order_id: result.orderId,
      phone_number: result.phoneNumber,
      expires_at: result.expiresAt,
      country_name: result.countryName,
    });
  } catch (err) {
    if (err instanceof PurchaseError) {
      if (err.code === 'INSUFFICIENT_BALANCE') {
        return res.status(400).json({ error: err.code, message: err.message });
      }
      if (err.code === 'OUT_OF_STOCK' || err.code === 'INVALID_COUNTRY') {
        return res.status(409).json({ error: err.code, message: err.message });
      }
    }
    console.error('[purchaseRoute] Error:', err.message);
    return res.status(500).json({ error: 'TRANSACTION_FAILED', message: 'Transaksi gagal, coba lagi.' });
  }
});

module.exports = router;
