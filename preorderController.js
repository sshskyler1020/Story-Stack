/**
 * POST /api/cron/process-preorders
 *
 * Submits to Lulu any print purchase that was queued at checkout time
 * because its book hadn't released yet (see webhookController.js), and
 * whose release date has now arrived. Nothing in this app calls this on
 * a timer by itself — Render's free/starter web service plans don't
 * include a built-in scheduler, so this needs an external trigger:
 *
 *   - Render Cron Jobs (a separate service type on Render, paid) hitting
 *     this URL daily, or
 *   - A free scheduler like cron-job.org or a GitHub Actions scheduled
 *     workflow doing an HTTP POST to this URL daily.
 *
 * Either way, whoever calls it must send the shared secret configured
 * below — there's no Firebase user context available for a cron-style
 * call, so this can't use requireAuth like the rest of the app.
 */
const store = require('./store');
const config = require('./config');
const { submitPrintJob } = require('./podService');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, BUCKET_NAME } = require('./s3');

async function processDuePreorders(req, res, next) {
  try {
    const providedSecret = req.headers['x-cron-secret'];
    if (!config.server.cronSecret || providedSecret !== config.server.cronSecret) {
      return res.status(401).json({ error: 'Missing or invalid x-cron-secret header.' });
    }

    const queued = await store.listQueuedPreorderPurchases();
    const now = Date.now();
    const due = [];
    for (const p of queued) {
      const book = await store.getBook(p.book_id);
      if (book && book.release_date && new Date(book.release_date).getTime() <= now) {
        due.push({ purchase: p, book });
      }
    }

    const results = [];

    for (const { purchase, book } of due) {
      try {
        const [interiorUrl, coverUrl] = await Promise.all([
          getSignedUrl(s3Client, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: book.print_interior_s3_key }), { expiresIn: 3600 }),
          getSignedUrl(s3Client, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: book.print_cover_s3_key }), { expiresIn: 3600 }),
        ]);

        const { luluOrderId, status } = await submitPrintJob({
          podPackageId: book.lulu_pod_package_id,
          bookTitle: book.title,
          interiorFileUrl: interiorUrl,
          coverFileUrl: coverUrl,
          shippingAddress: purchase.shipping_address,
          externalOrderId: purchase.id,
        });

        await store.updatePurchase(purchase.stripe_checkout_session_id, { pod_order_id: luluOrderId, pod_status: status });
        results.push({ purchaseId: purchase.id, ok: true, luluOrderId });
      } catch (err) {
        console.error(`[preorders] Failed to submit queued print job for purchase ${purchase.id}:`, err.message);
        await store.updatePurchase(purchase.stripe_checkout_session_id, { pod_status: 'submission_failed' });
        results.push({ purchaseId: purchase.id, ok: false, error: err.message });
      }
    }

    return res.status(200).json({ processed: results.length, results });
  } catch (err) {
    next(err);
  }
}

module.exports = { processDuePreorders };
