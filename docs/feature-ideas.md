# ITEMDEX: Feature Ideas

Features to add, mapped to the use cases in [use-cases.md](use-cases.md). Ranked by impact for
the Google Cloud AI Builder Cup (submission deadline Oct 18, 2026).

| # | Feature | Use cases served | Notes | Status |
|---|---------|------------------|-------|---|
| 1 | **One-tap listing generator** | Resell | Title, description and price for Facebook Marketplace, Tokopedia or eBay. Small addition on top of existing card data. | Done (Sell it → write listing) |
| 2 | **Insurance / moving report export** | Inventory, moving | PDF or CSV with photos, values, location and totals, built from `total_value` and the location history. | Done (CSV + printable report) |
| 3 | **Live price grounding** | Resell, small business | Value is currently a model estimate. Ground it in real listing comparables and show sources. Biggest credibility gap. | Done as an optional Shopee check with your own login session; the AI estimate stays the default. Tokopedia, OLX, Bukalapak and eBay-style sources were blocked or unavailable |
| 4 | **Google Cloud migration** | Competition requirement | Cloud Run (service), Cloud SQL for Postgres, Cloud Storage (images), Vertex AI (Gemma/Gemini), Secret Manager. The Dockerfile and `SERVE_UI=false` already exist, so this is mostly configuration. | Not done (out of scope) |
| 5 | **Whole-room scan** | Declutter, moving | One video produces many cards. Extend the existing detector (it already draws boxes) to multi-item detection. | Done (ROOM mode) |
| 6 | **Natural-language search** | Inventory, resell | "What's in the garage worth over $50?" Needs embeddings or LLM-generated filters on top of the Postgres search. | Done (ASK) |
| 7 | **Accounts and households** | Shared equipment, family | Multi-user support and shared collections. Currently only an API key. | Done (`ACCOUNTS=true`; no login rate limit yet) |
| 8 | **Lent / borrowed tracking** | Shared equipment | Add a "who has it" field and reminders next to the existing "last seen" location. | Done (lend, due date, overdue chip) |
| 9 | **Warranty and receipt capture** | Insurance | Scan a receipt and attach purchase date and warranty expiry to the card. | Done (receipt scan, warranty chip) |
| 10 | **Price history and sell-now alerts** | Collectors, resell | Track value over time and notify when an item's value peaks. | Partly: price history chart and SELL NOW flag; no push notifications |
| 11 | **Multilingual and local market** | All | `Meta` already carries `currency`, `language` and `market`. Supports the "scale globally" claim. | Done for card text, currency and market (UI stays English) |

## Original plan (kept for reference)

1. Deploy to Google Cloud (item 4).
2. Ship items 1 and 2 as the demo story: scan, value, then list or insure.
3. Add item 3 if time allows. It is the best answer to a judge asking how accurate the prices are.
