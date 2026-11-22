/**
 * Stripe client. apiVersion pinned intentionally so Stripe dashboard
 * upgrades never silently change webhook payload shape under us.
 */
const Stripe = require('stripe');
const config = require('./config');

const stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: '2024-06-20',
});

module.exports = stripe;
