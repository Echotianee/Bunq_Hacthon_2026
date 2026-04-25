const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.BUNQ_API_KEY || '';
const API_HOST = 'public-api.sandbox.bunq.com';
const PORT = 3000;

const KEYS_FILE = path.join(__dirname, 'bunq-keys.json');
const CONTEXT_FILE = path.join(__dirname, 'bunq-context.json');
const HTML_FILE = path.join(__dirname, 'finn-abroad-live.html');

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

function apiRequest({ method, reqPath, body, authToken, privateKey, sign }) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'User-Agent': 'finn-abroad-demo/1.0',
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

async function setupContext() {
  const keys = loadOrCreateKeys();
  const ctx = loadContext();

  if (!ctx.installationToken) {
    console.log('[bunq] Creating installation...');
    const res = await apiRequest({
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
    await apiRequest({
      method: 'POST',
      reqPath: '/v1/device-server',
      body: {
        description: 'Finn Abroad hackathon demo',
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
  const sess = await apiRequest({
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
  const accRes = await apiRequest({
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
  const res = await apiRequest({
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
  console.log('Booting Finn Abroad bunq proxy...');
  try {
    state = await setupContext();
    console.log(`[bunq] READY — balance ${state.ctx.balance.currency} ${state.ctx.balance.value}`);
  } catch (err) {
    console.error('[bunq] Setup FAILED:', err.message);
    console.error('[bunq] Server will start anyway; /request-money will return 503.');
    console.error('[bunq] If the sandbox reset, delete bunq-context.json and restart.');
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      if (fs.existsSync(HTML_FILE)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(HTML_FILE).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('finn-abroad-live.html not found next to bunq-proxy.js');
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: !!state,
        userId: state?.ctx.userId || null,
        accountId: state?.ctx.accountId || null,
        accountDesc: state?.ctx.accountDesc || null,
        balance: state?.ctx.balance || null,
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/request-money') {
      if (!state) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bunq context not ready' }));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const input = JSON.parse(body || '{}');
          const amount = input.amount || '23.13';
          const currency = input.currency || 'EUR';
          const email = input.email || 'julia.demo@bunq.com';
          const description = input.description || 'Izakaya Sakura — Julia share';
          console.log(`[bunq] Creating request-inquiry: ${currency} ${amount} to ${email}`);
          const result = await createRequestInquiry({ ctx: state.ctx, keys: state.keys, amount, currency, email, description });
          console.log(`[bunq] Request created with id ${result.id}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, requestId: result.id, amount, currency, email }));
        } catch (err) {
          console.error('[bunq] request-money failed:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(PORT, () => {
    console.log(`\n  Proxy + demo live at:  http://localhost:${PORT}`);
    console.log(`  Health check:          http://localhost:${PORT}/health`);
    console.log(`  Press Ctrl+C to stop.\n`);
  });
}

main();
