'use strict';

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function encodeUserCursor(kind, user) {
  const value = kind === 'username_lower'
    ? normalizeUsername(user.username_lower || user.username)
    : Number(user.created_at) || 0;
  return Buffer.from(JSON.stringify({ kind, value, uid: user.uid }), 'utf8').toString('base64url');
}

function decodeUserCursor(encoded) {
  if (typeof encoded !== 'string' || !encoded || encoded.length > 512) {
    throw new Error('Invalid cursor.');
  }

  let cursor;
  try {
    cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid cursor.');
  }

  if (!cursor || !['created_at', 'username_lower'].includes(cursor.kind) ||
      typeof cursor.uid !== 'string' || !cursor.uid || cursor.uid.length > 128) {
    throw new Error('Invalid cursor.');
  }
  if (cursor.kind === 'created_at' &&
      (!Number.isSafeInteger(cursor.value) || cursor.value < 0)) {
    throw new Error('Invalid cursor.');
  }
  if (cursor.kind === 'username_lower' &&
      (typeof cursor.value !== 'string' || cursor.value.length > 256)) {
    throw new Error('Invalid cursor.');
  }

  return cursor;
}

function projectAdminUser(uid, user) {
  return {
    uid,
    username: user.username || '',
    username_lower: user.username_lower || normalizeUsername(user.username),
    balance: Number(user.balance) || 0,
    referral_code: user.referral_code || '',
    banned: user.banned === true,
    ban_reason: user.ban_reason || '',
    appeal_pending: user.appeal_pending === true,
    created_at: Number(user.created_at) || 0,
  };
}

function selectUserCursorPage(rows, { kind, direction, cursor, limit }) {
  let pageRows = cursor ? rows.filter(row => row.uid !== cursor.uid) : rows.slice();
  let hasNext = false;
  let hasPrev = false;

  if (kind === 'username_lower') {
    if (cursor && direction === 'previous') {
      hasPrev = pageRows.length > limit;
      pageRows = pageRows.slice(-limit);
      hasNext = true;
    } else {
      hasNext = pageRows.length > limit;
      pageRows = pageRows.slice(0, limit);
      hasPrev = Boolean(cursor);
    }
  } else if (cursor && direction === 'previous') {
    hasPrev = pageRows.length > limit;
    pageRows = pageRows.slice(0, limit).reverse();
    hasNext = true;
  } else {
    hasNext = pageRows.length > limit;
    pageRows = pageRows.slice(-limit).reverse();
    hasPrev = Boolean(cursor);
  }

  return { rows: pageRows, has_next: hasNext, has_prev: hasPrev };
}

module.exports = {
  decodeUserCursor,
  encodeUserCursor,
  normalizeUsername,
  projectAdminUser,
  selectUserCursorPage,
};
