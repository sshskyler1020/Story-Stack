const express = require('express');
const { requireAuth } = require('./authMiddleware');
const { renderReader } = require('./readerController');
const { getProgress, saveProgress } = require('./readingProgressController');

const router = express.Router();

// GET so it can be dropped straight into an <iframe src="..."> from Google
// Sites; requireAuth accepts the token via ?token= for this reason (see
// middleware/authMiddleware.js).
router.get('/:bookId', requireAuth, renderReader);

// Auto-save / bookmark — see readingProgressController.js.
router.get('/:bookId/progress', requireAuth, getProgress);
router.put('/:bookId/progress', requireAuth, saveProgress);

module.exports = router;
