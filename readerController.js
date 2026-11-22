/**
 * GET /api/reader/:bookId
 *
 * 1. requireAuth (middleware) has already verified the Firebase JWT.
 * 2. Confirms the caller has a 'paid' purchase of the requested format —
 *    ?variant=ebook (default, needs a 'digital' purchase) or
 *    ?variant=audiobook (needs an 'audiobook' purchase). A reader could
 *    own both independently for the same book.
 * 3. Confirms the book has actually released (see PREORDERS below) —
 *    owning a preorder isn't the same as it being accessible yet.
 * 4. Generates a 15-minute presigned S3 URL for the file.
 * 5a. ?format=json — returns { title, fileType, presignedUrl } as JSON.
 *     This is what the Story Stack frontend actually calls; the reader
 *     page does its own epub.js/pdf.js/<audio> rendering client-side
 *     rather than using the server-rendered HTML page below.
 * 5b. no query param — renders a complete inline HTML page (epub.js /
 *     pdf.js / <audio>) directly, for embedding this route in a bare
 *     <iframe src> without any SPA involved. The raw S3/presigned link
 *     is never exposed as a clickable download href either way, and the
 *     HTML page sets headers to resist embedding/clickjacking from
 *     origins other than our own Google Sites host.
 *
 * PREORDERS: a book with books.release_date in the future can still be
 * purchased (see checkoutController.js), but isn't actually accessible
 * until that date arrives. This is checked lazily right here at request
 * time — no scheduled job needed for ebook/audiobook access, since "has
 * this timestamp passed yet" is just a comparison made whenever someone
 * asks. (Print preorders work differently — see preorderController.js —
 * since physical fulfillment can't be resolved by a comparison alone.)
 */
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3Client, BUCKET_NAME } = require('./s3');
const store = require('./store');
const { buildReaderHtml } = require('./readerTemplate');
const config = require('./config');

const PRESIGNED_URL_TTL_SECONDS = 15 * 60; // 15 minutes, per spec

async function renderReader(req, res, next) {
  try {
    const { uid } = req.firebaseUser;
    const { bookId } = req.params;
    const wantsJson = req.query.format === 'json';
    // Which purchased format to open — 'ebook' (epub/pdf, via a 'digital'
    // purchase) or 'audiobook' (via an 'audiobook' purchase). A reader
    // could own both for the same book, each independently, so this has
    // to be explicit rather than guessed.
    const variant = req.query.variant === 'audiobook' ? 'audiobook' : 'ebook';
    const purchaseTypeForVariant = variant === 'audiobook' ? 'audiobook' : 'digital';

    const purchase = await store.findPaidPurchase(uid, bookId, purchaseTypeForVariant);
    const book = purchase ? await store.getBook(bookId) : null;

    if (!purchase || !book) {
      return res.status(403).json({ error: `You do not own the ${variant === 'audiobook' ? 'audiobook' : 'digital'} edition of this book.` });
    }

    const { title, digital_s3_key: digitalKey, audiobook_s3_key: audiobookKey, release_date: releaseDate } = book;

    if (releaseDate && new Date(releaseDate) > new Date()) {
      return res.status(403).json({
        error: `This is a preorder — "${title}" releases on ${new Date(releaseDate).toLocaleDateString()}. You'll be able to access it here as soon as it's out.`,
        releaseDate,
      });
    }

    const fileKey = variant === 'audiobook' ? audiobookKey : digitalKey;
    if (!fileKey) {
      return res.status(404).json({ error: `No ${variant} file is associated with this book.` });
    }

    const fileType = variant === 'audiobook'
      ? 'audio'
      : (fileKey.toLowerCase().endsWith('.epub') ? 'epub' : 'pdf');

    const presignedUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: BUCKET_NAME, Key: fileKey }),
      { expiresIn: PRESIGNED_URL_TTL_SECONDS }
    );

    if (wantsJson) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ title, fileType, presignedUrl });
    }

    // --- Security headers for the server-rendered HTML reader page ---
    // Only allow this page to be framed by our own Google Sites domain(s),
    // preventing clickjacking via arbitrary third-party iframes.
    //
    // allowedOrigins entries use the same convention as server.js's CORS
    // check: an exact origin ('https://sites.google.com'), or a suffix
    // wildcard starting with '.' ('.googleusercontent.com') matching any
    // subdomain. CSP's frame-ancestors has its own wildcard syntax
    // ('*.example.com' — leading asterisk, not a bare dot) which is NOT
    // the same string, so it has to be translated here rather than reused
    // directly.
    const allowedFrameAncestors = (config.server.allowedOrigins || [])
      .map((entry) => (entry.startsWith('.') ? `*${entry}` : entry))
      .join(' ');

    res.setHeader(
      'Content-Security-Policy',
      `frame-ancestors 'self' ${allowedFrameAncestors}; script-src 'self' https://cdnjs.cloudflare.com 'unsafe-inline'; object-src 'none';`
    );
    res.removeHeader('X-Frame-Options'); // CSP frame-ancestors supersedes it; avoid conflicting directives
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Discourage caching of this page (it embeds a time-limited signed URL).
    res.setHeader('Cache-Control', 'no-store');

    const html = buildReaderHtml({ bookTitle: title, fileType, presignedUrl });
    return res.status(200).type('html').send(html);
  } catch (err) {
    next(err);
  }
}

module.exports = { renderReader };
