/**
 * POST /api/author/print-cost-estimate
 *
 * Lets the Publishing Wizard / My Books edit form show an author what
 * their book will actually cost to print and ship BEFORE they commit to
 * a print price — calls Lulu's real cost-calculation API (see
 * podService.js's calculatePrintCost), no print job is created.
 *
 * This is also called again, server-side, at actual publish/edit time
 * (see publishController.js / authorBooksController.js) to enforce the
 * price floor — never trusted purely from what the client displayed,
 * since a client-side-only check could be bypassed by anyone calling the
 * API directly.
 */
const { calculatePrintCost } = require('./podService');

async function getPrintCostEstimate(req, res, next) {
  try {
    const { luluPodPackageId, pageCount } = req.body;
    const pageCountNum = parseInt(pageCount, 10);

    if (!luluPodPackageId) {
      return res.status(400).json({ error: 'luluPodPackageId is required.' });
    }
    if (!Number.isInteger(pageCountNum) || pageCountNum < 1) {
      return res.status(400).json({ error: 'pageCount must be a whole number of at least 1.' });
    }

    const { totalCostCents, currency } = await calculatePrintCost({
      podPackageId: luluPodPackageId,
      pageCount: pageCountNum,
    });

    return res.status(200).json({ estimatedCostCents: totalCostCents, currency });
  } catch (err) {
    next(err);
  }
}

module.exports = { getPrintCostEstimate };
