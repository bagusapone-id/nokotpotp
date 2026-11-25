'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

// Vercel Cron memanggil endpoint ini dengan header Authorization: Bearer <CRON_SECRET>
function verifyCron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // jika tidak di-set, skip auth (dev mode)
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${secret}`;
}

/**
 * GET /api/cron/cleanup
 * Dipanggil Vercel Cron setiap jam.
 *
 * Yang dihapus:
 * 1. Deposit PENDING / EXPIRED / CANCELED / FAILED lebih dari 24 jam
 * 2. Order CANCELLED / EXPIRED / berstatus refund (is_refunded=true) lebih dari 1 jam
 *
 * Yang TIDAK dihapus:
 * - Deposit SUCCESS (riwayat finansial)
 * - Order COMPLETED (riwayat sukses)
 * - Order WAITING_OTP / OTP_REQUESTED (masih aktif)
 */
router.get('/cleanup', async (req, res) => {
  if (!verifyCron(req, res)) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  const now = Date.now();
  const DEPOSIT_TTL = 24 * 60 * 60 * 1000;  // 24 jam
  const ORDER_TTL   = 60 * 60 * 1000;        // 1 jam setelah cancel/refund

  const result = {
    deposits_deleted: 0,
    orders_deleted: 0,
    errors: [],
  };

  try {
    // ── 1. Deposit cleanup ──────────────────────────────────────────────────
    const depositSnap = await db.ref('deposits').once('value');
    if (depositSnap.exists()) {
      const depositUpdates = {};
      depositSnap.forEach(child => {
        const d = child.val();
        if (!d) return;
        // Simpan deposit SUCCESS — itu riwayat finansial
        if (d.status === 'SUCCESS') return;
        // Hapus status non-sukses yang sudah lewat 24 jam
        const staleStatuses = ['PENDING', 'EXPIRED', 'CANCELED', 'CANCELLED', 'FAILED'];
        if (staleStatuses.includes(d.status) && Number(d.created_at) < now - DEPOSIT_TTL) {
          depositUpdates[child.key] = null;
          result.deposits_deleted++;
        }
      });
      if (result.deposits_deleted > 0) {
        const updates = {};
        Object.keys(depositUpdates).forEach(k => { updates[`deposits/${k}`] = null; });
        await db.ref('/').update(updates);
      }
    }

    // ── 2. Order cleanup ────────────────────────────────────────────────────
    const orderSnap = await db.ref('orders').once('value');
    if (orderSnap.exists()) {
      const orderUpdates = {};
      orderSnap.forEach(child => {
        const o = child.val();
        if (!o) return;
        // Simpan order aktif dan yang sudah selesai
        if (['WAITING_OTP', 'OTP_REQUESTED', 'COMPLETED'].includes(o.status)) return;
        // Hapus order cancel/refund/expired yang sudah > 1 jam
        const staleStatuses = ['CANCELLED', 'EXPIRED', 'FAILED'];
        const isRefunded = o.is_refunded === true;
        if ((staleStatuses.includes(o.status) || isRefunded) &&
            Number(o.created_at) < now - ORDER_TTL) {
          orderUpdates[child.key] = null;
          result.orders_deleted++;
        }
      });
      if (result.orders_deleted > 0) {
        const updates = {};
        Object.keys(orderUpdates).forEach(k => { updates[`orders/${k}`] = null; });
        await db.ref('/').update(updates);
      }
    }

    console.log(`[cleanup] ✅ deposits=${result.deposits_deleted} orders=${result.orders_deleted}`);
    return res.status(200).json({ success: true, ...result });

  } catch (err) {
    console.error('[cleanup] error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message, ...result });
  }
});

module.exports = router;
