/**
 * Firebase Admin SDK initialization.
 * Used for verifying ID tokens issued to the frontend by Firebase Auth,
 * and for setting custom claims (e.g. isAuthor: true).
 */
const admin = require('firebase-admin');
const config = require('./config');

/**
 * Normalizes a pasted private key regardless of which form it arrived in:
 *   - real newlines (recommended — what a template literal naturally holds)
 *   - literal "\n" escape sequences (common if copied straight out of a
 *     JSON file without converting them)
 *   - a mix of both, or duplicate BEGIN/END markers from a copy-paste slip
 *
 * Then validates the result actually has exactly one BEGIN and one END
 * marker before handing it to Firebase, so a malformed key fails loudly
 * with a specific message at startup instead of crashing on a cryptic
 * low-level PEM parse error.
 */
function normalizeAndValidatePrivateKey(rawKey) {
  let key = rawKey.replace(/\\n/g, '\n').trim();

  // Anchored to the start of the string (^) rather than a bare substring
  // search — a key with an extra leading dash ("------BEGIN...") still
  // CONTAINS the correct 5-dash marker starting from its second
  // character, so an unanchored search wrongly treats it as valid. The
  // real PEM header must be exactly 5 dashes at the very start.
  const beginCount = (key.match(/^-----BEGIN PRIVATE KEY-----/gm) || []).length;
  const endCount = (key.match(/^-----END PRIVATE KEY-----/gm) || []).length;

  if (beginCount !== 1 || endCount !== 1) {
    throw new Error(
      `firebase.privateKey in config.js looks malformed: found ${beginCount} ` +
      `correctly-formatted BEGIN marker(s) and ${endCount} END marker(s) on their own line ` +
      '(expected exactly 1 of each). Common causes: an extra or missing dash in ' +
      '"-----BEGIN PRIVATE KEY-----" (must be exactly 5 dashes on each side), the key ' +
      'pasted twice, or a literal "\\n" left in place of a real line break partway through. ' +
      'Re-copy the private_key field from your Firebase service account JSON and paste it in fresh.'
    );
  }

  return key;
}

if (!admin.apps.length) {
  const { projectId, clientEmail, privateKey } = config.firebase;
  const isPlaceholder = !projectId || projectId === 'YOUR_PROJECT_ID' || !privateKey || privateKey.includes('PASTE_YOUR_MULTILINE_PRIVATE_KEY_HERE');

  if (isPlaceholder) {
    // Fail loudly and immediately with an actionable message instead of
    // letting Firebase throw a cryptic error deep in a request handler.
    throw new Error(
      'Firebase Admin credentials are missing. Open config.js and fill in ' +
      'firebase.projectId, firebase.clientEmail, and firebase.privateKey ' +
      'with the values from your Firebase service account JSON.'
    );
  }

  const normalizedPrivateKey = normalizeAndValidatePrivateKey(privateKey);

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: normalizedPrivateKey,
    }),
  });
}

module.exports = admin;
