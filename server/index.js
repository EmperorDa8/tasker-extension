/**
 * Tasker Summary Service
 *
 * Sits between the extension and the Gemini API so the API key stays server-side.
 * A Chrome extension ships as readable source, so a key embedded in it is public
 * the moment the extension is published.
 *
 * Deliberately zero-dependency: runs on Node 18+ anywhere (Render, Railway, Fly,
 * a VPS) with no install step.
 *
 * Also verifies Pro licences. Paddle is the system of record for who has paid,
 * so there is no database here: the extension sends the order reference from the
 * buyer's receipt and this asks Paddle whether that transaction is real,
 * completed, and for the Tasker price.
 *
 * Required env:
 *   GEMINI_API_KEY        your Google Gemini API key
 * Optional env:
 *   PORT                  default 3000
 *   ALLOWED_EXTENSION_IDS comma-separated Chrome extension IDs allowed to call
 *   MAX_PER_INSTALL_MONTH default 3
 *   MAX_GLOBAL_PER_DAY    default 300
 *   MIN_SECONDS_BETWEEN   default 20
 *   GEMINI_MODEL          default gemini-1.5-flash
 * Licence verification (optional; without these /v1/license/verify returns 501):
 *   PADDLE_API_KEY        Paddle server-side API key
 *   PADDLE_ENV           'sandbox' or 'live'  (default sandbox)
 *   PADDLE_PRICE_IDS      comma-separated price IDs that grant Pro
 */

const http = require('http');

const PADDLE_API_KEY = process.env.PADDLE_API_KEY || '';
const PADDLE_ENV = (process.env.PADDLE_ENV || 'sandbox').toLowerCase();
// PADDLE_API_BASE exists so the verification path can be pointed at a stub in
// tests. Leave it unset in production and the environment picks the host.
const PADDLE_BASE = process.env.PADDLE_API_BASE || (PADDLE_ENV === 'live'
  ? 'https://api.paddle.com'
  : 'https://sandbox-api.paddle.com');
const PADDLE_PRICE_IDS = (process.env.PADDLE_PRICE_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const PORT = parseInt(process.env.PORT || '3000', 10);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const ALLOWED_EXTENSION_IDS = (process.env.ALLOWED_EXTENSION_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const MAX_PER_INSTALL_MONTH = parseInt(process.env.MAX_PER_INSTALL_MONTH || '3', 10);
const MAX_GLOBAL_PER_DAY = parseInt(process.env.MAX_GLOBAL_PER_DAY || '300', 10);
const MIN_SECONDS_BETWEEN = parseInt(process.env.MIN_SECONDS_BETWEEN || '20', 10);
const MAX_BODY_BYTES = 8 * 1024;
const MAX_OUTPUT_TOKENS = 700;

// ---------------------------------------------------------------- rate limiting
// In-memory: resets if the process restarts, and is per-instance. It exists for
// fairness between users, NOT as the cost guarantee - set a hard quota on the key
// in Google Cloud Console, which is the only limit that cannot be bypassed.
const installUsage = new Map();  // installId -> { monthKey, count, lastRequestMs }
const ipUsage = new Map();       // ip -> { dayKey, count }
let globalUsage = { dayKey: '', count: 0 };

function todayKey() { return new Date().toISOString().slice(0, 10); }
function thisMonthKey() { return new Date().toISOString().slice(0, 7); }

// Keep the maps from growing without bound on a long-lived process.
setInterval(() => {
  const month = thisMonthKey();
  const day = todayKey();
  const hour = new Date().toISOString().slice(0, 13);
  for (const [k, v] of installUsage) if (v.monthKey !== month) installUsage.delete(k);
  for (const [k, v] of ipUsage) if (v.dayKey !== day) ipUsage.delete(k);
  for (const [k, v] of licenseAttempts) if (v.hour !== hour) licenseAttempts.delete(k);
}, 60 * 60 * 1000).unref();

function checkQuota(installId, ip) {
  const month = thisMonthKey();
  const day = todayKey();
  const now = Date.now();

  if (globalUsage.dayKey !== day) globalUsage = { dayKey: day, count: 0 };
  if (globalUsage.count >= MAX_GLOBAL_PER_DAY) {
    return { ok: false, status: 503, reason: 'daily_capacity_reached' };
  }

  const ipRecord = ipUsage.get(ip);
  const ipCount = ipRecord && ipRecord.dayKey === day ? ipRecord.count : 0;
  if (ipCount >= MAX_PER_INSTALL_MONTH * 4) {
    return { ok: false, status: 429, reason: 'too_many_requests' };
  }

  const record = installUsage.get(installId);
  if (record && record.monthKey === month) {
    if (now - record.lastRequestMs < MIN_SECONDS_BETWEEN * 1000) {
      return { ok: false, status: 429, reason: 'slow_down' };
    }
    if (record.count >= MAX_PER_INSTALL_MONTH) {
      return { ok: false, status: 429, reason: 'monthly_limit_reached' };
    }
  }
  return { ok: true };
}

function recordUsage(installId, ip) {
  const month = thisMonthKey();
  const day = todayKey();
  const record = installUsage.get(installId);
  if (record && record.monthKey === month) {
    record.count++;
    record.lastRequestMs = Date.now();
  } else {
    installUsage.set(installId, { monthKey: month, count: 1, lastRequestMs: Date.now() });
  }
  const ipRecord = ipUsage.get(ip);
  if (ipRecord && ipRecord.dayKey === day) ipRecord.count++;
  else ipUsage.set(ip, { dayKey: day, count: 1 });
  globalUsage.count++;
}

// ---------------------------------------------------------------- validation
function validPayload(body) {
  if (!body || typeof body !== 'object') return 'malformed body';
  if (typeof body.installId !== 'string' || body.installId.length < 8 || body.installId.length > 64) {
    return 'bad installId';
  }
  if (!/^\d{4}-\d{2}$/.test(body.monthKey || '')) return 'bad monthKey';
  if (typeof body.totalSeconds !== 'number' || body.totalSeconds < 0 || body.totalSeconds > 40000000) {
    return 'bad totalSeconds';
  }
  if (typeof body.daysTracked !== 'number' || body.daysTracked < 0 || body.daysTracked > 31) {
    return 'bad daysTracked';
  }
  if (!body.categories || typeof body.categories !== 'object') return 'bad categories';
  const keys = Object.keys(body.categories);
  if (keys.length > 20) return 'too many categories';
  for (const k of keys) {
    if (k.length > 40) return 'category name too long';
    if (typeof body.categories[k] !== 'number') return 'bad category value';
  }
  return null;
}

// ---------------------------------------------------------------- Gemini
function hours(seconds) { return Math.round((seconds / 3600) * 10) / 10; }

async function callGemini(payload) {
  const lines = Object.keys(payload.categories)
    .sort((a, b) => payload.categories[b] - payload.categories[a])
    .map(c => `- ${c}: ${hours(payload.categories[c])} hours`)
    .join('\n');

  const prompt = `You are a concise productivity coach writing a monthly work recap.

Month: ${payload.monthKey}
Total tracked time: ${hours(payload.totalSeconds)} hours across ${payload.daysTracked} active days.
Time by category:
${lines}

Return JSON with exactly two fields:
"summaryParagraph": 2-3 sentences summarising the month's focus in a warm, factual tone. Do not invent specific projects, companies or task names - you only know category totals.
"milestones": an array of 3-5 objects, each with "title", "description" and "category", describing themes visible in the category data. Keep each description under 15 words.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.7
        }
      })
    }
  );

  if (!res.ok) throw new Error(`gemini_${res.status}`);
  const data = await res.json();
  const raw = data && data.candidates && data.candidates[0] &&
    data.candidates[0].content && data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!raw) throw new Error('gemini_empty');

  const parsed = JSON.parse(raw);
  return {
    summaryParagraph: String(parsed.summaryParagraph || '').slice(0, 1200),
    milestones: Array.isArray(parsed.milestones)
      ? parsed.milestones.slice(0, 5).map(m => ({
          title: String(m.title || '').slice(0, 120),
          description: String(m.description || '').slice(0, 240),
          category: String(m.category || 'Productivity').slice(0, 40)
        }))
      : []
  };
}

// ---------------------------------------------------------------- licences

// Verification attempts per IP per hour. A transaction ID is the only thing
// standing between a stranger and a free unlock, so guessing has to be
// expensive even though the keyspace is large.
const LICENSE_ATTEMPTS_PER_HOUR = 20;
const licenseAttempts = new Map(); // ip -> { hour, count }

function allowLicenseAttempt(ip) {
  const hour = new Date().toISOString().slice(0, 13);
  const record = licenseAttempts.get(ip);
  if (!record || record.hour !== hour) {
    licenseAttempts.set(ip, { hour, count: 1 });
    return true;
  }
  if (record.count >= LICENSE_ATTEMPTS_PER_HOUR) return false;
  record.count++;
  return true;
}

/**
 * Check an order reference against Paddle.
 *
 * Paddle holds the truth about who paid, so nothing is stored here. A
 * transaction ID is a 26-character random string, so it is not guessable - but
 * it is also not a secret the way a password is. That is an accepted trade for
 * a $49 one-time product: the cost of someone sharing a reference is one extra
 * unlock, and the alternative is running an account system for a tool whose
 * entire pitch is that it has no accounts.
 */
async function verifyPaddleTransaction(reference) {
  const res = await fetch(`${PADDLE_BASE}/transactions/${encodeURIComponent(reference)}`, {
    headers: { 'Authorization': `Bearer ${PADDLE_API_KEY}` }
  });

  if (res.status === 404) return { valid: false, reason: 'not_found' };
  if (!res.ok) throw new Error(`paddle_${res.status}`);

  const body = await res.json();
  const txn = body && body.data;
  if (!txn) return { valid: false, reason: 'not_found' };

  // Only a paid transaction counts. 'billed' and 'past_due' mean an invoice was
  // raised, not that money arrived.
  if (txn.status !== 'completed' && txn.status !== 'paid') {
    return { valid: false, reason: 'not_paid', status: txn.status };
  }

  // And it must be for something that actually grants Pro, or any past purchase
  // from the same Paddle account would unlock the extension.
  if (PADDLE_PRICE_IDS.length) {
    const items = txn.items || [];
    const match = items.some(item => item.price && PADDLE_PRICE_IDS.includes(item.price.id));
    if (!match) return { valid: false, reason: 'wrong_product' };
  }

  return { valid: true, plan: 'lifetime', purchasedAt: txn.billed_at || txn.created_at || null };
}

// ---------------------------------------------------------------- http
function originAllowed(origin) {
  if (!origin || !origin.startsWith('chrome-extension://')) return false;
  if (ALLOWED_EXTENSION_IDS.length === 0) return true; // not yet pinned to an ID
  const id = origin.replace('chrome-extension://', '').replace(/\/$/, '');
  return ALLOWED_EXTENSION_IDS.includes(id);
}

function send(res, status, obj, origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;

  if (req.url === '/health') return send(res, 200, { ok: true }, null);

  if (req.method === 'OPTIONS') {
    if (!originAllowed(origin)) return send(res, 403, { error: 'forbidden_origin' }, null);
    return send(res, 204, {}, origin);
  }

  const route = String(req.url || '').split('?')[0];
  const ROUTES = ['/v1/monthly-summary', '/v1/license/verify'];

  if (req.method !== 'POST' || ROUTES.indexOf(route) === -1) {
    return send(res, 404, { error: 'not_found' }, null);
  }
  if (!originAllowed(origin)) return send(res, 403, { error: 'forbidden_origin' }, null);
  if (route === '/v1/monthly-summary' && !GEMINI_API_KEY) {
    return send(res, 500, { error: 'server_not_configured' }, origin);
  }
  if (route === '/v1/license/verify' && !PADDLE_API_KEY) {
    return send(res, 501, { error: 'licensing_not_configured' }, origin);
  }

  let raw = '';
  let tooBig = false;

  // A client that drops mid-upload must not take the process down.
  req.on('error', () => { tooBig = true; });

  req.on('data', chunk => {
    if (tooBig) return;
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) {
      tooBig = true;
      // Answer first, then hang up - destroying the socket without a reply
      // leaves the caller staring at a connection reset instead of a 413.
      send(res, 413, { error: 'payload_too_large' }, origin);
      res.on('finish', () => { try { req.destroy(); } catch (e) { /* already gone */ } });
    }
  });

  req.on('end', async () => {
    if (tooBig) return;

    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid_json' }, origin); }

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket.remoteAddress || 'unknown';

    if (route === '/v1/license/verify') {
      const reference = String((body && body.reference) || '').trim();
      if (!/^txn_[a-z0-9]{20,40}$/i.test(reference)) {
        return send(res, 400, { error: 'invalid_reference' }, origin);
      }
      // Rate limited by IP so the endpoint cannot be used to probe for valid
      // references, which are the only credential Pro has.
      if (!allowLicenseAttempt(ip)) {
        return send(res, 429, { error: 'too_many_attempts' }, origin);
      }
      try {
        const result = await verifyPaddleTransaction(reference);
        return send(res, 200, result, origin);
      } catch (err) {
        console.warn('licence check failed:', err && err.message);
        return send(res, 502, { error: 'verification_unavailable' }, origin);
      }
    }

    const invalid = validPayload(body);
    if (invalid) return send(res, 400, { error: 'invalid_payload', detail: invalid }, origin);

    const quota = checkQuota(body.installId, ip);
    if (!quota.ok) return send(res, quota.status, { error: quota.reason }, origin);

    // Count the attempt before calling out, so a burst cannot slip past the cap
    // while requests are in flight.
    recordUsage(body.installId, ip);

    try {
      const result = await callGemini(body);
      return send(res, 200, result, origin);
    } catch (err) {
      console.warn('summary failed:', err && err.message);
      return send(res, 502, { error: 'summary_unavailable' }, origin);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Tasker summary service listening on ${PORT}`);
  if (!GEMINI_API_KEY) console.warn('WARNING: GEMINI_API_KEY is not set - requests will fail.');
});
