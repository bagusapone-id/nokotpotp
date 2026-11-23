'use strict';
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const authUser = require('../middleware/authUser');
const { CODE_PATTERN, ensureReferralCode } = require('../services/referralService');
const {
  SUCCESSFUL_DEPOSIT_REQUIRED_MESSAGE,
  hasSuccessfulDeposit,
} = require('../services/depositAccessService');
const isAdminUser = require('../utils/isAdminUser');

const STOCK_COUNTS_CACHE_MS = 2000;
let stockCountsCache = null;
let stockCountsCacheAt = 0;
let stockCountsLoad = null;

async function getAvailableStockCounts() {
  if (stockCountsCache && Date.now() - stockCountsCacheAt < STOCK_COUNTS_CACHE_MS) {
    return stockCountsCache;
  }
  if (stockCountsLoad) return stockCountsLoad;

  stockCountsLoad = (async () => {
    const snapshot = await db.ref('phone_stocks').once('value');
    const counts = {};
    snapshot.forEach(child => {
      const stock = child.val();
      if (stock && stock.status === 'AVAILABLE' && typeof stock.country_key === 'string') {
        counts[stock.country_key] = (counts[stock.country_key] || 0) + 1;
      }
    });
    stockCountsCache = counts;
    stockCountsCacheAt = Date.now();
    return counts;
  })();

  try {
    return await stockCountsLoad;
  } finally {
    stockCountsLoad = null;
  }
}

router.get('/stock-summary', authUser, async (req, res) => {
  try {
    const availableCounts = await getAvailableStockCounts();
    return res.status(200).json({ success: true, available_counts: availableCounts });
  } catch (err) {
    console.error('[userRoutes] stock summary error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal memuat jumlah stok.' });
  }
});

// GET /api/user/referrals — referral link, invited users, and earned commissions
router.get('/referrals', authUser, async (req, res) => {
  const uid = req.user.uid;
  try {
    if (!isAdminUser(req.user) && !(await hasSuccessfulDeposit(uid))) {
      return res.status(403).json({
        error: 'SUCCESSFUL_DEPOSIT_REQUIRED',
        message: SUCCESSFUL_DEPOSIT_REQUIRED_MESSAGE,
      });
    }

    const userSnap = await db.ref(`users/${uid}`).once('value');
    if (!userSnap.exists()) return res.status(404).json({ error: 'NOT_FOUND', message: 'Akun tidak ditemukan.' });
    const [referralsSnap, referralCode, attributionSnap] = await Promise.all([
      db.ref(`referrals/${uid}`).once('value'),
      ensureReferralCode(uid),
      db.ref(`referral_attributions/${uid}`).once('value'),
    ]);
    const referrals = referralsSnap.val() || {};
    const earnings = (userSnap.val() || {}).referral_earnings || {};
    const history = Object.entries(earnings)
      .map(([depositId, earning]) => ({ deposit_id: depositId, ...earning }))
      .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));

    return res.status(200).json({
      success: true,
      referral_code: referralCode,
      can_claim_referral: !attributionSnap.exists(),
      invited_count: Object.keys(referrals).length,
      total_earned: history.reduce((total, earning) => total + (Number(earning.commission) || 0), 0),
      referrals: Object.entries(referrals)
        .map(([user_id, referral]) => ({ user_id, ...referral }))
        .sort((a, b) => Number(b.joined_at || 0) - Number(a.joined_at || 0)),
      history,
    });
  } catch (err) {
    console.error('[userRoutes] referral history error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal memuat riwayat referral.' });
  }
});

router.post('/referrals/claim', authUser, async (req, res) => {
  const referralCode = typeof req.body.referralCode === 'string'
    ? req.body.referralCode.trim().toUpperCase()
    : '';
  if (!CODE_PATTERN.test(referralCode)) {
    return res.status(400).json({ error: 'INVALID_REFERRAL_CODE', message: 'Format kode harus NOKOTP + 5 karakter.' });
  }

  const uid = req.user.uid;
  try {
    if (!isAdminUser(req.user) && !(await hasSuccessfulDeposit(uid))) {
      return res.status(403).json({
        error: 'SUCCESSFUL_DEPOSIT_REQUIRED',
        message: SUCCESSFUL_DEPOSIT_REQUIRED_MESSAGE,
      });
    }

    const codeSnap = await db.ref(`referral_codes/${referralCode}`).once('value');
    const referrerId = codeSnap.child('user_id').val();
    if (!referrerId) {
      return res.status(400).json({ error: 'INVALID_REFERRAL_CODE', message: 'Kode referral tidak ditemukan.' });
    }
    if (referrerId === uid) {
      return res.status(400).json({ error: 'SELF_REFERRAL', message: 'Kode referral sendiri tidak dapat digunakan.' });
    }

    const [referrerSnap, userSnap] = await Promise.all([
      db.ref(`users/${referrerId}`).once('value'),
      db.ref(`users/${uid}`).once('value'),
    ]);
    if (!referrerSnap.exists()) {
      return res.status(400).json({ error: 'INVALID_REFERRAL_CODE', message: 'Kode referral tidak ditemukan.' });
    }
    if (!userSnap.exists()) return res.status(404).json({ error: 'NOT_FOUND', message: 'Akun tidak ditemukan.' });

    const attributionRef = db.ref(`referral_attributions/${uid}`);
    const result = await attributionRef.transaction(current => {
      if (current === null) return { referrer_id: referrerId, created_at: Date.now(), source: 'post_signup' };
      return;
    });
    const attribution = result.snapshot.val();
    if (!attribution || attribution.referrer_id !== referrerId) {
      return res.status(409).json({
        error: 'REFERRAL_ALREADY_SET',
        message: 'Kode referral untuk akun ini sudah pernah ditetapkan.',
      });
    }

    await db.ref(`referrals/${referrerId}/${uid}`).set({
      username: userSnap.child('username').val() || uid,
      joined_at: attribution.created_at,
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[userRoutes] referral claim error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal menyimpan kode referral.' });
  }
});

// POST /api/user/appeal — banned user submit appeal
// Note: authUser will check banned but we need to allow this endpoint for banned users
router.post('/appeal', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'UNAUTHORIZED' });

  const { auth } = require('../config/firebase');
  let decoded;
  try { decoded = await auth.verifyIdToken(token); } 
  catch { return res.status(401).json({ error: 'UNAUTHORIZED' }); }

  const uid = decoded.uid;
  try {
    // Check user is actually banned
    const snap = await db.ref(`users/${uid}`).once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'NOT_FOUND' });
    const user = snap.val();
    if (!user.banned) return res.status(400).json({ error: 'NOT_BANNED', message: 'Akun tidak dibatasi.' });
    if (user.appeal_pending) return res.status(409).json({ error: 'ALREADY_APPEALED', message: 'Banding sudah dikirim sebelumnya.' });

    const appealAt = Date.now();
    await db.ref('/').update({
      [`users/${uid}/appeal_pending`]: true,
      [`users/${uid}/appeal_at`]: appealAt,
      [`admin_appeals/${uid}`]: {
        username: user.username || uid,
        ban_reason: user.ban_reason || '',
        appeal_at: appealAt,
      },
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
