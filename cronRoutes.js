const express = require('express');
const { processDuePreorders } = require('./preorderController');

const router = express.Router();

// Protected by a shared secret header, not requireAuth — see
// preorderController.js for why (no Firebase user context for a
// scheduler-triggered call).
router.post('/process-preorders', processDuePreorders);

module.exports = router;
