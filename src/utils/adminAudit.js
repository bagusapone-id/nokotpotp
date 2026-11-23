'use strict';

function buildAdminAuditEntry(req, statusCode, createdAt = Date.now(), responseBody) {
  const path = `${req.baseUrl || ''}${req.path || ''}`;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const details = {};

  if (path.endsWith('/balance-adjustments')) {
    if (['add', 'subtract'].includes(body.type)) details.type = body.type;
    if (Number.isSafeInteger(Number(body.amount))) details.amount = Number(body.amount);
    if (typeof body.reason === 'string') details.reason = body.reason.trim().slice(0, 300);
  } else if (/\/users\/[^/]+\/ban$/.test(path) && typeof body.reason === 'string') {
    details.reason = body.reason.trim().slice(0, 300);
  } else if (/\/country\/[^/]+\/offline$/.test(path)) {
    if (typeof body.offline === 'boolean') details.offline = body.offline;
    if (typeof body.reason === 'string') details.reason = body.reason.trim().slice(0, 300);
  } else if (path.endsWith('/events/deposit_double')) {
    if (typeof body.active === 'boolean') details.active = body.active;
    if (Number.isSafeInteger(Number(body.min_amount))) details.min_amount = Number(body.min_amount);
  } else if (path.endsWith('/stock/bulk')) {
    if (typeof body.country_key === 'string') details.country_key = body.country_key;
    if (Array.isArray(body.numbers)) details.count = body.numbers.length;
  } else if (path.endsWith('/notifications') && typeof body.type === 'string') {
    details.type = body.type;
  }
  if (path.endsWith('/admin-cancel-active') && responseBody) {
    for (const field of ['total', 'cancelled', 'skipped']) {
      if (Number.isSafeInteger(responseBody[field])) details[field] = responseBody[field];
    }
    if (Array.isArray(responseBody.failed)) details.failed_count = responseBody.failed.length;
  } else if (/\/admin-cancel$/.test(path) && responseBody &&
      Number.isSafeInteger(responseBody.refunded_amount)) {
    details.refunded_amount = responseBody.refunded_amount;
  }

  const params = req.params || {};
  const targetId = params.uid || params.withdrawalId || params.stockId ||
    params.orderId || params.id || params.key || null;
  const success = statusCode < 400 && !(responseBody && responseBody.success === false);

  return {
    admin_uid: req.user.uid,
    action: `${req.method} ${path}`,
    target_id: targetId,
    status_code: statusCode,
    outcome: success ? 'SUCCESS' : 'FAILURE',
    details,
    created_at: createdAt,
  };
}

module.exports = { buildAdminAuditEntry };
