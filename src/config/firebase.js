require('dotenv').config();
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');

if (getApps().length === 0) {
  // Resolve private key — support 3 formats:
  // 1. FIREBASE_PRIVATE_KEY_B64 (base64-encoded, used on Vercel to avoid multiline issues)
  // 2. FIREBASE_PRIVATE_KEY with literal \n (standard .env)
  // 3. FIREBASE_PRIVATE_KEY with real newlines
  let privateKey;
  if (process.env.FIREBASE_PRIVATE_KEY_B64) {
    privateKey = Buffer.from(process.env.FIREBASE_PRIVATE_KEY_B64, 'base64').toString('utf8');
  } else if (process.env.FIREBASE_PRIVATE_KEY) {
    privateKey = process.env.FIREBASE_PRIVATE_KEY.includes('\\n')
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      : process.env.FIREBASE_PRIVATE_KEY;
  } else {
    throw new Error('FIREBASE_PRIVATE_KEY or FIREBASE_PRIVATE_KEY_B64 must be set');
  }

  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

const db = getDatabase();
const auth = getAuth();

module.exports = { db, auth };
