'use strict';

const { getApps } = require('firebase-admin/app');
const { db } = require('../src/config/firebase');
const { ensureReferralCode } = require('../src/services/referralService');

async function migrateReferralCodes() {
  const usersSnap = await db.ref('users').once('value');
  if (!usersSnap.exists()) {
    console.log('[referral migration] No users found.');
    return;
  }

  const users = [];
  usersSnap.forEach(userSnap => {
    users.push({
      uid: userSnap.key,
      oldCode: userSnap.child('referral_code').val(),
    });
  });

  let migrated = 0;
  let failed = 0;
  const total = users.length;
  const activeCodes = new Set();

  for (const user of users) {
    try {
      const newCode = await ensureReferralCode(user.uid);
      activeCodes.add(newCode);
      if (user.oldCode !== newCode) migrated++;
    } catch (err) {
      failed++;
      console.error(`[referral migration] Failed for user ${user.uid}:`, err.message);
    }
  }

  let removedMappings = 0;
  if (failed === 0) {
    const mappingsSnap = await db.ref('referral_codes').once('value');
    const updates = {};
    mappingsSnap.forEach(mapping => {
      if (!activeCodes.has(mapping.key)) {
        updates[`referral_codes/${mapping.key}`] = null;
        removedMappings++;
      }
    });
    if (removedMappings) await db.ref('/').update(updates);
  }

  console.log(`[referral migration] Processed ${total} users; updated ${migrated}; removed ${removedMappings} old mappings; failed ${failed}.`);
  if (failed) process.exitCode = 1;
}

migrateReferralCodes()
  .catch(err => {
    console.error('[referral migration] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all(getApps().map(app => app.delete()));
  });
