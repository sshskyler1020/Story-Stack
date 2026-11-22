/**
 * POST /api/author/register
 *
 * Flow:
 *   1. If they're not already an author, create the authors/{uid} Firestore doc.
 *   2. (n/a)
 *   3. Set the isAuthor: true custom claim on their Firebase account so the
 *      frontend/other services can trust req.firebaseUser.isAuthor on future
 *      requests without a database round trip.
 *
 * Note: Firebase custom claims only take effect on the user's NEXT ID token
 * refresh — the frontend should force a token refresh (getIdToken(true))
 * right after this call succeeds.
 */
const admin = require('./firebase');
const store = require('./store');

async function registerAuthor(req, res, next) {
  try {
    const { uid, email, name } = req.firebaseUser;
    const { displayName, bio } = req.body;

    if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
      return res.status(400).json({ error: 'displayName is required.' });
    }

    // Idempotent: if the profile already exists, make sure the claim is set and return.
    const existing = await store.getAuthor(uid);
    if (existing) {
      await grantAuthorClaim(uid);
      return res.status(200).json({
        message: 'User is already registered as an author.',
        authorId: existing.id,
      });
    }

    await store.createAuthor(uid, { display_name: displayName.trim(), bio, email: email || '' });

    // Grant the claim AFTER the profile exists so we never hand out the
    // claim without a backing record.
    await grantAuthorClaim(uid);

    return res.status(201).json({ message: 'Author registered successfully.', authorId: uid });
  } catch (err) {
    next(err);
  }
}

// req.firebaseUser is the full decoded ID token (reserved JWT fields
// included), which Firebase rejects in setCustomUserClaims — so fetch the
// real custom claims separately instead of spreading the token.
async function grantAuthorClaim(uid) {
  const userRecord = await admin.auth().getUser(uid);
  const existingClaims = userRecord.customClaims || {};
  if (existingClaims.isAuthor === true) return;
  await admin.auth().setCustomUserClaims(uid, { ...existingClaims, isAuthor: true });
}

/**
 * GET /api/author/whoami — TEMPORARY DEBUG ENDPOINT.
 *
 * Shows two things side by side, since they can genuinely disagree for a
 * few seconds after registration:
 *   - tokenClaims.isAuthor: what the CURRENT request's ID token says
 *     (whatever the frontend most recently refreshed)
 *   - liveClaims.isAuthor: what Firebase's Auth backend actually has on
 *     file for this user right now, fetched fresh via getUser()
 *
 * Useful for confirming whether a "stuck" Author Hub is a stale-token
 * problem (liveClaims already shows true, just needs another refresh) or
 * a real registration failure (liveClaims still shows false/missing).
 * Remove this route once you're done debugging — it's not meant to stay
 * in a production build long-term.
 */
async function whoAmI(req, res, next) {
  try {
    const { uid } = req.firebaseUser;
    const userRecord = await admin.auth().getUser(uid);
    return res.status(200).json({
      uid,
      tokenClaims: { isAuthor: req.firebaseUser.isAuthor === true },
      liveClaims: userRecord.customClaims || {},
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { registerAuthor, whoAmI };
