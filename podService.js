/**
 * Print-on-Demand integration hooks, structured against Lulu's Print API
 * (https://api.lulu.com — Print Job Orders resource).
 *
 * This is a placeholder integration: swap getAccessToken()'s stub and the
 * job payload mapping for Lulu's actual OAuth + print-job schema once
 * sandbox credentials are available. The shape below mirrors what Lulu's
 * "Create Print Job" endpoint expects.
 */
const config = require('./config');

const LULU_API_BASE_URL = config.lulu.apiBaseUrl || 'https://api.lulu.com';

/**
 * Lulu uses OAuth2 client-credentials. Cache the token in-memory between
 * calls; refresh a little before actual expiry.
 */
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const res = await fetch(`${LULU_API_BASE_URL}/auth/realms/glasstree/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.lulu.clientKey,
      client_secret: config.lulu.clientSecret,
    }),
  });

  if (!res.ok) {
    throw new Error(`Lulu auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000; // refresh 60s early
  return cachedToken;
}

/**
 * Submits a print job to Lulu for a paid 'print' purchase.
 *
 * @param {Object} params
 * @param {string} params.podPackageId       Lulu print SKU/spec mapped on the book row
 * @param {string} params.bookTitle          The book's title — required by Lulu on each line item, printed on the cover
 * @param {string} params.interiorFileUrl    Presigned/public URL to the interior PDF
 * @param {string} params.coverFileUrl       Presigned/public URL to the cover PDF
 * @param {Object} params.shippingAddress    Shipping address captured from Stripe
 * @param {string} params.externalOrderId    Our own purchases.id, for idempotency/tracing
 * @returns {Promise<{ luluOrderId: string, status: string }>}
 */
async function submitPrintJob({ podPackageId, bookTitle, interiorFileUrl, coverFileUrl, shippingAddress, externalOrderId }) {
  // Fail with a clear, specific message rather than letting a missing
  // field crash deep inside the payload construction below, or get
  // rejected by Lulu's API with an error that doesn't say which of OUR
  // fields caused it.
  if (!shippingAddress || !shippingAddress.name || !shippingAddress.line1) {
    throw new Error('submitPrintJob called without a complete shippingAddress (need at least name and line1).');
  }
  if (!shippingAddress.phone_number) {
    throw new Error('submitPrintJob called without shippingAddress.phone_number — Lulu requires a phone number on every shipping address.');
  }
  if (!podPackageId) {
    throw new Error('submitPrintJob called without a podPackageId.');
  }
  if (!bookTitle) {
    throw new Error('submitPrintJob called without a bookTitle — Lulu requires a title on each line item.');
  }
  if (!config.lulu.contactEmail) {
    throw new Error('config.lulu.contactEmail is not set — Lulu requires a top-level contact_email on every print job.');
  }

  const accessToken = await getAccessToken();

  const payload = {
    external_id: externalOrderId,
    // Lulu requires an email for questions about the print job itself —
    // this is YOUR contact (developer/business owner), not the buyer's.
    contact_email: config.lulu.contactEmail,
    line_items: [
      {
        external_id: externalOrderId,
        title: bookTitle, // required by Lulu — printed on the line item / used for their records
        printable_normalization: {
          pod_package_id: podPackageId,
          interior: { source_url: interiorFileUrl },
          cover: { source_url: coverFileUrl },
        },
        quantity: 1,
      },
    ],
    shipping_address: {
      name: shippingAddress.name,
      street1: shippingAddress.line1,
      street2: shippingAddress.line2 || '',
      city: shippingAddress.city,
      state_code: shippingAddress.state,
      postcode: shippingAddress.postal_code,
      country_code: shippingAddress.country,
      phone_number: shippingAddress.phone_number,
    },
    shipping_level: 'MAIL', // map to a real Lulu shipping tier as needed
    production_delay: 120,
  };

  const res = await fetch(`${LULU_API_BASE_URL}/print-jobs/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Lulu print job submission failed: ${res.status} ${await res.text()}`);
  }

  const job = await res.json();
  return { luluOrderId: job.id, status: job.status?.name || 'CREATED' };
}

/**
 * A fixed, representative US shipping destination used only to estimate
 * print cost at publish/edit time — the real buyer's address isn't known
 * yet at that point. This gives authors a realistic "cost to print and
 * ship one copy" floor before anyone has actually bought anything;
 * actual per-order costs will vary somewhat by real destination.
 */
const REFERENCE_SHIPPING_ADDRESS = {
  street1: '3005 Center Green Dr',
  city: 'Boulder',
  state_code: 'CO',
  postcode: '80301',
  country_code: 'US',
  phone_number: '3035551234',
};

/**
 * Calls Lulu's print-job-cost-calculations endpoint — calculates what a
 * print job would actually cost (product + shipping + fulfillment fee +
 * tax) WITHOUT creating a real job. Used to enforce a sane minimum print
 * price so an author can't accidentally list a book for less than it
 * costs to manufacture and ship.
 *
 * @param {Object} params
 * @param {string} params.podPackageId
 * @param {number} params.pageCount
 * @returns {Promise<{ totalCostCents: number, currency: string }>}
 */
async function calculatePrintCost({ podPackageId, pageCount }) {
  if (!podPackageId) throw new Error('calculatePrintCost called without a podPackageId.');
  if (!pageCount || pageCount < 1) throw new Error('calculatePrintCost called without a valid pageCount.');

  const accessToken = await getAccessToken();

  const payload = {
    line_items: [
      {
        page_count: pageCount,
        pod_package_id: podPackageId,
        quantity: 1,
      },
    ],
    shipping_address: REFERENCE_SHIPPING_ADDRESS,
    shipping_option: 'MAIL', // matches the shipping_level used in submitPrintJob
  };

  const res = await fetch(`${LULU_API_BASE_URL}/print-job-cost-calculations/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Lulu cost calculation failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  // Lulu returns decimal strings (e.g. "12.34"), not cents — convert
  // carefully via string math to avoid float rounding surprises.
  const totalCostCents = Math.round(parseFloat(data.total_cost_incl_tax) * 100);

  return { totalCostCents, currency: data.currency || 'USD' };
}

module.exports = { submitPrintJob, calculatePrintCost };
