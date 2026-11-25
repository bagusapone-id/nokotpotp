'use strict';
const express = require('express');
const router = express.Router();
const authUser = require('../middleware/authUser');
const { db } = require('../config/firebase');
const { addDepositCredit, addWithdrawableCredit } = require('../services/balanceService');
const { hasSuccessfulDeposit } = require('../services/depositAccessService');
const isAdminUser = require('../utils/isAdminUser');
const { depositCreateLimiter, depositMethodsLimiter } = require('../middleware/rateLimits');
const kaseraPay = require('../services/kaseraPay');

const MIN_DEPOSIT_AMOUNT = 5000;
const MAX_DEPOSIT_AMOUNT = 10000000;
const DELIVERY_DETAILS_THRESHOLD = 1000000;

function normalizeCustomerName(username, userId) {
  const normalized = String(username || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
  return normalized || `User ${String(userId).slice(0, 20)}`;
}

function getJakartaDate() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${date.year}-${date.month}-${date.day}`;
}

router.get('/methods', authUser, depositMethodsLimiter, async (req, res) => {
  const amount = Number(req.query.amount);
  if (!Number.isSafeInteger(amount) || amount < MIN_DEPOSIT_AMOUNT || amount > MAX_DEPOSIT_AMOUNT) {
    return res.status(400).json({
      error: 'INVALID_AMOUNT',
      message: `Nominal deposit harus antara Rp ${MIN_DEPOSIT_AMOUNT.toLocaleString('id-ID')} dan Rp ${MAX_DEPOSIT_AMOUNT.toLocaleString('id-ID')}.`,
    });
  }

  try {
    const methods = await kaseraPay.getEligiblePaymentMethods(amount);
    return res.status(200).json({ success: true, methods });
  } catch (err) {
    console.error('[depositRoutes] payment methods error:', err.message);
    const status = err.status >= 400 && err.status < 600 ? err.status : 500;
    return res.status(status).json({
      error: 'SERVER_ERROR',
      message: err.publicMessage || 'Gagal memuat metode pembayaran.',
    });
  }
});

router.post('/create', authUser, depositCreateLimiter, async (req, res) => {
  const { amount, payment_method, quoted_total } = req.body;
  const userId = req.user.uid;

  if (!Number.isSafeInteger(amount) || amount < MIN_DEPOSIT_AMOUNT || amount > MAX_DEPOSIT_AMOUNT) {
    return res.status(400).json({
      error: 'INVALID_AMOUNT',
      message: `Nominal deposit harus antara Rp ${MIN_DEPOSIT_AMOUNT.toLocaleString('id-ID')} dan Rp ${MAX_DEPOSIT_AMOUNT.toLocaleString('id-ID')}.`,
    });
  }
  try {
    if (typeof payment_method !== 'string' || !Number.isSafeInteger(quoted_total)) {
      return res.status(400).json({
        error: 'INVALID_METHOD',
        message: 'Pilih metode pembayaran yang tersedia.',
      });
    }
    const availableMethods = await kaseraPay.getEligiblePaymentMethods(amount);
    const selectedMethod = availableMethods.find(method => method.code === payment_method);
    if (!selectedMethod) {
      return res.status(400).json({
        error: 'INVALID_METHOD',
        message: 'Metode pembayaran sudah tidak tersedia. Muat ulang pilihan metode.',
      });
    }
    if (quoted_total !== selectedMethod.total_amount) {
      return res.status(409).json({
        error: 'PAYMENT_QUOTE_CHANGED',
        message: 'Biaya pembayaran berubah. Muat ulang pilihan metode sebelum melanjutkan.',
      });
    }
    if (selectedMethod.total_amount > DELIVERY_DETAILS_THRESHOLD &&
        (req.body.delivery_date !== getJakartaDate() || req.body.delivery_terms_shown !== true)) {
      return res.status(400).json({
        error: 'DELIVERY_TERMS_REQUIRED',
        message: 'Tampilkan tanggal pemenuhan sebelum membuat pembayaran di atas Rp 1.000.000.',
      });
    }
    if (selectedMethod.total_amount > DELIVERY_DETAILS_THRESHOLD && !req.user.email && !req.user.phone_number) {
      return res.status(400).json({
        error: 'CONTACT_REQUIRED',
        message: 'Akun perlu memiliki email atau nomor telepon untuk pembayaran di atas Rp 1.000.000.',
      });
    }

    const depositRef = db.ref('deposits').push();
    const depositId  = depositRef.key;
    const orderId    = `DEP-${depositId}`;
    const [attributionSnap, userSnap] = await Promise.all([
      db.ref(`referral_attributions/${userId}`).once('value'),
      db.ref(`users/${userId}`).once('value'),
    ]);
    const attribution = attributionSnap.val();
    const username = userSnap.child('username').val() || '';
    const customerName = normalizeCustomerName(username, userId);
    const transactionInput = {
      amount: selectedMethod.total_amount,
      description: `Deposit saldo ${customerName}`.slice(0, 255),
      external_id: orderId,
      payment_methods: [selectedMethod.code],
      customer: { name: customerName },
    };
    if (req.user.email) transactionInput.customer.email = req.user.email;
    if (req.user.phone_number) transactionInput.customer.phone = req.user.phone_number;
    if (selectedMethod.total_amount > DELIVERY_DETAILS_THRESHOLD) {
      transactionInput.delivery_date = req.body.delivery_date;
      transactionInput.delivery_terms_shown = true;
    }
    transactionInput.checkout = { steps: ['customer', 'payment'] };

    const transaction = await kaseraPay.createTransaction(transactionInput, orderId);
    let checkoutUrl;
    try {
      checkoutUrl = new URL(transaction.checkout_url);
    } catch {
      throw new Error('Kasera Pay returned an invalid checkout URL.');
    }
    if (!transaction.id || !Number.isSafeInteger(transaction.amount) ||
        !Number.isSafeInteger(transaction.fee) ||
        !Number.isSafeInteger(transaction.net) ||
        transaction.net !== amount ||
        transaction.amount !== transaction.net + transaction.fee ||
        transaction.amount !== selectedMethod.total_amount ||
        transaction.fee !== selectedMethod.fee_amount ||
        checkoutUrl.origin !== 'https://pay.kasera.id') {
      const error = new Error('Kasera Pay returned an unexpected gross-up amount or fee.');
      error.status = 503;
      error.publicMessage = 'Tarif pembayaran berubah saat permintaan dibuat. Muat ulang metode pembayaran dan coba lagi.';
      throw error;
    }

    const depositData = {
      deposit_id:     depositId,
      order_id:       orderId,
      user_id:        userId,
      username,
      referrer_id:    attribution ? attribution.referrer_id : null,
      amount,
      status:         'PENDING',
      gateway:        'kasera',
      txn_id:         transaction.id,
      payment_request_id: transaction.id,
      payment_mode:   'checkout',
      payment_method: 'payment_link',
      requested_payment_method: selectedMethod.code,
      gateway_payment_method_name: selectedMethod.display_name,
      gateway_payment_method: transaction.payment_method,
      payment_link:   checkoutUrl.toString(),
      checkout_url:  checkoutUrl.toString(),
      payment:        transaction.payment || null,
      instructions:   transaction.instructions || null,
      fee:            transaction.fee || 0,
      net:            transaction.net,
      fee_handling:   'grossed_up',
      total_payment:  transaction.amount,
      expired_at:     transaction.expires_at || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      created_at:     Date.now(),
      completed_at:   null,
    };

    await depositRef.set(depositData);
    if (transaction.status === 'succeeded') {
      await processSuccessfulDeposit(depositId, depositData, transaction);
      depositData.status = 'SUCCESS';
      depositData.completed_at = transaction.paid_at || Date.now();
    }
    return res.status(201).json({ success: true, deposit: depositData });

  } catch (err) {
    console.error('[depositRoutes] create error:', err.message);
    const status = err.status >= 400 && err.status < 600 ? err.status : 500;
    return res.status(status).json({
      error: 'SERVER_ERROR',
      message: err.publicMessage || (status === 500 ? 'Gagal membuat pembayaran. Coba lagi.' : err.message),
    });
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

    if (deposit.status === 'PENDING' && deposit.txn_id && deposit.gateway === 'kasera') {
      try {
        const detail = await kaseraPay.getTransaction(deposit.txn_id);
        if (detail.id !== deposit.txn_id ||
            detail.external_id !== deposit.order_id ||
            detail.amount !== (deposit.total_payment || deposit.amount) ||
            ((deposit.fee_handling === 'grossed_up' || deposit.fee_bearer === 'customer') &&
              detail.net !== deposit.amount)) {
          throw new Error('Kasera Pay transaction details do not match the deposit.');
        }
        if (detail.status === 'succeeded') {
          await processSuccessfulDeposit(depositId, deposit, detail);
          deposit.status       = 'SUCCESS';
          deposit.completed_at = detail.paid_at;
        } else if (['expired', 'canceled', 'failed'].includes(detail.status)) {
          deposit.status = detail.status.toUpperCase();
          await db.ref(`deposits/${depositId}/status`).set(deposit.status);
        }
      } catch (apiErr) {
        console.error('[depositRoutes] Kasera status check error:', apiErr.message);
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

router.post('/webhook', async (req, res) => {
  if (!Buffer.isBuffer(req.body)) {
    return res.status(400).json({ error: 'RAW_BODY_REQUIRED' });
  }

  const signature = req.get('Kasera-Signature-V1');
  const webhookSecret = process.env.KASERA_WEBHOOK_SECRET || process.env.KASERA_PAY_WEBHOOK_SECRET;
  if (!kaseraPay.verifyWebhookSignature(req.body, signature, webhookSecret)) {
    console.error('[depositRoutes] Kasera webhook verification failed');
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'INVALID_PAYLOAD' });
  }

  if (event.type !== 'payment.paid') {
    return res.status(200).json({ success: true, message: 'ignored' });
  }

  try {
    const data = event.data;
    if (!event.id || !data || !data.payment_request_id || !data.external_id ||
        !Number.isSafeInteger(data.amount) || data.status !== 'succeeded') {
      return res.status(400).json({ error: 'INVALID_PAYLOAD' });
    }

    const snap = await db.ref('deposits')
      .orderByChild('order_id').equalTo(data.external_id).limitToFirst(1)
      .once('value');
    if (!snap.exists()) {
      console.error('[depositRoutes] Kasera webhook: deposit not found', data.external_id);
      return res.status(404).json({ error: 'NOT_FOUND' });
    }

    let depositId, deposit;
    snap.forEach(child => { depositId = child.key; deposit = child.val(); });
    if (deposit.gateway !== 'kasera' ||
        deposit.txn_id !== data.payment_request_id ||
        (deposit.total_payment || deposit.amount) !== data.amount ||
        ((deposit.fee_handling === 'grossed_up' || deposit.fee_bearer === 'customer') &&
          data.net !== undefined && data.net !== deposit.amount)) {
      console.error('[depositRoutes] Kasera webhook details do not match deposit', data.external_id);
      return res.status(400).json({ error: 'VERIFICATION_FAILED' });
    }
    if (deposit.status === 'SUCCESS') {
      return res.status(200).json({ success: true, message: 'already processed' });
    }

    await processSuccessfulDeposit(depositId, deposit, { paid_at: data.paid_at });
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[depositRoutes] Kasera webhook error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ── Helper ───────────────────────────────────────────────────────────────────
async function processSuccessfulDeposit(depositId, deposit, detail) {
  const amount = deposit.amount;
  const completedAt = detail.paid_at || detail.completed_at || Date.now();
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
    completed_at:  detail.paid_at || detail.completed_at || Date.now(),
    credited:      credit.credited,
    event_applied: credit.event_applied,
    referral_commission: referralCommission,
  });
  console.log(`[depositRoutes] ✅ +Rp${credit.credited} → user ${deposit.user_id}; referral +Rp${referralCommission} → ${deposit.referrer_id || 'none'}`);
}

module.exports = router;
