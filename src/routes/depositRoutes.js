const express = require('express');
const router = express.Router();
const authUser = require('../middleware/authUser');
const { db } = require('../config/firebase');
const { Pakasir, verifyWebhook, parseWebhook, WEBHOOK_SECRET_HEADER } = require('pakasir-sdk');

// Initialize Pakasir client
const pakasir = new Pakasir({
  slug: process.env.PAKASIR_SLUG,
  apikey: process.env.PAKASIR_API_KEY,
});

/**
 * POST /api/deposit/create
 * Create deposit transaction
 * Body: { amount: number, payment_method: 'qris' | 'payment_link' | 'bni_va' | ... }
 */
router.post('/create', authUser, async (req, res) => {
  const { amount, payment_method } = req.body;
  const userId = req.user.uid;

  // Validate amount
  if (!amount || typeof amount !== 'number' || amount < 10000) {
    return res.status(400).json({
      error: 'INVALID_AMOUNT',
      message: 'Minimal deposit Rp 10.000',
    });
  }

  // Validate payment method
  const validMethods = ['payment_link', 'qris', 'bni_va', 'bri_va', 'cimb_niaga_va', 'permata_va', 'maybank_va', 'bnc_va', 'artha_graha_va', 'sampoerna_va'];
  if (!payment_method || !validMethods.includes(payment_method)) {
    return res.status(400).json({
      error: 'INVALID_METHOD',
      message: 'Metode pembayaran tidak valid',
    });
  }

  try {
    // Generate unique deposit ID
    const depositRef = db.ref('deposits').push();
    const depositId = depositRef.key;
    const orderId = `DEP-${depositId}`;

    let txData;

    // Create transaction with Pakasir
    if (payment_method === 'payment_link') {
      const result = await pakasir.createPaymentLink(orderId, amount, {
        qrisOnly: false,
      });
      txData = {
        txn_id: result.txn_id,
        payment_link: result.payment_link,
        payment_method: 'payment_link',
        qr_string: '',
        va_number: '',
      };
    } else {
      const tx = await pakasir.createTransaction(payment_method, orderId, amount);
      txData = {
        txn_id: tx.txn_id,
        payment_link: '',
        payment_method: tx.payment_method,
        qr_string: tx.qr_string || '',
        va_number: tx.va_number || '',
        fee: tx.fee,
        total_payment: tx.total_payment,
        expired_at: tx.expired_at,
      };
    }

    // Save deposit record to Firebase
    const depositData = {
      deposit_id: depositId,
      order_id: orderId,
      user_id: userId,
      amount: amount,
      status: 'PENDING',
      payment_method: txData.payment_method,
      txn_id: txData.txn_id,
      payment_link: txData.payment_link,
      qr_string: txData.qr_string,
      va_number: txData.va_number,
      fee: txData.fee || 0,
      total_payment: txData.total_payment || amount,
      expired_at: txData.expired_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      created_at: Date.now(),
      completed_at: null,
    };

    await depositRef.set(depositData);

    return res.status(201).json({
      success: true,
      deposit: depositData,
    });
  } catch (err) {
    console.error('[depositRoutes] create error:', err.message);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Gagal membuat deposit: ' + err.message,
    });
  }
});

/**
 * GET /api/deposit/status/:depositId
 * Check deposit status
 */
router.get('/status/:depositId', authUser, async (req, res) => {
  const { depositId } = req.params;
  const userId = req.user.uid;

  try {
    const snap = await db.ref(`deposits/${depositId}`).once('value');
    if (!snap.exists()) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Deposit tidak ditemukan' });
    }

    const deposit = snap.val();

    // Verify ownership
    if (deposit.user_id !== userId) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Akses ditolak' });
    }

    // If still pending, check with Pakasir API
    if (deposit.status === 'PENDING' && deposit.txn_id) {
      try {
        const detail = await pakasir.getTransactionStatus(deposit.txn_id);
        
        // Update if status changed
        if (detail.status === 'completed' && deposit.status === 'PENDING') {
          await processSuccessfulDeposit(depositId, deposit, detail);
          deposit.status = 'SUCCESS';
          deposit.completed_at = detail.completed_at;
        } else if (detail.status === 'canceled' && deposit.status === 'PENDING') {
          await db.ref(`deposits/${depositId}/status`).set('CANCELED');
          deposit.status = 'CANCELED';
        }
      } catch (apiErr) {
        console.error('[depositRoutes] status check error:', apiErr.message);
        // Return cached data if API fails
      }
    }

    return res.status(200).json({ success: true, deposit });
  } catch (err) {
    console.error('[depositRoutes] status error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal mengecek status' });
  }
});

/**
 * GET /api/deposit/history
 * Get user deposit history
 */
router.get('/history', authUser, async (req, res) => {
  const userId = req.user.uid;

  try {
    const snap = await db.ref('deposits')
      .orderByChild('user_id')
      .equalTo(userId)
      .limitToLast(50)
      .once('value');

    const deposits = [];
    if (snap.exists()) {
      snap.forEach(child => {
        deposits.push({ ...child.val(), deposit_id: child.key });
      });
    }

    // Sort by created_at desc
    deposits.sort((a, b) => b.created_at - a.created_at);

    return res.status(200).json({ success: true, deposits });
  } catch (err) {
    console.error('[depositRoutes] history error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal memuat riwayat' });
  }
});

/**
 * POST /api/deposit/webhook
 * Pakasir webhook handler
 * PUBLIC ENDPOINT - no auth required
 */
router.post('/webhook', express.json(), async (req, res) => {
  const webhookSecret = process.env.PAKASIR_WEBHOOK_SECRET;
  const headerSecret = req.get(WEBHOOK_SECRET_HEADER);

  // Verify webhook signature
  if (!verifyWebhook(headerSecret, webhookSecret)) {
    console.error('[depositRoutes] webhook verification failed');
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid webhook signature' });
  }

  try {
    const event = parseWebhook(req.body);
    console.log('[depositRoutes] webhook received:', event);

    // Only process completed payments
    if (event.status !== 'completed') {
      return res.status(200).json({ success: true, message: 'Status not completed, ignored' });
    }

    // Find deposit by order_id
    const orderId = event.order_id;
    const snap = await db.ref('deposits')
      .orderByChild('order_id')
      .equalTo(orderId)
      .limitToFirst(1)
      .once('value');

    if (!snap.exists()) {
      console.error('[depositRoutes] webhook: deposit not found for', orderId);
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Deposit not found' });
    }

    let depositId, deposit;
    snap.forEach(child => {
      depositId = child.key;
      deposit = child.val();
    });

    // Skip if already processed
    if (deposit.status === 'SUCCESS') {
      return res.status(200).json({ success: true, message: 'Already processed' });
    }

    // Verify amount matches
    if (deposit.amount !== event.amount) {
      console.error('[depositRoutes] webhook: amount mismatch', { expected: deposit.amount, got: event.amount });
      return res.status(400).json({ error: 'AMOUNT_MISMATCH', message: 'Amount does not match' });
    }

    // Double-check with API
    const detail = await pakasir.getTransactionStatus(event.txn_id);
    if (detail.status !== 'completed' || detail.order_id !== orderId || detail.amount !== deposit.amount) {
      console.error('[depositRoutes] webhook: API verification failed', detail);
      return res.status(400).json({ error: 'VERIFICATION_FAILED', message: 'API verification failed' });
    }

    // Process successful deposit
    await processSuccessfulDeposit(depositId, deposit, detail);

    return res.status(200).json({ success: true, message: 'Deposit processed' });
  } catch (err) {
    console.error('[depositRoutes] webhook error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * Helper: Process successful deposit (add balance, update status)
 */
async function processSuccessfulDeposit(depositId, deposit, detail) {
  const userId = deposit.user_id;
  const amount = deposit.amount;

  try {
    // Use transaction to safely increment balance
    const balanceRef = db.ref(`users/${userId}/balance`);
    await balanceRef.transaction(currentBalance => {
      return (currentBalance || 0) + amount;
    });

    // Update deposit status
    await db.ref(`deposits/${depositId}`).update({
      status: 'SUCCESS',
      completed_at: detail.completed_at || Date.now(),
    });

    console.log(`[depositRoutes] ✅ Deposit ${depositId} success: +Rp ${amount} to user ${userId}`);
  } catch (err) {
    console.error('[depositRoutes] processSuccessfulDeposit error:', err.message);
    throw err;
  }
}

module.exports = router;
