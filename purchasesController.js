/**
 * Buyer-facing purchase data — distinct from authorBooksController.js
 * (which is author-facing, "books I publish") and catalogController.js
 * (public storefront). This is "purchases I, the signed-in buyer, made."
 *
 * Both endpoints here were previously missing entirely, even though the
 * frontend has always called them. The practical impact was severe for
 * /purchases/digital specifically: with no real endpoint to hit, the
 * frontend silently fell back to hardcoded demo data whose book ids
 * don't match anything real, meaning a real buyer who genuinely
 * purchased a digital book could never see "Read Now" or open the
 * reader from the UI — the client-side ownership gate would always say
 * they didn't own it, even though the purchases ledger said otherwise.
 */
const store = require('./store');

/**
 * GET /api/orders
 * Every purchase (digital + print) made by the signed-in user.
 */
async function listMyOrders(req, res, next) {
  try {
    const { uid } = req.firebaseUser;

    const purchases = await store.listPaidPurchasesByUser(uid);
    const books = await Promise.all([...new Set(purchases.map((p) => p.book_id))].map((id) => store.getBook(id)));
    const titles = {};
    books.forEach((b) => { if (b) titles[b.id] = b.title; });

    const orders = purchases.filter((p) => titles[p.book_id]).map((row) => ({
      id: row.id,
      bookId: row.book_id,
      bookTitle: titles[row.book_id],
      type: row.purchase_type,
      // Digital access is immediate once paid — there's no further
      // fulfillment step, so it's always "delivered" once it's in the
      // ledger at all. Print status is a simplified read of Lulu's
      // pod_status text (we don't yet ingest real carrier/tracking data
      // from Lulu — that would need their shipping-webhook integration,
      // which isn't built — so no carrier/tracking fields are returned;
      // the frontend already handles their absence gracefully).
      status: deriveOrderStatus(row.purchase_type, row.pod_status),
      date: row.created_at,
    }));

    return res.status(200).json(orders);
  } catch (err) {
    next(err);
  }
}

function deriveOrderStatus(purchaseType, podStatus) {
  if (purchaseType === 'digital' || purchaseType === 'audiobook') return 'delivered';
  const normalized = (podStatus || '').toUpperCase();
  if (normalized.includes('DELIVER')) return 'delivered';
  if (normalized.includes('SHIP')) return 'shipped';
  return 'processing'; // covers null, 'queued_for_release', 'CREATED', 'submission_failed', etc.
}

/**
 * GET /api/purchases/digital
 * Just the book ids the signed-in user owns digitally — this is what
 * the frontend's state.ownedDigitalBookIds gets built from, gating the
 * "Read Now" vs "Buy" button and the reader page's client-side check.
 */
async function listOwnedDigitalBookIds(req, res, next) {
  try {
    const { uid } = req.firebaseUser;

    const purchases = await store.listPaidPurchasesByUser(uid);
    const bookIds = [...new Set(purchases.filter((p) => p.purchase_type === 'digital').map((p) => p.book_id))];

    return res.status(200).json({ bookIds });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/purchases/audiobook
 * Same idea as /purchases/digital, for audiobooks — gates "Listen Now"
 * vs "Buy" independently, since a reader might own one format but not
 * the other for the same book.
 */
async function listOwnedAudiobookIds(req, res, next) {
  try {
    const { uid } = req.firebaseUser;

    const purchases = await store.listPaidPurchasesByUser(uid);
    const bookIds = [...new Set(purchases.filter((p) => p.purchase_type === 'audiobook').map((p) => p.book_id))];

    return res.status(200).json({ bookIds });
  } catch (err) {
    next(err);
  }
}

module.exports = { listMyOrders, listOwnedDigitalBookIds, listOwnedAudiobookIds };
