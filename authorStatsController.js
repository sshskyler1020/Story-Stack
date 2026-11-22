/**
 * GET /api/author/stats
 * Sales analytics for the signed-in author's own books — powers the
 * Author Hub dashboard, which previously always showed hardcoded demo
 * numbers since this endpoint didn't exist.
 *
 * Note on "outstanding royalties": we don't run a separate payout
 * reconciliation system — money for a Destination Charge sale lands
 * directly in the author's own connected Stripe account, and Stripe pays
 * it out to their bank on Stripe's own schedule, invisible to our DB.
 * So "lifetime" and "outstanding" are the same figure here (everything
 * this ledger has ever recorded) rather than a genuine paid-out vs
 * pending split — that would require querying the Payouts API on the
 * author's connected account, which isn't built. Documented here rather
 * than silently pretending the split is real.
 */
const store = require('./store');

async function getAuthorStats(req, res, next) {
  try {
    const { uid } = req.firebaseUser;

    const purchases = await store.listPaidPurchasesByAuthor(uid);

    let lifetimeEarningsCents = 0;
    let printCopiesSold = 0;
    let digitalCopiesSold = 0;
    for (const p of purchases) {
      lifetimeEarningsCents += (p.amount_cents || 0) - (p.platform_fee_cents || 0) + (p.tip_cents || 0);
      if (p.purchase_type === 'print') printCopiesSold += 1;
      if (p.purchase_type === 'digital') digitalCopiesSold += 1;
    }

    return res.status(200).json({
      lifetimeEarningsCents,
      outstandingRoyaltiesCents: lifetimeEarningsCents, // see note above
      printCopiesSold,
      digitalCopiesSold,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAuthorStats };
