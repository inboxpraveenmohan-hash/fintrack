# FinTrack — Personal Finance

A portable, offline personal-finance app with two pages: a **Portfolio Manager** (asset allocation vs. target, deviation/correction, monthly SIP splits, net worth) and a **Daily Tracker** (day-to-day income/expenses, account balances, monthly budgets). Switch between them with the tabs in the header.

Live demo (illustrative sample data, not real numbers): **https://inboxpraveenmohan-hash.github.io/fintrack/**

## Running it

Double-click `index.html` (Portfolio) or `tracker.html` (Daily Tracker) to open either in any modern browser (Chrome, Edge, Firefox) — the tabs in the header link between them. No install, no server, no internet connection needed after you have the files — everything (including the Excel/CSV library and charting library) is bundled in the `lib/` folder.

To carry it around, copy the whole `app/` folder — all of `index.html`, `tracker.html`, `app.js`, `tracker.js`, `shared.css`, `theme.js`, and `lib/` need to stay together — e.g. onto a USB drive or a shared folder.

Your data is saved automatically in the browser's local storage on the machine you're using, tied to this file's location — both pages share the same local storage, so they always agree on what's there. It does **not** sync between computers — use Export (below) to move data between machines, or set up Cloud Sync (below) to sync automatically, including from an Android phone.

## Portfolio Manager

- **Theme** (button in the header, top right): cycles Match system → Light → Dark. Follows your OS/browser preference by default; the manual choice is remembered on this device either way.
- **Edit inline**: click any Target %, current value, or SIP % cell to edit. Totals, deviation, correction and net worth recalculate immediately.
- **Add/remove** asset classes and holdings in Asset Allocation, or items/subsections in Other Assets, using the + rows and ✕ buttons.
- **SIP split** (dropdown next to the Asset Allocation table): controls how your Monthly Investment splits across the 4 asset classes.
  - **Same as Target %** (default) — each class's SIP share always matches its target allocation %.
  - **Deviation-weighted** — new money is steered toward whichever classes are furthest *under* their target, proportional to the shortfall; a class already at or above target gets 0% until the others catch up. Recalculates automatically as values change, so it's a live rebalancing suggestion, not a one-time snapshot.
  - **Manual** — type each class's SIP % directly (a badge shows the running total, like Target %). Only this mode's numbers are ever edited by hand; the other two are always computed.
  - This only changes how the total splits *across* the 4 classes — the existing per-holding "SIP %" (how a class's own SIP further splits among its funds) is unaffected either way.
- **Other Assets subsections**: most other-asset items (Chit, NPS, Safe Gold, …) are a single value, but an item can instead be a **subsection** — an expandable group of individual line items whose values sum to the section's total (e.g. "Bonds" holding several NCDs). Click "+ Add Subsection" to create one, then expand it and use "+ Add Item" inside.
- **Expand All / Collapse All**: buttons in each section header expand or collapse every asset class (or Other Assets subsection) at once — individual rows still toggle on click as before.
- **Move between sections** (⇄ button on each row): an Asset Allocation class can move to Other Assets (becomes a subsection with the same holdings; its Target % and per-holding SIP % are dropped, since Other Assets doesn't use those). An Other Assets subsection can move the other way to become a full Asset Allocation class (starts at 0% target — set it after moving); a simple Other Assets item (no sub-holdings, e.g. Chit) can too, becoming a new class with one holding matching its value.
- **Import CSV/Excel**: use "Download Template" to get a starter file with the current column layout, fill it in Excel/Sheets, then "Import CSV / Excel" to load it (this replaces the current portfolio — export a backup first if unsure).
- **Export**: "Export CSV" / "Export Excel" save your current portfolio as a backup or for editing outside the app.
- **Load Sample Portfolio**: resets to the example data matching the original reference sheet.
- **Reset All Data**: clears everything.
- **Sync from CDSL Statement**: refreshes current values from a CDSL "Transaction cum Holding" statement (see below).

## Import/Export file format

A flat table with columns: `Section, Name, Parent, CurrentValue, TargetPct, SIPPct, MonthlyContribution, ISIN, ManualSipPct`

- `Meta` rows set `MonthlyInvestment`, `Updated` date, and `SipMode` (`target` / `deviation` / `manual`).
- `AssetClass` rows define a class name, its `TargetPct` (should sum to 100 across classes), and `ManualSipPct` (only used when `SipMode` is `manual`; should also sum to 100 across classes).
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

## Daily Tracker

The second tab — day-to-day income/expenses, account balances, and monthly budgets. Its data is completely separate from the Portfolio page (no automatic links between them); it lives alongside the portfolio data in the same local storage and syncs through the same Cloud Sync mechanism below.

- **Accounts**: track SALARY/SAVINGS/CASH/CC-style accounts (fully editable — rename, add, or delete). Each has a **type** — *Asset* (money you hold) or *Liability* (money you owe, e.g. a credit card) — and an **Opening Balance**. **Current Balance** is computed automatically from every transaction ever logged against that account (not scoped to the month you're viewing) and gets the sign right for both: spending from an asset account reduces it, spending on a liability account increases what's owed. Paying a credit card bill isn't logged as an expense — see Transfers below.
- **Categories** ("Manage Categories" button): each has a **type** — *Expense*, *Income*, *Savings*, or *Transfer* — which determines how it affects totals and account balances. Rename, retype, or archive any category (archiving hides it from new-transaction pickers but keeps it on past transactions for history).
- **Transfers**: a *Transfer*-type category (seeded with "CC Bills" and "Just transfer") moves money between two of your own accounts rather than counting as income or spend — e.g. paying a credit card bill is a transfer from SAVINGS to CC, which correctly reduces both the SAVINGS balance and the CC amount owed at once. Picking a transfer category on a transaction reveals a second "To Account" field.
- **Month selector** (◀ / ▶ in the toolbar): the stat cards, budget table, category chart, and transaction log are all scoped to one month at a time; account balances are always all-time regardless of which month you're viewing.
- **Budget vs Actual**: set a recurring monthly budget per expense category (applies to every month until you change it) — a progress bar shows spend as a % of budget, turning red past 100%.
- **Transaction Log**: every row is inline-editable, same as the Portfolio page's holdings table. Search by description or filter by category using the controls above the table.
- **Import CSV/Excel**: column layout is `Date, Item, Income, Expense, Account, Category` — compatible with a daily-tracker spreadsheet you may already keep (dates in `DD/MM/YYYY` are recognized). Unlike the Portfolio page's import (which replaces your data), importing here **adds** the file's transactions to your existing log — nothing is removed — and any category/account name it doesn't recognize is created automatically.
- **Export**: CSV/Excel export your full transaction history (all months) as a backup.

## Cloud sync (Google Drive) and Android access

The app can optionally sync your data — Portfolio and Daily Tracker together, as one file — to your own Google Drive, letting you use it from any browser, including on your Android phone via Chrome, with edits syncing automatically between devices. This is entirely opt-in: signed out (or opened as a local file), the app works exactly as described above, fully offline, with no account needed.

**One-time setup**: see [`CLOUD_SYNC_SETUP.md`](CLOUD_SYNC_SETUP.md) — you'll host the app on GitHub Pages and create a free Google OAuth Client ID (both need your own accounts).

**Once set up**: click **Sign in with Google** in the header of either page. A status badge shows **Saving…** → **Synced**, or **Offline — will sync when reconnected** if you lose connection (edits keep working locally and catch up automatically once you're back online). On Android, use Chrome's "Add to Home Screen" for an app-like icon and launch.

**Multi-device edits**: if the same portfolio is edited on two devices, the app checks for changes when you switch back to a tab and warns before overwriting anything — you choose which version to keep rather than one silently clobbering the other. Sign out any time to go back to local-only; your data always stays in this browser's storage regardless of sync state.

Scope note: the app only ever requests Google's `drive.file` permission — access to files it creates itself, never your whole Drive.
