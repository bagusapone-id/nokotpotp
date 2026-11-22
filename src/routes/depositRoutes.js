'use strict';
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const authUser = require('../middleware/authUser');
const { db }   = require('../config/firebase');
const { addDepositCredit, addWithdrawableCredit } = require('../services/balanceService');
const { hasSuccessfulDeposit } = require('../services/depositAccessService');
const isAdminUser = require('../utils/isAdminUser');

// ── Duitku config ─────────────────────────────────────────────────────────────
const DUITKU_BASE = () =>
  process.env.DUITKU_MODE === 'production'
    ? 'https://passport.duitku.com/webapi'
    : 'https://sandbox.duitku.com/webapi';

const DUITKU_MERCHANT = () => process.env.DUITKU_MERCHANT_CODE;
const DUITKU_KEY      = () => process.env.DUITKU_API_KEY;

// Payment method codes (Duitku v2)
// QR = QRIS dinamis, BC = BCA VA, M2 = Mandiri VA,
// BR = BRI VA, B1 = BNI VA, DA = DANA, OV = OVO, S1 = ShopeePay
const VALID_METHODS = ['QR', 'BC', 'M2', 'BR', 'B1', 'DA', 'OV', 'S1'];

// ── Duitku helpers ────────────────────────────────────────────────────────────

/** Build Duitku request signature: MD5(merchantCode + amount + merchantOrderId + apiKey) */
function buildSignature(merchantCode, amount, merchantOrderId, apiKey) {
  const raw = `${merchantCode}${amount}${merchantOrderId}${apiKey}`;
  return crypto.createHash('md5').update(raw).digest('hex');
}

/**
 * Create a transaction on Duitku.
 * Returns the full Duitku response object.
 */
async function duitkuCreateTransaction({
  merchantOrderId,
  paymentAmount,
  paymentMethod,
  productDetails,
  email,
  customerVaName,
  returnUrl,
  callbackUrl,
  expiryPeriod = 60, // minutes
}) {
  const merchantCode = DUITKU_MERCHANT();
  const apiKey       = DUITKU_KEY();

  if (!merchantCode || !apiKey) {
    throw new Error('DUITKU_MERCHANT_CODE atau DUITKU_API_KEY belum di-set di .env');
  }

  const signature = buildSignature(merchantCode, paymentAmount, merchantOrderId, apiKey);

  const body = {
    merchantCode,
    paymentAmount,
    paymentMethod,
    merchantOrderId,
    productDetails,
    email,
    customerVaName,
    returnUrl:    returnUrl  || process.env.DUITKU_RETURN_URL   || '',
    callbackUrl:  callbackUrl || process.env.DUITKU_CALLBACK_URL || '',
    signature,
    expiryPeriod,
  };

  const url = `${DUITKU_BASE()}/api/merchant/v2/inquiry`;
  console.log(`[duitku] POST ${url} method=${paymentMethod} orderId=${merchantOrderId}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  console.log(`[duitku] response ${res.status}:`, JSON.stringify(json));

  // Duitku returns 200 even on some errors — check statusCode field
  if (!res.ok || (json.statusCode && json.statusCode !== '00')) {
    const msg = json.statusMessage || json.Message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  return json;
}

/**
 * Check a Duitku transaction status.
 * GET /api/merchant/transactionStatus
 */
async function duitkuCheckStatus(merchantOrderId, amount) {
  const merchantCode = DUITKU_MERCHANT();
  const apiKey       = DUITKU_KEY();
  const signature    = buildSignature(merchantCode, amount, merchantOrderId, apiKey);

  const url = `${DUITKU_BASE()}/api/merchant/transactionStatus`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchantCode, merchantOrderId, amount, signature }),
  });
  const json = await res.json().catch(() => ({}));
  return json; // { transactionStatus, statusCode, statusMessage, ... }
}

// ── POST /api/deposit/create ──────────────────────────────────────────────────
router.post('/create', authUser, async (req, res) => {
  const { amount, payment_method } = req.body;
  const userId = req.user.uid;

  if (!amount || typeof amount !== 'number' || !Number.isInteger(amount) || amount < 15000) {
    return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'Minimal deposit Rp 15.000' });
  }
  if (!payment_method || !VALID_METHODS.includes(payment_method)) {
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
    const userEmail   = req.user.email || '';
    const username    = userSnap.child('username').val() || userEmail || userId;

    // Create Duitku transaction
    const duitkuRes = await duitkuCreateTransaction({
      merchantOrderId: orderId,
      paymentAmount:   amount,
      paymentMethod:   payment_method,
      productDetails:  `Deposit saldo NOKOTPOTP - ${username}`,
      email:           userEmail,
      customerVaName:  username,
    });

    // Map Duitku response to internal txData shape
    const txData = {
      txn_id:         duitkuRes.reference  || '',      // Duitku reference number
      payment_method,
      payment_link:   duitkuRes.paymentUrl || '',      // payment page / redirect URL
      qr_string:      duitkuRes.qrString   || '',      // QRIS string (for QR method)
      va_number:      duitkuRes.vaNumber   || '',      // VA number (for VA methods)
      fee:            0,                               // Duitku includes fee in amount
      total_payment:  amount,
      expired_at:     new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 60 min default
    };

    const depositData = {
      deposit_id:  depositId,
      order_id:    orderId,
      user_id:     userId,
      username,
      referrer_id: attribution ? attribution.referrer_id : null,
      amount,
      status:      'PENDING',
      gateway:     'duitku',
      ...txData,
      created_at:  Date.now(),
      completed_at: null,
    };

    await depositRef.set(depositData);
    return res.status(201).json({ success: true, deposit: depositData });

  } catch (err) {
    console.error('[depositRoutes] create error:', err.message);
    return res.status(err.status || 500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── GET /api/deposit/access ───────────────────────────────────────────────────
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

    // Poll Duitku for status update if still pending
    if (deposit.status === 'PENDING' && deposit.order_id) {
      try {
        const detail = await duitkuCheckStatus(deposit.order_id, deposit.amount);
        // statusCode '00' = success
        if (detail.statusCode === '00') {
          await processSuccessfulDeposit(depositId, deposit, {
            completed_at: Date.now(),
            duitku_ref:   detail.reference || deposit.txn_id,
          });
          deposit.status       = 'SUCCESS';
          deposit.completed_at = Date.now();
        } else if (['04', '05'].includes(detail.statusCode)) {
          // 04 = canceled, 05 = expired
          await db.ref(`deposits/${depositId}/status`).set('CANCELED');
          deposit.status = 'CANCELED';
        }
      } catch (apiErr) {
        console.error('[depositRoutes] duitku status check error:', apiErr.message);
      }
    }

    return res.status(200).json({ success: true, deposit });
  } catch (err) {
    console.error('[depositRoutes] status error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── GET /api/deposit/history ──────────────────────────────────────────────────
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

// ── POST /api/deposit/callback ────────────────────────────────────────────────
// Duitku posts to this endpoint when payment status changes.
// Must be publicly accessible (no authUser).
// Registered as DUITKU_CALLBACK_URL in .env and in Duitku dashboard.
router.post('/callback', express.json(), express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const {
      merchantCode,
      amount,
      merchantOrderId,
      productDetail,
      additionalParam,
      paymentCode,
      resultCode,
      merchantUserId,
      reference,
      signature: incomingSignature,
    } = req.body;

    console.log('[duitku callback] received:', JSON.stringify({
      merchantOrderId, amount, resultCode, reference,
    }));

    // ── 1. Verify signature ──────────────────────────────────────────────────
    const expectedSignature = buildSignature(
      merchantCode,
      amount,
      merchantOrderId,
      DUITKU_KEY()
    );
    // Constant-time compare to prevent timing attacks
    const sigBufExpected = Buffer.from(expectedSignature, 'utf8');
    const sigBufIncoming = Buffer.from(incomingSignature || '', 'utf8');
    const signatureValid =
      sigBufExpected.length === sigBufIncoming.length &&
      crypto.timingSafeEqual(sigBufExpected, sigBufIncoming);

    if (!signatureValid) {
      console.error('[duitku callback] signature mismatch — possible forgery');
      return res.status(400).send('Bad Signature');
    }

    // ── 2. Only process success ──────────────────────────────────────────────
    if (resultCode !== '00') {
      console.log(`[duitku callback] non-success resultCode=${resultCode}, ignored`);
      return res.status(200).send('OK');
    }

    // ── 3. Find deposit by order_id ──────────────────────────────────────────
    const snap = await db.ref('deposits')
      .orderByChild('order_id').equalTo(merchantOrderId).limitToFirst(1)
      .once('value');

    if (!snap.exists()) {
      console.error('[duitku callback] deposit not found for', merchantOrderId);
      return res.status(404).send('Not Found');
    }

    let depositId, deposit;
    snap.forEach(c => { depositId = c.key; deposit = c.val(); });

    // ── 4. Idempotency check — already processed ─────────────────────────────
    if (deposit.status === 'SUCCESS') {
      console.log(`[duitku callback] ${merchantOrderId} already processed, skipping`);
      return res.status(200).send('OK');
    }

    // ── 5. Amount check — must match database ────────────────────────────────
    const callbackAmount = Number(amount);
    if (callbackAmount !== Number(deposit.amount)) {
      console.error('[duitku callback] amount mismatch', {
        callback: callbackAmount,
        db: deposit.amount,
        orderId: merchantOrderId,
      });
      return res.status(400).send('Amount Mismatch');
    }

    // ── 6. Double-check with Duitku API (re-verify before crediting) ─────────
    const statusDetail = await duitkuCheckStatus(merchantOrderId, deposit.amount);
    if (statusDetail.statusCode !== '00') {
      console.error('[duitku callback] API re-check failed', statusDetail);
      return res.status(400).send('Verification Failed');
    }

    // ── 7. Credit balance (idempotent inside processSuccessfulDeposit) ───────
    await processSuccessfulDeposit(depositId, deposit, {
      completed_at: Date.now(),
      duitku_ref:   reference || statusDetail.reference || '',
    });

    console.log(`[duitku callback] ✅ processed ${merchantOrderId}`);
    return res.status(200).send('OK');

  } catch (err) {
    console.error('[duitku callback] error:', err.message, err.stack);
    // Return 200 to prevent Duitku from retrying indefinitely on our bugs
    return res.status(200).send('OK');
  }
});

// ── Helper: processSuccessfulDeposit ─────────────────────────────────────────
// Idempotency is guaranteed by the Firebase transaction inside:
// it checks deposit_credits[depositId] before crediting.
async function processSuccessfulDeposit(depositId, deposit, detail) {
  const amount      = deposit.amount;
  const completedAt = detail.completed_at || Date.now();
  const completedAtTimestamp = typeof completedAt === 'number' || /^\d+$/.test(String(completedAt))
    ? Number(completedAt)
    : Date.parse(completedAt);
  const referralCreatedAt = Number.isFinite(completedAtTimestamp) ? completedAtTimestamp : Date.now();

  const eventSnap = await db.ref('events/deposit_double').once('value');
  const event     = eventSnap.val();
  const eligibleForDouble = event && event.active === true && amount >= (event.min_amount || 25000);

  const userRef    = db.ref(`users/${deposit.user_id}`);
  const userResult = await userRef.transaction(user => {
    if (user === null) return null;
    if (!user || typeof user !== 'object' || Array.isArray(user)) return;

    // Idempotency: if this deposit was already credited, abort transaction
    if (user.deposit_credits && user.deposit_credits[depositId]) return;

    const eventApplied  = Boolean(eligibleForDouble && !(user.events && user.events.deposit_double_used));
    const eventBonus    = eventApplied ? amount : 0;
    const creditAmount  = amount + eventBonus;

    addDepositCredit(user, amount, eventBonus);

    if (eventApplied) {
      user.events = user.events || {};
      user.events.deposit_double_used = true;
    }

    user.deposit_credits = user.deposit_credits || {};
    user.deposit_credits[depositId] = {
      credited:           creditAmount,
      withdrawable_credit: amount,
      event_bonus:        eventBonus,
      event_applied:      eventApplied,
    };
    return user;
  });

  const credit = userResult.snapshot.child(`deposit_credits/${depositId}`).val();
  if (!credit) {
    // Transaction was aborted — most likely already processed (idempotent)
    console.log(`[depositRoutes] deposit ${depositId} was already credited, skipping`);
    return;
  }

  // ── Referral commission ───────────────────────────────────────────────────
  const referralCommission = Math.floor(amount / 2);
  if (deposit.referrer_id && referralCommission > 0) {
    const referrerRef    = db.ref(`users/${deposit.referrer_id}`);
    const referralResult = await referrerRef.transaction(user => {
      if (user === null) return null;
      if (!user || typeof user !== 'object' || Array.isArray(user)) return;

      // Idempotency: skip if already credited this deposit's commission
      if (user.referral_earnings && user.referral_earnings[depositId]) return;

      addWithdrawableCredit(user, referralCommission);
      user.referral_earnings = user.referral_earnings || {};
      user.referral_earnings[depositId] = {
        referred_user_id:  deposit.user_id,
        referred_username: deposit.username || deposit.user_id,
        deposit_amount:    amount,
        commission:        referralCommission,
        created_at:        referralCreatedAt,
      };
      return user;
    });

    const earning = referralResult.snapshot.child(`referral_earnings/${depositId}`).val();
    if (!earning) {
      console.log(`[depositRoutes] referral for deposit ${depositId} already credited, skipping`);
    }
  }

  // ── Finalise deposit record ───────────────────────────────────────────────
  await db.ref(`deposits/${depositId}`).update({
    status:              'SUCCESS',
    completed_at:        completedAt,
    credited:            credit.credited,
    event_applied:       credit.event_applied,
    referral_commission: referralCommission,
    duitku_ref:          detail.duitku_ref || '',
  });

  console.log(
    `[depositRoutes] ✅ +Rp${credit.credited} → user ${deposit.user_id}` +
    `; referral +Rp${referralCommission} → ${deposit.referrer_id || 'none'}`
  );
}

module.exports = router;
