/**
 * GET /api/books
 *
 * Public, unauthenticated — this is the catalog listing. It was entirely
 * missing before: the frontend called this exact path and had nothing to
 * talk to, so every catalog view silently fell back to demo data no
 * matter what authors had actually published.
 */
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3Client, BUCKET_NAME } = require('./s3');
const store = require('./store');

const COVER_URL_TTL_SECONDS = 60 * 60; // 1 hour — generous since a cover thumbnail isn't sensitive content

async function listBooks(req, res, next) {
  try {
    const rows = await store.listBooksByStatus('published');
    const authors = await store.getAuthorsByIds(rows.map((b) => b.author_id));

    const books = rows.map((row) => ({
      id: row.id,
      title: row.title,
      author: (authors[row.author_id] || {}).display_name || 'Unknown author',
      genre: row.genre || 'Uncategorized',
      keywords: row.keywords || [],
      description: row.description || '',
      ebookPriceCents: row.ebook_price_cents,
      printPriceCents: row.print_price_cents,
      audiobookPriceCents: row.audiobook_price_cents,
      // Running average kept on the book doc by store.upsertReview().
      rating: row.rating_count ? row.rating_sum / row.rating_count : 0,
      digital: row.is_digital_available,
      print: row.is_print_available,
      audiobook: row.is_audiobook_available,
      // The frontend points an <img> straight at GET /api/books/:id/cover
      // when this is true, rather than us returning a presigned URL here
      // — presigned URLs are long strings with an expiry baked in, and
      // stuffing one into every catalog row would mean the URL goes stale
      // sitting in a cached response. A redirect endpoint stays valid
      // indefinitely from the frontend's perspective.
      hasCover: !!row.ebook_cover_s3_key,
    }));

    return res.status(200).json(books);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/books/:bookId/cover
 *
 * Public, unauthenticated — redirects straight to a presigned S3 URL for
 * the book's ebook cover thumbnail. A redirect (rather than proxying the
 * bytes or returning JSON) lets the frontend just use a plain <img
 * src="..."> tag with no extra fetch/blob plumbing needed.
 */
async function getBookCover(req, res, next) {
  try {
    const { bookId } = req.params;

    const book = await store.getBook(bookId);

    if (!book || !book.ebook_cover_s3_key) {
      return res.status(404).json({ error: 'No cover image for this book.' });
    }

    const presignedUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: BUCKET_NAME, Key: book.ebook_cover_s3_key }),
      { expiresIn: COVER_URL_TTL_SECONDS }
    );

    return res.redirect(302, presignedUrl);
  } catch (err) {
    next(err);
  }
}

module.exports = { listBooks, getBookCover };
