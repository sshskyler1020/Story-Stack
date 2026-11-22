const express = require('express');
const { listBooks, getBookCover } = require('./catalogController');
const { listReviews, submitReview } = require('./reviewsController');
const { requireAuth } = require('./authMiddleware');

const router = express.Router();

// Public — no requireAuth. Anyone browsing the storefront needs to see
// the catalog before they've signed in.
router.get('/', listBooks);
router.get('/:bookId/cover', getBookCover);
router.get('/:bookId/reviews', listReviews);
router.post('/:bookId/reviews', requireAuth, submitReview);

module.exports = router;
