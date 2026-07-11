# FinTrack — Portfolio Manager

A portable, offline portfolio dashboard that replicates the "Wealth Portfolio" spreadsheet: asset allocation vs. target, deviation/correction, monthly SIP splits, and net worth tracking.

Live demo (illustrative sample data, not real portfolio numbers): **https://inboxpraveenmohan-hash.github.io/fintrack/**

## Running it

Double-click `index.html` to open it in any modern browser (Chrome, Edge, Firefox). No install, no server, no internet connection needed after you have the files — everything (including the Excel/CSV library and charting library) is bundled in the `lib/` folder next to `index.html`.

To carry it around, copy the whole `app/` folder (keep `index.html`, `app.js`, and `lib/` together) — e.g. onto a USB drive or a shared folder.

Your data is saved automatically in the browser's local storage on the machine you're using, tied to this file's location. It does **not** sync between computers — use Export (below) to move data between machines, or set up Cloud Sync (below) to sync automatically, including from an Android phone.

## Using it

- **Edit inline**: click any Target %, current value, or SIP % cell to edit. Totals, deviation, correction and net worth recalculate immediately.
- **Add/remove** asset classes and holdings in Asset Allocation, or items/subsections in Other Assets, using the + rows and ✕ buttons.
- **Other Assets subsections**: most other-asset items (Chit, NPS, Safe Gold, …) are a single value, but an item can instead be a **subsection** — an expandable group of individual line items whose values sum to the section's total (e.g. "Bonds" holding several NCDs). Click "+ Add Subsection" to create one, then expand it and use "+ Add Item" inside.
- **Import CSV/Excel**: use "Download Template" to get a starter file with the current column layout, fill it in Excel/Sheets, then "Import CSV / Excel" to load it (this replaces the current portfolio — export a backup first if unsure).
- **Export**: "Export CSV" / "Export Excel" save your current portfolio as a backup or for editing outside the app.
- **Load Sample Portfolio**: resets to the example data matching the original reference sheet.
- **Reset All Data**: clears everything.
- **Sync from CDSL Statement**: refreshes current values from a CDSL "Transaction cum Holding" statement (see below).

## Import/Export file format

A flat table with columns: `Section, Name, Parent, CurrentValue, TargetPct, SIPPct, MonthlyContribution, ISIN`

- `Meta` rows set `MonthlyInvestment` and `Updated` date.
- `AssetClass` rows define a class name and its `TargetPct` (should sum to 100 across classes).
- `Holding` rows define a fund/stock under a class (`Parent` must match an AssetClass name), its `CurrentValue`, `SIPPct` (share of that class's monthly SIP; should sum to 100 within each class), and optionally `ISIN` (used for exact matching on CDSL sync).
- `Other` rows define a simple net-worth item outside the 4-class allocation (Chit, NPS, Gold, etc.) with `CurrentValue` and `MonthlyContribution`.
- `OtherGroup` rows define an Other Assets subsection (e.g. "Bonds") and its `MonthlyContribution`; `OtherHolding` rows are its line items (`Parent` must match an OtherGroup name), with `CurrentValue` and optionally `ISIN`.

## Syncing from a CDSL statement

CDSL's "Transaction cum Holding_Consolidated" statement (downloadable as CSV from the CDSL Easi/Easiest portal, covering CDSL + NSDL demat accounts and mutual fund folios) can be used to refresh your holdings' current values without an API, login, or credentials — it's a file you already have.

Click **Sync from CDSL Statement** and pick the CSV. The app:

1. Parses every demat holdings section (CDSL + NSDL) and the mutual fund folio holdings section, skipping transaction ledgers and zero-value rows.
2. Aggregates by ISIN (a security held across multiple accounts/folios is summed into one value).
3. Matches each entry to an existing holding — anywhere in Asset Allocation *or* Other Assets subsections — first by stored ISIN, then by fuzzy name matching (e.g. "Sample Index Fund" ↔ "SAMPLE AMC INDEX FUND - NIFTY 50 PLAN..."). The first successful match backfills the ISIN onto that holding, so every sync after that is exact.
4. Shows a review screen before touching anything: matched holdings (old → new value, uncheck to skip any), and entries not found in your portfolio. Bonds/NCDs are detected automatically and default to your "Bonds" Other Assets subsection (created automatically the first time if you don't have one) — change the dropdown per row to target a different asset class or subsection, or type a new section name, or leave unchecked to ignore.
5. Only applies what's checked when you click **Apply Selected**. Your target %, SIP %, and simple Other Assets items (Chit, NPS, Gold — none of which live in a demat account) are never touched by this.

Name matching is heuristic — always check the review screen before applying, especially the first time before ISINs are recorded.

## Cloud sync (Google Drive) and Android access

The app can optionally sync your portfolio to a JSON file in your own Google Drive, letting you use it from any browser — including on your Android phone via Chrome — with edits syncing automatically between devices. This is entirely opt-in: signed out (or opened as a local file), the app works exactly as described above, fully offline, with no account needed.

**One-time setup**: see [`CLOUD_SYNC_SETUP.md`](CLOUD_SYNC_SETUP.md) — you'll host the app on GitHub Pages and create a free Google OAuth Client ID (both need your own accounts).

**Once set up**: click **Sign in with Google** in the header. A status badge shows **Saving…** → **Synced**, or **Offline — will sync when reconnected** if you lose connection (edits keep working locally and catch up automatically once you're back online). On Android, use Chrome's "Add to Home Screen" for an app-like icon and launch.

**Multi-device edits**: if the same portfolio is edited on two devices, the app checks for changes when you switch back to a tab and warns before overwriting anything — you choose which version to keep rather than one silently clobbering the other. Sign out any time to go back to local-only; your data always stays in this browser's storage regardless of sync state.

Scope note: the app only ever requests Google's `drive.file` permission — access to files it creates itself, never your whole Drive.
