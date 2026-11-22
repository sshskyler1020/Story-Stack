const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const webhookRoutes = require('./webhookRoutes');
const authorRoutes = require('./authorRoutes');
const checkoutRoutes = require('./checkoutRoutes');
const readerRoutes = require('./readerRoutes');
const catalogRoutes = require('./catalogRoutes');
const ordersRoutes = require('./ordersRoutes');
const purchasesRoutes = require('./purchasesRoutes');
const cronRoutes = require('./cronRoutes');
const { notFoundHandler, errorHandler } = require('./errorHandler');
const config = require('./config');

const app = express();
const PORT = config.server.port; // config.js already falls back to process.env.PORT for Render

const allowedOrigins = config.server.allowedOrigins || [];

// Google Sites serves embedded "Embed code" HTML inside an iframe hosted
// on a Google-controlled sandbox domain — NOT your site's own URL
// (sites.google.com/view/... is the page URL, but the iframe content
// itself runs from a different origin, often a googleusercontent.com
// subdomain that can vary and isn't practical to hardcode exactly).
// So allowedOrigins entries can be either:
//   - an exact origin, e.g. 'https://sites.google.com'
//   - a domain suffix starting with '.', e.g. '.googleusercontent.com',
//     matching any origin ending in that suffix (any subdomain)
function isOriginAllowed(origin) {
  if (!origin) return true; // non-browser tools (no Origin header)
  return allowedOrigins.some((entry) =>
    entry.startsWith('.') ? origin.endsWith(entry) : origin === entry
  );
}

// --- Security headers ---
// Default helmet posture (nosniff, hidePoweredBy, HSTS, etc). Frame-ancestors
// / X-Frame-Options are then overridden per-route: the reader route needs to
// ALLOW framing from our own Google Sites origin, while everything else can
// stay locked down to same-origin/deny by default.
app.use(
  helmet({
    frameguard: { action: 'deny' }, // default: nothing may iframe the API; readerController overrides this itself
    contentSecurityPolicy: false, // set per-route where needed (see readerController.js)
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow S3-fetched blobs / CDN scripts in the reader
  })
);

// --- CORS ---
// Only the Google Sites host(s) embedding our iframes may call this API
// with credentials/tokens attached.
app.use(
  cors({
    origin: (origin, callback) => {
      const isAllowed = isOriginAllowed(origin);

      // TEMPORARY DIAGNOSTIC — remove once CORS is confirmed working.
      // The origin is embedded directly in the thrown error's message so
      // it shows up in Render's log stack trace itself (Logs tab, readable
      // from a phone browser) without needing a separate console.log line
      // to line up with the right request.
      console.log(`[CORS] incoming origin="${origin || '(none)'}" allowed=${isAllowed} configuredAllowedOrigins=${JSON.stringify(allowedOrigins)}`);

      if (isAllowed) {
        return callback(null, true);
      }
      return callback(new Error(`Not allowed by CORS: request origin was "${origin}" — add it to config.js's server.allowedOrigins`));
    },
    credentials: true,
  })
);

// --- Stripe webhook route MUST be mounted before express.json() so it can
// consume the raw body for signature verification (see webhookRoutes.js). ---
app.use('/api/webhooks', webhookRoutes);

// --- Standard JSON body parsing for every other route ---
app.use(express.json());

// --- Feature routes ---
app.use('/api/author', authorRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/reader', readerRoutes);
app.use('/api/books', catalogRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/purchases', purchasesRoutes);
app.use('/api/cron', cronRoutes);

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

// --- Fallback handlers (must be registered last) ---
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Book marketplace backend listening on port ${PORT}`);
});

// --- Crash resilience ---
// Render already restarts a web service automatically whenever its
// process exits (crash-restart) or whenever the healthCheckPath above
// stops responding (unhealthy-instance restart) — both work with zero
// extra config here. What this adds: a Node process can end up in a
// broken-but-still-running state after an uncaught error deep in async
// code (e.g. a promise rejection nobody awaited), which doesn't
// necessarily crash the process on its own. Rather than let the server
// limp along half-working, log clearly and exit deliberately — that
// makes Render's restart-on-crash actually kick in instead of the
// process silently staying up in a bad state.
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception — exiting for a clean restart:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled promise rejection — exiting for a clean restart:', reason);
  process.exit(1);
});

// Render sends SIGTERM before restarting/redeploying an instance — close
// the server cleanly (finish in-flight requests, then exit).
process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM received, exiting.');
  process.exit(0);
});
