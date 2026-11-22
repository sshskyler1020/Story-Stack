const express = require('express');
const { requireAuth } = require('./authMiddleware');
const { createCheckoutSession } = require('./checkoutController');

const router = express.Router();

router.post('/create-session', requireAuth, createCheckoutSession);

module.exports = router;
