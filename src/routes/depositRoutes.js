'use strict';
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const authUser = require('../middleware/authUser');
const { db } = require('../config/firebase');
const { addDepositCredit, addWithdrawableCredit } = require('../services/balanceService');
const { hasSuccessfulDeposit } = require('../services/depositAccessService');
const isAdminUser = require('../utils/isAdminUser');

// ── Pakasir API v2 base ──────────────────────────────────────────────────────
const PAKASIR_BASE = 'https://app.pakasir.com';
const PAKASIR_SLUG = () => process.env.PAKASIR_SLUG;
const PAKASIR_KEY  = () => process.env.PAKASIR_API_KEY;
const WEBHOOK_SECRET_HEADER = 'x-secret';

/** POST/GET to Pakasir v2 */
async function pakasirFetch(method, path, body) {
  const url = `${PAKASIR_BASE}${path}`;
  console.log(`[pakasir] ${method} ${url}`, body ? JSON.stringify(body) : '');
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': PAKASIR_KEY(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  console.log(`[pakasir] response ${res.status}:`, JSON.stringify(json));
  if (!res.ok) {
    const msg = json?.message || json?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

/** Constant-time compare webhook secret */
function verifyWebhook(headerValue, secret) {
  if (!headerValue || !secret) return false;
  try {
    const h1 = crypto.createHash('sha256').update(headerValue).digest();
    const h2 = crypto.createHash('sha256').update(secret).digest();
    return crypto.timingSafeEqual(h1, h2);
  } catch {
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const VALID_METHODS = [
  'payment_link','qris',
  'bni_va','bri_va','cimb_niaga_va','danamon_va',
  'maybank_va','bnc_va','bsi_va','muamalat_va','ocbc_va',
];

// ── POST /api/deposit/create ─────────────────────────────────────────────────
router.post('/create', authUser, async (req, res) => {
  const { amount, payment_method = 'payment_link' } = req.body;
  const userId = req.user.uid;

  if (!amount || typeof amount !== 'number' || !Number.isInteger(amount) || amount < 10000) {
    return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'Minimal deposit Rp 10.000' });
  }
  if (!VALID_METHODS.includes(payment_method)) {
    return res.status(400).json({ error: 'INVALID_METHOD', message: 'Metode pembayaran tidak valid' });
  }

  try {
    const depositRef = db.ref('deposits').push();
    const depositId  = depositRef.key;
    const orderId    = `DEP-${depositId}`;
    const [attributionSnap, userSnap] = await Promise.all([
      db.ref(`referral_attributions/${userId}`).once('value'),
      db.ref(`users/${userId}`).once('value'),
    ]);
    const attribution = attributionSnap.val();
    const username = userSnap.child('username').val() || '';

    let txData;

    if (payment_method === 'payment_link') {
      // payment_link juga pakai endpoint create-transaction dengan method: 'payment_link'
      const result = await pakasirFetch('POST',
        `/api/v2/create-transaction/${PAKASIR_SLUG()}/${orderId}`,
        { method: 'payment_link', amount }
      );
      txData = {
        txn_id:         result.txn_id,
        payment_link:   result.payment_link || `https://app.pakasir.com/pay-v2/${result.txn_id}`,
        payment_method: 'payment_link',
        qr_string:      '',
        va_number:      '',
        fee:            0,
        total_payment:  amount,
        expired_at:     new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
    } else {
      // POST /api/v2/create-transaction/{slug}/{order_id}
      // body pakai "method" bukan "payment_method"
      const tx = await pakasirFetch('POST',
        `/api/v2/create-transaction/${PAKASIR_SLUG()}/${orderId}`,
        { method: payment_method, amount }
      );
      txData = {
        txn_id:         tx.txn_id,
        payment_link:   '',  // kosong untuk non-payment_link
        payment_method: tx.payment_method || payment_method,
        qr_string:      tx.qr_string  || '',
        va_number:      tx.va_number  || '',
        fee:            tx.fee            || 0,
        total_payment:  tx.total_payment  || amount,
        expired_at:     tx.expired_at     || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
    }

    const depositData = {
      deposit_id:     depositId,
      order_id:       orderId,
      user_id:        userId,
      username,
      referrer_id:    attribution ? attribution.referrer_id : null,
      amount,
      status:         'PENDING',
      ...txData,
      created_at:     Date.now(),
      completed_at:   null,
    };

    await depositRef.set(depositData);
    return res.status(201).json({ success: true, deposit: depositData });

  } catch (err) {
    console.error('[depositRoutes] create error:', err.message);
    return res.status(err.status || 500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

router.get('/access', authUser, async (req, res) => {
  try {
    const hasSuccessful = isAdminUser(req.user) || await hasSuccessfulDeposit(req.user.uid);
    return res.status(200).json({ success: true, has_successful_deposit: hasSuccessful });
  } catch (err) {
    console.error('[depositRoutes] access check error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal memeriksa akses fitur.' });
  }
});

// ── GET /api/deposit/status/:depositId ───────────────────────────────────────
router.get('/status/:depositId', authUser, async (req, res) => {
  const { depositId } = req.params;
  const userId = req.user.uid;

  try {
    const snap = await db.ref(`deposits/${depositId}`).once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'NOT_FOUND', message: 'Deposit tidak ditemukan' });

    const deposit = snap.val();
    if (deposit.user_id !== userId) return res.status(403).json({ error: 'FORBIDDEN' });

    if (deposit.status === 'PENDING' && deposit.txn_id) {
      try {
        const detail = await pakasirFetch('GET',
          `/api/v2/transaction-status/${PAKASIR_SLUG()}/${deposit.txn_id}`
        );
        if (detail.status === 'completed') {
          await processSuccessfulDeposit(depositId, deposit, detail);
          deposit.status       = 'SUCCESS';
          deposit.completed_at = detail.completed_at;
        } else if (detail.status === 'canceled') {
          await db.ref(`deposits/${depositId}/status`).set('CANCELED');
          deposit.status = 'CANCELED';
        }
      } catch (apiErr) {
        console.error('[depositRoutes] status check error:', apiErr.message);
      }
    }

    return res.status(200).json({ success: true, deposit });
  } catch (err) {
    console.error('[depositRoutes] status error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── GET /api/deposit/history ─────────────────────────────────────────────────
router.get('/history', authUser, async (req, res) => {
  const userId = req.user.uid;
  try {
    const snap = await db.ref('deposits')
      .orderByChild('user_id').equalTo(userId).limitToLast(50)
      .once('value');

    const deposits = [];
    if (snap.exists()) snap.forEach(c => deposits.push({ ...c.val(), deposit_id: c.key }));
    deposits.sort((a, b) => b.created_at - a.created_at);

    return res.status(200).json({ success: true, deposits });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /api/deposit/webhook ─────────────────────────────────────────────────
router.post('/webhook', express.json(), async (req, res) => {
  const headerSecret  = req.get(WEBHOOK_SECRET_HEADER);
  const webhookSecret = process.env.PAKASIR_WEBHOOK_SECRET;

  if (!verifyWebhook(headerSecret, webhookSecret)) {
    console.error('[depositRoutes] webhook verification failed');
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  try {
    const event = req.body;
    const { txn_id, order_id, amount, status } = event;

    if (!txn_id || !order_id || !amount || !status) {
      return res.status(400).json({ error: 'INVALID_PAYLOAD' });
    }
    if (status !== 'completed') {
      return res.status(200).json({ success: true, message: 'ignored' });
    }

    // Find deposit by order_id
    const snap = await db.ref('deposits')
      .orderByChild('order_id').equalTo(order_id).limitToFirst(1)
      .once('value');

    if (!snap.exists()) {
      console.error('[depositRoutes] webhook: deposit not found', order_id);
      return res.status(404).json({ error: 'NOT_FOUND' });
    }

    let depositId, deposit;
    snap.forEach(c => { depositId = c.key; deposit = c.val(); });

    if (deposit.status === 'SUCCESS') return res.status(200).json({ success: true, message: 'already processed' });
    if (deposit.amount !== amount) {
      console.error('[depositRoutes] amount mismatch', { expected: deposit.amount, got: amount });
      return res.status(400).json({ error: 'AMOUNT_MISMATCH' });
    }

    // Double-check with Pakasir API
    const detail = await pakasirFetch('GET',
      `/api/v2/transaction-status/${PAKASIR_SLUG()}/${txn_id}`
    );
    if (detail.status !== 'completed' || detail.order_id !== order_id || detail.amount !== deposit.amount) {
      console.error('[depositRoutes] webhook API verify failed', detail);
      return res.status(400).json({ error: 'VERIFICATION_FAILED' });
    }

    await processSuccessfulDeposit(depositId, deposit, detail);
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[depositRoutes] webhook error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── Helper ───────────────────────────────────────────────────────────────────
async function processSuccessfulDeposit(depositId, deposit, detail) {
  const amount = deposit.amount;
  const completedAt = detail.completed_at || Date.now();
  const completedAtTimestamp = typeof completedAt === 'number' || /^\d+$/.test(String(completedAt))
    ? Number(completedAt)
    : Date.parse(completedAt);
  const referralCreatedAt = Number.isFinite(completedAtTimestamp) ? completedAtTimestamp : Date.now();

  const eventSnap = await db.ref('events/deposit_double').once('value');
  const event = eventSnap.val();
  const eligibleForDouble = event && event.active === true && amount >= (event.min_amount || 25000);
  const userRef = db.ref(`users/${deposit.user_id}`);
  const userResult = await userRef.transaction(user => {
    if (user === null) return null;
    if (!user || typeof user !== 'object' || Array.isArray(user)) return;
    if (user.deposit_credits && user.deposit_credits[depositId]) return;

    const eventApplied = Boolean(eligibleForDouble && !(user.events && user.events.deposit_double_used));
    const eventBonus = eventApplied ? amount : 0;
    const creditAmount = amount + eventBonus;
    addDepositCredit(user, amount, eventBonus);
    if (eventApplied) {
      user.events = user.events || {};
      user.events.deposit_double_used = true;
    }
    user.deposit_credits = user.deposit_credits || {};
    user.deposit_credits[depositId] = {
      credited: creditAmount,
      withdrawable_credit: amount,
      event_bonus: eventBonus,
      event_applied: eventApplied,
    };
    return user;
  });
  const credit = userResult.snapshot.child(`deposit_credits/${depositId}`).val();
  if (!credit) throw new Error(`Could not credit deposit ${depositId} to user ${deposit.user_id}`);

  const referralCommission = Math.floor(amount / 2);
  if (deposit.referrer_id && referralCommission > 0) {
    const referrerRef = db.ref(`users/${deposit.referrer_id}`);
    const referralResult = await referrerRef.transaction(user => {
      if (user === null) return null;
      if (!user || typeof user !== 'object' || Array.isArray(user)) return;
      if (user.referral_earnings && user.referral_earnings[depositId]) return;

      addWithdrawableCredit(user, referralCommission);
      user.referral_earnings = user.referral_earnings || {};
      user.referral_earnings[depositId] = {
        referred_user_id: deposit.user_id,
        referred_username: deposit.username || deposit.user_id,
        deposit_amount: amount,
        commission: referralCommission,
        created_at: referralCreatedAt,
      };
      return user;
    });
    const earning = referralResult.snapshot.child(`referral_earnings/${depositId}`).val();
    if (!earning) throw new Error(`Could not credit referral commission for deposit ${depositId}`);
  }

  await db.ref(`deposits/${depositId}`).update({
    status:        'SUCCESS',
    completed_at:  detail.completed_at || Date.now(),
    credited:      credit.credited,
    event_applied: credit.event_applied,
    referral_commission: referralCommission,
  });
  console.log(`[depositRoutes] ✅ +Rp${credit.credited} → user ${deposit.user_id}; referral +Rp${referralCommission} → ${deposit.referrer_id || 'none'}`);
}

module.exports = router;
