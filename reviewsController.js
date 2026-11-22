/**
 * GET  /api/books/:bookId/reviews — public, anyone can read reviews.
 * POST /api/books/:bookId/reviews — requires auth AND a paid purchase of
 *                                    this exact book ("verified buyers
 *                                    only", per the original spec).
 *
 * This was previously entirely missing — the frontend always faked a
 * successful submission client-side regardless of what (nonexistent)
 * endpoint it tried to hit, so reviews never actually persisted past a
 * page refresh and weren't gated by purchase at all.
 */
const store = require('./store');

async function listReviews(req, res, next) {
  try {
    const { bookId } = req.params;

    const rows = await store.listReviews(bookId);

    return res.status(200).json(
      rows.map((row) => ({
        name: row.display_name || 'Story Stack reader',
        stars: row.stars,
        text: row.body,
      }))
    );
  } catch (err) {
    next(err);
  }
}

async function submitReview(req, res, next) {
  try {
    const { uid } = req.firebaseUser;
    const { bookId } = req.params;
    const { stars, text } = req.body;

    const starsNum = parseInt(stars, 10);
    if (!Number.isInteger(starsNum) || starsNum < 1 || starsNum > 5) {
      return res.status(400).json({ error: 'stars must be a whole number from 1 to 5.' });
    }
    const body = (text || '').trim();
    if (!body) {
      return res.status(400).json({ error: 'Review text is required.' });
    }

    // "Verified buyers only" — must have at least one paid purchase (any
    // type) of this exact book.
    const purchases = await store.listPaidPurchasesByUser(uid);
    if (!purchases.some((p) => p.book_id === bookId)) {
      return res.status(403).json({ error: 'Only verified buyers can review this book.' });
    }

    const { name, email } = req.firebaseUser;
    const displayName = name || (email ? email.split('@')[0] : null);

    // One review per buyer per book — resubmitting replaces it, and the
    // book's running rating average is adjusted in the same transaction.
    await store.upsertReview({ bookId, uid, displayName, stars: starsNum, body });

    return res.status(201).json({ stars: starsNum, text: body });
  } catch (err) {
    next(err);
  }
}

module.exports = { listReviews, submitReview };
