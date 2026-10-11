# ITEMDEX Service — Panduan API & Integrasi

Dokumen ini untuk developer yang mau membangun UI/aplikasi sendiri (web, mobile,
desktop, bot, dll.) di atas ITEMDEX service. UI retro di folder `ui/` cuma demo
internal: semua yang dia lakukan bisa dilakukan aplikasi lain lewat API ini.

- **Referensi lengkap (interaktif):** jalankan service lalu buka `http://localhost:7777/api/docs` (Swagger, bisa "Try it out").
- **Spec mesin:** [`docs/openapi.yaml`](openapi.yaml) (juga di `/api/v1/openapi.json`) bisa dipakai untuk generate client otomatis.

---

## 1. Gambaran

```
 Aplikasi kamu (web / mobile / desktop)
          │  HTTPS + JSON (gambar = base64 data URL)
          ▼
 ITEMDEX service (Node/Express)  ──►  Gemma (vLLM, OpenAI-compatible)
          │                            identifikasi, ukuran, harga, rarity
          ▼
 data/items.json + data/media/*.jpg   (koleksi + foto cover)
```

Service ini yang **memegang key Gemma**. Aplikasi client tidak pernah memanggil
Gemma langsung dan tidak boleh menyimpan `LLM_API_KEY`.

Yang disediakan service:

| Kemampuan | Endpoint | Waktu (terukur) |
|---|---|---|
| Deteksi objek live di frame kamera (box + nama) | `POST /detect` | ~0.7 s |
| Analisis barang → data kartu (nama, brand, ukuran, berat, kondisi, harga pasar, rarity, 2 "jurus") | `POST /scan` | ~4.5–6 s |
| Simpan / lihat / cari / edit / hapus koleksi | `/items` | < 50 ms |
| Lokasi terakhir barang (nama tempat + GPS + alamat) | `PUT /items/{id}/location` | < 1 s |

---

## 2. Menjalankan service

```bash
npm install
npm run service                 # http://127.0.0.1:7777 , docs di /api/docs
```

Konfigurasi lewat `.env` (lihat `.env.example`):

| Variabel | Default | Fungsi |
|---|---|---|
| `LLM_API_BASE`, `LLM_API_KEY`, `LLM_MODEL` | — (wajib) | Server Gemma (vLLM, OpenAI-compatible) |
| `PORT` | `7777` | Port HTTP |
| `HOST` | `127.0.0.1` | Pakai `0.0.0.0` supaya bisa diakses device lain (HP, laptop tim) |
| `ITEMDEX_API_KEY` | kosong (tanpa auth) | **Wajib diisi** kalau service bisa diakses dari luar laptop |
| `CORS_ORIGINS` | kosong | Origin web app yang boleh akses, dipisah koma, mis. `http://localhost:5173,https://app.kamu.com`, atau `*` |
| `SERVE_UI` | `true` | `false` = matikan UI demo, service jadi API murni |
| `DATA_DIR` | `./data` | Lokasi `items.json` + folder `media/` |
| `CARD_LANGUAGE` | `Indonesian` | Bahasa teks kartu (deskripsi, catatan, jurus) |
| `CURRENCY` / `MARKET` | `IDR` / `Indonesian` | Mata uang & pasar acuan estimasi harga |
| `LLM_TIMEOUT_MS` | `120000` | Batas waktu panggilan `/scan` |
| `REVERSE_GEOCODE` | `true` | Koordinat → alamat via OpenStreetMap Nominatim (`false` = matikan; koordinat tidak dikirim keluar) |

Contoh mode "API untuk tim" (diakses dari HP/laptop lain di jaringan yang sama):

```bash
HOST=0.0.0.0 ITEMDEX_API_KEY=ganti-dengan-key-panjang CORS_ORIGINS=http://localhost:5173 \
SERVE_UI=false npm run service
```

> Catatan: app desktop (Electron) selalu menjalankan service-nya sendiri secara
> lokal tanpa key/CORS, terlepas dari isi `.env`. Variabel di atas hanya untuk `npm run service`.

---

## 3. Aturan umum

**Base URL:** `http://<host>:<port>/api/v1`
(`/api/...` tanpa versi juga ada, tapi itu alias untuk UI demo. Aplikasi baru pakai `/api/v1`.)

**Auth** (hanya kalau server memakai `ITEMDEX_API_KEY`). Kirim salah satu:

```
X-API-Key: <key>
Authorization: Bearer <key>
```

`GET /health` dan `GET /meta` selalu publik. File gambar di `/media/...` juga
publik (nama file UUID acak) supaya bisa langsung dipakai di `<img src>`.

**Gambar** dikirim sebagai *data URL* di dalam JSON:
`"data:image/jpeg;base64,/9j/4AAQ..."` (jpeg, png, atau webp).

- Resize dulu di client: **sisi terpanjang ~1024 px** untuk `/scan`, **~512 px** untuk `/detect`. Lebih besar tidak menambah akurasi, cuma memperlambat.
- Maks **6 gambar** per scan, body maks **60 MB**.
- HEIC (foto default iPhone) tidak didukung. Konversi ke JPEG dulu.

**Error** selalu JSON dengan HTTP status yang sesuai:

```json
{ "error": "Item not found", "code": "not_found" }
```

| `code` | HTTP | Arti / tindakan di client |
|---|---|---|
| `bad_request` | 400 | Input salah. Tampilkan pesan, jangan retry |
| `unauthorized` | 401 | Key salah atau tidak ada |
| `not_found` | 404 | Item/route tidak ada |
| `payload_too_large` | 413 | Gambar terlalu besar. Resize |
| `llm_error` | 502 | Gemma error/tidak terjangkau (mis. VPN putus). Boleh retry |
| `llm_timeout` | 504 | Gemma lambat. Boleh retry |
| `internal` | 500 | Bug di service |

**Enum & limit** jangan di-hardcode. Ambil dari `GET /meta`:

```json
{
  "currency": "IDR", "language": "Indonesian", "auth_required": true,
  "enums": {
    "type": ["ELECTRONIC","FASHION","BOOK","TOY","HOME","KITCHEN","SPORT","TOOL","COLLECTIBLE","BEAUTY","VEHICLE","MUSIC","OFFICE","OTHER"],
    "rarity": ["COMMON","UNCOMMON","RARE","EPIC","LEGENDARY"],
    "condition": ["MINT","EXCELLENT","GOOD","FAIR","POOR"],
    "size_class": ["TINY","SMALL","MEDIUM","LARGE","HUGE"],
    "source": ["photo","video","camera"]
  },
  "limits": { "max_images_per_scan": 6, "max_body_mb": 60,
              "recommended_scan_image_side_px": 1024, "recommended_detect_image_side_px": 512 }
}
```

---

## 4. Alur integrasi

### 4.1 Alur utama: scan → review → simpan

`/scan` **tidak menyimpan apa-apa**. Tujuannya supaya user bisa lihat/edit
kartu dulu dan memilih simpan atau buang. Simpan pakai `POST /items`.

```
client                         service                     Gemma
  │ POST /scan {images,hint}     │                            │
  │─────────────────────────────►│ analyze ──────────────────►│
  │◄─────────────────────────────│◄───────────────────────────│
  │ {card, best_frame}           │                            │
  │                              │                            │
  │ (tampilkan kartu, user edit) │                            │
  │                              │                            │
  │ POST /items {card, image: images[best_frame], location}   │
  │─────────────────────────────►│ simpan + foto cover        │
  │◄──── 201 {item}  (id, number, image_url, ...)             │
```

Request `/scan`:

```json
{
  "images": ["data:image/jpeg;base64,..."],
  "hint": "beli 2022, ada baret di belakang",
  "source": "photo"
}
```

- `images`: 1–6 foto **satu barang** (boleh beberapa angle). Untuk video, ambil ~4 frame merata lalu kirim dengan `"source": "video"`.
- `hint` (opsional): catatan pemilik, ikut dibaca Gemma.

Response:

```json
{
  "card": {
    "is_item": true,
    "name": "MacBook 12-inch Gold",
    "brand": "Apple", "model": "MacBook (Retina, 12-inch)",
    "type": "ELECTRONIC", "subcategory": "Laptop",
    "description": "Perangkat ramping yang mampu memproses data secepat kilat...",
    "color": "Gold", "material": "Aluminum",
    "dimensions": { "length_cm": 28.1, "width_cm": 19.6, "height_cm": 1.3 },
    "size_class": "MEDIUM", "weight_g": 1080,
    "condition": { "score": 95, "label": "EXCELLENT", "notes": "..." },
    "value": { "min": 4000000, "max": 7000000, "typical": 5500000,
               "new_price": 15000000, "confidence": "MEDIUM", "reasoning": "..." },
    "rarity": "UNCOMMON",
    "abilities": [ { "name": "Retina Vision", "power": 85, "text": "..." },
                   { "name": "Ultra-Slim Glide", "power": 70, "text": "..." } ],
    "tags": ["laptop", "apple", "macbook"],
    "location_guess": "meja kerja"
  },
  "best_frame": 0,
  "elapsed_ms": 4700
}
```

Hal penting dari response:
- `is_item: false` artinya Gemma tidak menemukan barang fisik yang jelas. Sebaiknya minta user foto ulang.
- `best_frame` = indeks gambar yang paling jelas. Kirim gambar itu sebagai `image` saat menyimpan.
- `location_guess` = tebakan lokasi dari background foto. Bisa dipakai sebagai default isian "lokasi".
- Semua angka harga adalah **estimasi AI** untuk barang bekas, bukan harga pasti. Tampilkan sebagai estimasi.

Request `POST /items`:

```json
{
  "card": { "...": "objek card dari /scan (boleh sudah diedit user)" },
  "image": "data:image/jpeg;base64,...",
  "source": "camera",
  "location": { "place": "meja kerja", "lat": -6.2297, "lng": 106.8295, "accuracy_m": 25, "source": "device" }
}
```

`location` opsional. Isi `place` dan/atau `lat`+`lng`. Kalau ada koordinat,
service otomatis menambahkan `address` (alamat jalan).

### 4.2 Kamera live dengan auto-snap (opsional)

Ini cara UI demo bikin efek "kamera langsung deteksi barang lalu jepret otomatis".
Semuanya logika client. Service cuma menyediakan `POST /detect`.

```json
// request
{ "image": "data:image/jpeg;base64,..." }      // frame ~512px

// response
{ "has_item": true, "name": "laptop", "box": [456, 526, 748, 886], "elapsed_ms": 650 }
```

`box` = `[ymin, xmin, ymax, xmax]`, skala **0–1000** relatif terhadap gambar
yang dikirim. Konversi ke piksel:

```js
const [y1, x1, y2, x2] = det.box;
const rect = {
  x: (x1 / 1000) * frameWidth,  y: (y1 / 1000) * frameHeight,
  w: ((x2 - x1) / 1000) * frameWidth, h: ((y2 - y1) / 1000) * frameHeight,
};
```

Resep yang dipakai UI demo (lihat implementasi lengkap di [`ui/live.js`](../ui/live.js)):

1. **Loop deteksi:** kirim frame ke `/detect`, **satu request sekaligus** (tunggu hasil, jeda ~250 ms, kirim lagi). Kalau gagal, backoff 1s, 2s, 3s, dst.
2. **Gambar box** dari hasil terakhir. Haluskan perpindahannya (lerp) supaya tidak loncat-loncat.
3. **Cek kamera diam** secara lokal (murah, tanpa AI): kecilkan frame ke 32×24 grayscale tiap ~120 ms, hitung rata-rata selisih piksel dengan frame sebelumnya. Di bawah ~6 (skala 0–255) berarti diam.
4. **Lock:** barang yang sama terdeteksi **2× berturut-turut** (box overlap/IoU > 0.45 atau nama sama) **dan** kamera diam **1.2 s**, maka snap.
5. **Snap:** ambil frame resolusi penuh dan juga crop di sekitar box (+15% padding). Kirim `[crop, full]` ke `/scan`. Crop menghasilkan gambar kartu yang lebih bersih, full frame memberi konteks lokasi.
6. **Jangan snap ulang** barang yang sama: setelah snap, tunggu sampai `/detect` melihat "tidak ada barang" atau barang lain.
7. Pause loop deteksi selama `/scan` berjalan dan selama user mereview kartu, supaya tidak membebani Gemma.

> Biaya: loop ini mengirim ~1 request/detik ke Gemma per user yang membuka kamera.
> Untuk banyak user sekaligus, tambah jeda atau pakai tombol SNAP manual saja.

### 4.3 Koleksi

**List & cari:** `GET /items?q=&type=&rarity=&sort=&limit=&offset=`

| Param | Contoh | Keterangan |
|---|---|---|
| `q` | `lemari` | Cari di nama, brand, model, tag, warna, material, **dan lokasi** (place + alamat) |
| `type` | `ELECTRONIC,TOY` | Filter tipe (koma = OR) |
| `rarity` | `RARE,EPIC,LEGENDARY` | Filter rarity |
| `sort` | `new` (default), `old`, `value`, `rarity`, `name`, `number` | Urutan |
| `limit` / `offset` | `20` / `40` | Paging (maks 500) |

```json
{ "items": [ { "id": "…", "number": 7, "name": "…", "image_url": "http://…/media/….jpg", "...": "…" } ],
  "total": 31, "total_value": 48250000 }
```

`total` dan `total_value` dihitung dari semua hasil filter (sebelum paging),
cocok untuk header "31 barang · Rp 48 jt".

**Fitur "barangku di mana?"**: cukup `GET /items?q=<nama barang>` lalu baca
`item.location`, atau `GET /items?q=<nama tempat>` untuk melihat semua barang di tempat itu.

**Detail:** `GET /items/{id}`

**Edit:** `PATCH /items/{id}` dengan field yang mau diubah saja. Objek nested
(`value`, `condition`, `dimensions`) di-*merge*, jadi field lain tidak hilang:

```json
{ "card": { "name": "Laptop Kantor", "value": { "typical": 8000000 } } }
```

`size_class` dihitung ulang otomatis dari `dimensions`. `id`, `number`, foto,
lokasi, dan tanggal dibuat tidak bisa diubah lewat endpoint ini.

**Pindah lokasi:** `PUT /items/{id}/location`

```json
{ "place": "tas kantor" }
{ "place": "gudang", "lat": -6.2, "lng": 106.8, "accuracy_m": 30, "source": "device" }
```

Lokasi lama masuk ke `location_history` (terbaru di depan, maks 20).

**Hapus:** `DELETE /items/{id}` → `{ "ok": true }` (foto ikut terhapus).

---

## 5. Model data `Item`

`Item` = semua field `Card` (lihat 4.1) + field berikut:

| Field | Tipe | Keterangan |
|---|---|---|
| `id` | string (UUID) | ID permanen |
| `number` | int | Nomor koleksi (tampilkan sebagai `NO.007`) |
| `image_url` | string \| null | URL absolut foto cover, bisa langsung untuk `<img>` |
| `image` | string \| null | Nama file (internal) |
| `source` | `photo` \| `video` \| `camera` | Asal input |
| `location` | Location \| null | Lokasi terakhir |
| `location_history` | Location[] | Riwayat, terbaru di depan |
| `created_at`, `updated_at` | ISO 8601 | |

`Location`: `{ place, lat, lng, accuracy_m, source: exif|device|manual, address, at }`

Ide mapping ke tampilan kartu (seperti UI demo): `condition.score` = HP,
`type` = elemen/warna kartu, `rarity` = jumlah bintang (1–5),
`abilities` = 2 jurus dengan `power` sebagai damage.

---

## 6. Contoh kode

### JavaScript / TypeScript (web, React, React Native, Electron)

```js
const BASE = 'http://localhost:7777/api/v1';
const KEY = '...'; // kosongkan kalau server tanpa ITEMDEX_API_KEY

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(KEY && { 'X-API-Key': KEY }) },
    body: body && JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error), { code: data.code, status: res.status });
  return data;
}

// File/Blob -> data URL JPEG, sisi terpanjang maxSide
async function toDataUrl(file, maxSide = 1024) {
  const img = await createImageBitmap(file);
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = Object.assign(document.createElement('canvas'), {
    width: Math.round(img.width * s), height: Math.round(img.height * s),
  });
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

// scan -> simpan
const images = [await toDataUrl(fileInput.files[0])];
const { card, best_frame } = await api('/scan', { method: 'POST', body: { images, source: 'photo' } });
const { item } = await api('/items', {
  method: 'POST',
  body: { card, image: images[best_frame], source: 'photo', location: { place: card.location_guess } },
});
console.log(item.number, item.name, item.value.typical, item.image_url);
```

### Python

```python
import base64, requests

BASE = "http://localhost:7777/api/v1"
H = {"X-API-Key": "..."}  # hapus kalau tanpa auth

def data_url(path):
    return "data:image/jpeg;base64," + base64.b64encode(open(path, "rb").read()).decode()

imgs = [data_url("barang.jpg")]
scan = requests.post(f"{BASE}/scan", json={"images": imgs}, headers=H, timeout=120).json()
item = requests.post(f"{BASE}/items", headers=H, json={
    "card": scan["card"], "image": imgs[scan["best_frame"]],
    "location": {"place": "lemari kamar"},
}).json()["item"]
print(item["number"], item["name"], item["value"]["typical"])

# barang di lemari apa saja?
print([i["name"] for i in requests.get(f"{BASE}/items", params={"q": "lemari"}, headers=H).json()["items"]])
```

### curl

```bash
curl http://localhost:7777/api/v1/health
curl -H "X-API-Key: $KEY" "http://localhost:7777/api/v1/items?q=lemari&sort=value"
curl -X PATCH -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"card":{"name":"Laptop Kantor"}}' http://localhost:7777/api/v1/items/<id>
```

### Mobile (Flutter / Kotlin / Swift)

Polanya sama: kompres foto ke JPEG ±1024 px, base64-kan, kirim JSON. Untuk
generate client otomatis dari spec:

```bash
npx @openapitools/openapi-generator-cli generate -i docs/openapi.yaml -g dart -o clients/dart
# -g typescript-fetch | kotlin | swift5 | python | ...
```

Di HP, `localhost` = HP itu sendiri. Pakai IP laptop yang menjalankan service
(`HOST=0.0.0.0`) atau URL tunnel HTTPS. Kamera dan GPS di browser HP butuh **HTTPS**.

---

## 7. Deploy, keamanan, dan batasan

- **Jangan expose tanpa key.** Kalau `HOST` bukan `127.0.0.1`, isi `ITEMDEX_API_KEY`. Kalau tidak, siapa pun bisa menghabiskan kuota Gemma. Service akan memberi WARNING di log.
- **Key ITEMDEX di aplikasi publik:** key yang ditanam di web/mobile app bisa dibaca orang. Untuk demo/hackathon ini cukup. Untuk produksi, taruh di backend kalian sendiri atau pakai login per user.
- **CORS** hanya untuk web app di browser. Mobile/desktop/server tidak butuh CORS.
- **Gemma harus terjangkau dari mesin service.** Server Gemma saat ini kemungkinan hanya bisa diakses dari jaringan internal/VPN. Kalau service di-deploy di cloud, pastikan Gemma bisa dijangkau dari sana.
- **Penyimpanan** adalah file JSON + folder foto, cocok untuk demo dan satu instance. Jangan jalankan beberapa instance ke `DATA_DIR` yang sama. Backup = salin folder `DATA_DIR`. Hosting gratis dengan disk sementara (Render free, dll.) akan menghapus data saat redeploy.
- **Foto di `/media`** bisa diakses tanpa key (nama file acak/UUID). Jangan simpan foto sensitif.
- **Reverse geocoding** mengirim koordinat ke OpenStreetMap Nominatim (batas wajar ±1 request/detik). Matikan dengan `REVERSE_GEOCODE=false` kalau tidak boleh keluar.
- **Akurasi:** nama/brand biasanya tepat untuk barang umum. Ukuran, berat, kondisi, dan harga adalah **estimasi**. Sediakan tombol edit di UI.

---

## 8. Referensi cepat

| Method | Path | Auth | Fungsi |
|---|---|---|---|
| GET | `/api/v1/health` | – | Status service + Gemma |
| GET | `/api/v1/meta` | – | Enum, limit, mata uang, bahasa |
| POST | `/api/v1/detect` | ✓ | Deteksi barang di 1 frame (box 0–1000) |
| POST | `/api/v1/scan` | ✓ | 1–6 gambar → data kartu (tidak disimpan) |
| GET | `/api/v1/items` | ✓ | List/cari/filter/sort/paging |
| POST | `/api/v1/items` | ✓ | Simpan kartu + foto + lokasi |
| GET | `/api/v1/items/{id}` | ✓ | Detail |
| PATCH/PUT | `/api/v1/items/{id}` | ✓ | Edit sebagian (merge) |
| PUT | `/api/v1/items/{id}/location` | ✓ | Update lokasi terakhir |
| DELETE | `/api/v1/items/{id}` | ✓ | Hapus |
| GET | `/media/{file}` | – | Foto cover (pakai `image_url`) |
| GET | `/api/docs` | – | Swagger UI |
| GET | `/api/v1/openapi.json` | – | OpenAPI spec |
