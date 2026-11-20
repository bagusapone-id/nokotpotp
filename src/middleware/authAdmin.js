const authUser = require('./authUser');
const isAdminUser = require('../utils/isAdminUser');

/**
 * Middleware: verify Firebase ID token AND admin custom claim.
 * Requires authUser to pass first, then checks admin: true claim.
 */
async function authAdmin(req, res, next) {
  // Skip ban check for admin
  req._skipBanCheck = true;
  // Run user auth first
  await new Promise((resolve) => authUser(req, res, resolve));

  // If authUser sent a response, stop here
  if (res.headersSent) return;

  const user = req.user;

  // Check custom claim OR env-based admin UID
  if (!isAdminUser(user)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  next();
}

module.exports = authAdmin;
