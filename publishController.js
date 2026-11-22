/**
 * POST /api/author/publish
 *
 * Expects multipart/form-data with:
 *   - fields: title, description, genre, keywords (comma-separated),
 *             isDigitalAvailable, isPrintAvailable, isAudiobookAvailable,
 *             ebookPriceCents (required if isDigitalAvailable),
 *             printPriceCents + printPageCount + luluPodPackageId (required if isPrintAvailable),
 *             audiobookPriceCents (required if isAudiobookAvailable),
 *             releaseDate (optional — ISO date string; a future date makes this a preorder)
 *   - files:  epub (optional if not digital), printInterior + printCover (optional if not print),
 *             audiobook (optional if not audiobook), ebookCoverImage (optional listing thumbnail)
 *
 * File upload to S3 is handled upstream by publishUploadFields
 * (multer-s3, see s3UploadMiddleware.js) — by the time this
 * controller runs, req.files already contains the S3 keys.
 *
 * PRICE FLOOR: printPriceCents must be at least what Lulu will actually
 * charge to print and ship one copy (see podService.js's
 * calculatePrintCost). This is re-calculated here server-side rather
 * than trusting whatever the Publishing Wizard displayed — a
 * client-side-only check could be bypassed by anyone calling this API
 * directly, and a book priced below its own manufacturing cost would
 * lose the author money on every single sale. Audiobooks and ebooks
 * have no equivalent manufacturing cost (no physical production), so
 * they have no price floor beyond "not negative."
 */
const store = require('./store');
const { calculatePrintCost } = require('./podService');

function parseKeywords(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 25); // generous cap — keeps a mistaken paste of a whole paragraph from becoming 400 "keywords"
}

async function publishBook(req, res, next) {
  try {
    const { uid } = req.firebaseUser;
    const {
      title,
      description,
      genre,
      keywords,
      isDigitalAvailable,
      isPrintAvailable,
      isAudiobookAvailable,
      ebookPriceCents,
      printPriceCents,
      printPageCount,
      audiobookPriceCents,
      releaseDate,
      luluPodPackageId,
    } = req.body;

    const wantsDigital = isDigitalAvailable === 'true' || isDigitalAvailable === true;
    const wantsPrint = isPrintAvailable === 'true' || isPrintAvailable === true;
    const wantsAudiobook = isAudiobookAvailable === 'true' || isAudiobookAvailable === true;

    if (!title) {
      return res.status(400).json({ error: 'title is required.' });
    }
    if (!wantsDigital && !wantsPrint && !wantsAudiobook) {
      return res.status(400).json({ error: 'At least one of digital, print, or audiobook availability must be set.' });
    }

    if (wantsDigital && (!ebookPriceCents || Number.isNaN(Number(ebookPriceCents)) || Number(ebookPriceCents) < 0)) {
      return res.status(400).json({ error: 'ebookPriceCents is required and must be a non-negative number for digital availability.' });
    }
    if (wantsAudiobook && (!audiobookPriceCents || Number.isNaN(Number(audiobookPriceCents)) || Number(audiobookPriceCents) < 0)) {
      return res.status(400).json({ error: 'audiobookPriceCents is required and must be a non-negative number for audiobook availability.' });
    }

    // Lulu's API requires a pod_package_id (their print spec/SKU code) on
    // every print job — without one, every print order for this book
    // would reach checkout successfully, take the buyer's payment, and
    // THEN fail at the Lulu submission step in webhookController.js,
    // which is a much worse place to discover a missing setting than
    // right here at publish time.
    if (wantsPrint && !luluPodPackageId) {
      return res.status(400).json({ error: 'luluPodPackageId is required for print availability — find your book\'s print spec code in your Lulu account.' });
    }
    const pageCountNum = parseInt(printPageCount, 10);
    if (wantsPrint && (!Number.isInteger(pageCountNum) || pageCountNum < 1)) {
      return res.status(400).json({ error: 'printPageCount is required (a whole number of at least 1) for print availability — Lulu needs it to calculate cost and print the book.' });
    }
    if (wantsPrint && (!printPriceCents || Number.isNaN(Number(printPriceCents)) || Number(printPriceCents) < 0)) {
      return res.status(400).json({ error: 'printPriceCents is required and must be a non-negative number for print availability.' });
    }

    let printBaseCostCents = null;
    if (wantsPrint) {
      let costResult;
      try {
        costResult = await calculatePrintCost({ podPackageId: luluPodPackageId, pageCount: pageCountNum });
      } catch (costErr) {
        // Fail clearly rather than silently publishing with no cost
        // basis at all — a bad luluPodPackageId here would otherwise
        // only surface much later, at actual fulfillment time.
        return res.status(400).json({ error: `Could not calculate print cost — check your Lulu Print Package ID. (${costErr.message})` });
      }
      printBaseCostCents = costResult.totalCostCents;

      if (Number(printPriceCents) < printBaseCostCents) {
        return res.status(400).json({
          error: `printPriceCents ($${(Number(printPriceCents) / 100).toFixed(2)}) is below the estimated cost to print and ship one copy ($${(printBaseCostCents / 100).toFixed(2)}). Raise your print price to at least this amount.`,
          minimumPrintPriceCents: printBaseCostCents,
        });
      }
    }

    let parsedReleaseDate = null;
    if (releaseDate) {
      parsedReleaseDate = new Date(releaseDate);
      if (Number.isNaN(parsedReleaseDate.getTime())) {
        return res.status(400).json({ error: 'releaseDate is not a valid date.' });
      }
    }

    const files = req.files || {};
    const epubFile = files.epub?.[0];
    const interiorFile = files.printInterior?.[0];
    const coverFile = files.printCover?.[0];
    const ebookCoverFile = files.ebookCoverImage?.[0];
    const audiobookFile = files.audiobook?.[0];

    if (wantsDigital && !epubFile) {
      return res.status(400).json({ error: 'A digital file (epub field) is required for digital availability.' });
    }
    if (wantsPrint && (!interiorFile || !coverFile)) {
      return res.status(400).json({
        error: 'Both printInterior and printCover files are required for print availability.',
      });
    }
    if (wantsAudiobook && !audiobookFile) {
      return res.status(400).json({ error: 'An audiobook audio file is required for audiobook availability.' });
    }

    // Authors are keyed by Firebase UID.
    const author = await store.getAuthor(uid);
    if (!author) {
      return res.status(403).json({ error: 'No author profile found for this account. Register as an author first.' });
    }

    const keywordsArray = parseKeywords(keywords);

    const book = await store.createBook({
      author_id: uid,
      title: title.trim(),
      description: description || null,
      genre: genre || null,
      keywords: keywordsArray,
      currency: 'usd',
      is_digital_available: wantsDigital,
      digital_s3_key: epubFile ? epubFile.key : null, // .key is the S3 object key set by multer-s3
      ebook_cover_s3_key: ebookCoverFile ? ebookCoverFile.key : null,
      ebook_price_cents: wantsDigital ? parseInt(ebookPriceCents, 10) : null,
      is_print_available: wantsPrint,
      print_interior_s3_key: interiorFile ? interiorFile.key : null,
      print_cover_s3_key: coverFile ? coverFile.key : null,
      lulu_pod_package_id: wantsPrint ? luluPodPackageId : null,
      print_price_cents: wantsPrint ? parseInt(printPriceCents, 10) : null,
      print_page_count: wantsPrint ? pageCountNum : null,
      print_base_cost_cents: printBaseCostCents,
      is_audiobook_available: wantsAudiobook,
      audiobook_s3_key: audiobookFile ? audiobookFile.key : null,
      audiobook_price_cents: wantsAudiobook ? parseInt(audiobookPriceCents, 10) : null,
      release_date: parsedReleaseDate ? parsedReleaseDate.toISOString() : null,
      status: 'published',
    });

    return res.status(201).json({ message: 'Book published.', book: { id: book.id, title: book.title, status: book.status } });
  } catch (err) {
    next(err);
  }
}

module.exports = { publishBook };
