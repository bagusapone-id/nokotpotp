'use strict';

const { getApps } = require('firebase-admin/app');
const { db } = require('../src/config/firebase');

const BATCH_SIZE = 400;

async function migrateAdminUserIndexes() {
  const snapshot = await db.ref('users').once('value');
  if (!snapshot.exists()) {
    console.log('[admin user index migration] No users found.');
    return;
  }

  const updates = [];
  const activeAppeals = new Set();
  snapshot.forEach(child => {
    const user = child.val();
    if (!user || typeof user !== 'object' || Array.isArray(user)) return;

    const usernameLower = String(user.username || '').trim().toLowerCase();
    const createdAtValue = Number(user.created_at);
    const joinedAtValue = Number(user.joined_at);
    const createdAt = Number.isSafeInteger(createdAtValue) && createdAtValue >= 0
      ? createdAtValue
      : Number.isSafeInteger(joinedAtValue) && joinedAtValue >= 0
        ? joinedAtValue
        : 0;
    const appealAtValue = Number(user.appeal_at);
    const patch = {};

    if (user.username_lower !== usernameLower) patch.username_lower = usernameLower;
    if (user.created_at !== createdAt) patch.created_at = createdAt;
    const hasPendingAppeal = user.banned === true && user.appeal_pending === true;
    if (hasPendingAppeal) activeAppeals.add(child.key);
    if (Object.keys(patch).length || hasPendingAppeal) {
      updates.push({
        uid: child.key,
        patch,
        appeal: hasPendingAppeal
          ? {
            username: user.username || child.key,
            ban_reason: user.ban_reason || '',
            appeal_at: Number.isSafeInteger(appealAtValue) && appealAtValue >= 0 ? appealAtValue : 0,
          }
          : null,
      });
    }
  });

  let updated = 0;
  for (let offset = 0; offset < updates.length; offset += BATCH_SIZE) {
    const batch = updates.slice(offset, offset + BATCH_SIZE);
    const rootUpdates = {};
    for (const { uid, patch, appeal } of batch) {
      for (const [field, value] of Object.entries(patch)) {
        rootUpdates[`users/${uid}/${field}`] = value;
      }
      if (appeal) rootUpdates[`admin_appeals/${uid}`] = appeal;
    }
    await db.ref('/').update(rootUpdates);
    updated += batch.length;
  }

  const existingAppeals = await db.ref('admin_appeals').once('value');
  const obsoleteAppealUids = [];
  existingAppeals.forEach(child => {
    if (!activeAppeals.has(child.key)) obsoleteAppealUids.push(child.key);
  });
  for (let offset = 0; offset < obsoleteAppealUids.length; offset += BATCH_SIZE) {
    const rootUpdates = {};
    for (const uid of obsoleteAppealUids.slice(offset, offset + BATCH_SIZE)) {
      rootUpdates[`admin_appeals/${uid}`] = null;
    }
    await db.ref('/').update(rootUpdates);
  }

  console.log(`[admin user index migration] Processed ${snapshot.numChildren()} users; updated ${updated}.`);
}

migrateAdminUserIndexes()
  .catch(err => {
    console.error('[admin user index migration] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all(getApps().map(app => app.delete()));
  });
