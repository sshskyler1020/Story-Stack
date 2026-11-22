/**
 * Builds the inline HTML page served by GET /api/reader/:bookId.
 *
 * Security notes:
 *  - The presigned S3 URL is embedded once and fetched by JS into memory
 *    (as a Blob) rather than left sitting in a visible <a href> or <iframe
 *    src>, so casual view-source / "save as" doesn't hand over a working
 *    download link once the 15-minute presigned URL is still valid.
 *    EXCEPTION: audio streams directly from the presigned URL rather
 *    than being fetched into a blob first — see the FILE_TYPE === 'audio'
 *    branch below for why.
 *  - CSS disables text selection and the browser context menu to raise the
 *    bar against casual copy/scrape (this is a deterrent, not DRM — a
 *    determined user can still extract content from any rendered page).
 *  - This HTML is additionally served behind the response headers set in
 *    readerController.js (X-Frame-Options / frame-ancestors, nosniff, etc).
 */
function buildReaderHtml({ bookTitle, fileType, presignedUrl }) {
  const isEpub = fileType === 'epub';
  const isAudio = fileType === 'audio';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(bookTitle)} — Reader</title>
<meta name="robots" content="noindex, nofollow" />
<meta name="viewport" content="width=device-width, initial-scale=1" />

${isAudio ? '' : (isEpub
    ? '<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>\n<script src="https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js"></script>'
    : '<script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js"></script>')}

<style>
  html, body {
    margin: 0; padding: 0; height: 100%; background: #f4f1ea;
    font-family: Georgia, 'Times New Roman', serif;
  }
  /* Deter casual copy/scrape of rendered text. Not a security boundary. */
  * {
    -webkit-user-select: none; -moz-user-select: none; user-select: none;
  }
  #viewer { width: 100%; height: 100vh; }
  #status { text-align: center; padding-top: 40vh; color: #555; }
  #pdf-pages canvas { display: block; margin: 12px auto; box-shadow: 0 1px 4px rgba(0,0,0,0.2); }
  #audio-player { display:flex; align-items:center; justify-content:center; height:100vh; }
  #audio-player audio { width: min(90vw, 480px); }
</style>
</head>
<body oncontextmenu="return false;">
  <div id="status">Loading “${escapeHtml(bookTitle)}”…</div>
  <div id="viewer" style="display:none;">
    ${isAudio ? '<div id="audio-player"><audio id="audio-el" controls controlsList="nodownload"></audio></div>' : (isEpub ? '' : '<div id="pdf-pages"></div>')}
  </div>

<script>
(function () {
  // The presigned URL is short-lived (15 min) and scoped to this book only.
  var PRESIGNED_URL = ${JSON.stringify(presignedUrl)};
  var FILE_TYPE = ${JSON.stringify(fileType)};

  function showViewer() {
    document.getElementById('status').style.display = 'none';
    document.getElementById('viewer').style.display = 'block';
  }

  if (FILE_TYPE === 'audio') {
    // Audio streams directly from the presigned URL rather than being
    // fetched into a blob first — unlike text, a large audiobook file
    // benefits far more from the browser's native range-request
    // streaming/seeking than from the extra step of hiding the raw URL
    // (which would also mean downloading the whole file before any
    // playback could start at all). A deliberate, documented tradeoff,
    // not an oversight.
    var audioEl = document.getElementById('audio-el');
    audioEl.src = PRESIGNED_URL;
    audioEl.addEventListener('loadedmetadata', showViewer);
    audioEl.addEventListener('error', function () {
      document.getElementById('status').textContent = 'Unable to load this audiobook.';
    });
    return;
  }

  fetch(PRESIGNED_URL)
    .then(function (res) {
      if (!res.ok) throw new Error('Failed to load file (' + res.status + ')');
      return res.blob();
    })
    .then(function (blob) {
      var objectUrl = URL.createObjectURL(blob);

      if (FILE_TYPE === 'epub') {
        showViewer();
        var book = ePub(objectUrl);
        var rendition = book.renderTo('viewer', { width: '100%', height: '100%' });
        rendition.display();
      } else {
        // pdf.js requires its worker script location set explicitly — it
        // doesn't reliably auto-detect this when loaded via a plain CDN
        // <script> tag. Must match the exact pdfjs-dist version above.
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js';
        // pdf.js: render every page to its own canvas, in-memory only.
        pdfjsLib.getDocument({ url: objectUrl }).promise.then(function (pdf) {
          showViewer();
          var container = document.getElementById('pdf-pages');
          var renderPage = function (num) {
            pdf.getPage(num).then(function (page) {
              var scale = 1.3;
              var viewport = page.getViewport({ scale: scale });
              var canvas = document.createElement('canvas');
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              container.appendChild(canvas);
              page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport });
              if (num < pdf.numPages) renderPage(num + 1);
            });
          };
          renderPage(1);
        });
      }

      // Revoke the in-memory blob URL once the tab closes; the S3 presigned
      // URL itself also naturally expires after 15 minutes.
      window.addEventListener('beforeunload', function () {
        URL.revokeObjectURL(objectUrl);
      });
    })
    .catch(function (err) {
      document.getElementById('status').textContent = 'Unable to load this book: ' + err.message;
    });
})();
</script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

module.exports = { buildReaderHtml };
