# Finn Abroad — live bunq demo

A multi-modal travel assistant for bunq, with real bunq sandbox integration for the hero payment moment.

## What this is

Three files:

- `bunq-proxy.js` — tiny Node.js server that handles the bunq sandbox handshake (installation → device → session) and exposes `POST /request-money`.
- `finn-abroad-live.html` — the demo UI. Shows the 5 scenes (welcome → capture → agents → split → paid). Julia's "Request via bunq" button calls the proxy, which creates a real request-inquiry in the sandbox. Falls back silently to mock mode if the proxy is unreachable.
- `README.md` — this file.

No npm dependencies. Pure Node built-ins (`http`, `https`, `crypto`, `fs`).

## Setup

### 1. Requirements

- Node.js 18 or newer (`node -v` to check).
- The three files above in one folder.
- Internet access to reach `public-api.sandbox.bunq.com`.

### 2. Run

```bash
node bunq-proxy.js
```

First run output should look like:

```
Booting Finn Abroad bunq proxy...
[bunq] Generating RSA-2048 keypair...
[bunq] Creating installation...
[bunq] Installation token stored.
[bunq] Registering device-server...
[bunq] Device registered.
[bunq] Starting fresh session-server...
[bunq] Session ok. User ID: 1823455
[bunq] Fetching monetary accounts...
[bunq] Using account #4529181 (bunq account) — balance EUR 500.00
[bunq] READY — balance EUR 500.00

  Proxy + demo live at:  http://localhost:3000
  Health check:          http://localhost:3000/health
```

### 3. Open the demo

Open `http://localhost:3000` in your browser. A green "Live" banner at the top confirms the proxy is connected to your sandbox account.

### 4. Run the demo

Tap the dark button at the bottom of the phone mockup to advance through the 5 scenes. On scene 4 ("Split ready"), tap `Request €23.13 via bunq` on Julia's row — the proxy creates a real `request-inquiry` in the bunq sandbox and the success screen shows the real request ID.

## Troubleshooting

### The banner says "Mock mode · proxy not reachable"

Proxy isn't running, or isn't on port 3000. Start it with `node bunq-proxy.js`.

### Proxy fails at installation

Your API key may be wrong or the sandbox may have reset. To force a clean handshake:

```bash
rm bunq-keys.json bunq-context.json
node bunq-proxy.js
```

### Proxy fails at session-server

Most often "sandbox reset" — sandbox gets wiped periodically and old installations become invalid. Run the clean command above.

### Need a different API key

Either edit the `API_KEY` constant at the top of `bunq-proxy.js`, or run with the env var:

```bash
BUNQ_API_KEY=sandbox_yourkeyhere node bunq-proxy.js
```

Remember to `rm bunq-context.json` when swapping keys so the handshake runs fresh.

### Request-inquiry fails

Check the proxy console — bunq returns a JSON error with a clear message. Common causes:
- Counterparty email format invalid
- Amount format wrong (needs to be a string like `"23.13"`, not a number)
- Session expired — restart the proxy

### Browser can't reach localhost:3000

- Check firewall isn't blocking local connections.
- Try `http://127.0.0.1:3000` instead of `http://localhost:3000`.

## Customizing the demo

### Change the scenario (city, restaurant, amounts)

Open `finn-abroad-live.html` and edit:

- Header pill and scene headings → search for "Tokyo", "Shinjuku", "Izakaya Sakura"
- Receipt items and prices → the inline `<svg>` in scene 1
- Voice note → the `.voice` div in scene 1
- Per-person amounts → the `.person` rows in scene 3
- FX rate display → "1 EUR = 160.01 JPY" in scene 3

### Change the request amount

Edit the `payJulia` function in the `<script>` tag:

```js
body: JSON.stringify({
  amount: '23.13',      // change this
  currency: 'EUR',
  email: 'julia.demo@bunq.com',
  description: '...'
})
```

### Change the agent narration

Edit the `statusLines` array in the `<script>` tag.

## Security notes

- The API key in this repo is a **sandbox** key — it only touches bunq's test environment with fake money. No real financial exposure.
- Do not check this repo into public GitHub with a production key embedded. Use the `BUNQ_API_KEY` env var instead.
- `bunq-keys.json` contains your RSA private key. Treat it like any other secret — don't commit it, don't share it.

## What's mocked, what's real

| Part | Real or mock |
|---|---|
| Proactive "Tokyo detected" | Mock (hardcoded) |
| Receipt OCR | Mock (SVG image, hardcoded items) |
| Japanese → English translation | Mock (hardcoded) |
| JPY → EUR conversion | Mock rate (1 EUR = 160.01 JPY) |
| Agent animation | UI only — no actual orchestrator running |
| Split math for Julia/Marco/You | Hardcoded amounts |
| **Julia's bunq request** | **Real bunq sandbox request-inquiry** |
| Marco's payment link | Mock (no real link generated) |
| Tricount logging | Mock (just a visual card) |
| Real sandbox balance display | Real (pulled from /health) |

The "hero moment" is real — everything else is deterministic for demo reliability.

## Extending further

Good next additions, in order of impact vs effort:

1. **Real Claude call for the Translate agent** — a quick way to make the agent animation feel genuine. Use the Anthropic API with a vision model on an uploaded receipt image.
2. **Real FX rate** — hit `exchangerate.host` (free, no auth) for a live JPY→EUR rate.
3. **Real Tricount API** — if you have access to it during the hackathon, log the expense for real.
4. **Polling for the request-inquiry status** — after the proxy creates the request, poll every 2s until Julia's status becomes `ACCEPTED`, then update the success screen. Makes the demo feel even more alive.
