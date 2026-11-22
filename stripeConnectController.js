/**
 * Stripe Connect onboarding for authors.
 *
 * Authors need a Stripe Express connected account before checkoutController
 * will let anyone buy their books — that's what powers the Destination
 * Charges split (their ~80%, platform's ~20% commission). This was
 * previously entirely missing: authors could register and publish books,
 * but had no way to actually link a payout account, so every checkout
 * attempt hit checkoutController's "payout account not ready" 409.
 *
 * Flow:
 *   1. POST /api/author/stripe/connect (frontend, authenticated) — creates
 *      a Stripe Express account for the author if they don't have one yet,
 *      then returns a one-time Account Link URL for them to complete
 *      onboarding on Stripe's own hosted UI.
 *   2. GET /api/author/stripe/refresh — hit directly by Stripe if that
 *      link expired before they finished (Account Links are short-lived).
 *      Generates a fresh one and redirects there.
 *   3. GET /api/author/stripe/return — hit directly by Stripe once the
 *      author finishes (or abandons) onboarding. Checks the account's
 *      actual status with Stripe and updates authors.stripe_onboarding_complete
 *      accordingly, then redirects the browser back to the Story Stack
 *      frontend.
 *
 * Steps 2 and 3 are plain browser redirects from Stripe, not fetch calls
 * from the SPA — there's no Authorization header available in that
 * context, which is why the Stripe account id (not sensitive — it's not
 * a credential, just an identifier) travels in the query string instead.
 */
const stripe = require('./stripe');
const store = require('./store');
const config = require('./config');

async function startOnboarding(req, res, next) {
  try {
    const { uid, email } = req.firebaseUser;

    const author = await store.getAuthor(uid);

    if (!author) {
      return res.status(403).json({ error: 'No author profile found for this account.' });
    }

    let stripeAccountId = author.stripe_account_id;
    const alreadyComplete = author.stripe_onboarding_complete;

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: email || undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
      stripeAccountId = account.id;
      await store.updateAuthor(uid, { stripe_account_id: stripeAccountId });
    }

    // Already fully verified — an account_onboarding link would have
    // nothing left to collect and would just bounce straight back with
    // no visible form (which is exactly the confusing behavior this
    // branch exists to avoid). Send them to their real Stripe Express
    // dashboard instead, where they can see balances, payouts, and
    // update their own details directly with Stripe.
    if (alreadyComplete) {
      const loginLink = await stripe.accounts.createLoginLink(stripeAccountId);
      return res.status(200).json({ onboardingUrl: loginLink.url, alreadyConnected: true });
    }

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${config.server.backendUrl}/api/author/stripe/refresh?account=${stripeAccountId}`,
      return_url: `${config.server.backendUrl}/api/author/stripe/return?account=${stripeAccountId}`,
      type: 'account_onboarding',
    });

    return res.status(200).json({ onboardingUrl: accountLink.url, alreadyConnected: false });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/author/stripe/status
 * Lets the frontend show the right button label/state proactively,
 * instead of the author having to click "Connect" just to find out
 * they're already connected.
 */
async function getConnectionStatus(req, res, next) {
  try {
    const { uid } = req.firebaseUser;
    const author = await store.getAuthor(uid);

    if (!author) {
      return res.status(403).json({ error: 'No author profile found for this account.' });
    }

    return res.status(200).json({
      hasAccount: !!author.stripe_account_id,
      connected: !!author.stripe_onboarding_complete,
    });
  } catch (err) {
    next(err);
  }
}


async function refreshOnboarding(req, res, next) {
  try {
    const stripeAccountId = req.query.account;
    if (!stripeAccountId) return res.status(400).send('Missing account parameter.');

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${config.server.backendUrl}/api/author/stripe/refresh?account=${stripeAccountId}`,
      return_url: `${config.server.backendUrl}/api/author/stripe/return?account=${stripeAccountId}`,
      type: 'account_onboarding',
    });

    return res.redirect(302, accountLink.url);
  } catch (err) {
    next(err);
  }
}

async function handleOnboardingReturn(req, res, next) {
  try {
    const stripeAccountId = req.query.account;
    const frontendBase = config.stripe.checkoutSuccessUrl;

    if (!stripeAccountId) {
      return res.redirect(302, frontendBase);
    }

    const account = await stripe.accounts.retrieve(stripeAccountId);
    const isComplete = !!(account.details_submitted && account.charges_enabled);

    await store.updateAuthorsByStripeAccount(stripeAccountId, { stripe_onboarding_complete: isComplete });

    const separator = frontendBase.includes('?') ? '&' : '?';
    return res.redirect(302, `${frontendBase}${separator}stripe_onboarding=${isComplete ? 'complete' : 'pending'}`);
  } catch (err) {
    next(err);
  }
}

module.exports = { startOnboarding, refreshOnboarding, handleOnboardingReturn, getConnectionStatus };
