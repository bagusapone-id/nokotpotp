'use strict';

const express = require('express');
const router = express.Router();
const { db, auth } = require('../config/firebase');

// Vercel Cron memanggil endpoint ini dengan header Authorization: Bearer <CRON_SECRET>
function verifyCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev mode tanpa secret
  const authHeader = req.headers.authorization || '';
  return authHeader === `Bearer ${secret}`;
}

/**
 * GET /api/cron/cleanup
 * Dipanggil Vercel Cron sekali sehari (00:00 UTC).
 *
 * 1. Deposit PENDING/EXPIRED/CANCELED/FAILED > 48 jam → hapus
 * 2. Order CANCELLED/is_refunded > 1 jam → hapus
 * 3. User tanpa aktivitas > 24 jam → hapus akun + Firebase Auth
 *
 * User AMAN jika salah satu true:
 *   - Ada deposit SUCCESS
 *   - Ada order COMPLETED
 *   - balance > 0
 *   - Akun dibuat < 24 jam lalu
 *   - UID == ADMIN_SECRET_UID
 */
router.get('/cleanup', async (req, res) => {
  if (!verifyCron(req)) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  const now = Date.now();
  const DEPOSIT_TTL  = 48 * 60 * 60 * 1000; // 48 jam
  const ORDER_TTL    = 60 * 60 * 1000;       // 1 jam
  const ACCOUNT_TTL  = 24 * 60 * 60 * 1000; // 24 jam tanpa aktivitas
  const ADMIN_UID    = process.env.ADMIN_SECRET_UID || '';

  const result = {
    deposits_deleted: 0,
    orders_deleted: 0,
    users_deleted: 0,
    errors: [],
  };

  // ── Helper: kumpulkan UID yang punya aktivitas ──────────────────────────
  async function getActiveUserUids() {
    const active = new Set();

    // UID yang punya deposit SUCCESS
    const depSnap = await db.ref('deposits')
      .orderByChild('status').equalTo('SUCCESS').once('value');
    if (depSnap.exists()) {
      depSnap.forEach(c => { if (c.val()?.user_id) active.add(c.val().user_id); });
    }

    // UID yang punya order COMPLETED
    const ordSnap = await db.ref('orders')
      .orderByChild('status').equalTo('COMPLETED').once('value');
    if (ordSnap.exists()) {
      ordSnap.forEach(c => { if (c.val()?.user_id) active.add(c.val().user_id); });
    }

    return active;
  }

  try {
    // ── 1. Deposit cleanup ────────────────────────────────────────────────
    const depositSnap = await db.ref('deposits').once('value');
    if (depositSnap.exists()) {
      const updates = {};
      depositSnap.forEach(child => {
        const d = child.val();
        if (!d || d.status === 'SUCCESS') return;
        const stale = ['PENDING', 'EXPIRED', 'CANCELED', 'CANCELLED', 'FAILED'];
        if (stale.includes(d.status) && Number(d.created_at) < now - DEPOSIT_TTL) {
          updates[`deposits/${child.key}`] = null;
          result.deposits_deleted++;
        }
      });
      if (result.deposits_deleted > 0) await db.ref('/').update(updates);
    }

    // ── 2. Order cleanup ──────────────────────────────────────────────────
    const orderSnap = await db.ref('orders').once('value');
    if (orderSnap.exists()) {
      const updates = {};
      orderSnap.forEach(child => {
        const o = child.val();
        if (!o) return;
        if (['WAITING_OTP', 'OTP_REQUESTED', 'COMPLETED'].includes(o.status)) return;
        const stale = ['CANCELLED', 'EXPIRED', 'FAILED'];
        if ((stale.includes(o.status) || o.is_refunded === true) &&
            Number(o.created_at) < now - ORDER_TTL) {
          updates[`orders/${child.key}`] = null;
          result.orders_deleted++;
        }
      });
      if (result.orders_deleted > 0) await db.ref('/').update(updates);
    }

    // ── 3. Inactive user cleanup ──────────────────────────────────────────
    const usersSnap = await db.ref('users').once('value');
    if (usersSnap.exists()) {
      // Ambil atau set baseline timestamp — waktu sistem cleanup pertama kali jalan.
      // User lama yang tidak punya created_at dianggap "mulai dihitung" dari sini.
      let baselineSnap = await db.ref('system/cleanup_baseline_at').once('value');
      let baseline = baselineSnap.val();
      if (!baseline) {
        baseline = now;
        await db.ref('system/cleanup_baseline_at').set(baseline);
        console.log(`[cleanup] baseline set: ${new Date(baseline).toISOString()}`);
      }

      const activeUids = await getActiveUserUids();
      const toDelete = [];

      usersSnap.forEach(child => {
        const uid  = child.key;
        const user = child.val();
        if (!user) return;

        // Jangan hapus admin
        if (ADMIN_UID && uid === ADMIN_UID) return;
        // Jangan hapus user yang punya aktivitas finansial
        if (activeUids.has(uid)) return;
        // Jangan hapus jika balance > 0
        if (Number(user.balance || 0) > 0) return;

        // Tentukan "waktu mulai dihitung" untuk user ini:
        // - Jika punya created_at → pakai itu
        // - Jika tidak punya (user lama) → pakai baseline (waktu sistem ini pertama jalan)
        const countFrom = Number(user.created_at || 0) || baseline;

        // Hapus jika sudah > 24 jam sejak countFrom
        if (countFrom > now - ACCOUNT_TTL) return;

        toDelete.push({
          uid,
          referral_code: user.referral_code || null,
        });
      });

      for (const { uid, referral_code } of toDelete) {
        try {
          // Ambil referrer_id dari attributions (untuk hapus entri di referrals/{referrer}/{uid})
          const attrSnap = await db.ref(`referral_attributions/${uid}`).once('value');
          const referrerId = attrSnap.exists() ? attrSnap.val().referrer_id : null;

          const updates = {};
          // Hapus user record
          updates[`users/${uid}`] = null;
          // Hapus attribution
          updates[`referral_attributions/${uid}`] = null;
          // Hapus kode referral miliknya
          if (referral_code) updates[`referral_codes/${referral_code}`] = null;
          // Hapus entri di daftar teman referrer
          if (referrerId) updates[`referrals/${referrerId}/${uid}`] = null;

          await db.ref('/').update(updates);

          // Hapus Firebase Auth account
          try {
            await auth.deleteUser(uid);
          } catch (authErr) {
            // User mungkin sudah tidak ada di Auth — tidak masalah
            if (authErr.code !== 'auth/user-not-found') {
              console.warn(`[cleanup] Auth delete warning uid=${uid}:`, authErr.message);
            }
          }

          result.users_deleted++;
        } catch (err) {
          console.error(`[cleanup] Failed to delete user ${uid}:`, err.message);
          result.errors.push({ uid, error: err.message });
        }
      }
    }

    console.log(`[cleanup] ✅ deposits=${result.deposits_deleted} orders=${result.orders_deleted} users=${result.users_deleted} errors=${result.errors.length}`);
    return res.status(200).json({ success: true, ...result });

  } catch (err) {
    console.error('[cleanup] fatal error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message, ...result });
  }
});

module.exports = router;
