'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAdminAuditEntry } = require('../src/utils/adminAudit');

test('audit entries record safe balance-adjustment details without unrelated request data', () => {
  const entry = buildAdminAuditEntry({
    baseUrl: '/api/admin',
    path: '/users/user-1/balance-adjustments',
    method: 'POST',
    params: { uid: 'user-1' },
    user: { uid: 'admin-1' },
    body: {
      type: 'add',
      amount: 5000,
      reason: 'Manual correction',
      otp_code: '123456',
    },
  }, 200, 1700000000000, { success: true });

  assert.deepEqual(entry, {
    admin_uid: 'admin-1',
    action: 'POST /api/admin/users/user-1/balance-adjustments',
    target_id: 'user-1',
    status_code: 200,
    outcome: 'SUCCESS',
    details: {
      type: 'add',
      amount: 5000,
      reason: 'Manual correction',
    },
    created_at: 1700000000000,
  });
  assert.equal(JSON.stringify(entry).includes('123456'), false);
});

test('audit entries mark failed and partial bulk operations as failures', () => {
  const req = {
    baseUrl: '/api/admin',
    path: '/users/user-1/unban',
    method: 'POST',
    params: { uid: 'user-1' },
    user: { uid: 'admin-1' },
  };

  assert.equal(buildAdminAuditEntry(req, 500).outcome, 'FAILURE');
  assert.equal(buildAdminAuditEntry(req, 200, Date.now(), { success: false }).outcome, 'FAILURE');
});

test('OTP submissions never copy their request body into the audit record', () => {
  const entry = buildAdminAuditEntry({
    baseUrl: '/api/orders',
    path: '/order-1/submit-otp',
    method: 'POST',
    params: { id: 'order-1' },
    user: { uid: 'admin-1' },
    body: { otp_code: '123456' },
  }, 200);

  assert.deepEqual(entry.details, {});
  assert.equal(JSON.stringify(entry).includes('123456'), false);
});
