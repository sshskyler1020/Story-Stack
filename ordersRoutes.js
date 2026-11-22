const express = require('express');
const { requireAuth } = require('./authMiddleware');
const { listMyOrders } = require('./purchasesController');

const router = express.Router();

router.get('/', requireAuth, listMyOrders);

module.exports = router;
