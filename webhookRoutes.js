/**
 * Stripe webhooks require the RAW request body for signature verification,
 * so express.raw() is applied on this specific route rather than the
 * app-wide express.json() parser. This router must be mounted in server.js
 * BEFORE the global JSON body parser to guarantee the raw buffer survives.
 */
const express = require('express');
const { handleStripeWebhook } = require('./webhookController');

const router = express.Router();

router.post('/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

module.exports = router;
