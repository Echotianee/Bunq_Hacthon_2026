const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvFile();

const API_KEY = process.env.BUNQ_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const API_HOST   = 'public-api.sandbox.bunq.com';
const PORT       = 3000;
const PORT_HTTPS = 3001;

const KEYS_FILE    = path.join(__dirname, 'bunq-keys.json');
const CONTEXT_FILE = path.join(__dirname, 'bunq-context.json');
const HTML_FILE    = path.join(__dirname, 'travel-buddy.html');
const CERT_FILE    = path.join(__dirname, 'cert.pem');
const KEY_FILE     = path.join(__dirname, 'key.pem');

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function ensureCert() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) return true;
  console.log('[https] Generating self-signed cert...');
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" -days 365 -nodes -subj "/CN=travel-buddy-local"`,
      { stdio: 'pipe' }
    );
    console.log('[https] cert.pem + key.pem created.');
    return true;
  } catch (e) {
    console.warn('[https] openssl unavailable — HTTPS disabled. Install openssl to enable phone camera/mic.');
    return false;
  }
}

const SYSTEM_PROMPT = `You are travel buddy, an AI assistant inside the bunq travel banking app. You help travelers with money, splits, and trip context.

CURRENT TRIP CONTEXT:
- Location: Tokyo, day 2 of 6
- Restaurant just settled: Izakaya Sakura, Shibuya
- Bill total: \u00a514,100 \u2248 \u20ac88.13 (1 EUR = 160.01 JPY)
- Diners: the user, Julia (bunq user, ate but skipped drinks), Marco (not on bunq, drinks only)
- Items ordered: karaage \u00a51,200, sashimi platter \u00a53,500, yakitori 6 skewers \u00a51,800, gyoza \u00a5900, beer x 3 \u00a52,400, sake bottle \u00a52,800, water \u00a5600, otoshi/cover charge x 3 \u00a5900
- Voice instruction was: "Julia didn't drink, Marco only had drinks, split the food with me"
- Final split: Julia \u20ac23.13, Marco \u20ac36.25, user \u20ac28.75
- Status: real bunq request sent to Julia, payment link sent to Marco
- Travel buddies the user splits with often: Julia (12 splits, bunq), Marco (8 splits, external link), Ana (5 splits, bunq)
- Recent trips logged: Lisbon \u20ac142.30, Bali \u20ac438.00, Paris \u20ac88.50
- This trip plants 2 trees via bunq's veritree partnership

ABOUT TRAVEL BUDDY:
- A multi-agent assistant inside bunq, built on Claude via Amazon Bedrock
- Specialist agents: Vision (OCR), Translate (38 languages), FX (live rates), Group (Tricount contacts), Split (per-diner math), Payment (bunq + universal link)
- Tricount is bunq's bill-splitting product; group memory comes from there
- bunq is always written lowercase
- bunq is the EU bank built for digital nomads

YOUR STYLE:
- Concise: 1-3 sentences unless the question genuinely needs more
- Warm but efficient, like a smart friend who's done this many times
- Use both \u00a5 and \u20ac when relevant; be precise with numbers
- Stay on topic \u2014 travel, spending, this trip, bunq features. If asked something unrelated, gently redirect
- Don't invent data. If asked for info you don't have, say so plainly`;

function loadOrCreateKeys() {
  if (fs.existsSync(KEYS_FILE)) {
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  }
  console.log('[bunq] Generating RSA-2048 keypair...');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const keys = { publicKey, privateKey };
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
  return keys;
}

function loadContext() {
  if (fs.existsSync(CONTEXT_FILE)) {
    return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
  }
  return {};
}

function saveContext(ctx) {
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2));
}

function bunqRequest({ method, reqPath, body, authToken, privateKey, sign }) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'User-Agent': 'travel-buddy-demo/1.0',
    'X-Bunq-Language': 'en_US',
    'X-Bunq-Region': 'nl_NL',
    'X-Bunq-Client-Request-Id': crypto.randomUUID(),
    'X-Bunq-Geolocation': '0 0 0 0 000',
  };
  if (authToken) headers['X-Bunq-Client-Authentication'] = authToken;
  if (sign && privateKey && bodyStr) {
    const sig = crypto.sign('RSA-SHA256', Buffer.from(bodyStr, 'utf8'), privateKey);
    headers['X-Bunq-Client-Signature'] = sig.toString('base64');
  }
  if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: API_HOST, port: 443, path: reqPath, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`${res.statusCode} ${res.statusMessage}: ${data}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Parse error (${res.statusCode}): ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function anthropicRequest(messages) {
  const body = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 250,
    system: SYSTEM_PROMPT,
    messages,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`${res.statusCode}: ${data}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Parse error: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function setupContext() {
  const keys = loadOrCreateKeys();
  const ctx = loadContext();

  if (!ctx.installationToken) {
    console.log('[bunq] Creating installation...');
    const res = await bunqRequest({
      method: 'POST',
      reqPath: '/v1/installation',
      body: { client_public_key: keys.publicKey },
      sign: false,
    });
    for (const item of res.Response) {
      if (item.Token) ctx.installationToken = item.Token.token;
      if (item.ServerPublicKey) ctx.serverPublicKey = item.ServerPublicKey.server_public_key;
    }
    saveContext(ctx);
    console.log('[bunq] Installation token stored.');
  }

  if (!ctx.deviceRegistered) {
    console.log('[bunq] Registering device-server...');
    await bunqRequest({
      method: 'POST',
      reqPath: '/v1/device-server',
      body: {
        description: 'travel buddy hackathon demo',
        secret: API_KEY,
        permitted_ips: ['*'],
      },
      authToken: ctx.installationToken,
      privateKey: keys.privateKey,
      sign: true,
    });
    ctx.deviceRegistered = true;
    saveContext(ctx);
    console.log('[bunq] Device registered.');
  }

  console.log('[bunq] Starting fresh session-server...');
  const sess = await bunqRequest({
    method: 'POST',
    reqPath: '/v1/session-server',
    body: { secret: API_KEY },
    authToken: ctx.installationToken,
    privateKey: keys.privateKey,
    sign: true,
  });
  for (const item of sess.Response) {
    if (item.Token) ctx.sessionToken = item.Token.token;
    const userObj = item.UserPerson || item.UserCompany || item.UserApiKey || item.UserLight;
    if (userObj) ctx.userId = userObj.id;
  }
  if (!ctx.sessionToken || !ctx.userId) {
    throw new Error('Failed to start session: ' + JSON.stringify(sess));
  }
  console.log(`[bunq] Session ok. User ID: ${ctx.userId}`);

  console.log('[bunq] Fetching monetary accounts...');
  const accRes = await bunqRequest({
    method: 'GET',
    reqPath: `/v1/user/${ctx.userId}/monetary-account`,
    authToken: ctx.sessionToken,
    privateKey: keys.privateKey,
    sign: false,
  });
  let chosen = null;
  for (const row of accRes.Response) {
    const acc = row.MonetaryAccountBank || row.MonetaryAccountJoint || row.MonetaryAccountLight || row.MonetaryAccountSavings;
    if (acc && acc.status === 'ACTIVE') { chosen = acc; break; }
  }
  if (!chosen) throw new Error('No active monetary account found');
  ctx.accountId = chosen.id;
  ctx.balance = chosen.balance;
  ctx.accountDesc = chosen.description || 'bunq sandbox account';
  console.log(`[bunq] Using account #${ctx.accountId} (${ctx.accountDesc}) — balance ${chosen.balance.currency} ${chosen.balance.value}`);

  return { ctx, keys };
}

async function createRequestInquiry({ ctx, keys, amount, currency, email, description }) {
  const body = {
    amount_inquired: { value: amount, currency: currency || 'EUR' },
    counterparty_alias: { type: 'EMAIL', value: email, name: 'Julia' },
    description: description,
    allow_bunqme: true,
  };
  const res = await bunqRequest({
    method: 'POST',
    reqPath: `/v1/user/${ctx.userId}/monetary-account/${ctx.accountId}/request-inquiry`,
    body,
    authToken: ctx.sessionToken,
    privateKey: keys.privateKey,
    sign: true,
  });
  const id = res.Response?.[0]?.Id?.id;
  return { id, raw: res };
}

let state = null;

async function main() {
  console.log('Booting travel buddy proxy...');
  if (!API_KEY)        console.warn('[bunq] BUNQ_API_KEY not set — bunq endpoints will fail.');
  if (!ANTHROPIC_KEY)  console.warn('[anthropic] ANTHROPIC_API_KEY not set — AI features disabled.');
  else                 console.log('[anthropic] ANTHROPIC_API_KEY found — AI live.');
  try {
    state = await setupContext();
    console.log(`[bunq] READY — balance ${state.ctx.balance.currency} ${state.ctx.balance.value}`);
  } catch (err) {
    console.error('[bunq] Setup FAILED:', err.message);
    console.error('[bunq] Delete bunq-context.json + bunq-keys.json and restart to reset.');
  }

  const localIP = getLocalIP();
  const certOk  = ensureCert();

  http.createServer(handleRequest).listen(PORT, () => {
    console.log(`\n  Laptop:  http://localhost:${PORT}`);
  });

  if (certOk && fs.existsSync(CERT_FILE)) {
    https.createServer(
      { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) },
      handleRequest
    ).listen(PORT_HTTPS, () => {
      console.log(`  📱 Phone:  https://${localIP}:${PORT_HTTPS}`);
      console.log(`  ⚠️  Tap "Advanced → Proceed" on the browser security warning (self-signed cert).\n`);
    });
  }
}

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Serve HTML ──────────────────────────────────────────────
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    if (fs.existsSync(HTML_FILE)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(HTML_FILE).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('travel-buddy.html not found');
    }
    return;
  }

  // ── Health ──────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: !!state, chatLive: !!ANTHROPIC_KEY,
      userId: state?.ctx.userId || null,
      accountId: state?.ctx.accountId || null,
      accountDesc: state?.ctx.accountDesc || null,
      balance: state?.ctx.balance || null,
    }));
    return;
  }

  // ── Collect POST body helper ────────────────────────────────
  function collectBody() {
    return new Promise(resolve => {
      let b = '';
      req.on('data', c => (b += c));
      req.on('end', () => resolve(b));
    });
  }

  // ── /request-money ──────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/request-money') {
    if (!state) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bunq not ready' })); return; }
    try {
      const input = JSON.parse(await collectBody() || '{}');
      const amount   = input.amount || '23.13';
      const currency = input.currency || 'EUR';
      const email    = input.email || 'sara.demo@bunq.com';
      const desc     = input.description || 'Dinner — Sara share';
      console.log(`[bunq] request-inquiry: ${currency} ${amount} → ${email}`);
      const result = await createRequestInquiry({ ctx: state.ctx, keys: state.keys, amount, currency, email, description: desc });
      console.log(`[bunq] created id ${result.id}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, requestId: result.id, amount, currency, email }));
    } catch (err) {
      console.error('[bunq] request-money failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── /chat ───────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/chat') {
    if (!ANTHROPIC_KEY) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no key' })); return; }
    try {
      const input    = JSON.parse(await collectBody() || '{}');
      const messages = input.messages || (input.question ? [{ role: 'user', content: input.question }] : []);
      if (!messages.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no messages' })); return; }
      console.log(`[chat] "${messages.at(-1)?.content?.slice?.(0,80)}"`);
      const result = await anthropicRequest(messages);
      const reply  = result.content?.find(b => b.type === 'text')?.text || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reply }));
    } catch (err) {
      console.error('[chat] failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── /upload-audio ───────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/upload-audio') {
    if (!ANTHROPIC_KEY) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no key' })); return; }
    let mime = 'audio/webm';
    try {
      const input    = JSON.parse(await collectBody() || '{}');
      const audioB64 = input.audio;
      mime           = input.mimeType || 'audio/webm';
      if (!audioB64) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no audio' })); return; }
      console.log(`[audio] transcribing ${Math.round(audioB64.length * 0.75 / 1024)}KB of ${mime}`);

      const body = JSON.stringify({
        model: 'claude-sonnet-4-5', max_tokens: 300,
        system: 'Transcribe this audio exactly as spoken in English. Return ONLY the transcript — no quotes, no labels. If inaudible: [inaudible]',
        messages: [{ role: 'user', content: [
          { type: 'audio', source: { type: 'base64', media_type: mime, data: audioB64 } },
          { type: 'text', text: 'Transcribe this voice note.' },
        ]}],
      });
      const transcript = await callAnthropic(body);
      console.log(`[audio] → "${transcript.slice(0,100)}"`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, transcript }));
    } catch (err) {
      console.error('[audio] failed:', err.message);
      const msg = String(err.message || 'audio transcription failed');
      if (msg.includes('media_type') || msg.includes('invalid_request_error') || msg.includes('Input should be')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Audio transcription via Anthropic is unsupported for ${mime} in this endpoint. Use browser speech recognition.` }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
      }
    }
    return;
  }

  // ── /analyze-image ──────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/analyze-image') {
    if (!ANTHROPIC_KEY) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no key' })); return; }
    try {
      const input      = JSON.parse(await collectBody() || '{}');
      const imageB64   = input.image;
      const transcript = input.transcript || '';
      const imgMime    = input.mimeType || 'image/jpeg';
      if (!imageB64) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no image' })); return; }
      console.log(`[vision] analyzing ${Math.round(imageB64.length * 0.75 / 1024)}KB image`);
      console.log(`[vision] voice: "${transcript.slice(0,120)}"`);

      const prompt = `You are analyzing a restaurant bill image plus a voice note to compute a fair split.

Voice note: "${transcript}"

Study the bill carefully. Extract every line item with its original name and price.

Then use the voice note to assign items to each person named. Unmentioned shared items split equally. The last person in the "people" array is always "Alex" (the person who paid at the table — they owe nothing to collect, but their items are listed).

IMPORTANT: Return ONLY valid JSON — no markdown fences, no commentary.

{
  "restaurant": "name from bill",
  "detected_language": "e.g. Japanese, Thai, Italian — the language the bill is written in",
  "bill_currency": "currency symbol exactly as on the bill, e.g. ¥ or ฿ or $ or €",
  "bill_currency_code": "ISO code e.g. JPY, THB, USD, EUR",
  "total_bill": 0,
  "total_bill_eur": 0,
  "fx_rate": "e.g. 1 EUR = 160 JPY — empty string if bill is already in EUR",
  "translate_label": "e.g. JP → EN or TH → EN — source language code to EN",
  "items": [
    { "name_original": "original text", "name_en": "English name", "price_original": 0, "price_eur": 0, "assigned_to": "person name or shared" }
  ],
  "people": [
    { "name": "Sara", "subtotal_original": 0, "subtotal_eur": 0, "note": "what they had" },
    { "name": "Marco", "subtotal_original": 0, "subtotal_eur": 0, "note": "what they had" },
    { "name": "Alex", "subtotal_original": 0, "subtotal_eur": 0, "note": "paid at table" }
  ],
  "confidence": "high | medium | low"
}`;

      const reqBody = JSON.stringify({
        model: 'claude-sonnet-4-5', max_tokens: 1500,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: imgMime, data: imageB64 } },
          { type: 'text', text: prompt },
        ]}],
      });
      const raw   = await callAnthropic(reqBody);
      const clean = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
      const split = JSON.parse(clean);
      console.log(`[vision] ${split.detected_language} bill, ${split.bill_currency}${split.total_bill} → €${split.total_bill_eur} | ${split.people?.length} people`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, split }));
    } catch (err) {
      console.error('[vision] failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// ── Shared Anthropic caller ─────────────────────────────────
function callAnthropic(bodyStr) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', c => (data += c));
      apiRes.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (apiRes.statusCode >= 400) return reject(new Error(`${apiRes.statusCode}: ${data}`));
          resolve((p.content?.find(b => b.type === 'text')?.text || '').trim());
        } catch (e) { reject(new Error('parse: ' + data)); }
      });
    });
    r.on('error', reject);
    r.write(bodyStr);
    r.end();
  });
}

main();
