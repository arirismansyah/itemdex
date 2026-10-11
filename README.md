# ITEMDEX: Gotta catalog 'em all

Turn photos/videos of your stuff into retro, Pokémon-style collectible cards.
Gemma (vision) identifies the item, estimates its size, weight, condition and
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
apps/server       Fastify 5 + PostgreSQL (pg), Gemma client, migrations, Swagger docs
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

## Setup

Requirements: Node **20.19+** (22 recommended, see `.nvmrc`), PostgreSQL 13+.

```bash
nvm use            # or any Node >= 20.19
npm install
cp .env.example .env   # then fill DATABASE_URL + LLM_* (Gemma)
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
   Gemma watches the frame (~0.6s per check) and draws a box + label on the item it sees.
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
- `GEMMA OFFLINE` in the header: the Gemma server is not reachable from this machine (VPN?).
- `DB OFFLINE`: check `DATABASE_URL` and that PostgreSQL is running.
