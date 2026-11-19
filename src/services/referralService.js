'use strict';

const crypto = require('crypto');
const { db } = require('../config/firebase');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PREFIX = 'NOKOTP';
const CODE_PATTERN = /^NOKOTP[A-HJ-NP-Z2-9]{5}$/;

function generateCode() {
  const bytes = crypto.randomBytes(5);
  const suffix = Array.from(bytes, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
  return `${CODE_PREFIX}${suffix}`;
}

async function claimCode(code, uid) {
  const result = await db.ref(`referral_codes/${code}`).transaction(current => {
    if (current === null) return { user_id: uid, created_at: Date.now() };
    return;
  });
  return result.snapshot.val()?.user_id === uid;
}

async function releaseCode(code, uid) {
  const codeRef = db.ref(`referral_codes/${code}`);
  const current = await codeRef.once('value');
  if (current.child('user_id').val() === uid) await codeRef.remove();
}

async function createUniqueReferralCode(uid) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCode();
    if (await claimCode(code, uid)) return code;
  }
  throw new Error(`Could not create a unique referral code for user ${uid}`);
}

async function ensureReferralCode(uid) {
  const codeRef = db.ref(`users/${uid}/referral_code`);

  for (let attempt = 0; attempt < 10; attempt++) {
    const currentCode = (await codeRef.once('value')).val();
    const currentCodeIsValid = typeof currentCode === 'string' &&
      currentCode !== uid && CODE_PATTERN.test(currentCode);
    if (currentCodeIsValid) {
      if (await claimCode(currentCode, uid)) return currentCode;
    } else if (typeof currentCode === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(currentCode)) {
      await releaseCode(currentCode, uid);
    }

    const candidate = await createUniqueReferralCode(uid);
    const result = await codeRef.transaction(value => {
      if (typeof value === 'string' && value !== uid && CODE_PATTERN.test(value) &&
          value !== currentCode) return value;
      return candidate;
    });
    const assignedCode = result.snapshot.val();
    if (assignedCode === candidate) return candidate;

    await releaseCode(candidate, uid);
    if (typeof assignedCode === 'string' && CODE_PATTERN.test(assignedCode) &&
        await claimCode(assignedCode, uid)) return assignedCode;
  }

  throw new Error(`Could not assign a unique referral code to user ${uid}`);
}

module.exports = { CODE_PATTERN, createUniqueReferralCode, ensureReferralCode };
