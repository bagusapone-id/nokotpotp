const express = require('express');
const router = express.Router();
const authAdmin = require('../middleware/authAdmin');
const { db } = require('../config/firebase');
const { addWithdrawableCredit, getBalanceBuckets, adjustBalance } = require('../services/balanceService');

/**
 * GET /api/admin/verify
 */
router.get('/verify', authAdmin, (req, res) => {
  return res.status(200).json({ admin: true, uid: req.user.uid });
});

router.get('/withdrawals', authAdmin, async (req, res) => {
  try {
    const snapshot = await db.ref('withdrawal_requests').once('value');
    const withdrawals = [];
    const cutoff = Date.now() - 5 * 60 * 1000;

    for (const [uid, userRequests] of Object.entries(snapshot.val() || {})) {
      for (const [withdrawalId, request] of Object.entries(userRequests || {})) {
        if (!request || typeof request !== 'object') continue;
        if (request.status === 'PROCESSING' && Number(request.created_at) < cutoff) {
          const reservationSnap = await db.ref(`users/${uid}/withdrawal_reservations/${withdrawalId}`).once('value');
          const status = reservationSnap.exists() ? 'PENDING' : 'FAILED';
          await db.ref(`withdrawal_requests/${uid}/${withdrawalId}`).update({ status });
          request.status = status;
        }
        if (request.status !== 'FAILED') {
          withdrawals.push({ ...request, user_id: uid, withdrawal_id: withdrawalId });
        }
      }
    }

    withdrawals.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
    return res.status(200).json({ success: true, withdrawals: withdrawals.slice(0, 200) });
  } catch (err) {
    console.error('[adminRoutes] withdrawal list error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal memuat permintaan penarikan.' });
  }
});

router.post('/withdrawals/:uid/:withdrawalId/complete', authAdmin, async (req, res) => {
  const { uid, withdrawalId } = req.params;
  const requestRef = db.ref(`withdrawal_requests/${uid}/${withdrawalId}`);
  try {
    const result = await requestRef.transaction(request => {
      if (request === null) return null;
      if (!request || request.status !== 'PENDING') return;
      request.status = 'COMPLETED';
      request.processed_at = Date.now();
      request.processed_by = req.user.uid;
      return request;
    });

    if (!result.committed) {
      const request = result.snapshot.val();
      if (!request) return res.status(404).json({ error: 'NOT_FOUND', message: 'Permintaan penarikan tidak ditemukan.' });
      return res.status(409).json({ error: 'INVALID_STATUS', message: 'Permintaan ini sudah diproses atau tidak dapat diselesaikan.' });
    }
    return res.status(200).json({ success: true, message: 'Penarikan ditandai selesai.' });
  } catch (err) {
    console.error('[adminRoutes] complete withdrawal error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal menyelesaikan penarikan.' });
  }
});

router.post('/withdrawals/:uid/:withdrawalId/reject', authAdmin, async (req, res) => {
  const { uid, withdrawalId } = req.params;
  const requestRef = db.ref(`withdrawal_requests/${uid}/${withdrawalId}`);
  try {
    const requestSnap = await requestRef.once('value');
    const storedRequest = requestSnap.val();
    if (!storedRequest) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Permintaan penarikan tidak ditemukan.' });
    }
    if (!Number.isSafeInteger(Number(storedRequest.amount)) || Number(storedRequest.amount) < 15000) {
      return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Nominal penarikan tidak valid.' });
    }

    const claimResult = await requestRef.transaction(request => {
      if (request === null) return null;
      if (!request || !['PENDING', 'REJECTING'].includes(request.status)) return;
      request.status = 'REJECTING';
      request.rejection_started_at = request.rejection_started_at || Date.now();
      return request;
    });

    if (!claimResult.committed) {
      const request = claimResult.snapshot.val();
      if (!request) return res.status(404).json({ error: 'NOT_FOUND', message: 'Permintaan penarikan tidak ditemukan.' });
      return res.status(409).json({ error: 'INVALID_STATUS', message: 'Permintaan ini sudah diproses atau tidak dapat ditolak.' });
    }

    const request = claimResult.snapshot.val();
    const userRef = db.ref(`users/${uid}`);
    const refundResult = await userRef.transaction(user => {
      if (user === null) return null;
      if (typeof user !== 'object') return;
      if (!user.withdrawal_refunds || typeof user.withdrawal_refunds !== 'object' ||
          Array.isArray(user.withdrawal_refunds)) {
        user.withdrawal_refunds = {};
      }
      if (user.withdrawal_refunds[withdrawalId]) return user;

      addWithdrawableCredit(user, Number(request.amount));
      user.withdrawal_refunds[withdrawalId] = Date.now();
      return user;
    });

    if (!refundResult.committed) {
      return res.status(500).json({ error: 'REFUND_FAILED', message: 'Gagal mengembalikan saldo. Permintaan dapat dicoba kembali.' });
    }

    const finishResult = await requestRef.transaction(current => {
      if (current === null) return null;
      if (!current || current.status !== 'REJECTING') return;
      current.status = 'REJECTED';
      current.processed_at = Date.now();
      current.processed_by = req.user.uid;
      return current;
    });
    if (!finishResult.committed && finishResult.snapshot.child('status').val() !== 'REJECTED') {
      return res.status(500).json({ error: 'STATUS_UPDATE_FAILED', message: 'Saldo sudah dikembalikan tetapi status belum diperbarui. Coba kembali.' });
    }

    return res.status(200).json({ success: true, message: 'Penarikan ditolak dan saldo dikembalikan.' });
  } catch (err) {
    console.error('[adminRoutes] reject withdrawal error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal menolak penarikan.' });
  }
});

/**
 * POST /api/admin/stock
 * Single stock entry (legacy, kept for compatibility)
 */
router.post('/stock', authAdmin, async (req, res) => {
  const { phone_number, country_key } = req.body;
  if (!phone_number || !country_key) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'phone_number dan country_key diperlukan.' });
  }
  const cleanNumber = String(phone_number).trim();
  try {
    const snap = await db.ref('phone_stocks').orderByChild('number').equalTo(cleanNumber).once('value');
    if (snap.exists()) {
      return res.status(409).json({ error: 'DUPLICATE_NUMBER', message: 'Nomor HP sudah ada di database.' });
    }
    const countrySnap = await db.ref(`countries/${country_key}`).once('value');
    if (!countrySnap.exists()) {
      return res.status(404).json({ error: 'INVALID_COUNTRY', message: 'Kode negara tidak ditemukan.' });
    }
    const newRef = db.ref('phone_stocks').push();
    await newRef.set({ country_key, number: cleanNumber, status: 'AVAILABLE' });
    return res.status(201).json({ success: true, stock_id: newRef.key });
  } catch (err) {
    console.error('[adminRoutes] add stock error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal menambah stok.' });
  }
});

/**
 * POST /api/admin/stock/bulk
 * Add multiple phone numbers at once.
 * Body: { country_key: string, numbers: string[] }
 */
router.post('/stock/bulk', authAdmin, async (req, res) => {
  const { country_key, numbers } = req.body;

  if (!country_key || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'country_key dan numbers[] diperlukan.' });
  }

  // Verify country
  const countrySnap = await db.ref(`countries/${country_key}`).once('value');
  if (!countrySnap.exists()) {
    return res.status(404).json({ error: 'INVALID_COUNTRY', message: 'Kode negara tidak ditemukan.' });
  }

  // Load all existing numbers for duplicate check
  const existingSnap = await db.ref('phone_stocks').once('value');
  const existingNumbers = new Set();
  if (existingSnap.exists()) {
    existingSnap.forEach(child => {
      existingNumbers.add(child.val().number);
    });
  }

  let added = 0;
  let skipped = 0;
  const updates = {};

  for (const raw of numbers) {
    const num = String(raw).trim().replace(/\s/g, '');
    if (!num) continue;
    if (existingNumbers.has(num)) {
      skipped++;
      continue;
    }
    const key = db.ref('phone_stocks').push().key;
    updates[`phone_stocks/${key}`] = {
      country_key,
      number: num,
      status: 'AVAILABLE',
    };
    existingNumbers.add(num); // prevent duplicate within same batch
    added++;
  }

  if (added === 0) {
    return res.status(409).json({
      error: 'ALL_DUPLICATE',
      message: 'Semua nomor sudah ada di database.',
      added: 0,
      skipped,
    });
  }

  try {
    await db.ref('/').update(updates);
    return res.status(200).json({ success: true, added, skipped });
  } catch (err) {
    console.error('[adminRoutes] bulk stock error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal menyimpan stok massal.' });
  }
});

/**
 * DELETE /api/admin/stock/:stockId
 * Delete a stock entry
 */
router.delete('/stock/:stockId', authAdmin, async (req, res) => {
  const { stockId } = req.params;
  if (!stockId) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'stockId diperlukan.' });
  }
  try {
    const snap = await db.ref(`phone_stocks/${stockId}`).once('value');
    if (!snap.exists()) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Stok tidak ditemukan.' });
    }
    const stock = snap.val();
    // Only allow deleting AVAILABLE or BURNED stocks, not LOCKED (in active order)
    if (stock.status === 'LOCKED') {
      return res.status(403).json({ error: 'LOCKED', message: 'Tidak bisa hapus nomor yang sedang terkunci dalam order aktif.' });
    }
    await db.ref(`phone_stocks/${stockId}`).remove();
    return res.status(200).json({ success: true, message: 'Stok berhasil dihapus.' });
  } catch (err) {
    console.error('[adminRoutes] delete stock error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal menghapus stok.' });
  }
});

/**
 * POST /api/admin/country
 * Add a new country/service entry.
 * Body: { key, tab, country_name, flag, price }
 */
router.post('/country', authAdmin, async (req, res) => {
  const { key, tab, country_name, flag, price } = req.body;

  if (!key || !tab || !country_name || price === undefined) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'key, tab, country_name, dan price wajib diisi.' });
  }

  if (!/^[a-z0-9_]+$/.test(key)) {
    return res.status(400).json({ error: 'INVALID_KEY', message: 'Key hanya boleh huruf kecil, angka, dan underscore.' });
  }

  if (!['indo', 'luar'].includes(tab)) {
    return res.status(400).json({ error: 'INVALID_TAB', message: 'Tab harus "indo" atau "luar".' });
  }

  try {
    const existing = await db.ref(`countries/${key}`).once('value');
    if (existing.exists()) {
      return res.status(409).json({ error: 'DUPLICATE_KEY', message: 'ID negara sudah digunakan.' });
    }

    await db.ref(`countries/${key}`).set({
      tab,
      country_name,
      flag: flag || '',
      price: Number(price),
    });

    return res.status(201).json({ success: true });
  } catch (err) {
    console.error('[adminRoutes] add country error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal menyimpan negara.' });
  }
});

/**
 * DELETE /api/admin/country/:key
 * Delete a country entry
 */
router.delete('/country/:key', authAdmin, async (req, res) => {
  const { key } = req.params;
  try {
    const snap = await db.ref(`countries/${key}`).once('value');
    if (!snap.exists()) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Negara tidak ditemukan.' });
    }
    // Check if there are AVAILABLE or LOCKED stocks under this country
    const stockSnap = await db.ref('phone_stocks')
      .orderByChild('country_key').equalTo(key).once('value');

    // Hapus semua stok yang terkait (kecuali LOCKED — masih dalam order aktif)
    if (stockSnap.exists()) {
      let lockedCount = 0;
      stockSnap.forEach(child => {
        if (child.val().status === 'LOCKED') lockedCount++;
      });
      if (lockedCount > 0) {
        return res.status(403).json({
          error: 'HAS_LOCKED_STOCK',
          message: `Tidak bisa hapus negara — ada ${lockedCount} nomor yang sedang terkunci dalam order aktif.`
        });
      }
      // Hapus semua stok sekaligus
      const deleteUpdates = {};
      stockSnap.forEach(child => { deleteUpdates[`phone_stocks/${child.key}`] = null; });
      await db.ref('/').update(deleteUpdates);
    }

    await db.ref(`countries/${key}`).remove();
    return res.status(200).json({ success: true, message: 'Negara dan semua stoknya berhasil dihapus.' });
  } catch (err) {
    console.error('[adminRoutes] delete country error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal menghapus negara.' });
  }
});

/**
 * GET /api/admin/notifications
 * List all notifications
 */
router.get('/notifications', authAdmin, async (req, res) => {
  try {
    const snap = await db.ref('notifications').orderByChild('created_at').limitToLast(100).once('value');
    const items = [];
    if (snap.exists()) snap.forEach(c => items.push({ id: c.key, ...c.val() }));
    items.sort((a, b) => b.created_at - a.created_at);
    return res.status(200).json({ success: true, notifications: items });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * POST /api/admin/notifications
 * Broadcast a notification to all users
 * Body: { title, message, type: 'info'|'warning'|'success' }
 */
router.post('/notifications', authAdmin, async (req, res) => {
  const { title, message, type = 'info' } = req.body;
  if (!title || !message) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'title dan message wajib diisi.' });
  }
  if (!['info','warning','success'].includes(type)) {
    return res.status(400).json({ error: 'INVALID_TYPE', message: 'type harus info, warning, atau success.' });
  }
  try {
    const ref = db.ref('notifications').push();
    await ref.set({ title, message, type, created_at: Date.now(), active: true });
    return res.status(201).json({ success: true, id: ref.key });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * DELETE /api/admin/notifications/:id
 * Delete a notification
 */
router.delete('/notifications/:id', authAdmin, async (req, res) => {
  try {
    await db.ref(`notifications/${req.params.id}`).remove();
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// GET /api/admin/users — list all users from Firebase users/{uid}
router.get('/users', authAdmin, async (req, res) => {
  try {
    // Gunakan Firebase REST API untuk read semua users — lebih reliable di serverless
    const dbUrl = process.env.FIREBASE_DATABASE_URL;
    const accessToken = await db.app.options.credential.getAccessToken();
    const fetchRes = await fetch(`${dbUrl}/users.json?access_token=${accessToken.access_token}`);
    const data = await fetchRes.json();
    const users = [];
    if (data && typeof data === 'object') {
      Object.entries(data).forEach(([uid, val]) => {
        if (val && typeof val === 'object') users.push({ uid, ...val });
      });
    }
    console.log('[adminRoutes] users count via REST:', users.length);
    return res.status(200).json({ success: true, users });
  } catch (err) {
    console.error('[adminRoutes] users error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

router.post('/users/:uid/balance-adjustments', authAdmin, async (req, res) => {
  const { uid } = req.params;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const type = typeof body.type === 'string' ? body.type.trim().toLowerCase() : '';
  const amount = Number(body.amount);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  if (!['add', 'subtract'].includes(type)) {
    return res.status(400).json({ error: 'INVALID_TYPE', message: 'Pilih tambah atau kurangi saldo.' });
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'Nominal harus bilangan bulat positif.' });
  }
  if (!reason || reason.length > 300) {
    return res.status(400).json({ error: 'INVALID_REASON', message: 'Alasan wajib diisi, maksimal 300 karakter.' });
  }

  const userRef = db.ref(`users/${uid}`);
  const adjustmentId = db.ref(`users/${uid}/admin_balance_adjustments`).push().key;
  const createdAt = Date.now();

  try {
    const userSnap = await userRef.once('value');
    if (!userSnap.exists()) {
      return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User tidak ditemukan.' });
    }

    const result = await userRef.transaction(user => {
      if (user === null) return null;
      if (!user || typeof user !== 'object' || Array.isArray(user)) return;

      if (!user.admin_balance_adjustments ||
          typeof user.admin_balance_adjustments !== 'object' ||
          Array.isArray(user.admin_balance_adjustments)) {
        user.admin_balance_adjustments = {};
      }
      if (user.admin_balance_adjustments[adjustmentId]) return user;

      const adjustment = adjustBalance(user, type, amount);
      if (!adjustment) return;

      user.admin_balance_adjustments[adjustmentId] = {
        type,
        amount,
        ...adjustment,
        reason,
        admin_uid: req.user.uid,
        created_at: createdAt,
      };
      return user;
    });

    const adjustmentExists = result.snapshot.child(`admin_balance_adjustments/${adjustmentId}`).exists();
    if (!result.committed || !adjustmentExists) {
      const currentUser = await userRef.once('value');
      if (!currentUser.exists()) {
        return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User tidak ditemukan.' });
      }
      const balance = getBalanceBuckets(currentUser.val()).balance;
      if (type === 'subtract' && balance < amount) {
        return res.status(400).json({ error: 'INSUFFICIENT_BALANCE', message: 'Saldo user tidak mencukupi.' });
      }
      return res.status(409).json({ error: 'BALANCE_ADJUSTMENT_FAILED', message: 'Saldo tidak berhasil diperbarui. Coba muat ulang data user.' });
    }

    const adjustment = result.snapshot.child(`admin_balance_adjustments/${adjustmentId}`).val();
    return res.status(200).json({
      success: true,
      message: type === 'add' ? 'Saldo user berhasil ditambahkan.' : 'Saldo user berhasil dikurangi.',
      adjustment_id: adjustmentId,
      balance: adjustment.balance_after,
      withdrawable_balance: adjustment.withdrawable_after,
    });
  } catch (err) {
    console.error('[adminRoutes] user balance adjustment error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal memperbarui saldo user.' });
  }
});

// POST /api/admin/users/:uid/ban — ban a user
router.post('/users/:uid/ban', authAdmin, async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Reason wajib diisi.' });
  try {
    await db.ref(`users/${req.params.uid}`).update({ banned: true, ban_reason: reason, banned_at: Date.now() });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// POST /api/admin/users/:uid/unban — unban a user
router.post('/users/:uid/unban', authAdmin, async (req, res) => {
  try {
    await db.ref(`users/${req.params.uid}`).update({ banned: false, ban_reason: null, banned_at: null, appeal_pending: false, appeal_at: null });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * POST /api/admin/country/:key/offline
 * Body: { offline: boolean, reason?: string }
 */
router.post('/country/:key/offline', authAdmin, async (req, res) => {
  const { key } = req.params;
  const { offline, reason = '' } = req.body;
  if (typeof offline !== 'boolean') {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'offline harus boolean.' });
  }
  try {
    const snap = await db.ref(`countries/${key}`).once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'NOT_FOUND', message: 'Negara tidak ditemukan.' });
    await db.ref(`countries/${key}`).update({
      offline,
      offline_reason: offline ? (reason || 'Stok sedang tidak tersedia sementara.') : null,
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * GET /api/admin/events
 */
router.get('/events', authAdmin, async (req, res) => {
  try {
    const snap = await db.ref('events').once('value');
    return res.status(200).json({ success: true, events: snap.val() || {} });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * POST /api/admin/events/deposit_double
 * Body: { active: boolean, min_amount: number }
 */
router.post('/events/deposit_double', authAdmin, async (req, res) => {
  const { active, min_amount = 25000 } = req.body;
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'active harus boolean.' });
  }
  try {
    await db.ref('events/deposit_double').set({ active, min_amount });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * POST /api/admin/events/deposit_double/reset-users
 * Reset semua user event usage (untuk mulai event baru)
 */
router.post('/events/deposit_double/reset-users', authAdmin, async (req, res) => {
  try {
    const snap = await db.ref('users').once('value');
    const updates = {};
    if (snap.exists()) {
      snap.forEach(c => {
        updates[`users/${c.key}/events/deposit_double_used`] = null;
      });
    }
    await db.ref('/').update(updates);
    return res.status(200).json({ success: true, message: 'Reset berhasil.' });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
