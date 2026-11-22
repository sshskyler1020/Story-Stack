const express = require('express');
const { requireAuth } = require('./authMiddleware');
const { listOwnedDigitalBookIds, listOwnedAudiobookIds } = require('./purchasesController');

const router = express.Router();

router.get('/digital', requireAuth, listOwnedDigitalBookIds);
router.get('/audiobook', requireAuth, listOwnedAudiobookIds);

module.exports = router;
