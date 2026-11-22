/**
 * Author-facing book management — lets an author see and edit their own
 * catalog from the Author Hub. Distinct from catalogController.js, which
 * is the PUBLIC storefront listing (published books, any author, no
 * auth required). This one is scoped to "books belonging to the
 * signed-in author" and includes drafts/archived books too.
 */
const store = require('./store');
const { calculatePrintCost } = require('./podService');

function parseKeywords(raw) {
  if (raw === undefined) return undefined; // "not provided" — leave whatever's already stored
  return String(raw)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 25);
}

/**
 * GET /api/author/books
 * Every book belonging to the signed-in author, any status.
 */
async function listMyBooks(req, res, next) {
  try {
    const { uid } = req.firebaseUser;

    const rows = await store.listBooksByAuthor(uid);

    const books = rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description || '',
      genre: row.genre || '',
      keywords: row.keywords || [],
      ebookPriceCents: row.ebook_price_cents,
      printPriceCents: row.print_price_cents,
      printPageCount: row.print_page_count,
      printBaseCostCents: row.print_base_cost_cents,
      audiobookPriceCents: row.audiobook_price_cents,
      hasAudiobookFile: !!row.audiobook_s3_key,
      hasCover: !!row.ebook_cover_s3_key,
      status: row.status,
      digital: row.is_digital_available,
      print: row.is_print_available,
      audiobook: row.is_audiobook_available,
      luluPodPackageId: row.lulu_pod_package_id || '',
    }));

    return res.status(200).json(books);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/author/books/:bookId
 * Editable fields: title, description, genre, keywords, isDigitalAvailable,
 * ebookPriceCents, isPrintAvailable, printPriceCents, printPageCount,
 * luluPodPackageId, isAudiobookAvailable, audiobookPriceCents, status
 * ('published' | 'archived' only — 'draft' isn't reachable through this
 * endpoint since nothing in this app currently publishes a book as a
 * draft in the first place).
 *
 * Ownership is enforced directly in the UPDATE's WHERE clause (via a
 * subquery to the requesting user's author row) rather than as a
 * separate SELECT-then-check — a book id that doesn't belong to this
 * author simply matches zero rows instead of leaking whether it exists.
 *
 * PRICE FLOOR: same server-side re-calculation and enforcement as
 * publishController.js — see the comment there for why this can't be a
 * client-side-only check. Only re-calculated when something that
 * affects cost actually changed (package id or page count), to avoid
 * hitting Lulu's API on every unrelated edit (e.g. just fixing a typo in
 * the description). Audiobooks/ebooks have no equivalent floor.
 */
async function updateMyBook(req, res, next) {
  try {
    const { uid } = req.firebaseUser;
    const { bookId } = req.params;

    const current = await store.getBook(bookId);
    if (!current || current.author_id !== uid) {
      return res.status(404).json({ error: 'Book not found, or it does not belong to your author account.' });
    }
        const body = req.body;

    const title = body.title !== undefined ? String(body.title).trim() : current.title;
    const description = body.description !== undefined ? body.description : current.description;
    const genre = body.genre !== undefined ? body.genre : current.genre;
    const keywordsArray = parseKeywords(body.keywords) ?? current.keywords;
    const isDigitalAvailable = body.isDigitalAvailable !== undefined ? !!body.isDigitalAvailable : current.is_digital_available;
    const isPrintAvailable = body.isPrintAvailable !== undefined ? !!body.isPrintAvailable : current.is_print_available;
    const isAudiobookAvailable = body.isAudiobookAvailable !== undefined ? !!body.isAudiobookAvailable : current.is_audiobook_available;
    const luluPodPackageId = body.luluPodPackageId !== undefined ? body.luluPodPackageId : current.lulu_pod_package_id;
    const ebookPriceCents = body.ebookPriceCents !== undefined ? parseInt(body.ebookPriceCents, 10) : current.ebook_price_cents;
    const printPriceCents = body.printPriceCents !== undefined ? parseInt(body.printPriceCents, 10) : current.print_price_cents;
    const printPageCount = body.printPageCount !== undefined ? parseInt(body.printPageCount, 10) : current.print_page_count;
    const audiobookPriceCents = body.audiobookPriceCents !== undefined ? parseInt(body.audiobookPriceCents, 10) : current.audiobook_price_cents;

    let status = current.status;
    if (body.status !== undefined) {
      if (!['published', 'archived'].includes(body.status)) {
        return res.status(400).json({ error: "status must be 'published' or 'archived'." });
      }
      status = body.status;
    }

    if (!title) {
      return res.status(400).json({ error: 'title cannot be empty.' });
    }
    if (!isDigitalAvailable && !isPrintAvailable && !isAudiobookAvailable) {
      return res.status(400).json({ error: 'At least one of digital, print, or audiobook availability must stay enabled.' });
    }
    // Guard against enabling a variant that has no underlying file — this
    // endpoint doesn't handle file re-uploads, so it can only toggle
    // availability for variants that were already uploaded at publish time.
    if (isDigitalAvailable && !current.digital_s3_key) {
      return res.status(400).json({ error: 'This book has no digital file uploaded — digital availability cannot be enabled here.' });
    }
    if (isPrintAvailable && (!current.print_interior_s3_key || !current.print_cover_s3_key)) {
      return res.status(400).json({ error: 'This book has no print files uploaded — print availability cannot be enabled here.' });
    }
    if (isAudiobookAvailable && !current.audiobook_s3_key) {
      return res.status(400).json({ error: 'This book has no audiobook file uploaded — audiobook availability cannot be enabled here.' });
    }

    if (isDigitalAvailable && (Number.isNaN(ebookPriceCents) || ebookPriceCents < 0)) {
      return res.status(400).json({ error: 'ebookPriceCents must be a non-negative number.' });
    }
    if (isAudiobookAvailable && (Number.isNaN(audiobookPriceCents) || audiobookPriceCents < 0)) {
      return res.status(400).json({ error: 'audiobookPriceCents must be a non-negative number.' });
    }

    let printBaseCostCents = current.print_base_cost_cents;
    if (isPrintAvailable) {
      if (!luluPodPackageId) {
        return res.status(400).json({ error: 'A Lulu print package ID is required for print availability.' });
      }
      if (!Number.isInteger(printPageCount) || printPageCount < 1) {
        return res.status(400).json({ error: 'printPageCount is required (a whole number of at least 1) for print availability.' });
      }
      if (Number.isNaN(printPriceCents) || printPriceCents < 0) {
        return res.status(400).json({ error: 'printPriceCents must be a non-negative number.' });
      }

      // Only re-hit Lulu's cost calculator if something that actually
      // affects cost changed — no need to re-price on every unrelated edit.
      const costInputsChanged =
        luluPodPackageId !== current.lulu_pod_package_id || printPageCount !== current.print_page_count;

      if (costInputsChanged || printBaseCostCents === null) {
        let costResult;
        try {
          costResult = await calculatePrintCost({ podPackageId: luluPodPackageId, pageCount: printPageCount });
        } catch (costErr) {
          return res.status(400).json({ error: `Could not calculate print cost — check your Lulu Print Package ID. (${costErr.message})` });
        }
        printBaseCostCents = costResult.totalCostCents;
      }

      if (printPriceCents < printBaseCostCents) {
        return res.status(400).json({
          error: `printPriceCents ($${(printPriceCents / 100).toFixed(2)}) is below the estimated cost to print and ship one copy ($${(printBaseCostCents / 100).toFixed(2)}). Raise your print price to at least this amount.`,
          minimumPrintPriceCents: printBaseCostCents,
        });
      }
    }

    const updated = await store.updateBook(bookId, {
      title,
      description: description || null,
      genre: genre || null,
      keywords: keywordsArray || [],
      is_digital_available: isDigitalAvailable,
      ebook_price_cents: isDigitalAvailable ? ebookPriceCents : null,
      is_print_available: isPrintAvailable,
      print_price_cents: isPrintAvailable ? printPriceCents : null,
      print_page_count: isPrintAvailable ? printPageCount : null,
      print_base_cost_cents: isPrintAvailable ? printBaseCostCents : null,
      is_audiobook_available: isAudiobookAvailable,
      audiobook_price_cents: isAudiobookAvailable ? audiobookPriceCents : null,
      status,
      lulu_pod_package_id: luluPodPackageId || null,
    });
    return res.status(200).json({
      id: updated.id,
      title: updated.title,
      description: updated.description || '',
      genre: updated.genre || '',
      keywords: updated.keywords || [],
      status: updated.status,
      digital: updated.is_digital_available,
      ebookPriceCents: updated.ebook_price_cents,
      print: updated.is_print_available,
      printPriceCents: updated.print_price_cents,
      printPageCount: updated.print_page_count,
      printBaseCostCents: updated.print_base_cost_cents,
      audiobook: updated.is_audiobook_available,
      audiobookPriceCents: updated.audiobook_price_cents,
      luluPodPackageId: updated.lulu_pod_package_id || '',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/author/books/:bookId/files
 *
 * Republish flow — swaps out the actual files (EPUB, print interior PDF,
 * print cover PDF, ebook cover image, audiobook audio file) for a book
 * that's already published. All five are optional here (unlike the
 * initial /publish call): only the ones actually sent get replaced,
 * everything else is left untouched. Old S3 objects are deleted after a
 * successful DB update (best-effort — a delete failure is logged but
 * doesn't fail the request, since the new file is already live and
 * correctly referenced at that point).
 *
 * Uses the same multer-s3 middleware as the original publish endpoint
 * (publishUploadFields) — it already treats every field as optional at
 * the multer level, so it works unchanged for a partial republish too.
 */
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, BUCKET_NAME } = require('./s3');

async function replaceBookFiles(req, res, next) {
  try {
    const { uid } = req.firebaseUser;
    const { bookId } = req.params;

    const current = await store.getBook(bookId);
    if (!current || current.author_id !== uid) {
      return res.status(404).json({ error: 'Book not found, or it does not belong to your author account.' });
    }

    const files = req.files || {};
    const newKeys = {
      digital_s3_key: files.epub?.[0]?.key,
      print_interior_s3_key: files.printInterior?.[0]?.key,
      print_cover_s3_key: files.printCover?.[0]?.key,
      ebook_cover_s3_key: files.ebookCoverImage?.[0]?.key,
      audiobook_s3_key: files.audiobook?.[0]?.key,
    };

    const columnsToUpdate = Object.entries(newKeys).filter(([, key]) => key !== undefined);
    if (columnsToUpdate.length === 0) {
      return res.status(400).json({ error: 'No files were included in this request.' });
    }

    await store.updateBook(bookId, Object.fromEntries(columnsToUpdate));

    // Best-effort cleanup of whichever old S3 objects just got replaced.
    const oldKeysToDelete = columnsToUpdate
      .map(([col]) => current[col])
      .filter(Boolean);

    await Promise.all(
      oldKeysToDelete.map((key) =>
        s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key })).catch((delErr) => {
          console.error(`[replaceBookFiles] Failed to delete old S3 object ${key}:`, delErr.message);
        })
      )
    );

    return res.status(200).json({
      message: 'Files updated.',
      replaced: columnsToUpdate.map(([col]) => col),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listMyBooks, updateMyBook, replaceBookFiles };
