const express = require('express');
const router = express.Router();
const authAdmin = require('../middleware/authAdmin');
const { db } = require('../config/firebase');
const { addWithdrawableCredit, getBalanceBuckets, adjustBalance } = require('../services/balanceService');
const { installAdminAudit } = require('../services/adminAuditService');
const {
  decodeUserCursor,
  encodeUserCursor,
  normalizeUsername,
  projectAdminUser,
  selectUserCursorPage,
} = require('../utils/adminUserIndex');

installAdminAudit(router);

router.get('/audit-logs', authAdmin, async (req, res) => {
  try {
    const snapshot = await db.ref('admin_audit_logs')
      .orderByChild('created_at')
      .limitToLast(100)
      .once('value');
    const logs = [];
    snapshot.forEach(child => {
      const log = child.val();
      if (log && typeof log === 'object') logs.push({ id: child.key, ...log });
    });
    logs.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
    return res.status(200).json({ success: true, logs });
  } catch (err) {
    console.error('[adminRoutes] audit log list error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal memuat audit log.' });
  }
});

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
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  const requestRef = db.ref(`withdrawal_requests/${uid}/${withdrawalId}`);
  try {
    const requestSnap = await requestRef.once('value');
    const storedRequest = requestSnap.val();
    if (!storedRequest) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Permintaan penarikan tidak ditemukan.' });
    }
    if (!Number.isSafeInteger(Number(storedRequest.amount)) || Number(storedRequest.amount) < 1000) {
      return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Nominal penarikan tidak valid.' });
    }

    const claimResult = await requestRef.transaction(request => {
      if (request === null) return null;
      if (!request || !['PENDING', 'REJECTING'].includes(request.status)) return;
      request.status = 'REJECTING';
      request.rejection_started_at = request.rejection_started_at || Date.now();
      if (reason) request.rejection_reason = reason;
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
      if (reason) current.rejection_reason = reason;
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

router.get('/orders', authAdmin, async (req, res) => {
  try {
    const snapshot = await db.ref('orders').once('value');
    const orders = {};
    snapshot.forEach(child => {
      const order = child.val();
      if (order && ['WAITING_OTP', 'OTP_REQUESTED'].includes(order.status)) {
        orders[child.key] = order;
      }
    });
    return res.status(200).json({ success: true, orders });
  } catch (err) {
    console.error('[adminRoutes] active orders error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal memuat order aktif.' });
  }
});

/**
 * POST /api/admin/stock
 * Single stock entry (legacy, kept for compatibility)
 */
router.get('/stock', authAdmin, async (req, res) => {
  try {
    const snapshot = await db.ref('phone_stocks').once('value');
    return res.status(200).json({ success: true, stock: snapshot.val() || {} });
  } catch (err) {
    console.error('[adminRoutes] stock list error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal memuat stok.' });
  }
});

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
 * DELETE /api/admin/stock/country/:countryKey/all
 * Hapus semua stok (AVAILABLE + BURNED) untuk satu negara.
 * Stok LOCKED (dalam order aktif) tidak dihapus dan tidak menyebabkan error.
 */
router.delete('/stock/country/:countryKey/all', authAdmin, async (req, res) => {
  const { countryKey } = req.params;
  if (!countryKey) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'countryKey diperlukan.' });
  }
  try {
    const countrySnap = await db.ref(`countries/${countryKey}`).once('value');
    if (!countrySnap.exists()) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Negara tidak ditemukan.' });
    }

    const stockSnap = await db.ref('phone_stocks')
      .orderByChild('country_key').equalTo(countryKey).once('value');

    if (!stockSnap.exists()) {
      return res.status(200).json({ success: true, deleted: 0, skipped_locked: 0 });
    }

    let deleted = 0;
    let skippedLocked = 0;
    const updates = {};

    stockSnap.forEach(child => {
      if (child.val().status === 'LOCKED') {
        skippedLocked++;
      } else {
        updates[`phone_stocks/${child.key}`] = null;
        deleted++;
      }
    });

    if (deleted > 0) {
      await db.ref('/').update(updates);
    }

    return res.status(200).json({ success: true, deleted, skipped_locked: skippedLocked });
  } catch (err) {
    console.error('[adminRoutes] clear country stock error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal menghapus stok.' });
  }
});

/**
 * DELETE /api/admin/stock/country/:countryKey/all
 * Hapus semua stok (AVAILABLE + BURNED) untuk satu negara, tanpa menghapus negara.
 * Stok LOCKED (dalam order aktif) dilewati.
 */
router.delete('/stock/country/:countryKey/all', authAdmin, async (req, res) => {
  const { countryKey } = req.params;
  if (!countryKey) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'countryKey diperlukan.' });
  }
  try {
    const countrySnap = await db.ref(`countries/${countryKey}`).once('value');
    if (!countrySnap.exists()) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Negara tidak ditemukan.' });
    }

    const stockSnap = await db.ref('phone_stocks')
      .orderByChild('country_key').equalTo(countryKey).once('value');

    if (!stockSnap.exists()) {
      return res.status(200).json({ success: true, deleted: 0, skipped_locked: 0 });
    }

    let deleted = 0;
    let skippedLocked = 0;
    const updates = {};

    stockSnap.forEach(child => {
      if (child.val().status === 'LOCKED') {
        skippedLocked++;
      } else {
        updates[`phone_stocks/${child.key}`] = null;
        deleted++;
      }
    });

    if (deleted > 0) {
      await db.ref('/').update(updates);
    }

    return res.status(200).json({ success: true, deleted, skipped_locked: skippedLocked });
  } catch (err) {
    console.error('[adminRoutes] clear country stock error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal menghapus stok.' });
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
 * GET /api/admin/tabs
 * List all tabs
 */
router.get('/tabs', authAdmin, async (req, res) => {
  try {
    const snap = await db.ref('tabs').once('value');
    const tabs = snap.val() || {};
    return res.status(200).json({ success: true, tabs });
  } catch (err) {
    console.error('[adminRoutes] tabs list error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal memuat tab.' });
  }
});

/**
 * POST /api/admin/tabs
 * Create a new tab
 * Body: { id: string, name: string, emoji?: string }
 */
router.post('/tabs', authAdmin, async (req, res) => {
  const { id, name, emoji = '' } = req.body;

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'INVALID_ID', message: 'ID tab wajib diisi.' });
  }
  const cleanId = id.trim().toLowerCase();
  if (!/^[a-z0-9_]{2,20}$/.test(cleanId)) {
    return res.status(400).json({ error: 'INVALID_ID', message: 'ID tab hanya huruf kecil, angka, underscore, min 2 maks 20 karakter.' });
  }
  if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 40) {
    return res.status(400).json({ error: 'INVALID_NAME', message: 'Nama tab wajib diisi, min 2 maks 40 karakter.' });
  }

  try {
    const existing = await db.ref(`tabs/${cleanId}`).once('value');
    if (existing.exists()) {
      return res.status(409).json({ error: 'DUPLICATE_ID', message: 'ID tab sudah digunakan.' });
    }

    // Determine order: max existing order + 1
    const allSnap = await db.ref('tabs').once('value');
    const allTabs = allSnap.val() || {};
    const maxOrder = Object.values(allTabs).reduce((m, t) => Math.max(m, Number(t.order) || 0), -1);

    await db.ref(`tabs/${cleanId}`).set({
      name: name.trim(),
      emoji: typeof emoji === 'string' ? emoji.trim() : '',
      order: maxOrder + 1,
      created_at: Date.now(),
    });

    return res.status(201).json({ success: true, id: cleanId });
  } catch (err) {
    console.error('[adminRoutes] add tab error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal menyimpan tab.' });
  }
});

/**
 * DELETE /api/admin/tabs/:tabId
 * Delete a tab (not indo or luar; not if countries still use it)
 */
router.delete('/tabs/:tabId', authAdmin, async (req, res) => {
  const { tabId } = req.params;

  if (['indo', 'luar'].includes(tabId)) {
    return res.status(403).json({ error: 'PROTECTED_TAB', message: 'Tab "indo" dan "luar" tidak bisa dihapus.' });
  }

  try {
    const snap = await db.ref(`tabs/${tabId}`).once('value');
    if (!snap.exists()) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Tab tidak ditemukan.' });
    }

    // Check if any country uses this tab
    const countrySnap = await db.ref('countries').orderByChild('tab').equalTo(tabId).once('value');
    if (countrySnap.exists()) {
      let count = 0;
      countrySnap.forEach(() => { count++; });
      return res.status(409).json({
        error: 'TAB_IN_USE',
        message: `Tidak bisa hapus tab — masih ada ${count} negara yang menggunakan tab ini.`,
      });
    }

    await db.ref(`tabs/${tabId}`).remove();
    return res.status(200).json({ success: true, message: 'Tab berhasil dihapus.' });
  } catch (err) {
    console.error('[adminRoutes] delete tab error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal menghapus tab.' });
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

  // Accept any tab that exists in DB (not just 'indo'/'luar')
  const tabSnap = await db.ref(`tabs/${tab}`).once('value');
  if (!tabSnap.exists()) {
    return res.status(400).json({ error: 'INVALID_TAB', message: 'Tab tidak ditemukan. Buat tab terlebih dahulu.' });
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

// Cursor queries use the indexed created_at or username_lower fields.
router.get('/users', authAdmin, async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const rawSearch = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 128) : '';
  const search = normalizeUsername(rawSearch);
  const sortKind = search ? 'username_lower' : 'created_at';
  if (req.query.direction && !['next', 'previous'].includes(req.query.direction)) {
    return res.status(400).json({ error: 'INVALID_DIRECTION', message: 'Arah paginasi tidak valid.' });
  }
  const direction = req.query.direction === 'previous' ? 'previous' : 'next';
  let cursor = null;
  if (req.query.cursor) {
    try {
      cursor = decodeUserCursor(req.query.cursor);
    } catch (err) {
      return res.status(400).json({ error: 'INVALID_CURSOR', message: err.message });
    }
  }
  if (cursor && cursor.kind !== sortKind) {
    return res.status(400).json({ error: 'INVALID_CURSOR', message: 'Cursor tidak sesuai dengan daftar user.' });
  }

  try {
    let rows = [];

    if (search && /^NOKOTP[A-HJ-NP-Z2-9]{5}$/i.test(rawSearch)) {
      const codeSnap = await db.ref(`referral_codes/${rawSearch.toUpperCase()}/user_id`).once('value');
      const uid = codeSnap.val();
      if (uid) {
        const userSnap = await db.ref(`users/${uid}`).once('value');
        const user = userSnap.val();
        if (user && typeof user === 'object' && !Array.isArray(user)) rows = [{ uid, user }];
      }
    } else if (search && /^[^.#$\[\]\/\u0000-\u001F\u007F]{1,128}$/.test(rawSearch)) {
      const exactSnap = await db.ref('users').orderByKey().equalTo(rawSearch).once('value');
      exactSnap.forEach(child => {
        const user = child.val();
        if (user && typeof user === 'object' && !Array.isArray(user)) {
          rows.push({ uid: child.key, user });
        }
      });
    }

    if (search && rows.length === 0) {
      if (cursor && cursor.kind !== 'username_lower') {
        return res.status(400).json({ error: 'INVALID_CURSOR', message: 'Cursor tidak sesuai dengan pencarian username.' });
      }
      let usersQuery = db.ref('users').orderByChild('username_lower');
      if (cursor) {
        if (direction === 'previous') {
          usersQuery = usersQuery.startAt(search).endAt(cursor.value, cursor.uid).limitToLast(limit + 2);
        } else {
          usersQuery = usersQuery.startAt(cursor.value, cursor.uid)
            .endAt(`${search}\uf8ff`).limitToFirst(limit + 2);
        }
      } else {
        usersQuery = usersQuery.startAt(search).endAt(`${search}\uf8ff`).limitToFirst(limit + 1);
      }
      const snapshot = await usersQuery.once('value');
      snapshot.forEach(child => {
        const user = child.val();
        if (user && typeof user === 'object' && !Array.isArray(user)) {
          rows.push({ uid: child.key, user });
        }
      });
    } else if (!search) {
      if (cursor && cursor.kind !== 'created_at') {
        return res.status(400).json({ error: 'INVALID_CURSOR', message: 'Cursor tidak sesuai dengan daftar user.' });
      }
      let usersQuery = db.ref('users').orderByChild('created_at');
      if (cursor) {
        usersQuery = direction === 'previous'
          ? usersQuery.startAt(cursor.value, cursor.uid).limitToFirst(limit + 2)
          : usersQuery.endAt(cursor.value, cursor.uid).limitToLast(limit + 2);
      } else {
        usersQuery = usersQuery.limitToLast(limit + 1);
      }
      const snapshot = await usersQuery.once('value');
      snapshot.forEach(child => {
        const user = child.val();
        if (user && typeof user === 'object' && !Array.isArray(user)) {
          rows.push({ uid: child.key, user });
        }
      });
    }

    const page = selectUserCursorPage(rows, { kind: sortKind, direction, cursor, limit });
    rows = page.rows;
    const users = rows.map(({ uid, user }) => projectAdminUser(uid, user));
    return res.status(200).json({
      success: true,
      users,
      pagination: {
        limit,
        has_next: page.has_next,
        has_prev: page.has_prev,
        next_cursor: users.length ? encodeUserCursor(sortKind, users[users.length - 1]) : null,
        prev_cursor: users.length ? encodeUserCursor(sortKind, users[0]) : null,
      },
    });
  } catch (err) {
    console.error('[adminRoutes] users error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

router.get('/users/appeals', authAdmin, async (req, res) => {
  try {
    const snapshot = await db.ref('admin_appeals')
      .orderByChild('appeal_at')
      .limitToLast(100)
      .once('value');
    const appeals = [];
    snapshot.forEach(child => {
      const user = child.val();
      if (user && typeof user === 'object') {
        appeals.push({
          uid: child.key,
          username: user.username || child.key,
          ban_reason: user.ban_reason || '',
          appeal_at: Number(user.appeal_at) || 0,
        });
      }
    });
    appeals.sort((a, b) => b.appeal_at - a.appeal_at);
    return res.status(200).json({ success: true, appeals });
  } catch (err) {
    console.error('[adminRoutes] user appeals error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal memuat permintaan banding.' });
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
    const uid = req.params.uid;
    await db.ref('/').update({
      [`users/${uid}/banned`]: false,
      [`users/${uid}/ban_reason`]: null,
      [`users/${uid}/banned_at`]: null,
      [`users/${uid}/appeal_pending`]: false,
      [`users/${uid}/appeal_at`]: null,
      [`admin_appeals/${uid}`]: null,
    });
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
