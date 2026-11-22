/**
 * POST /api/checkout/create-session
 *
 * Creates a Stripe Checkout Session using Destination Charges:
 *   - Payment is collected on the PLATFORM's Stripe account.
 *   - `payment_intent_data.application_fee_amount` skims the platform
 *     commission (default 20%) off the top.
 *   - `payment_intent_data.transfer_data.destination` routes the remaining
 *     ~80% directly to the author's connected Stripe account.
 *
 * Firebase UID + purchase type are embedded in `metadata` so the webhook
 * handler can attribute the resulting payment_intent.succeeded event back
 * to the right user/book without another auth round trip.
 */
const stripe = require('./stripe');
const store = require('./store');
const config = require('./config');

const PLATFORM_COMMISSION_PERCENT = Number(config.stripe.platformCommissionPercent || 20);

async function createCheckoutSession(req, res, next) {
  try {
    const { uid } = req.firebaseUser;
    const { bookId, purchaseType } = req.body;

    if (!bookId || !['print', 'digital', 'audiobook'].includes(purchaseType)) {
      return res.status(400).json({ error: "bookId and purchaseType ('print' | 'digital' | 'audiobook') are required." });
    }

    const book = await store.getBook(bookId);
    if (!book || book.status !== 'published') {
      return res.status(404).json({ error: 'Book not found or not published.' });
    }
    const author = (await store.getAuthor(book.author_id)) || {};
    book.stripe_account_id = author.stripe_account_id;
    book.stripe_onboarding_complete = author.stripe_onboarding_complete;

    if (purchaseType === 'digital' && !book.is_digital_available) {
      return res.status(400).json({ error: 'This book has no digital variant available.' });
    }
    if (purchaseType === 'print' && !book.is_print_available) {
      return res.status(400).json({ error: 'This book has no print variant available.' });
    }
    if (purchaseType === 'audiobook' && !book.is_audiobook_available) {
      return res.status(400).json({ error: 'This book has no audiobook variant available.' });
    }
    if (!book.stripe_account_id || !book.stripe_onboarding_complete) {
      return res.status(409).json({ error: "This author's payout account is not yet ready to accept sales." });
    }

    // Ebook, print, and audiobook each have independent prices — use
    // whichever one matches what's actually being purchased.
    const priceCentsByType = {
      digital: book.ebook_price_cents,
      print: book.print_price_cents,
      audiobook: book.audiobook_price_cents,
    };
    const priceCents = priceCentsByType[purchaseType];
    if (!priceCents) {
      return res.status(400).json({ error: `This book has no ${purchaseType} price set.` });
    }

    const applicationFeeAmount = Math.round(priceCents * (PLATFORM_COMMISSION_PERCENT / 100));

    const successSeparator = config.stripe.checkoutSuccessUrl.includes('?') ? '&' : '?';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: book.currency,
            product_data: { name: book.title },
            unit_amount: priceCents,
          },
          quantity: 1,
        },
      ],
      // Collect a shipping address only when it's actually needed for POD fulfillment.
      shipping_address_collection:
        purchaseType === 'print' ? { allowed_countries: ['US', 'CA', 'GB', 'AU', 'DE', 'FR'] } : undefined,
      // Lulu requires a phone number on every print job's shipping
      // address (their shipping carriers need it for delivery issues).
      // Stripe's shipping_address_collection does NOT include a phone
      // field on its own — this is a separate opt-in, and the value ends
      // up at session.customer_details.phone (not inside shipping
      // details) once checkout completes. See webhookController.js.
      phone_number_collection: purchaseType === 'print' ? { enabled: true } : undefined,

      payment_intent_data: {
        application_fee_amount: applicationFeeAmount, // platform's cut
        transfer_data: {
          destination: book.stripe_account_id, // remaining ~80% -> author's connected account
        },
        metadata: {
          firebaseUid: uid,
          bookId: book.id,
          purchaseType,
        },
      },

      // Also mirrored at the session level for convenience/reporting.
      metadata: {
        firebaseUid: uid,
        bookId: book.id,
        purchaseType,
      },

      success_url: `${config.stripe.checkoutSuccessUrl}${successSeparator}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: config.stripe.checkoutCancelUrl,
    });

    return res.status(200).json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    next(err);
  }
}

module.exports = { createCheckoutSession };
