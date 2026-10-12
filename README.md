# ITEMDEX: Gotta catalog 'em all

Turn photos/videos of your stuff into retro, Pokémon-style collectible cards.
An AI vision model (Claude, DeepSeek, Gemini, Gemma, OpenAI, Ollama, ... your choice) identifies the item, estimates its size, weight, condition and
second-hand market value, and invents two "moves" for the card. Each card also
remembers where the item was **last seen** (place name + GPS).

One codebase, three ways to run it:

| | What | How |
| --- | --- | --- |
| **Web** | Responsive web app (desktop + phone, installable as PWA) served by the service | `npm run build && npm start` |
| **Desktop** | Electron app; runs the service in-process, no browser needed | `npm run desktop` / `npm run dist:desktop` |
| **Service only** | REST API for other apps (mobile, bots, another web) | `SERVE_UI=false npm start` or Docker |

## Stack

```text
packages/shared   TypeScript types, enums, card normalization (used by server + web)
apps/server       Fastify 5 + PostgreSQL (pg), AI client, migrations, Swagger docs
apps/web          React 19 + Vite + TanStack Query, retro CSS, live camera (livecam.ts)
apps/desktop      Electron shell: bundles server + web into one 1 MB main.cjs (no node_modules)
docs/             API.md (integration guide, Bahasa Indonesia), openapi.yaml
```

Why it stays light and smooth:

- Collection is paginated, searched and sorted **in PostgreSQL**; the grid loads 360px
  thumbnails (generated in the browser before upload) and skips off-screen cards
  (`content-visibility`), so thousands of items scroll fine on a phone.
- Images live in their own table and are served with `Cache-Control: immutable`.
- The live viewfinder draws on a canvas outside React and pauses when the tab is hidden.
- Fonts are self-hosted (works offline in the desktop app); JS is ~95 KB gzipped.
- The desktop app runs the service inside Electron's main process (no second Node process).

## Beyond the card

| Feature | Where | Notes |
| --- | --- | --- |
| Sale listing | item → SELL IT | `POST /items/:id/listing` (generic, tokopedia, facebook, ebay) |
| Inventory report | COLLECTION → CSV / REPORT | `GET /report?format=csv\|html` (HTML → Save as PDF) |
| Room scan | SCAN → ROOM | `POST /scan/room`: one photo, a card per item |
| Price check | cart icon → log in, then item → CHECK ON SHOPEE | `POST /items/:id/comps`; uses your saved Shopee session, sets the value from 3+ listings (IDR only). Without a session the value stays the AI estimate |
| AI server settings | ⚙ icon in the header | provider presets (Claude, DeepSeek, Gemini, OpenAI, Ollama, custom), URL, API key and model; test button lists its models. Saved in the database and overrides `LLM_*`. With accounts, only the first account may change it |
| Ask in plain words | COLLECTION → ASK | `POST /ask` returns filters for `GET /items` |
| Households | sign-in screen | `ACCOUNTS=true`; share the invite code to share a collection |
| Lent out | item → LENT OUT | `PUT/DELETE /items/:id/lend`, OVERDUE chip in the collection |
| Receipt + warranty | item → PURCHASE | `POST /items/:id/receipt`, `PUT /items/:id/purchase` |
| Price history | item → value chart | SELL NOW flags items at their peak (10%+ above first value) |
| Locale | header selector | language, currency and market per scan (card text only; the UI stays English) |

All endpoints are in [docs/API.md](docs/API.md) (Bahasa Indonesia) and Swagger at `/api/docs`.
`npm run smoke -w @itemdex/server` runs an end-to-end check against an empty scratch database
(`DATABASE_URL`) with a fake AI server.

### Choosing the AI model

The model must be able to **read images**. Pick a provider in the app (⚙ icon) or set the values in `.env`:

| Provider | URL | Key | Notes |
| --- | --- | --- | --- |
| Claude (Anthropic API) | `https://api.anthropic.com` | API key from console.anthropic.com | Native Claude API, JSON via forced tool use. Pay per use. |
| DeepSeek | `https://api.deepseek.com` | API key from platform.deepseek.com | `deepseek-chat` is text-only and fails the image check; use the vision model that TEST lists. |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | API key from aistudio.google.com | Free tier available. |
| OpenAI | `https://api.openai.com/v1` | API key | e.g. `gpt-4o-mini`. |
| Ollama (local) | `http://localhost:11434` | none | Vision models only: `llava`, `gemma3`, `qwen2.5vl`. |
| Gemma on vLLM, LM Studio, OpenRouter, ... | your server | optional | Anything with `/chat/completions` and image input. |

A bare host such as `https://api.deepseek.com` gets `/v1` added; a URL with a path is used as written.

**Claude subscription (Pro/Max): not possible.** Anthropic only allows subscription logins in Claude Code and
claude.ai, not in other apps, so ITEMDEX needs an API key (pay per use, billed separately from the subscription).
**Google Antigravity: no API.** It is an IDE; the matching option is Google Gemini above, which uses the same models.

Either set `LLM_API_BASE`, `LLM_API_KEY` and `LLM_MODEL` in `.env`, or open the **⚙ icon** in the app,
fill URL, model and key, press **TEST** (it lists the models the server offers) and **SAVE**. The change applies
immediately. Values saved in the app are stored in the database and override `.env`. **TEST** checks the server, the key,
that the model exists, and that it accepts an image. Small models give poor cards, and the live viewfinder
wants a fast one (~1s per frame): prefer a "flash" or "haiku" class model for scanning.

Not tested against the real Claude, DeepSeek and Gemini services (no keys here): the request formats follow their
docs and are covered by offline tests, so report any provider that fails the TEST button.

### Optional: Shopee price check

The AI's price is an estimate. To check a price against real Shopee listings:

```bash
npx playwright-core install chromium   # once
```

Then click the **🛒 icon** in the app and log in to Shopee in the window that opens (you type your own password;
only the browser session is saved to `.itemdex/shopee-state.json`, which is git-ignored). Items priced in IDR now
have a **CHECK ON SHOPEE** button. Without the session, values stay the AI estimate. Shopee may block automated
browsers or limit the account, so use a spare account. This works only when the service runs on your own computer
(not in Docker or the packaged desktop app).

### Optional: accounts and households

`ACCOUNTS=true` replaces `ITEMDEX_API_KEY` with email + password sign-in. Each account belongs to a household that
shares one collection; share the invite code (☺ icon) to add someone. Only the first account can change the AI server.
There is no login rate limit yet: add one before exposing the service publicly.

## Setup

Requirements: Node **20.19+** (22 recommended, see `.nvmrc`), PostgreSQL 13+.

```bash
nvm use            # or any Node >= 20.19
npm install
cp .env.example .env   # then fill DATABASE_URL (LLM_* optional: set the AI server in the app instead)
```

`DATABASE_URL` points at your database, e.g.
`postgres://postgres:PASSWORD@localhost:5432/itemdex-ai-builder`.
Tables are created automatically on first start (`npm run db:migrate` does it manually).

Bring over data from the old JSON version (v0.1):

```bash
npm run db:import-legacy                 # old desktop data folder (default)
npm run db:import-legacy -- ./data       # or any folder with items.json + media/
```

## Run

```bash
npm run dev          # service :7777 + web with hot reload at http://localhost:5173
npm run build        # build service + web
npm start            # production: service + web at http://127.0.0.1:7777
npm run desktop      # build and open the Electron app
npm run dist:desktop # installer in apps/desktop/release (.dmg / .exe / .AppImage)
npm run typecheck
```

Phone on the same Wi-Fi: `npm run dev` already listens on the network. Open
`http://<laptop-ip>:5173`. Camera and GPS in mobile browsers need **HTTPS**, so
use a tunnel or a reverse proxy with TLS for real phone use.

### Desktop config

The desktop app reads `itemdex.env` from its data folder
(macOS: `~/Library/Application Support/ITEMDEX/itemdex.env`), which is created on first run.
If the database is unreachable it shows a dialog with a button to open that file.
Set `ITEMDEX_SERVER_URL=https://...` there to use a hosted service instead of a local one.

Unsigned builds: macOS shows "unidentified developer" on first open (right-click → Open).

## Deploy the service separately

```bash
docker build -t itemdex .
docker run -p 7777:7777 --env-file .env -e DATABASE_URL=postgres://... itemdex
```

For an API-only server (web hosted elsewhere, or only mobile clients):

```bash
HOST=0.0.0.0 ITEMDEX_API_KEY=some-long-key CORS_ORIGINS=https://your-web.app SERVE_UI=false npm start
```

A separately hosted web build points at it with `VITE_API_URL=https://api.example.com npm run build -w @itemdex/web`.
Full API guide: [docs/API.md](docs/API.md) · Swagger: `http://localhost:7777/api/docs`.

## Demo flow

1. **SCAN** opens the live camera viewfinder (⟲ switches front/back camera on phones).
   The AI watches the frame (~0.6s per check) and draws a box + label on the item it sees.
   - **AUTO SNAP**: hold the item steady; once it is seen twice in a row and the camera is
     still for ~1.2s the lock bar fills, it snaps and scans by itself.
   - **MANUAL**: press **SNAP** (or Space) for each angle, then **SCAN**.
   - No camera? **⇪ PHOTO / ⇪ VIDEO** upload (or drag & drop onto the viewfinder).
2. Card flips in (~5s) → **SAVE TO DEX** → back to live camera.
3. **COLLECTION** → search by name/tag/**location**, filter by type, sort by value/rarity.
   Tap a card for details, value reasoning, location history, OPEN MAP, EDIT, EXPORT PNG.

## Troubleshooting

- `npm run desktop` opens nothing: the desktop launcher already clears `ELECTRON_RUN_AS_NODE`
  (set by VS Code terminals). If you run `electron` yourself, `unset ELECTRON_RUN_AS_NODE` first.
- `AI OFFLINE` in the header: the AI server is not set or not reachable from this machine (VPN?). Open the gear icon, enter its URL, key and model, and press TEST.
- `DB OFFLINE`: check `DATABASE_URL` and that PostgreSQL is running.
