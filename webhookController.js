/**
 * POST /api/webhooks/stripe
 *
 * IMPORTANT: this route must receive the RAW request body (not JSON-parsed)
 * for Stripe's signature verification to work — see the express.raw()
 * wiring in webhookRoutes.js / server.js.
 *
 * On checkout.session.completed:
 *   - Writes a doc to the `purchases` Firestore collection (source of truth for access/fulfillment).
 *   - digital  -> ledger row alone is sufficient; reader route checks it for access.
 *   - print    -> pulls shipping address from the session, then forwards the
 *                 order to Lulu via podService.submitPrintJob.
 *
 * Handlers are idempotent: the purchase doc id IS the Stripe checkout
 * session id and is written with create(), so Stripe's automatic webhook retries can't double-write the ledger.
 */
const stripe = require('./stripe');
const store = require('./store');
const { submitPrintJob } = require('./podService');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, BUCKET_NAME } = require('./s3');
const config = require('./config');

async function handleStripeWebhook(req, res) {
  let event;

  try {
    const signature = req.headers['stripe-signature'];
    // req.body is the raw Buffer here (see express.raw() in the route wiring).
    event = stripe.webhooks.constructEvent(req.body, signature, config.stripe.webhookSecret);
  } catch (err) {
    console.error('[stripe webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      default:
        // Unhandled event types are fine to ignore.
        break;
    }
    // Always 200 quickly once we've processed (or intentionally ignored) the event.
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[stripe webhook] Handler error:', err);
    // Non-2xx tells Stripe to retry the webhook later.
    return res.status(500).json({ error: 'Webhook handler failed.' });
  }
}

async function handleCheckoutCompleted(session) {
  const { firebaseUid, bookId, purchaseType } = session.metadata || {};

  if (!firebaseUid || !bookId || !purchaseType) {
    console.error('[stripe webhook] Missing metadata on session', session.id);
    return;
  }

  const book = await store.getBook(bookId);
  if (!book) {
    console.error('[stripe webhook] No book found for id', bookId);
    return;
  }

  const amountTotal = session.amount_total; // in cents
  const applicationFee = Math.round(amountTotal * (Number(config.stripe.platformCommissionPercent || 20) / 100));

  // Shipping details are only present on 'print' sessions (we requested
  // shipping_address_collection at checkout-creation time for those).
  //
  // Stripe moved this field: as of the Acacia (2025-02-24) and Basil
  // (2025-03-31) API versions, session.shipping_details was relocated to
  // session.collected_information.shipping_details — the old top-level
  // field is null/gone on any webhook endpoint using a current API
  // version. Check the new location first, falling back to the legacy
  // one only for a webhook endpoint still pinned to an older version.
  // (See https://docs.stripe.com/changelog/basil/2025-03-31/checkout-session-remove-shipping-details)
  const rawShippingDetails = session.collected_information?.shipping_details || session.shipping_details;

  const shippingAddress = rawShippingDetails
    ? {
        name: rawShippingDetails.name,
        line1: rawShippingDetails.address.line1,
        line2: rawShippingDetails.address.line2,
        city: rawShippingDetails.address.city,
        state: rawShippingDetails.address.state,
        postal_code: rawShippingDetails.address.postal_code,
        country: rawShippingDetails.address.country,
        // Phone isn't part of Stripe's shipping address object at all —
        // it's collected separately (see phone_number_collection in
        // checkoutController.js) and lands at customer_details.phone on
        // the completed session. Lulu requires it on the shipping
        // address though, so it's folded in here to travel together with
        // the rest of the address from this point on.
        phone_number: session.customer_details?.phone || null,
      }
    : null;

  // Idempotent insert — a retried webhook for the same session is a no-op.
  // Users are identified by Firebase UID everywhere — no separate users
  // table to look up (or to be missing a row for a regular buyer).
  const purchase = await store.createPurchaseOnce(session.id, {
    user_id: firebaseUid,
    author_id: book.author_id,
    book_id: bookId,
    purchase_type: purchaseType,
    stripe_payment_intent_id: session.payment_intent || null,
    amount_cents: amountTotal,
    platform_fee_cents: applicationFee,
    tip_cents: 0,
    currency: session.currency,
    status: 'paid',
    shipping_address: shippingAddress,
    pod_order_id: null,
    pod_status: null,
  });

  if (!purchase) {
    console.log('[stripe webhook] Duplicate event for session', session.id, '- already processed.');
    return;
  }

  const purchaseId = purchase.id;

  if (purchaseType === 'digital' || purchaseType === 'audiobook') {
    // Ledger row alone grants access — the reader route checks `purchases`
    // directly, so there's nothing further to do here. No physical
    // fulfillment involved for either format.
    console.log(`[stripe webhook] ${purchaseType} purchase ${purchaseId} recorded; access granted.`);
    return;
  }

  // purchaseType === 'print' -> forward the order to the POD network,
  // UNLESS this is a preorder that hasn't released yet (book.release_date
  // in the future). Submitting to Lulu immediately would start printing
  // and shipping before the book is actually supposed to be out — instead
  // the purchase is marked 'queued_for_release' and left for a scheduled
  // process to pick up once release day arrives (see the note below).
  if (book.release_date && new Date(book.release_date) > new Date()) {
    await store.updatePurchase(session.id, { pod_status: 'queued_for_release' });
    console.log(`[stripe webhook] Print preorder ${purchaseId} queued until release on ${book.release_date}.`);
    return;
  }

  // Guard against a missing shipping address before ever calling Lulu.
  // In normal operation this shouldn't happen — checkoutController.js
  // requests shipping_address_collection for every print purchase — but
  // it CAN happen if this webhook fires from something other than a real
  // completed checkout with real shipping info (e.g. Stripe's "Send test
  // webhook" button in the Dashboard sends a generic sample payload with
  // shipping_details: null, since it's synthetic data). Failing loudly
  // and clearly here beats a cryptic "Cannot read properties of null"
  // crash inside podService.js.
  if (!shippingAddress) {
    await store.updatePurchase(session.id, { pod_status: 'missing_shipping_address' });
    console.error(`[stripe webhook] Print purchase ${purchaseId} has no shipping address — skipping Lulu submission. If this was a real checkout (not a Stripe test webhook), this needs manual investigation.`);
    return;
  }

  try {
    const [interiorUrl, coverUrl] = await Promise.all([
      getSignedUrl(s3Client, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: book.print_interior_s3_key }), {
        expiresIn: 3600,
      }),
      getSignedUrl(s3Client, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: book.print_cover_s3_key }), {
        expiresIn: 3600,
      }),
    ]);

    const { luluOrderId, status } = await submitPrintJob({
      podPackageId: book.lulu_pod_package_id,
      bookTitle: book.title,
      interiorFileUrl: interiorUrl,
      coverFileUrl: coverUrl,
      shippingAddress,
      externalOrderId: purchaseId,
    });

    await store.updatePurchase(session.id, { pod_order_id: luluOrderId, pod_status: status });

    console.log(`[stripe webhook] Print purchase ${purchaseId} forwarded to Lulu as ${luluOrderId}.`);
  } catch (podErr) {
    // Payment already succeeded; a POD submission failure shouldn't be
    // silently lost — flag it for manual/ops follow-up rather than throwing
    // (which would trigger a Stripe retry re-processing an already-paid order).
    console.error(`[stripe webhook] Failed to submit print job for purchase ${purchaseId}:`, podErr);
    await store.updatePurchase(session.id, { pod_status: 'submission_failed' });
  }
}

module.exports = { handleStripeWebhook };
