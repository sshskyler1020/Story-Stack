/**
 * multer-s3 configuration for the /api/author/publish endpoint.
 *
 * Accepts exactly three files in one multipart request:
 *   - epub            (digital EPUB or PDF variant)
 *   - printInterior    (interior manuscript PDF for POD)
 *   - printCover       (cover artwork PDF for POD)
 *
 * Files are streamed directly to a private S3 bucket (no ACL, no public
 * access) under a per-author prefix so nothing is ever briefly written to
 * local disk.
 */
const multer = require('multer');
const multerS3 = require('multer-s3');
const { v4: uuidv4 } = require('uuid');
const { s3Client, BUCKET_NAME } = require('./s3');

const ALLOWED_MIME_TYPES = {
  epub: ['application/epub+zip', 'application/pdf'],
  printInterior: ['application/pdf'],
  printCover: ['application/pdf'],
  ebookCoverImage: ['image/jpeg', 'image/png', 'image/webp'],
  audiobook: ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4b', 'audio/aac'],
};

const MAX_FILE_SIZE_BYTES = 700 * 1024 * 1024; // 700 MB — raised from 250MB to fit a full audiobook

function fileFilter(req, file, cb) {
  const allowed = ALLOWED_MIME_TYPES[file.fieldname];
  if (!allowed) {
    const err = new Error(`Unexpected file field: ${file.fieldname}`);
    err.isFileValidationError = true;
    return cb(err);
  }
  if (!allowed.includes(file.mimetype)) {
    const err = new Error(
      `Invalid file type for ${file.fieldname}. Expected one of: ${allowed.join(', ')}`
    );
    err.isFileValidationError = true;
    return cb(err);
  }
  return cb(null, true);
}

const upload = multer({
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    // No ACL set => bucket/object stays private by default. Access is only
    // ever granted via short-lived presigned URLs (see readerController.js).
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: (req, file, cb) => {
      cb(null, { uploadedBy: req.firebaseUser?.uid || 'unknown' });
    },
    key: (req, file, cb) => {
      // Namespaced, unguessable key — never trust the client-supplied filename.
      const authorUid = req.firebaseUser?.uid || 'unknown-author';
      const ext = file.originalname.split('.').pop();
      const safeKey = `books/${authorUid}/${file.fieldname}-${uuidv4()}.${ext}`;
      cb(null, safeKey);
    },
  }),
});

// Middleware expecting the four named fields from the publish form.
// ebookCoverImage was previously missing here — the frontend has always
// sent it, so multer was rejecting every publish attempt that included a
// cover image with an "Unexpected field" error before this fix.
const publishUploadFields = upload.fields([
  { name: 'epub', maxCount: 1 },
  { name: 'printInterior', maxCount: 1 },
  { name: 'printCover', maxCount: 1 },
  { name: 'ebookCoverImage', maxCount: 1 },
  { name: 'audiobook', maxCount: 1 },
]);

module.exports = { publishUploadFields };
