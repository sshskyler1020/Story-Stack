/**
 * Data layer — Cloud Firestore (replaces PostgreSQL).
 *
 * Firestore is free on Firebase's Spark plan (1 GiB storage, 50k reads /
 * 20k writes per day) and uses the same Firebase project and service
 * account the backend already authenticates with — no extra database to
 * provision, no connection string, nothing to add to config.js.
 *
 * Every function here returns plain objects with the same snake_case
 * field names the old SQL rows had, so controllers read exactly what
 * they used to.
 *
 * Collections and document ids:
 *   authors/{firebaseUid}               one profile per user (id == firebase uid)
 *   books/{autoId}                      author_id is the author's firebase uid
 *   purchases/{stripeCheckoutSessionId} doc id == session id, which makes the
 *                                       webhook idempotent via create()
 *   reviews/{bookId}_{uid}              one review per buyer per book
 *   reading_progress/{uid}_{bookId}_{variant}
 *
 * Users are identified everywhere by their Firebase UID, so there is no
 * separate "users" collection to keep in sync (the old one was only ever
 * filled for authors, which silently broke webhook purchases made by
 * regular buyers).
 *
 * Queries are deliberately simple equality filters with sorting done in
 * memory — that avoids Firestore's composite-index requirement entirely,
 * so nothing needs to be created in the Firebase console.
 */
const crypto = require('crypto');
const admin = require('./firebase');

const fs = admin.firestore();
try {
  fs.settings({ ignoreUndefinedProperties: true });
} catch (e) {
  // settings() can only be called once, before first use — safe to ignore.
}

const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const byCreatedDesc = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));

async function queryEq(collection, field, value) {
  const snap = await fs.collection(collection).where(field, '==', value).get();
  return snap.docs.map((d) => ({ ...d.data(), _docId: d.id }));
}

/* ------------------------------ authors ------------------------------ */

async function getAuthor(uid) {
  const snap = await fs.collection('authors').doc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function createAuthor(uid, { display_name, bio, email }) {
  const data = {
    id: uid,
    user_id: uid,
    display_name,
    bio: bio || null,
    email: email || null,
    stripe_account_id: null,
    stripe_onboarding_complete: false,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  await fs.collection('authors').doc(uid).create(data);
  return data;
}

async function updateAuthor(uid, patch) {
  await fs.collection('authors').doc(uid).update({ ...patch, updated_at: nowIso() });
}

async function updateAuthorsByStripeAccount(stripeAccountId, patch) {
  const snap = await fs.collection('authors').where('stripe_account_id', '==', stripeAccountId).get();
  await Promise.all(snap.docs.map((d) => d.ref.update({ ...patch, updated_at: nowIso() })));
  return snap.size;
}

/** Returns { [authorId]: authorData } for a list of author ids. */
async function getAuthorsByIds(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return {};
  const refs = unique.map((id) => fs.collection('authors').doc(id));
  const snaps = await fs.getAll(...refs);
  const out = {};
  snaps.forEach((s) => {
    if (s.exists) out[s.id] = s.data();
  });
  return out;
}

/* ------------------------------- books ------------------------------- */

async function createBook(data) {
  const id = newId();
  const doc = {
    ...data,
    id,
    rating_sum: 0,
    rating_count: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  await fs.collection('books').doc(id).set(doc);
  return doc;
}

async function getBook(id) {
  if (!id || typeof id !== 'string' || id.includes('/')) return null;
  const snap = await fs.collection('books').doc(id).get();
  return snap.exists ? snap.data() : null;
}

async function listBooksByStatus(status) {
  const rows = await queryEq('books', 'status', status);
  return rows.sort(byCreatedDesc);
}

async function listBooksByAuthor(authorId) {
  const rows = await queryEq('books', 'author_id', authorId);
  return rows.sort(byCreatedDesc);
}

async function updateBook(id, patch) {
  await fs.collection('books').doc(id).update({ ...patch, updated_at: nowIso() });
  return getBook(id);
}

/* ----------------------------- purchases ----------------------------- */

/**
 * Idempotent insert keyed on the Stripe checkout session id. Returns the
 * new purchase, or null if that session was already recorded (Stripe
 * retried the webhook).
 */
async function createPurchaseOnce(sessionId, data) {
  const doc = { ...data, id: newId(), stripe_checkout_session_id: sessionId, created_at: nowIso(), updated_at: nowIso() };
  try {
    await fs.collection('purchases').doc(sessionId).create(doc);
    return doc;
  } catch (err) {
    if (err.code === 6 || /ALREADY_EXISTS/i.test(err.message || '')) return null;
    throw err;
  }
}

/** Purchases are addressed by their stripe_checkout_session_id (the doc id). */
async function updatePurchase(sessionId, patch) {
  await fs.collection('purchases').doc(sessionId).update({ ...patch, updated_at: nowIso() });
}

async function listPaidPurchasesByUser(uid) {
  const rows = await queryEq('purchases', 'user_id', uid);
  return rows.filter((p) => p.status === 'paid').sort(byCreatedDesc);
}

async function listPaidPurchasesByAuthor(authorId) {
  const rows = await queryEq('purchases', 'author_id', authorId);
  return rows.filter((p) => p.status === 'paid');
}

async function findPaidPurchase(uid, bookId, purchaseType) {
  const rows = await listPaidPurchasesByUser(uid);
  return rows.find((p) => p.book_id === bookId && (!purchaseType || p.purchase_type === purchaseType)) || null;
}

async function listQueuedPreorderPurchases() {
  const rows = await queryEq('purchases', 'pod_status', 'queued_for_release');
  return rows.filter((p) => p.purchase_type === 'print');
}

/* ------------------------------ reviews ------------------------------ */

async function listReviews(bookId) {
  const rows = await queryEq('reviews', 'book_id', bookId);
  return rows.sort(byCreatedDesc);
}

/**
 * One review per buyer per book. Resubmitting replaces it, and the book's
 * running rating_sum / rating_count are adjusted in the same transaction
 * so the catalog can show an average without reading every review.
 */
async function upsertReview({ bookId, uid, displayName, stars, body }) {
  const reviewRef = fs.collection('reviews').doc(`${bookId}_${uid}`);
  const bookRef = fs.collection('books').doc(bookId);

  await fs.runTransaction(async (tx) => {
    const [reviewSnap, bookSnap] = await Promise.all([tx.get(reviewRef), tx.get(bookRef)]);
    if (!bookSnap.exists) throw new Error('Book not found.');

    const book = bookSnap.data();
    let sum = book.rating_sum || 0;
    let count = book.rating_count || 0;

    if (reviewSnap.exists) {
      sum += stars - reviewSnap.data().stars;
    } else {
      sum += stars;
      count += 1;
    }

    tx.set(reviewRef, {
      book_id: bookId,
      user_id: uid,
      display_name: displayName || null,
      stars,
      body,
      created_at: nowIso(),
    });
    tx.update(bookRef, { rating_sum: sum, rating_count: count });
  });
}

/* ------------------------- reading progress -------------------------- */

const progressRef = (uid, bookId, variant) => fs.collection('reading_progress').doc(`${uid}_${bookId}_${variant}`);

async function getProgress(uid, bookId, variant) {
  const snap = await progressRef(uid, bookId, variant).get();
  return snap.exists ? snap.data() : null;
}

async function saveProgress(uid, bookId, variant, location) {
  await progressRef(uid, bookId, variant).set({
    user_id: uid,
    book_id: bookId,
    variant,
    location,
    updated_at: nowIso(),
  });
}

module.exports = {
  fs,
  getAuthor, createAuthor, updateAuthor, updateAuthorsByStripeAccount, getAuthorsByIds,
  createBook, getBook, listBooksByStatus, listBooksByAuthor, updateBook,
  createPurchaseOnce, updatePurchase, listPaidPurchasesByUser, listPaidPurchasesByAuthor,
  findPaidPurchase, listQueuedPreorderPurchases,
  listReviews, upsertReview,
  getProgress, saveProgress,
};
