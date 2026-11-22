/**
 * Firebase auth middleware.
 *
 * Because the frontend lives inside a Google Sites <iframe>, some browser
 * contexts strip custom headers on cross-origin requests (and some legacy
 * embed patterns rely on query params for simple GETs, e.g. the reader
 * route loaded directly as an <iframe src="...">). We support both:
 *   1. Authorization: Bearer <idToken>   (preferred — used for POST/JSON calls)
 *   2. ?token=<idToken>                  (fallback — used for direct iframe GETs)
 *
 * On success, req.firebaseUser is populated with the decoded token
 * (uid, email, custom claims like isAuthor, etc).
 */
const admin = require('./firebase');

function extractToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.query && req.query.token) {
    return String(req.query.token);
  }
  return null;
}

async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);

    if (!token) {
      return res.status(401).json({ error: 'Missing authentication token.' });
    }

    // checkRevoked: true adds a lookup to reject tokens for disabled/deleted users.
    const decoded = await admin.auth().verifyIdToken(token, true);

    req.firebaseUser = decoded; // { uid, email, isAuthor?, ... }
    return next();
  } catch (err) {
    console.error('[authMiddleware] Token verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired authentication token.' });
  }
}

/**
 * Gate for author-only routes. Must run AFTER requireAuth.
 * Relies on the isAuthor custom claim set during /api/author/register.
 */
function requireAuthorClaim(req, res, next) {
  if (!req.firebaseUser || req.firebaseUser.isAuthor !== true) {
    return res.status(403).json({ error: 'This action requires an author account.' });
  }
  return next();
}

module.exports = { requireAuth, requireAuthorClaim };
