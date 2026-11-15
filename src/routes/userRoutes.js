'use strict';
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

// POST /api/user/appeal — banned user submit appeal
// Note: authUser will check banned but we need to allow this endpoint for banned users
router.post('/appeal', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'UNAUTHORIZED' });

  const { auth } = require('../config/firebase');
  let decoded;
  try { decoded = await auth.verifyIdToken(token); } 
  catch { return res.status(401).json({ error: 'UNAUTHORIZED' }); }

  const uid = decoded.uid;
  try {
    // Check user is actually banned
    const snap = await db.ref(`users/${uid}`).once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'NOT_FOUND' });
    const user = snap.val();
    if (!user.banned) return res.status(400).json({ error: 'NOT_BANNED', message: 'Akun tidak dibatasi.' });
    if (user.appeal_pending) return res.status(409).json({ error: 'ALREADY_APPEALED', message: 'Banding sudah dikirim sebelumnya.' });

    await db.ref(`users/${uid}`).update({ appeal_pending: true, appeal_at: Date.now() });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
