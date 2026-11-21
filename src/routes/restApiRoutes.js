'use strict';
const express = require('express');
const router  = express.Router();
const authUser  = require('../middleware/authUser');
const authAdmin = require('../middleware/authAdmin');
const { db }    = require('../config/firebase');
const { sendNotification } = require('../services/telegramService');

const PRICE = 25000;

/**
 * POST /api/rest-api/order
 * Submit REST API WA order setelah bayar
 * Body: { nama, wa_target, nama_perangkat, deposit_id }
 */
router.post('/order', authUser, async (req, res) => {
  const { nama, wa_target, nama_perangkat, deposit_id } = req.body;
  const uid = req.user.uid;

  if (!nama || !wa_target || !nama_perangkat) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'nama, wa_target, dan nama_perangkat wajib diisi.' });
  }

  try {
    // Verifikasi deposit sudah sukses dan belum dipakai
    if (deposit_id) {
      const depSnap = await db.ref(`deposits/${deposit_id}`).once('value');
      if (!depSnap.exists()) return res.status(404).json({ error: 'DEPOSIT_NOT_FOUND', message: 'Deposit tidak ditemukan.' });
      const dep = depSnap.val();
      if (dep.user_id !== uid) return res.status(403).json({ error: 'FORBIDDEN' });
      if (dep.status !== 'SUCCESS') return res.status(400).json({ error: 'DEPOSIT_NOT_SUCCESS', message: 'Deposit belum berhasil.' });
      if (dep.used_for_rest_api) return res.status(409).json({ error: 'DEPOSIT_USED', message: 'Deposit sudah digunakan.' });
      if (dep.amount < PRICE) return res.status(400).json({ error: 'INSUFFICIENT', message: `Deposit minimal Rp ${PRICE.toLocaleString('id-ID')}.` });
      // Tandai deposit sudah dipakai
      await db.ref(`deposits/${deposit_id}/used_for_rest_api`).set(true);
    }

    // Ambil username
    const userSnap = await db.ref(`users/${uid}`).once('value');
    const user = userSnap.val() || {};

    const ref = db.ref('rest_api_orders').push();
    const orderId = ref.key;
    const orderData = {
      order_id:      orderId,
      user_id:       uid,
      username:      user.username || uid,
      nama,
      wa_target,
      nama_perangkat,
      deposit_id:    deposit_id || null,
      status:        'PENDING',
      status_note:   '',
      created_at:    Date.now(),
      updated_at:    Date.now(),
    };

    await ref.set(orderData);

    // Kirim notif Telegram ke admin
    const msg = `🤖 *REST API WA Order Baru*\n\n` +
      `👤 User: *${user.username || uid}*\n` +
      `📛 Nama: *${nama}*\n` +
      `📱 WA Target: *${wa_target}*\n` +
      `💻 Perangkat: *${nama_perangkat}*\n` +
      `🆔 Order ID: \`${orderId}\`\n\n` +
      `Status: ⏳ PENDING — Segera proses!`;
    sendNotification(msg).catch(() => {});

    return res.status(201).json({ success: true, order_id: orderId });
  } catch (err) {
    console.error('[restApiRoutes] order error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * GET /api/rest-api/orders
 * Get user's REST API orders
 */
router.get('/orders', authUser, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db.ref('rest_api_orders')
      .orderByChild('user_id').equalTo(uid)
      .once('value');
    const orders = [];
    if (snap.exists()) snap.forEach(c => orders.push({ ...c.val(), order_id: c.key }));
    orders.sort((a, b) => b.created_at - a.created_at);
    return res.status(200).json({ success: true, orders });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * GET /api/admin/rest-api/orders
 * Admin: get all REST API orders
 */
router.get('/admin/orders', authAdmin, async (req, res) => {
  try {
    const snap = await db.ref('rest_api_orders').orderByChild('status').equalTo('PENDING').once('value');
    const snap2 = await db.ref('rest_api_orders').once('value');
    const orders = [];
    if (snap2.exists()) snap2.forEach(c => orders.push({ ...c.val(), order_id: c.key }));
    orders.sort((a, b) => b.created_at - a.created_at);
    return res.status(200).json({ success: true, orders });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * POST /api/admin/rest-api/orders/:id/status
 * Admin: update status order
 * Body: { status: 'ACTIVE' | 'REJECTED', note?: string }
 */
router.post('/admin/orders/:id/status', authAdmin, async (req, res) => {
  const { status, note = '' } = req.body;
  if (!['ACTIVE','REJECTED'].includes(status)) {
    return res.status(400).json({ error: 'INVALID_STATUS' });
  }
  try {
    const snap = await db.ref(`rest_api_orders/${req.params.id}`).once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'NOT_FOUND' });
    const order = snap.val();
    await db.ref(`rest_api_orders/${req.params.id}`).update({
      status,
      status_note: note,
      updated_at: Date.now(),
    });
    // Notif Telegram
    const emoji = status === 'ACTIVE' ? '✅' : '❌';
    const msg = `${emoji} *REST API WA ${status}*\n\n` +
      `👤 User: *${order.username}*\n` +
      `📛 Nama: *${order.nama}*\n` +
      `📱 WA: *${order.wa_target}*\n` +
      (note ? `📝 Catatan: ${note}` : '');
    sendNotification(msg).catch(() => {});
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
