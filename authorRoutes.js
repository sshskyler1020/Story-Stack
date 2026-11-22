const express = require('express');
const { requireAuth, requireAuthorClaim } = require('./authMiddleware');
const { publishUploadFields } = require('./s3UploadMiddleware');
const { registerAuthor, whoAmI } = require('./authorController');
const { publishBook } = require('./publishController');
const { startOnboarding, refreshOnboarding, handleOnboardingReturn, getConnectionStatus } = require('./stripeConnectController');
const { listMyBooks, updateMyBook, replaceBookFiles } = require('./authorBooksController');
const { getAuthorStats } = require('./authorStatsController');
const { getPrintCostEstimate } = require('./printCostController');

const router = express.Router();

// Any authenticated user can register as an author.
router.post('/register', requireAuth, registerAuthor);

// Publishing requires the isAuthor custom claim (set during /register).
router.post('/publish', requireAuth, requireAuthorClaim, publishUploadFields, publishBook);

// An author's own book list + edits — see authorBooksController.js.
router.get('/books', requireAuth, requireAuthorClaim, listMyBooks);
router.patch('/books/:bookId', requireAuth, requireAuthorClaim, updateMyBook);

// Republish flow — swap out actual files on an existing book. Reuses the
// same multer-s3 middleware as /publish since every field is already
// optional at the multer level.
router.patch('/books/:bookId/files', requireAuth, requireAuthorClaim, publishUploadFields, replaceBookFiles);

// TEMPORARY DEBUG ROUTE — see whoAmI's comment in authorController.js.
router.get('/whoami', requireAuth, whoAmI);

// Sales analytics for the Author Hub dashboard.
router.get('/stats', requireAuth, requireAuthorClaim, getAuthorStats);

// Print cost estimate — see printCostController.js.
router.post('/print-cost-estimate', requireAuth, requireAuthorClaim, getPrintCostEstimate);

// Stripe Connect onboarding — see stripeConnectController.js for the full
// flow. /connect is called from the SPA (authenticated); /refresh and
// /return are hit directly by Stripe as plain browser redirects, so they
// can't carry an Authorization header and aren't gated by requireAuth.
router.post('/stripe/connect', requireAuth, requireAuthorClaim, startOnboarding);
router.get('/stripe/refresh', refreshOnboarding);
router.get('/stripe/return', handleOnboardingReturn);
router.get('/stripe/status', requireAuth, requireAuthorClaim, getConnectionStatus);

module.exports = router;
