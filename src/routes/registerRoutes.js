const express = require('express');
const router = express.Router();
const { auth, db } = require('../config/firebase');

/**
 * POST /api/register
 * Create user record in DB after Firebase Auth registration.
 * No auth middleware — called right after createUserWithEmailAndPassword.
 * Body: { idToken: string, username: string }
 */
router.post('/', async (req, res) => {
  const { idToken, username } = req.body;

  if (!idToken || !username) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'idToken dan username diperlukan.' });
  }

  if (String(username).trim().length < 3) {
    return res.status(400).json({ error: 'INVALID_USERNAME', message: 'Username minimal 3 karakter.' });
  }

  try {
    const decoded = await auth.verifyIdToken(idToken);
    const uid = decoded.uid;

    // Check if user record already exists
    const snap = await db.ref(`users/${uid}`).once('value');
    if (snap.exists()) {
      return res.status(200).json({ success: true, message: 'User sudah ada.' });
    }

    await db.ref(`users/${uid}`).set({
      username: String(username).trim(),
      balance: 0,
    });

    return res.status(201).json({ success: true });
  } catch (err) {
    if (err.code && err.code.startsWith('auth/')) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Token tidak valid.' });
    }
    console.error('[registerRoute] Error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Gagal membuat akun.' });
  }
});

module.exports = router;
