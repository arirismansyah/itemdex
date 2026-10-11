# ITEMDEX — Gotta catalog 'em all

Turn photos/videos of your stuff into retro, Pokémon-style collectible cards.
Gemma (vision) identifies the item, estimates its size, weight, condition and
second-hand market value, and invents two "moves" for the card. Each card also
remembers where the item was **last seen** (place name + GPS).

## Run

```bash
npm install
npm start            # desktop app (Electron)
# or
npm run service      # service + UI in the browser at http://127.0.0.1:7777
```

Requires `.env` (see `.env.example`): `LLM_API_BASE`, `LLM_API_KEY`, `LLM_MODEL`
pointing to the OpenAI-compatible (vLLM) Gemma server.

> If `npm start` behaves like plain Node ("Cannot find module 'electron'"),
> your shell has `ELECTRON_RUN_AS_NODE=1` set (VS Code does this in some
> terminals). Run `unset ELECTRON_RUN_AS_NODE` first.

## Using the service from another app

The demo UI is just one client. Any web/mobile/desktop app can use the REST API:

- **Guide (Bahasa Indonesia):** [docs/API.md](docs/API.md): flows, auth, live-camera recipe, code samples
- **Interactive reference:** run the service and open `http://localhost:7777/api/docs` (Swagger)
- **OpenAPI spec:** [docs/openapi.yaml](docs/openapi.yaml), for generating clients

```bash
HOST=0.0.0.0 ITEMDEX_API_KEY=some-long-key CORS_ORIGINS=http://localhost:5173 SERVE_UI=false npm run service
```

## Demo flow

1. **SCAN** opens the live camera viewfinder. Gemma watches the frame
   (~0.6s per check) and draws a box + label on the item it sees.
   - **AUTO SNAP**: hold the item steady; once it is seen twice in a row and
     the camera is still for ~1.2s the lock bar fills, it snaps and scans by
     itself. It won't re-snap the same item until you show something new.
   - **MANUAL**: press **SNAP** (or Space) for each angle, then **SCAN**.
   - No camera? **⇪ PHOTO / ⇪ VIDEO** upload (or drag & drop onto the viewfinder).
2. Card flips in (~5s) → **SAVE TO DEX** → back to live camera.
3. **COLLECTION** → search by name/tag/**location**, filter by type, sort by value/rarity.
   Click a card for details, value reasoning, location history, OPEN MAP, EDIT, EXPORT PNG.

Snaps send a crop around the detected box (cleaner card art) plus the full
frame (for context and the location guess).

## Location ("LAST SEEN")

- Place name: typed by you, or guessed by Gemma from the photo background.
- Coordinates: read from the photo's EXIF GPS (phone photos), otherwise from
  the device location. Converted to a street address with OpenStreetMap
  Nominatim (`REVERSE_GEOCODE=false` to disable).
- "Moved it?" in the detail view records a new location; the last 20 moves are kept.

## Structure

```
docs/      API.md (integration guide), openapi.yaml (spec)
service/   Express API (/api/v1) + static UI host
  gemma.js   prompt + JSON-schema structured output to Gemma
  card.js    validation/normalization of card data
  store.js   JSON file store + images (data/items.json, data/media/)
  server.js  /api/detect (live), /api/scan, /api/items CRUD, /api/items/:id/location
desktop/   Electron shell (starts the service in-process, PNG export)
ui/        Retro UI (vanilla JS, no build step); live.js = viewfinder + auto-snap
```

Data lives in the Electron `userData` folder (desktop) or `./data` (service);
override with `DATA_DIR`.
