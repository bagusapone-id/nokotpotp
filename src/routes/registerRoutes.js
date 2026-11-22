const express = require('express');
const router = express.Router();
const { auth, db } = require('../config/firebase');
const { CODE_PATTERN, createUniqueReferralCode } = require('../services/referralService');
const { registerLimiter } = require('../middleware/rateLimits');

router.post('/validate-referral-code', async (req, res) => {
  const referralCode = typeof req.body.referralCode === 'string'
    ? req.body.referralCode.trim().toUpperCase()
    : '';
  if (!CODE_PATTERN.test(referralCode)) {
    return res.status(200).json({ valid: false, message: 'Format kode harus NOKOTP + 5 karakter.' });
  }

  try {
    const codeSnap = await db.ref(`referral_codes/${referralCode}`).once('value');
    const referrerId = codeSnap.child('user_id').val();
    if (!referrerId) return res.status(200).json({ valid: false, message: 'Kode referral tidak ditemukan.' });

    const userSnap = await db.ref(`users/${referrerId}`).once('value');
    return res.status(200).json({
      valid: userSnap.exists(),
      message: userSnap.exists() ? 'Kode referral valid.' : 'Kode referral tidak ditemukan.',
    });
  } catch (err) {
    console.error('[registerRoute] Referral code validation error:', err.message);
    return res.status(500).json({ valid: false, message: 'Gagal memeriksa kode referral.' });
  }
});

/**
 * POST /api/register
 * Create user record in DB after Firebase Auth registration.
 * No auth middleware — called right after createUserWithEmailAndPassword.
 * Body: { idToken: string, username: string }
 * Rate limited: max 5 per 15 menit per IP.
 */
router.post('/', registerLimiter, async (req, res) => {
  const { idToken, username, referralCode } = req.body;

  if (!idToken || !username) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'idToken dan username diperlukan.' });
  }

  if (referralCode !== undefined && referralCode !== null && typeof referralCode !== 'string') {
    return res.status(400).json({ error: 'INVALID_REFERRAL_CODE', message: 'Format kode referral tidak valid.' });
  }

  const normalizedReferralCode = typeof referralCode === 'string'
    ? referralCode.trim().toUpperCase()
    : '';
  if (normalizedReferralCode && !CODE_PATTERN.test(normalizedReferralCode)) {
    return res.status(400).json({ error: 'INVALID_REFERRAL_CODE', message: 'Format kode referral tidak valid.' });
  }

  if (String(username).trim().length < 3) {
    return res.status(400).json({ error: 'INVALID_USERNAME', message: 'Username minimal 3 karakter.' });
  }

  try {
    const decoded = await auth.verifyIdToken(idToken);
    const uid = decoded.uid;

    // Check if user record already exists
    const snap = await db.ref(`users/${uid}`).once('value');
    if (snap.exists()) {
      return res.status(200).json({ success: true, message: 'User sudah ada.' });
    }

    let referrerId = null;
    if (normalizedReferralCode) {
      const codeSnap = await db.ref(`referral_codes/${normalizedReferralCode}`).once('value');
      referrerId = codeSnap.child('user_id').val();
      if (!referrerId || referrerId === uid) {
        if (!referrerId) {
          return res.status(400).json({ error: 'INVALID_REFERRAL_CODE', message: 'Kode referral tidak ditemukan.' });
        }
        referrerId = null;
      } else {
        const referrerSnap = await db.ref(`users/${referrerId}`).once('value');
        if (!referrerSnap.exists()) {
          return res.status(400).json({ error: 'INVALID_REFERRAL_CODE', message: 'Kode referral tidak ditemukan.' });
        }
      }
    }

    const ownReferralCode = await createUniqueReferralCode(uid);
    const updates = {
      [`users/${uid}`]: {
        username: String(username).trim(),
        balance: 0,
        withdrawable_balance: 0,
        referral_code: ownReferralCode,
      },
    };

    if (referrerId) {
      const joinedAt = Date.now();
      updates[`referral_attributions/${uid}`] = { referrer_id: referrerId, created_at: joinedAt };
      updates[`referrals/${referrerId}/${uid}`] = {
        username: String(username).trim(),
        joined_at: joinedAt,
      };
    }

    await db.ref('/').update(updates);

    return res.status(201).json({ success: true });
  } catch (err) {
    if (err.code && err.code.startsWith('auth/')) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Token tidak valid.' });
    }
    console.error('[registerRoute] Error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal membuat akun.' });
  }
});

module.exports = router;
