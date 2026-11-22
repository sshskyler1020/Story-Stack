/**
 * Centralized error handler. Keep route handlers thin by throwing/forwarding
 * errors to next(err) and letting this normalize the response shape.
 * Must be registered LAST in server.js (after all routes).
 */
function notFoundHandler(req, res) {
  res.status(404).json({ error: `No route matches ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('[errorHandler]', err);

  // Multer / multer-s3 file validation errors carry a friendly message.
  if (err.name === 'MulterError' || err.isFileValidationError) {
    return res.status(400).json({ error: err.message });
  }

  const status = err.statusCode || 500;
  const message = status === 500 ? 'Internal server error.' : err.message;

  res.status(status).json({ error: message });
}

module.exports = { notFoundHandler, errorHandler };
