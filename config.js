/**
 * =====================================================================
 * CENTRAL CONFIG — plug your real API keys and secrets in below.
 *
 * This replaces environment variables entirely: every other file in
 * this backend reads its settings from here (`require('./config')`)
 * instead of from `process.env`.
 *
 * ---------------------------------------------------------------------
 * SECURITY WARNING — read this before you fill anything in:
 *
 * Once you paste real secrets into this file, this file itself
 * becomes a secret. That means:
 *
 *   1. NEVER commit this file to a public git repository. If your
 *      repo is public, add "config.js" to .gitignore immediately
 *      (it already is, in the .gitignore shipped with this project).
 *
 *   2. If your repo is private and you're comfortable committing it
 *      there, that's a normal way to deploy this to Render — Render
 *      will just pull it down along with the rest of your code.
 *
 *   3. If you'd rather NOT commit it at all (recommended), use
 *      Render's "Secret Files" feature instead: Render dashboard ->
 *      your service -> Environment -> Secret Files -> add a file at
 *      path "config.js" and paste this file's contents (with your
 *      real values) directly into Render's UI. Render writes it onto
 *      the running container's filesystem at deploy time, without it
 *      ever touching your git history.
 *
 * Whichever route you take, this one file is now the single place
 * that holds every credential this backend needs.
 * =====================================================================
 */

module.exports = {
  server: {
    // Render assigns your service a port dynamically and injects it as
    // process.env.PORT — this is the one value that genuinely can't be
    // hardcoded, since it changes per-deploy. Everything else below is
    // a real, permanent value you plug in yourself.
    port: process.env.PORT || 8080,
    nodeEnv: 'production',

    // Your backend's own public URL (the Render URL, e.g.
    // 'https://story-stack-102d.onrender.com' — no trailing slash).
    // Used to build Stripe Connect's refresh_url/return_url, which have
    // to be full URLs pointing back at THIS server (not the frontend)
    // so it can process the onboarding result before redirecting onward.
    backendUrl: 'https://your-backend-service.onrender.com',

    // A shared secret only you and your external scheduler know — required
    // in an x-cron-secret header to call POST /api/cron/process-preorders.
    // Generate any long random string for this (e.g. run
    // `openssl rand -hex 32` locally) — it's not tied to any external
    // service, just a password only your scheduler should know.
    cronSecret: 'CHANGE_ME_TO_A_LONG_RANDOM_STRING',

    // Comma-free array is easier to edit here than a comma-joined string.
    // Add every Google Sites / embedding origin allowed to call this API.
    //
    // Two forms are supported:
    //   - an exact origin: 'https://sites.google.com'
    //   - a domain-suffix wildcard, starting with a dot, matching any
    //     subdomain: '.googleusercontent.com' — useful because Google
    //     Sites' "Embed code" feature serves your embedded HTML from a
    //     sandboxed subdomain that varies per-site/per-embed rather than
    //     a fixed address, so listing the exact one isn't reliable.
    allowedOrigins: [
      'https://sites.google.com',
      'https://your-site.example.com',
      // '.googleusercontent.com', // uncomment if your embed's real
      //                           // origin (see Render logs) is a
      //                           // googleusercontent.com subdomain
    ],
  },

  // From Firebase Console -> Project Settings -> Service Accounts ->
  // "Generate new private key". That download is a JSON file — copy
  // project_id, client_email, and private_key from it into the three
  // fields below.
  firebase: {
    projectId: 'story-stack-474be',
    clientEmail: 'firebase-adminsdk-xxxxx@YOUR_PROJECT_ID.iam.gserviceaccount.com',
    // Paste the key with REAL line breaks, exactly as shown here — a
    // template literal (backticks) supports actual newlines, so unlike
    // an environment variable, there's no \n-escaping to worry about.
    privateKey: `-----BEGIN PRIVATE KEY-----
PASTE_YOUR_MULTILINE_PRIVATE_KEY_HERE
-----END PRIVATE KEY-----
`,
  },

  aws: {
    region: 'us-east-1',
    accessKeyId: 'YOUR_AWS_ACCESS_KEY_ID',
    secretAccessKey: 'YOUR_AWS_SECRET_ACCESS_KEY',
    bucketName: 'bookstore-private-assets',
  },

  stripe: {
    secretKey: 'sk_live_xxx',
    // From Stripe Dashboard -> Developers -> Webhooks -> your endpoint -> "Signing secret".
    webhookSecret: 'whsec_xxx',
    platformCommissionPercent: 20,
    checkoutSuccessUrl: 'https://your-site.example.com/success',
    checkoutCancelUrl: 'https://your-site.example.com/cancel',
  },

  lulu: {
    apiBaseUrl: 'https://api.lulu.com',
    clientKey: 'YOUR_LULU_CLIENT_KEY',
    clientSecret: 'YOUR_LULU_CLIENT_SECRET',
    // Required by Lulu on every print job — this is YOUR contact email
    // for questions about the print job itself (a developer or business
    // owner's inbox), not the buyer's email. Lulu will reach out here if
    // something needs attention with an order.
    contactEmail: 'YOUR_EMAIL@example.com',
  },
};
