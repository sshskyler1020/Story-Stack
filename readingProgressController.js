/**
 * GET /api/reader/:bookId/progress?variant=ebook|audiobook — returns the
 * signed-in user's saved position for that format of this book, if any.
 * PUT  /api/reader/:bookId/progress?variant=ebook|audiobook — saves it.
 *
 * A reader can own BOTH the ebook and audiobook edition of the same
 * book, each needing its own independent saved position — that's why
 * this is keyed by (user, book, variant) rather than just (user, book).
 *
 * Both require the matching ownership check as the reader itself —
 * there's no reason to let someone read or write a "position" for a
 * format of a book they haven't actually bought.
 */
const store = require('./store');

function variantFromQuery(req) {
  return req.query.variant === 'audiobook' ? 'audiobook' : 'ebook';
}

async function verifyOwnership(uid, bookId, variant) {
  const purchaseType = variant === 'audiobook' ? 'audiobook' : 'digital';
  return !!(await store.findPaidPurchase(uid, bookId, purchaseType));
}

async function getProgressHandler(req, res, next) {
  try {
    const { uid } = req.firebaseUser;
    const { bookId } = req.params;
    const variant = variantFromQuery(req);

    if (!(await verifyOwnership(uid, bookId, variant))) {
      return res.status(403).json({ error: `You do not own the ${variant} edition of this book.` });
    }

    const row = await store.getProgress(uid, bookId, variant);
    if (!row) {
      return res.status(200).json({ location: null });
    }

    return res.status(200).json({ location: row.location, updatedAt: row.updated_at });
  } catch (err) {
    next(err);
  }
}

async function saveProgressHandler(req, res, next) {
  try {
    const { uid } = req.firebaseUser;
    const { bookId } = req.params;
    const { location } = req.body;
    const variant = variantFromQuery(req);

    if (!location || typeof location !== 'string') {
      return res.status(400).json({ error: 'location (string) is required.' });
    }

    if (!(await verifyOwnership(uid, bookId, variant))) {
      return res.status(403).json({ error: `You do not own the ${variant} edition of this book.` });
    }

    await store.saveProgress(uid, bookId, variant, location);

    return res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { getProgress: getProgressHandler, saveProgress: saveProgressHandler };
