'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeUserCursor,
  encodeUserCursor,
  normalizeUsername,
  projectAdminUser,
  selectUserCursorPage,
} = require('../src/utils/adminUserIndex');

test('user cursor round-trips both sort keys', () => {
  const createdCursor = decodeUserCursor(encodeUserCursor('created_at', {
    uid: 'user-1',
    created_at: 1700000000000,
  }));
  assert.deepEqual(createdCursor, {
    kind: 'created_at',
    value: 1700000000000,
    uid: 'user-1',
  });

  const nameCursor = decodeUserCursor(encodeUserCursor('username_lower', {
    uid: 'user-2',
    username: 'MiXeD',
  }));
  assert.deepEqual(nameCursor, {
    kind: 'username_lower',
    value: 'mixed',
    uid: 'user-2',
  });
});

test('rejects malformed or unsupported cursors', () => {
  assert.throws(() => decodeUserCursor('not-a-cursor'), /Invalid cursor/);
  assert.throws(() => decodeUserCursor(Buffer.from(JSON.stringify({
    kind: 'created_at',
    value: -1,
    uid: 'user-1',
  })).toString('base64url')), /Invalid cursor/);
});

test('projects only admin-list fields and normalizes usernames', () => {
  assert.equal(normalizeUsername('  Mixed CASE '), 'mixed case');
  assert.deepEqual(projectAdminUser('user-1', {
    username: 'Alice',
    balance: '2500',
    referral_code: 'NOKOTPABCDE',
    banned: true,
    ban_reason: 'review',
    appeal_pending: true,
    created_at: 123,
    private_field: 'do-not-return',
  }), {
    uid: 'user-1',
    username: 'Alice',
    username_lower: 'alice',
    balance: 2500,
    referral_code: 'NOKOTPABCDE',
    banned: true,
    ban_reason: 'review',
    appeal_pending: true,
    created_at: 123,
  });
  assert.equal(projectAdminUser('user-2', { joined_at: 456 }).created_at, 0);
});

test('cursor paging returns adjacent newer and older pages without repeating the cursor', () => {
  const rows = [
    { uid: 'u1', user: { created_at: 1 } },
    { uid: 'u2', user: { created_at: 2 } },
    { uid: 'u3', user: { created_at: 3 } },
  ];

  const first = selectUserCursorPage(rows, {
    kind: 'created_at',
    direction: 'next',
    cursor: null,
    limit: 2,
  });
  assert.deepEqual(first.rows.map(row => row.uid), ['u3', 'u2']);
  assert.equal(first.has_next, true);

  const next = selectUserCursorPage(rows.slice(0, 2), {
    kind: 'created_at',
    direction: 'next',
    cursor: { uid: 'u2' },
    limit: 2,
  });
  assert.deepEqual(next.rows.map(row => row.uid), ['u1']);
  assert.equal(next.has_prev, true);
  assert.equal(next.has_next, false);

  const previous = selectUserCursorPage(rows, {
    kind: 'created_at',
    direction: 'previous',
    cursor: { uid: 'u1' },
    limit: 2,
  });
  assert.deepEqual(previous.rows.map(row => row.uid), ['u3', 'u2']);
  assert.equal(previous.has_next, true);
});

test('username prefix cursor paging keeps its ascending order', () => {
  const rows = ['alex', 'alice', 'amy'].map(username => ({
    uid: username,
    user: { username_lower: username },
  }));
  const first = selectUserCursorPage(rows, {
    kind: 'username_lower',
    direction: 'next',
    cursor: null,
    limit: 2,
  });
  assert.deepEqual(first.rows.map(row => row.uid), ['alex', 'alice']);

  const next = selectUserCursorPage(rows.slice(1), {
    kind: 'username_lower',
    direction: 'next',
    cursor: { uid: 'alice' },
    limit: 2,
  });
  assert.deepEqual(next.rows.map(row => row.uid), ['amy']);
  assert.equal(next.has_prev, true);
});
