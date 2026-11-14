const express = require('express');
const router = express.Router();
const authAdmin = require('../middleware/authAdmin');
const { db } = require('../config/firebase');

/**
 * GET /api/admin/verify
 */
router.get('/verify', authAdmin, (req, res) => {
  return res.status(200).json({ admin: true, uid: req.user.uid });
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
    let activeCount = 0;
    if (stockSnap.exists()) {
      stockSnap.forEach(child => {
        if (['AVAILABLE','LOCKED'].includes(child.val().status)) activeCount++;
      });
    }
    if (activeCount > 0) {
      return res.status(403).json({
        error: 'HAS_STOCK',
        message: `Tidak bisa hapus negara yang masih memiliki ${activeCount} stok aktif. Hapus stoknya terlebih dahulu.`
      });
    }
    await db.ref(`countries/${key}`).remove();
    return res.status(200).json({ success: true, message: 'Negara berhasil dihapus.' });
  } catch (err) {
    console.error('[adminRoutes] delete country error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal menghapus negara.' });
  }
});

module.exports = router;
