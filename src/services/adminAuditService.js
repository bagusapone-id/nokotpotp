'use strict';

const { db } = require('../config/firebase');
const isAdminUser = require('../utils/isAdminUser');
const { buildAdminAuditEntry } = require('../utils/adminAudit');

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function installAdminAudit(router) {
  router.use((req, res, next) => {
    const sendJson = res.json.bind(res);
    let auditPending = false;

    res.json = body => {
      if (auditPending || !MUTATION_METHODS.has(req.method) || !isAdminUser(req.user)) {
        return sendJson(body);
      }

      auditPending = true;
      const entry = buildAdminAuditEntry(req, res.statusCode, Date.now(), body);
      const logWrite = db.ref('admin_audit_logs').push().set(entry);
      let timeoutId;
      const timeout = new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Audit logging timed out.')), 3000);
      });
      Promise.race([logWrite, timeout])
        .then(() => sendJson(body))
        .catch(err => {
          console.error('[adminAudit] failed to write audit log:', err.message);
          res.setHeader('X-Admin-Audit-Status', 'failed');
          const responseBody = body && typeof body === 'object'
            ? { ...body, audit_warning: true }
            : body;
          sendJson(responseBody);
        })
        .finally(() => clearTimeout(timeoutId));
      return res;
    };

    next();
  });
}

module.exports = { installAdminAudit };
