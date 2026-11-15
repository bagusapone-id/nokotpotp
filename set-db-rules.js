/**
 * set-db-rules.js
 * Sets Firebase Realtime Database security rules via Admin SDK.
 * Run once: node set-db-rules.js
 */
require('dotenv').config();
const { getDatabase } = require('firebase-admin/database');
const { initializeApp, getApps, cert } = require('firebase-admin/app');

if (getApps().length === 0) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY
        ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        : undefined,
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

// Firebase Admin SDK bypasses rules � no need to set rules via SDK.
// Rules must be set via Firebase Console or CLI.

console.log('='.repeat(60));
console.log('PENTING: Set Firebase Database Rules di Firebase Console!');
console.log('='.repeat(60));
console.log('\nBuka: https://console.firebase.google.com/project/nokotpotp/database/nokotpotp-default-rtdb/rules');
console.log('\nPaste rules berikut:\n');
console.log(JSON.stringify({
  rules: {
    users: {
      "$uid": {
        ".read": "$uid === auth.uid",
        ".write": "$uid === auth.uid"
      }
    },
    countries: {
      ".read": "auth !== null",
      ".write": "false"
    },
    phone_stocks: {
      ".read": "auth !== null",
      ".write": "false"
    },
    orders: {
      ".read": "auth !== null",
      ".write": "false",
      ".indexOn": ["user_id"]
    },
    notifications: {
      ".read": "auth !== null",
      ".write": "false"
    },
    events: {
      ".read": "auth !== null",
      ".write": "false"
    },
    deposits: {
      "$depositId": {
        ".read": "auth !== null && data.child('user_id').val() === auth.uid",
        ".write": "false"
      },
      ".indexOn": ["user_id"]
    }
  }
}, null, 2));
console.log('\nNote: Backend (Admin SDK) melewati rules ini secara otomatis.');
process.exit(0);
