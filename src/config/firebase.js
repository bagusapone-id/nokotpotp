require('dotenv').config();
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');

if (getApps().length === 0) {
  let credential;
  
  // Option 1: Use service account JSON file if provided
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (serviceAccountPath) {
    const serviceAccount = require(serviceAccountPath);
    credential = cert(serviceAccount);
  } 
  // Option 2: Use individual env vars
  else {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('FIREBASE_PRIVATE_KEY or FIREBASE_SERVICE_ACCOUNT_PATH must be set');
    }
    
    credential = cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Handle both escaped \n and real newlines
      privateKey: privateKey.includes('\\n') 
        ? privateKey.replace(/\\n/g, '\n') 
        : privateKey,
    });
  }

  initializeApp({
    credential,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

const db = getDatabase();
const auth = getAuth();

module.exports = { db, auth };
