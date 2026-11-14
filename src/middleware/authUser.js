const { auth } = require('../config/firebase');

/**
 * Middleware: verify Firebase ID token for regular users.
 * Attaches decoded token as req.user.
 */
async function authUser(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  try {
    const decoded = await auth.verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
}

module.exports = authUser;
