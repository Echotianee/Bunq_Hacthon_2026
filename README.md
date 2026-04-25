# travel buddy — bunq hackathon 2026

A multi-modal travel assistant for bunq with real bunq sandbox integration and live Claude chat.

## What this is

Four files:

- `bunq-proxy.js` — Node.js server that handles the bunq sandbox handshake, exposes `POST /request-money` for real bunq payment requests, and exposes `POST /chat` for real Claude responses
- `travel-buddy.html` — the demo UI: 6 scenes, multi-agent visualization, editable inputs, chat dock
- `.env.example` — template for your secret keys (copy to `.env` and fill in)
- `.gitignore` — keeps `.env` and other generated files out of git

No npm dependencies. Pure Node built-ins.

## Setup

### 1. Requirements

- Node.js 18 or newer (`node -v` to check)
- A bunq sandbox API key (see "Get a fresh bunq sandbox key" below)
- Optional: an Anthropic API key for live chat — get one at https://console.anthropic.com/settings/keys

### 2. Configure your keys

Copy the template and fill it in:

```bash
cp .env.example .env
```

Then edit `.env` in your editor. Replace the placeholder values with your real keys:

```
BUNQ_API_KEY=sandbox_e2912788dbfbb19f8669be3922bdf1f6cbe13be0a9ec68b73cefdd10
ANTHROPIC_API_KEY=sk-ant-api03-...your-real-key
```

The proxy reads `.env` automatically on startup. Don't commit this file — it's already in `.gitignore`.

### 3. Run

```bash
node bunq-proxy.js
```

First-run output:

```
Booting travel buddy proxy...
[anthropic] ANTHROPIC_API_KEY found — /chat live.
[bunq] Generating RSA-2048 keypair...
[bunq] Creating installation...
[bunq] Installation token stored.
[bunq] Registering device-server...
[bunq] Device registered.
[bunq] Starting fresh session-server...
[bunq] Session ok. User ID: 3628753
[bunq] Fetching monetary accounts...
[bunq] Using account #4529181 (bunq account) — balance EUR 500.00
[bunq] READY — balance EUR 500.00

  Demo + proxy live at:  http://localhost:3000
```

### 4. Open the demo

Go to `http://localhost:3000`. The banner at the top confirms what's connected:

- `Live · connected to bunq sandbox · EUR 500.00 · chat live` — both integrations working
- `Live · connected to bunq sandbox · EUR 500.00 · chat scripted` — bunq works, Claude not configured (chat falls back to scripted answers)
- `Mock mode · bunq proxy not reachable` — proxy isn't running

## Get a fresh bunq sandbox key

Sandbox keys can become invalid after bunq resets the sandbox. If your existing key fails the handshake, generate a new one with one curl call:

```bash
curl -X POST https://public-api.sandbox.bunq.com/v1/sandbox-user-person \
  -H "Content-Type: application/json" \
  -H "Cache-Control: none" \
  -H "User-Agent: hackathon" \
  -H "X-Bunq-Client-Request-Id: $(date +%s)" \
  -H "X-Bunq-Language: en_US" \
  -H "X-Bunq-Region: nl_NL" \
  -H "X-Bunq-Geolocation: 0 0 0 0 000" \
  -d '{}'
```

In the response, find `api_key` — that's your fresh sandbox key. Update your `.env` file with it. Note the email alias under the `alias` array — that's a real verified sandbox email you can use as a counterparty.

If swapping keys, also wipe the cache so the handshake re-runs:

```bash
rm bunq-keys.json bunq-context.json
node bunq-proxy.js
```

## Verify it all works

In a second terminal, with the proxy running:

```bash
curl http://localhost:3000/health
```

Expected response includes `"ok":true`, your user ID, account ID, and balance.

Test the bunq endpoint:

```bash
curl -X POST http://localhost:3000/request-money \
  -H "Content-Type: application/json" \
  -d '{"amount":"1.00","currency":"EUR","email":"test+...@bunq.com","description":"sanity check"}'
```

Should return `{"ok":true,"requestId":<some-number>,...}`.

Test the chat endpoint:

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"question":"What did Marco order?"}'
```

Should return `{"ok":true,"reply":"Marco only had drinks: ..."}`.

## How the demo flows

Six scenes, advanced by the dark button at the bottom:

1. **Welcome** — proactive Tokyo detection, travel buddies, recent trips
2. **Menu** — Japanese menu translated to English with EUR prices, saved to trip memory
3. **Capture** — bill snapshot + editable voice transcript
4. **Working** — orchestrator + 6 specialist agents animate sequentially
5. **Split** — per-diner amounts, editable amounts, personalized messages, payment options (bunq recommended), inline chat
6. **Paid** — Marco reminder card, Tricount + tree footprint, inline chat

The "Live" moment: clicking `Request €23.13 via bunq` on Julia's row in scene 5 creates a real bunq sandbox request-inquiry. The success screen shows the real request ID.

## Customizing the demo

### Change the scenario (city, restaurant, amounts)

Open `travel-buddy.html` and edit:

- Header pill, scene headings: search for "Tokyo", "Shinjuku", "Izakaya Sakura"
- Receipt items: the inline `<svg>` in scene 2
- Voice note: the `.voice-text` div in scene 2
- Per-person amounts: the `.person` rows in scene 4
- FX rate: "1 EUR = 160.01 JPY" in scene 4

If you change the trip context, also update the `SYSTEM_PROMPT` constant at the top of `bunq-proxy.js` so Claude has matching context for the chat box.

### Change the request amount

Edit the `payJulia` function in the `<script>` tag — the body of the fetch call.

## Troubleshooting

**Banner says "Mock mode"** — proxy isn't running. Check the terminal where you ran `node bunq-proxy.js`.

**Banner says "chat scripted" instead of "chat live"** — `ANTHROPIC_API_KEY` not set. Add it to `.env` and restart the proxy.

**bunq setup fails after working before** — sandbox reset. Run `rm bunq-keys.json bunq-context.json && node bunq-proxy.js`.

**Chat returns the scripted fallback even with a key set** — check the proxy console for `[anthropic] chat failed`. Most likely a bad key or quota issue. Test directly:

```bash
curl -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d '{"question":"hello"}'
```

The error message will tell you what bunq or Anthropic returned.

**Browser can't reach localhost:3000** — try `http://127.0.0.1:3000`. Some local firewalls block `localhost`.

## Security notes

- `.env` contains real secrets. It's in `.gitignore` and must never be committed.
- `bunq-keys.json` contains your RSA private key for the bunq handshake. Also gitignored.
- The bunq sandbox key only works on bunq's test environment with fake money. The Anthropic key is real money — guard it like a credit card. Rotate immediately if it ever leaks.
- For production, secrets would live in a proper secret manager (AWS Secrets Manager, GCP Secret Manager, etc.), not a `.env` file.

## What's mocked, what's real

| Part | Status |
|---|---|
| Proactive "Tokyo detected" | Mock (hardcoded) |
| Receipt OCR | Mock (SVG image) |
| Japanese → English translation | Mock (hardcoded) |
| JPY → EUR conversion | Mock rate (1 EUR = 160.01 JPY) |
| Agent animation | UI only — no actual orchestrator running |
| Split math | Hardcoded amounts |
| **Julia's bunq request** | **Real bunq sandbox request-inquiry** |
| **Chat box** | **Real Claude (Haiku 4.5) when ANTHROPIC_API_KEY is set** |
| Marco's payment link | Mock |
| Tricount logging | Mock |
| Real sandbox balance | Real (pulled from /health) |

Two real integrations is enough to make the demo credible without making it fragile.
