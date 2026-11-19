'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const authUser = require('../middleware/authUser');
const { sendWithdrawalNotification } = require('../services/telegramService');

const MIN_WITHDRAWAL = 25000;
const MINIMUM_BALANCE_TO_WITHDRAW = 50000;
const MINIMUM_BALANCE_MESSAGE = 'Saldo minimal Rp 50.000 diperlukan untuk menggunakan fitur tarik saldo.';
const BANKS = {
  dana: 'DANA',
  gopay: 'GoPay',
  seabank: 'SeaBank',
};

function respondMinimumBalanceRequired(res) {
  return res.status(403).json({
    error: 'MINIMUM_BALANCE_REQUIRED',
    message: MINIMUM_BALANCE_MESSAGE,
    minimum_balance: MINIMUM_BALANCE_TO_WITHDRAW,
  });
}

router.get('/', authUser, async (req, res) => {
  const uid = req.user.uid;
  try {
    const balanceSnap = await db.ref(`users/${uid}/balance`).once('value');
    const balance = Number(balanceSnap.val()) || 0;
    if (balance < MINIMUM_BALANCE_TO_WITHDRAW) return respondMinimumBalanceRequired(res);

    const requestsSnap = await db.ref(`withdrawal_requests/${uid}`).once('value');
    const withdrawals = Object.entries(requestsSnap.val() || {})
      .map(([withdrawal_id, request]) => ({ withdrawal_id, ...request }))
      .filter(request => request.status !== 'FAILED')
      .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));

    return res.status(200).json({
      success: true,
      balance,
      withdrawals,
    });
  } catch (err) {
    console.error('[withdrawalRoutes] history error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal memuat riwayat penarikan.' });
  }
});

router.post('/', authUser, async (req, res) => {
  const amount = Number(req.body.amount);
  const bankKey = typeof req.body.bank === 'string' ? req.body.bank.trim().toLowerCase() : '';
  const accountNumber = typeof req.body.account_number === 'string'
    ? req.body.account_number.trim()
    : '';

  if (!Number.isSafeInteger(amount) || amount < MIN_WITHDRAWAL) {
    return res.status(400).json({
      error: 'INVALID_AMOUNT',
      message: 'Minimal penarikan adalah Rp 25.000.',
    });
  }
  if (!BANKS[bankKey]) {
    return res.status(400).json({ error: 'INVALID_BANK', message: 'Pilih DANA, GoPay, atau SeaBank.' });
  }
  if (!/^[0-9]{8,20}$/.test(accountNumber)) {
    return res.status(400).json({
      error: 'INVALID_ACCOUNT_NUMBER',
      message: 'Nomor rekening harus terdiri dari 8 sampai 20 digit.',
    });
  }

  const uid = req.user.uid;
  const userRef = db.ref(`users/${uid}`);
  const withdrawalId = db.ref('withdrawal_requests').push().key;
  const createdAt = Date.now();
  const request = {
    user_id: uid,
    username: req.user.name || req.user.email || uid,
    amount,
    fee: 0,
    net_amount: amount,
    bank: BANKS[bankKey],
    account_number: accountNumber,
    status: 'PROCESSING',
    created_at: createdAt,
  };
  const requestRef = db.ref(`withdrawal_requests/${uid}/${withdrawalId}`);

  try {
    const accountSnap = await userRef.once('value');
    if (!accountSnap.exists()) {
      return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Akun tidak ditemukan.' });
    }
    if ((Number(accountSnap.child('balance').val()) || 0) < MINIMUM_BALANCE_TO_WITHDRAW) {
      return respondMinimumBalanceRequired(res);
    }

    await requestRef.set(request);
    const result = await userRef.transaction(user => {
      if (user === null) return null;
      if (typeof user !== 'object') return;
      if (!user.withdrawal_reservations || typeof user.withdrawal_reservations !== 'object' ||
          Array.isArray(user.withdrawal_reservations)) {
        user.withdrawal_reservations = {};
      }
      if (user.withdrawal_reservations[withdrawalId]) return user;

      const balance = Number(user.balance) || 0;
      if (balance < MINIMUM_BALANCE_TO_WITHDRAW || balance < amount) return;

      user.balance = balance - amount;
      user.withdrawal_reservations[withdrawalId] = { amount, created_at: createdAt };
      return user;
    });

    const reservationExists = result.snapshot.child(`withdrawal_reservations/${withdrawalId}`).exists();
    if (!result.committed || !reservationExists) {
      const userSnap = await userRef.once('value');
      await requestRef.update({ status: 'FAILED' });
      if (!userSnap.exists()) {
        return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Akun tidak ditemukan.' });
      }
      const availableBalance = Number(userSnap.child('balance').val()) || 0;
      if (availableBalance < MINIMUM_BALANCE_TO_WITHDRAW) return respondMinimumBalanceRequired(res);
      if (availableBalance < amount) {
        return res.status(400).json({ error: 'INSUFFICIENT_BALANCE', message: 'Saldo tidak mencukupi.' });
      }
      return res.status(409).json({
        error: 'WITHDRAWAL_NOT_RESERVED',
        message: 'Saldo tersedia, tetapi sistem gagal mencadangkannya. Muat ulang halaman sebelum mencoba lagi.',
      });
    }

    await requestRef.update({ status: 'PENDING' });
    await sendWithdrawalNotification({ withdrawal_id: withdrawalId, ...request });
    return res.status(201).json({
      success: true,
      message: 'Permintaan penarikan berhasil dikirim.',
      withdrawal_id: withdrawalId,
    });
  } catch (err) {
    console.error('[withdrawalRoutes] request error:', err.message);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Permintaan penarikan belum dapat diproses. Periksa riwayat sebelum mencoba lagi.',
    });
  }
});

module.exports = router;
