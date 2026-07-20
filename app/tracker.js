/* FinTrack — Ledger (transactions, accounts, categories, and monthly budgets)
   Second page of FinTrack. Shares the same localStorage blob and Google Drive sync mechanism
   as the Portfolio page (app.js), under a new top-level state.dailyTracker key — see the
   persist() contract note below, which must stay behaviorally identical to app.js's persist()
   so a shared _rev/updated stamp and Drive-sync notification work the same regardless of which
   page last saved. Independent ledger: never writes into state.assetClasses/otherAssets.

   Categories are a simple two-level hierarchy (a category with no parentId is itself a
   top-level group, e.g. "Income"/"Expense"/"Savings") used purely for organizing and charting —
   they carry no fixed income/expense/savings "type". Whether a transaction is money in or out
   is set per-transaction (the direction field), so the same category can be used either way
   (e.g. a rare refund logged as "in" under "Groceries"). Transfers — moving money between two
   of the user's own accounts, e.g. paying a credit card bill — are a separate structure
   entirely, not a category, since they're not real income or spending. */

(function () {
  "use strict";

  const STORAGE_KEY = "fintrack_portfolio_v1"; // same blob as app.js — see load()/persist() below
  const PALETTE = ["#4f46e5", "#0ea5a4", "#f59e0b", "#ef4444", "#8b5cf6", "#0f9d58", "#0284c7", "#d946ef", "#84cc16", "#f97316"];

  // Theme toggle logic lives in theme.js (shared with index.html). It calls window.onThemeChange
  // after every change, since Chart.js bakes colors in at creation time and needs an explicit
  // redraw — everything else updates for free via CSS custom properties.
  window.onThemeChange = () => {
    if (typeof renderCharts === "function") renderCharts(computeDerivedTracker());
    const ob = document.getElementById("overviewBackdrop");
    if (ob && ob.classList.contains("show") && typeof renderOverview === "function") renderOverview();
  };

  let idCounter = 0;
  function uid(prefix) {
    idCounter += 1;
    return prefix + "_" + idCounter + "_" + Math.random().toString(36).slice(2, 8);
  }

  // ---------- seed data ----------
  // openingBalance is the fallback used for any month with no entry of its own in
  // openingBalances (keyed "YYYY-MM") — effectively "the balance before tracking began". Every
  // month's balance is otherwise independent, set either by editing that month's field directly
  // or via "Copy Previous Month's Balances".
  function defaultAccounts() {
    return [
      { id: uid("acct"), name: "SALARY", openingBalance: 0, openingBalances: {} },
      { id: uid("acct"), name: "SAVINGS", openingBalance: 0, openingBalances: {} },
      { id: uid("acct"), name: "CASH", openingBalance: 0, openingBalances: {} },
      { id: uid("acct"), name: "CC", openingBalance: 0, openingBalances: {} }
    ];
  }

  function defaultCategories() {
    const income = { id: uid("cat"), name: "Income", parentId: null, archived: false, hasBudget: false };
    const expense = { id: uid("cat"), name: "Expense", parentId: null, archived: false, hasBudget: false };
    const savings = { id: uid("cat"), name: "Savings", parentId: null, archived: false, hasBudget: false };
    const mk = (name, parent, hasBudget) => ({ id: uid("cat"), name, parentId: parent.id, archived: false, hasBudget });
    return [
      income, expense, savings,
      mk("Groceries", expense, true), mk("EMI", expense, true), mk("Dining out", expense, true),
      mk("Rent & Maintenance", expense, true), mk("Meds & Supp", expense, true), mk("Charges", expense, true),
      mk("Entertainment", expense, true), mk("Food delivery", expense, true), mk("Transport (Fuel)", expense, true),
      mk("Online shopping", expense, true), mk("Essential Spends", expense, true), mk("Adhoc", expense, true),
      mk("Money lent", expense, true), mk("Travel", expense, true),
      mk("Investments", savings, true), mk("Emergency Fund", savings, true), mk("Chit", savings, true),
      mk("Paycheck", income, false), mk("Returns", income, false), mk("Inv/savings returns", income, false)
    ];
  }

  // Total Savings starts scoped to just the "Savings" top-level group's categories (falling back
  // to nothing excluded if there's no such group, e.g. a heavily-renamed category set) — an empty
  // default here would make it show the exact same number as Total Expenses out of the box, since
  // both would otherwise sum every "Out" transaction with nothing to tell them apart.
  function defaultSavingsExclusions(categories) {
    const savingsGroup = categories.find((c) => !c.parentId && c.name.trim().toLowerCase() === "savings");
    if (!savingsGroup) return [];
    return categories.filter((c) => c.parentId !== savingsGroup.id).map((c) => c.id);
  }

  function seedTracker() {
    const categories = defaultCategories();
    return {
      accounts: defaultAccounts(), categories, transactions: [], transfers: [], budgets: {},
      chartExclusions: { topLevel: [], category: [], totalIncome: [], totalExpenses: [], totalSavings: defaultSavingsExclusions(categories) }
    };
  }

  function isValidTracker(t) {
    return !!t && Array.isArray(t.accounts) && Array.isArray(t.categories) &&
      Array.isArray(t.transactions) && Array.isArray(t.transfers) && t.budgets && typeof t.budgets === "object";
  }

  // One-time upgrade from the first version of this feature, whose categories carried a fixed
  // type (expense/income/savings/transfer) and whose transactions used toAccountId for
  // transfers instead of a separate transfers[] list. Returns null if `old` isn't that shape
  // (nothing to migrate), so load() below falls back to a fresh seed as before.
  function migrateOldTracker(old) {
    if (!old || !Array.isArray(old.categories) || !old.categories.some((c) => c.type !== undefined)) return null;

    const groupNames = { income: "Income", expense: "Expense", savings: "Savings" };
    const groups = {};
    function groupFor(type) {
      const key = groupNames[type] ? type : "expense";
      if (!groups[key]) groups[key] = { id: uid("cat"), name: groupNames[key], parentId: null, archived: false, hasBudget: false };
      return groups[key];
    }

    const oldCatById = {};
    old.categories.forEach((c) => { oldCatById[c.id] = c; });

    const categories = [];
    old.categories.forEach((c) => {
      if (c.type === "transfer") return; // dropped — its transactions become real transfers below
      const group = groupFor(c.type);
      if (!categories.includes(group)) categories.push(group);
      categories.push({ id: c.id, name: c.name, parentId: group.id, archived: !!c.archived, hasBudget: c.type !== "income" });
    });

    const transactions = [];
    const transfers = [];
    (old.transactions || []).forEach((t) => {
      const oldCat = oldCatById[t.categoryId];
      if (oldCat && oldCat.type === "transfer" && t.toAccountId) {
        transfers.push({ id: t.id, date: t.date, item: t.item, amount: t.amount, fromAccountId: t.accountId, toAccountId: t.toAccountId });
      } else if (oldCat) {
        // The old model incorrectly treated "savings" the same as "income" (added to balance);
        // this migration corrects it to "out", matching what actually happened to the source
        // account (money left it to be invested) — see the balance-math comment further down.
        transactions.push({ id: t.id, date: t.date, item: t.item, amount: t.amount, direction: oldCat.type === "income" ? "in" : "out", categoryId: t.categoryId, accountId: t.accountId });
      }
    });

    return {
      accounts: Array.isArray(old.accounts) ? old.accounts : defaultAccounts(),
      categories, transactions, transfers,
      budgets: old.budgets && typeof old.budgets === "object" ? old.budgets : {}
    };
  }

  // ---------- state (shared blob with app.js) ----------
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { dailyTracker: seedTracker() };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { dailyTracker: seedTracker() };
      // Repair only the dailyTracker key — never touch assetClasses/otherAssets/etc., which
      // belong to app.js. This is the tracker-side half of the same fix applied to app.js's
      // load(): a corrupt/missing piece of one feature must not nuke the other's data.
      if (!isValidTracker(parsed.dailyTracker)) {
        parsed.dailyTracker = migrateOldTracker(parsed.dailyTracker) || seedTracker();
      }
      // Backfilled separately from isValidTracker() above, since an already-valid tracker saved
      // before this feature existed would otherwise never gain the field (or would be wrongly
      // treated as corrupt and reseeded, discarding real data, if it were added to that check).
      const ce = parsed.dailyTracker.chartExclusions;
      if (!ce || typeof ce !== "object" || Array.isArray(ce)) {
        parsed.dailyTracker.chartExclusions = {
          topLevel: [], category: [], totalIncome: [], totalExpenses: [],
          totalSavings: defaultSavingsExclusions(parsed.dailyTracker.categories)
        };
      } else {
        if (!Array.isArray(ce.topLevel)) ce.topLevel = [];
        if (!Array.isArray(ce.category)) ce.category = [];
        if (!Array.isArray(ce.totalIncome)) ce.totalIncome = [];
        if (!Array.isArray(ce.totalExpenses)) ce.totalExpenses = [];
        if (!Array.isArray(ce.totalSavings)) ce.totalSavings = defaultSavingsExclusions(parsed.dailyTracker.categories);
      }
      // Every account needs its own per-month map (added when Accounts became month-scoped) —
      // an empty one is a no-op: effectiveOpeningBalance() just keeps falling back to the
      // account's existing openingBalance for every month until one is explicitly set.
      (parsed.dailyTracker.accounts || []).forEach((a) => {
        if (!a.openingBalances || typeof a.openingBalances !== "object" || Array.isArray(a.openingBalances)) {
          a.openingBalances = {};
        }
      });
      return parsed;
    } catch (e) {
      return { dailyTracker: seedTracker() };
    }
  }

  let state = load();
  let selectedMonth = todayStr().slice(0, 7);
  let searchQuery = "";
  let filterCategoryId = "";
  let sortOrder = "newest"; // "newest" | "oldest"
  let chartTopLevel = null;
  let chartCategory = null;
  let overviewChart = null;
  let overviewMode = "year"; // "week" | "month" | "year"
  let overviewYear = null;
  let overviewMonth = null; // "01".."12" — only used in "week" mode
  let overviewCategoryId = ""; // "" = all top-level groups (default); a leaf category id drills into just that one
  let chartCustomizeTarget = null; // "topLevel" | "category" — which donut chart the modal is editing
  let pendingImport = null; // { categories, accounts, transactions, newCategoryIds } — awaiting review in the import preview modal
  let pendingStatementAccountName = null; // account chosen/typed in the statement-import account picker, before the file is chosen
  let expandedTxnCardId = null; // which mobile transaction card is expanded — survives re-renders so an edit doesn't collapse it
  let addTxnSessionCount = 0; // how many transactions "Add Another" has committed since the add modal was opened
  const TXN_CARD_CHUNK = 50; // mobile card list renders in chunks — heavy months stay fast
  let txnCardLimit = TXN_CARD_CHUNK; // grows via "Show older"; resets on month/filter/search/sort change
  let expandedBudgetGroups = new Set(); // which mobile budget group cards are open (session-only)
  // Same breakpoint as the CSS media query. Falls back to a static non-matching stub where
  // matchMedia isn't available (jsdom's test environment, and conceivably an odd WebView) —
  // mobile-only JS behaviors (month bar relocation, legend position) simply stay desktop-like
  // there, while the CSS media query itself still switches normally in any real browser.
  const MOBILE_MQ = typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width:720px)")
    : { matches: false, addEventListener: null };

  // Collapsed state of the mobile review sections (charts/budget/accounts) — a per-device view
  // preference, so it lives in its own localStorage key, never in the synced data blob.
  const COLLAPSE_KEY = "fintrack_ledger_collapsed";
  function loadCollapsedSections() {
    try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveCollapsedSections(map) {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map)); } catch (e) { /* view-only pref */ }
  }

  let storageWarned = false;
  function persist() {
    // Contract shared with app.js's persist() — must stay identical.
    state._rev = new Date().toISOString();
    state.updated = todayStr();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      if (!storageWarned) {
        storageWarned = true;
        toast("Warning: browser storage is unavailable, so changes won't be saved after reload. Use Export to back up your data.");
      }
    }
    if (window.driveSync) window.driveSync.notifyChange(state);
  }

  // ---------- lookups ----------
  function tracker() { return state.dailyTracker; }
  function findAccount(id) { return tracker().accounts.find((a) => a.id === id); }
  function findCategory(id) { return tracker().categories.find((c) => c.id === id); }
  function isLeafCategory(cat) { return !tracker().categories.some((c) => c.parentId === cat.id); }
  function topLevelOf(cat) {
    let c = cat;
    const seen = new Set();
    while (c && c.parentId && !seen.has(c.id)) {
      seen.add(c.id);
      const p = findCategory(c.parentId);
      if (!p) break;
      c = p;
    }
    return c;
  }

  // ---------- formatting (duplicated from app.js — must stay behaviorally identical) ----------
  const inrFmt = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
  function fmtINR(n) { return inrFmt.format(Number(n) || 0); }
  function numOr0(n) { return Number.isFinite(Number(n)) ? Number(n) : 0; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function escapeAttr(s) { return escapeHtml(s); }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function fmtDate(dateStr) {
    if (!dateStr) return "—";
    const d = new Date(dateStr + "T00:00:00");
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }
  function fmtMonthLabel(month) {
    const parts = month.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  // ---------- toast / confirm (duplicated verbatim from app.js) ----------
  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2200);
  }

  function confirmDialog(title, msg, okLabel, cancelLabel, danger) {
    if (danger === undefined) danger = true;
    return new Promise((resolve) => {
      const backdrop = document.getElementById("confirmBackdrop");
      document.getElementById("confirmTitle").textContent = title;
      document.getElementById("confirmMsg").textContent = msg;
      backdrop.classList.add("show");
      const okBtn = document.getElementById("confirmOk");
      const cancelBtn = document.getElementById("confirmCancel");
      okBtn.textContent = okLabel || "Confirm";
      cancelBtn.textContent = cancelLabel || "Cancel";
      okBtn.style.background = danger ? "var(--red)" : "var(--primary)";
      okBtn.style.borderColor = danger ? "var(--red)" : "var(--primary)";
      function cleanup(result) {
        backdrop.classList.remove("show");
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
    });
  }

  // ---------- account balances (scoped to the selected month — see computeAccountBalances) ----------
  // Every account uses the same plain formula: opening balance + in − out. There's no separate
  // asset/liability type — a credit card account just goes negative as you spend on it (that
  // negative number *is* what's owed) and comes back toward zero as you pay it down via a
  // transfer, no special-casing needed. Transfers move money between two of the user's own
  // accounts and must move both balances at once (this is exactly what the original
  // spreadsheet's #REF! formulas failed to do) — e.g. paying a CC bill reduces the paying
  // account and brings the CC balance back up toward zero simultaneously.
  function applyTxnToBalances(balances, txn) {
    const acct = findAccount(txn.accountId);
    if (!acct) return;
    const delta = (txn.direction === "in" ? 1 : -1) * txn.amount;
    balances[acct.id] = (balances[acct.id] || 0) + delta;
  }

  function applyTransferToBalances(balances, tr) {
    const from = findAccount(tr.fromAccountId);
    const to = findAccount(tr.toAccountId);
    if (!from || !to) return;
    balances[from.id] = (balances[from.id] || 0) - tr.amount;
    balances[to.id] = (balances[to.id] || 0) + tr.amount;
  }

  // Opening balance for a given month: an explicit value set for that exact month (typed
  // directly, or via "Copy Previous Month's Balances"), falling back to the account's single
  // base openingBalance for any month that's never had one set.
  function effectiveOpeningBalance(acct, month) {
    if (acct.openingBalances && Object.prototype.hasOwnProperty.call(acct.openingBalances, month)) {
      return numOr0(acct.openingBalances[month]);
    }
    return numOr0(acct.openingBalance);
  }

  // Scoped to one month — opening balance for that month plus only that month's own
  // transactions/transfers, mirroring a real monthly bank statement (opening + this month's
  // activity = closing), rather than an all-time running total.
  function computeAccountBalances(month) {
    const balances = {};
    tracker().accounts.forEach((a) => { balances[a.id] = effectiveOpeningBalance(a, month); });
    tracker().transactions.filter((t) => t.date && t.date.slice(0, 7) === month).forEach((txn) => applyTxnToBalances(balances, txn));
    tracker().transfers.filter((t) => t.date && t.date.slice(0, 7) === month).forEach((tr) => applyTransferToBalances(balances, tr));
    return balances;
  }

  // ---------- derived (month-scoped) ----------
  function computeDerivedTracker() {
    const monthTxns = tracker().transactions.filter((t) => t.date && t.date.slice(0, 7) === selectedMonth);
    const monthTransfers = tracker().transfers.filter((t) => t.date && t.date.slice(0, 7) === selectedMonth);
    let totalIncome = 0;
    let totalExpense = 0;
    let totalSavings = 0;
    const spendByTopLevel = {};
    const spendBySub = {};
    const incomeBySub = {};
    // Each of the three "Total ___" stat cards has its own independent exclusion list (via that
    // card's ⚙ customize icon) — spendByTopLevel/spendBySub always include everything regardless,
    // so Budget vs Actual and both charts (which have their own, separate exclusion lists) are
    // never affected by these.
    const excl = tracker().chartExclusions;
    monthTxns.forEach((t) => {
      const cat = findCategory(t.categoryId);
      if (!cat) return;
      if (t.direction === "in") {
        if (!excl.totalIncome.includes(cat.id)) totalIncome += t.amount;
        incomeBySub[cat.id] = (incomeBySub[cat.id] || 0) + t.amount; // always a plain, non-negative sum
      } else {
        if (!excl.totalExpenses.includes(cat.id)) totalExpense += t.amount;
        if (!excl.totalSavings.includes(cat.id)) totalSavings += t.amount;
        const top = topLevelOf(cat);
        if (top) spendByTopLevel[top.id] = (spendByTopLevel[top.id] || 0) + t.amount;
        spendBySub[cat.id] = (spendBySub[cat.id] || 0) + t.amount;
      }
    });
    // Every non-archived leaf category is listed, even with zero activity and no budget yet —
    // otherwise there'd be no row to type a budget into before you've spent anything in it.
    // "Actual" is always the net of out minus in, shown as a non-negative magnitude — a rare
    // refund reduces effective spend rather than being hidden. When in exceeds out (net inflow),
    // netNegative flags it so the bar renders in a distinct color instead of the normal/over ones.
    // Rows are grouped by top-level category (in the order that group first appears), and within
    // each group sorted by descending actual — recomputed on every render, so the order always
    // reflects the currently-selected month's activity rather than a stored/static ordering.
    const budgetGroups = [];
    const groupByTopId = {};
    tracker().categories
      .filter((c) => !c.archived && isLeafCategory(c))
      .forEach((c) => {
        const hasBudget = c.hasBudget !== false;
        const net = (spendBySub[c.id] || 0) - (incomeBySub[c.id] || 0);
        const actual = Math.abs(net);
        const netNegative = net < 0;
        const budget = hasBudget ? numOr0(tracker().budgets[c.id]) : 0;
        const pct = hasBudget && budget > 0 ? (actual / budget) * 100 : (hasBudget && actual > 0 ? 100 : 0);
        const row = { category: c, hasBudget, actual, netNegative, budget, pct };
        const top = topLevelOf(c);
        let group = groupByTopId[top.id];
        if (!group) {
          group = { topLevel: top, rows: [] };
          groupByTopId[top.id] = group;
          budgetGroups.push(group);
        }
        group.rows.push(row);
      });
    budgetGroups.forEach((g) => g.rows.sort((a, b) => b.actual - a.actual));
    return {
      monthTxns, monthTransfers, totalIncome, totalExpense, totalSavings,
      txnCount: monthTxns.length, spendByTopLevel, spendBySub, incomeBySub, budgetGroups, balances: computeAccountBalances(selectedMonth)
    };
  }

  // ---------- rendering ----------
  function renderAll() {
    const d = computeDerivedTracker();
    renderMonthLabel();
    renderAccounts(d);
    renderStats(d);
    renderBudget(d);
    renderCharts(d);
    renderTxnFilterOptions();
    renderTransactions(d);

    const updatedDisplay = document.getElementById("updatedDisplay");
    if (updatedDisplay) updatedDisplay.textContent = fmtDate(state.updated);
  }

  function renderMonthLabel() {
    const label = fmtMonthLabel(selectedMonth);
    document.getElementById("monthLabel").textContent = label;
    document.getElementById("monthSubtitle").textContent = label + " overview";
    document.getElementById("donutMonthLabel").textContent = label;
    document.getElementById("donutMonthLabel2").textContent = label;
    document.getElementById("accountsMonthLabel").textContent = label;
    document.getElementById("monthJump").value = selectedMonth;
  }

  function card(label, value, hintHtml, actionBtnHtml) {
    const labelRow = actionBtnHtml
      ? '<div class="stat-card-head"><div class="label">' + label + "</div>" + actionBtnHtml + "</div>"
      : '<div class="label">' + label + "</div>";
    return '<div class="stat-card">' + labelRow + '<div class="value">' + value + "</div>" + (hintHtml || "") + "</div>";
  }

  function renderAccounts(d) {
    let rows = tracker().accounts.map((a) => {
      const bal = d.balances[a.id] || 0;
      const balClass = bal < 0 ? "pos" : "neu";
      const balText = bal < 0 ? "-" + fmtINR(Math.abs(bal)) : fmtINR(bal);
      return "<tr>" +
        '<td class="left"><input class="cell-input name-input" data-type="account" data-id="' + a.id + '" data-field="name" value="' + escapeAttr(a.name) + '"></td>' +
        '<td><input class="cell-input amount" type="number" step="0.01" data-type="account" data-id="' + a.id + '" data-field="openingBalanceMonth" value="' + effectiveOpeningBalance(a, selectedMonth) + '"></td>' +
        '<td class="' + balClass + '">' + balText + "</td>" +
        '<td><button class="icon-btn" data-action="delete-account" data-id="' + a.id + '" title="Delete account">✕</button></td>' +
        "</tr>";
    }).join("");
    if (!rows) rows = '<tr><td colspan="4" class="empty-msg">No accounts yet — add one from Manage ▾.</td></tr>';
    document.getElementById("accountsBody").innerHTML = rows;
    document.getElementById("acctHint").textContent = tracker().accounts.length + " account" + (tracker().accounts.length === 1 ? "" : "s");

    // Mobile card rendering of the same accounts — hidden on desktop (and vice versa) purely
    // via CSS, both always in the DOM. Reuses the identical data-type="account" convention on
    // every input, so the existing delegated "change" handler serves both representations.
    let cardsHtml = tracker().accounts.map((a) => {
      const bal = d.balances[a.id] || 0;
      const balClass = bal < 0 ? "pos" : "neu";
      const balText = bal < 0 ? "-" + fmtINR(Math.abs(bal)) : fmtINR(bal);
      return '<div class="acct-card">' +
        '<div class="acct-top">' +
          '<input class="cell-input name-input" data-type="account" data-id="' + a.id + '" data-field="name" value="' + escapeAttr(a.name) + '">' +
          '<button class="icon-btn" data-action="delete-account" data-id="' + a.id + '" title="Delete account">✕</button>' +
        "</div>" +
        '<div class="acct-fields">' +
          '<div class="field"><label>Opening Balance</label><input class="cell-input amount" type="number" step="0.01" data-type="account" data-id="' + a.id + '" data-field="openingBalanceMonth" value="' + effectiveOpeningBalance(a, selectedMonth) + '"></div>' +
          '<div class="field"><label>Closing Balance</label><div class="acct-closing-value ' + balClass + '">' + balText + "</div></div>" +
        "</div>" +
      "</div>";
    }).join("");
    if (!cardsHtml) cardsHtml = '<div class="empty-msg">No accounts yet — add one from Manage ▾.</div>';
    document.getElementById("accountsCards").innerHTML = cardsHtml;
  }

  // Shows every transfer (not scoped to the selected month) — this renders into the Manage
  // Transfers modal, on demand when it's opened, the same way renderCategoriesModal() does.
  function renderTransfers() {
    let rows = tracker().transfers.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).map((t) => {
      return "<tr>" +
        '<td class="left"><input class="cell-input name-input" type="date" style="width:130px;" data-type="transfer" data-id="' + t.id + '" data-field="date" value="' + t.date + '"></td>' +
        '<td class="left"><input class="cell-input name-input" data-type="transfer" data-id="' + t.id + '" data-field="item" value="' + escapeAttr(t.item) + '"></td>' +
        '<td class="left"><select class="cell-input" style="width:110px;" data-type="transfer" data-id="' + t.id + '" data-field="fromAccountId">' + acctOptions(t.fromAccountId) + "</select></td>" +
        '<td class="left"><select class="cell-input" style="width:110px;" data-type="transfer" data-id="' + t.id + '" data-field="toAccountId">' + acctOptions(t.toAccountId) + "</select></td>" +
        '<td><input class="cell-input amount" type="number" step="0.01" data-type="transfer" data-id="' + t.id + '" data-field="amount" value="' + numOr0(t.amount) + '"></td>' +
        '<td><button class="icon-btn" data-action="delete-transfer" data-id="' + t.id + '" title="Delete transfer">✕</button></td>' +
        "</tr>";
    }).join("");
    if (!rows) rows = '<tr><td colspan="6" class="empty-msg">No transfers yet.</td></tr>';
    const firstAcct = tracker().accounts[0];
    const secondAcct = tracker().accounts[1] || firstAcct;
    rows += '<tr class="add-row">' +
      '<td class="left"><input class="cell-input name-input" type="date" style="width:130px;" id="newTransferDate" value="' + todayStr() + '"></td>' +
      '<td class="left"><input class="cell-input name-input" placeholder="e.g. CC bill payment" id="newTransferItem"></td>' +
      '<td class="left"><select class="cell-input" style="width:110px;" id="newTransferFrom">' + acctOptions(firstAcct && firstAcct.id) + "</select></td>" +
      '<td class="left"><select class="cell-input" style="width:110px;" id="newTransferTo">' + acctOptions(secondAcct && secondAcct.id) + "</select></td>" +
      '<td><input class="cell-input amount" type="number" placeholder="Amount" id="newTransferAmount"></td>' +
      '<td><button class="btn" style="padding:5px 10px;font-size:11px;" data-action="add-transfer">+ Add</button></td>' +
      "</tr>";
    document.getElementById("transferBody").innerHTML = rows;
  }

  function customizeStatBtn(target, label) {
    return '<button class="icon-btn" data-action="open-chart-customize" data-target="' + target + '" title="Choose which categories count toward ' + label + '">⚙</button>';
  }

  function renderStats(d) {
    document.getElementById("statCards").innerHTML = [
      card("Total Income", fmtINR(d.totalIncome), '<span class="hint">' + fmtMonthLabel(selectedMonth) + "</span>", customizeStatBtn("totalIncome", "Total Income")),
      card("Total Expenses", fmtINR(d.totalExpense), '<span class="hint">' + fmtMonthLabel(selectedMonth) + "</span>", customizeStatBtn("totalExpenses", "Total Expenses")),
      card("Total Savings", fmtINR(d.totalSavings), '<span class="hint">' + fmtMonthLabel(selectedMonth) + "</span>", customizeStatBtn("totalSavings", "Total Savings")),
      card("Transactions", String(d.txnCount), '<span class="hint">this month</span>')
    ].join("");
  }

  function renderBudget(d) {
    const totalRows = d.budgetGroups.reduce((n, g) => n + g.rows.length, 0);
    if (totalRows === 0) {
      const empty = '<tr><td colspan="4" class="empty-msg">No categories yet — add one via Manage Categories.</td></tr>';
      document.getElementById("budgetBody").innerHTML = empty;
      document.getElementById("budgetCards").innerHTML = '<div class="empty-msg">No categories yet — add one via Manage Categories.</div>';
      document.getElementById("budgetHint").textContent = "";
      return;
    }
    // Top-level accent bar color matches that group's own color in the "By Top-Level Category"
    // chart (same PALETTE, same index order) — see renderCharts() below.
    const topLevelIds = tracker().categories.filter((c) => !c.parentId).map((c) => c.id);
    let i = 0;
    let totalActual = 0, totalBudget = 0;
    const tableParts = [];
    const cardParts = [];
    d.budgetGroups.forEach((g) => {
      const topIdx = topLevelIds.indexOf(g.topLevel.id);
      const topColor = PALETTE[(topIdx < 0 ? 0 : topIdx) % PALETTE.length];
      tableParts.push('<tr class="budget-group-head"><td colspan="4"><span class="accent-bar" style="background:' + topColor + '"></span>' + escapeHtml(g.topLevel.name) + "</td></tr>");
      let gActual = 0, gBudget = 0;
      const subParts = [];
      g.rows.forEach((row) => {
        const idx = i++;
        const barPct = Math.min(row.pct, 100);
        const over = row.hasBudget && row.budget > 0 && row.pct > 100 && !row.netNegative;
        const budgetInput = row.hasBudget
          ? '<input class="cell-input amount" type="number" step="1" data-type="budget" data-field="budget" data-id="' + row.category.id + '" value="' + numOr0(tracker().budgets[row.category.id]) + '">'
          : "";
        const barClass = row.netNegative ? " negative" : (over ? " over" : "");
        const bar = row.hasBudget
          ? '<div class="budget-bar-track"><div class="budget-bar-fill' + barClass + '" style="width:' + barPct + '%"></div></div>'
          : "";
        gActual += row.actual;
        if (row.hasBudget) {
          gBudget += numOr0(tracker().budgets[row.category.id]);
          totalActual += row.actual;
        }
        tableParts.push("<tr>" +
          '<td class="left"><div class="name-cell"><span class="swatch" style="background:' + PALETTE[idx % PALETTE.length] + '"></span>' + escapeHtml(row.category.name) + "</div></td>" +
          "<td>" + budgetInput + "</td>" +
          '<td class="' + (over ? "pos" : "neu") + '">' + fmtINR(row.actual) + "</td>" +
          '<td style="min-width:110px;">' + bar + "</td>" +
          "</tr>");
        subParts.push('<div class="brow-m"><div class="brow-line">' +
          '<span class="brow-name"><span class="swatch" style="background:' + PALETTE[idx % PALETTE.length] + '"></span>' + escapeHtml(row.category.name) + "</span>" +
          '<span class="brow-actual ' + (over ? "pos" : "neu") + '">' + fmtINR(row.actual) + "</span>" + budgetInput +
          "</div>" + bar + "</div>");
      });
      totalBudget += gBudget;
      // Group summary card: one bar per top-level group; its sub-categories expand on tap.
      const gPct = gBudget > 0 ? Math.min((gActual / gBudget) * 100, 100) : 0;
      const gOver = gBudget > 0 && gActual > gBudget;
      const gBar = gBudget > 0
        ? '<div class="bgroup-bar"><div class="budget-bar-track"><div class="budget-bar-fill' + (gOver ? " over" : "") + '" style="width:' + gPct + '%"></div></div></div>'
        : "";
      cardParts.push('<div class="bgroup' + (expandedBudgetGroups.has(g.topLevel.id) ? " open" : "") + '" data-bgroup="' + g.topLevel.id + '">' +
        '<div class="bgroup-head"><span class="bchev">▶</span><span class="accent-bar" style="background:' + topColor + ';margin-right:0;"></span>' +
        '<span class="bg-name">' + escapeHtml(g.topLevel.name) + '</span>' +
        '<span class="bg-amt">' + fmtINR(gActual) + (gBudget > 0 ? " / " + fmtINR(gBudget) : "") + "</span></div>" +
        gBar + '<div class="bgroup-sub">' + subParts.join("") + "</div></div>");
    });
    document.getElementById("budgetBody").innerHTML = tableParts.join("");
    document.getElementById("budgetCards").innerHTML = cardParts.join("");
    document.getElementById("budgetHint").textContent = totalBudget > 0 ? fmtINR(totalActual) + " of " + fmtINR(totalBudget) : "";
  }

  function renderCharts(d) {
    const cs = getComputedStyle(document.documentElement);
    const mutedColor = cs.getPropertyValue("--muted").trim();
    const cardBg = cs.getPropertyValue("--card").trim();

    function draw(existing, canvasId, labels, data, colors) {
      const ctx = document.getElementById(canvasId).getContext("2d");
      if (existing) existing.destroy();
      if (labels.length === 0) return null;
      return new Chart(ctx, {
        type: "doughnut",
        data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: cardBg }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          // Phones: legend below so the donut gets the full width instead of fighting a tall
          // side stack of labels. renderAll() re-runs on breakpoint change (see init).
          plugins: { legend: { position: MOBILE_MQ.matches ? "bottom" : "right", labels: { boxWidth: 10, font: { size: 10 }, color: mutedColor } } }
        }
      });
    }

    const excl = tracker().chartExclusions;
    const topLabels = [], topData = [], topColors = [];
    tracker().categories.filter((c) => !c.parentId).forEach((c, i) => {
      const amt = d.spendByTopLevel[c.id] || 0;
      if (amt > 0 && !excl.topLevel.includes(c.id)) { topLabels.push(c.name); topData.push(amt); topColors.push(PALETTE[i % PALETTE.length]); }
    });
    chartTopLevel = draw(chartTopLevel, "chartTopLevel", topLabels, topData, topColors);

    const subLabels = [], subData = [], subColors = [];
    tracker().categories.filter((c) => isLeafCategory(c) && !c.archived).forEach((c, i) => {
      const amt = d.spendBySub[c.id] || 0;
      if (amt > 0 && !excl.category.includes(c.id)) { subLabels.push(c.name); subData.push(amt); subColors.push(PALETTE[i % PALETTE.length]); }
    });
    chartCategory = draw(chartCategory, "chartCategory", subLabels, subData, subColors);
  }

  // ---------- Chart customization modal (which categories show in each donut) ----------
  function chartCustomizeRow(c, excludedIds) {
    const checked = !excludedIds.includes(c.id);
    return '<label class="chart-customize-row"><input type="checkbox" data-chart-cat-id="' + c.id + '"' + (checked ? " checked" : "") + ">" + escapeHtml(c.name) + "</label>";
  }

  const CHART_CUSTOMIZE_TITLES = {
    topLevel: "By Top-Level Category chart",
    category: "By Category chart",
    totalIncome: "Total Income calculation",
    totalExpenses: "Total Expenses calculation",
    totalSavings: "Total Savings calculation"
  };
  const CHART_CUSTOMIZE_DESCS = {
    topLevel: "Uncheck a category to hide it from this chart only — nothing else about it changes.",
    category: "Uncheck a category to hide it from this chart only — nothing else about it changes.",
    totalIncome: "Uncheck a category to leave its \"In\" activity out of the Total Income stat card. This only affects that one number.",
    totalExpenses: "Uncheck a category to leave its spending out of the Total Expenses stat card. This only affects that one number — the category itself, its budget, and both charts are unaffected.",
    totalSavings: "Uncheck a category to leave its spending out of the Total Savings stat card. Defaults to just the \"Savings\" group's categories, so it doesn't double-count with Total Expenses — check others in if you want them counted as savings too."
  };

  function renderChartCustomizeModal() {
    const target = chartCustomizeTarget;
    const excludedIds = tracker().chartExclusions[target];
    document.getElementById("chartCustomizeTitle").textContent = CHART_CUSTOMIZE_TITLES[target] || "";
    document.getElementById("chartCustomizeDesc").textContent = CHART_CUSTOMIZE_DESCS[target] || "";

    let html;
    if (target === "topLevel") {
      html = tracker().categories.filter((c) => !c.parentId).map((c) => chartCustomizeRow(c, excludedIds)).join("");
    } else {
      html = tracker().categories.filter((c) => !c.parentId).map((top) => {
        const subs = tracker().categories.filter((c) => c.parentId === top.id && !c.archived);
        if (subs.length === 0) return "";
        return '<div class="chart-customize-group">' + escapeHtml(top.name) + "</div>" + subs.map((c) => chartCustomizeRow(c, excludedIds)).join("");
      }).join("");
    }
    document.getElementById("chartCustomizeList").innerHTML = html || '<p class="empty-msg">No categories yet.</p>';
  }

  // ---------- Category Overview modal (week/month/year, all-time — not scoped to selectedMonth) ----------
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function availableYears() {
    const years = Array.from(new Set(tracker().transactions.map((t) => (t.date || "").slice(0, 4)).filter(Boolean))).sort();
    return years.length ? years : [String(new Date().getFullYear())];
  }

  // Same net-out-minus-in convention as Budget vs Actual, bucketed by week/month/year instead of
  // per-leaf-category for a single month — "actual" is always a non-negative magnitude (a
  // category dominated by "In", like Income, still just shows its size). Two shapes: with no
  // categoryId, one series per top-level group (the original view); with a leaf categoryId, a
  // single series scoped to just that category's own transactions, for drilling into one
  // category's trend rather than comparing groups.
  function computeOverviewData(mode, year, month, categoryId) {
    const txns = tracker().transactions;

    let buckets;
    if (mode === "year") {
      buckets = availableYears().map((y) => ({ key: y, label: y }));
    } else if (mode === "month") {
      buckets = MONTH_NAMES.map((name, i) => ({ key: year + "-" + String(i + 1).padStart(2, "0"), label: name }));
    } else {
      const daysInMonth = new Date(Number(year), Number(month), 0).getDate();
      const weekCount = Math.ceil(daysInMonth / 7);
      buckets = Array.from({ length: weekCount }, (_, i) => ({ key: String(i + 1), label: "Week " + (i + 1) }));
    }
    const bucketIndex = {};
    buckets.forEach((b, i) => { bucketIndex[b.key] = i; });

    function inScope(t) {
      if (!t.date) return false;
      if (mode === "year") return true;
      if (mode === "month") return t.date.slice(0, 4) === year;
      return t.date.slice(0, 7) === (year + "-" + month);
    }
    function bucketKeyOf(t) {
      if (mode === "year") return t.date.slice(0, 4);
      if (mode === "month") return t.date.slice(0, 7);
      const day = Number(t.date.slice(8, 10));
      return String(Math.floor((day - 1) / 7) + 1);
    }

    let sums;
    if (categoryId) {
      const cat = findCategory(categoryId);
      if (!cat) return { buckets, series: [] };
      sums = [{ category: cat, out: new Array(buckets.length).fill(0), in: new Array(buckets.length).fill(0) }];
    } else {
      sums = tracker().categories.filter((c) => !c.parentId)
        .map((tl) => ({ category: tl, out: new Array(buckets.length).fill(0), in: new Array(buckets.length).fill(0) }));
    }
    const sumById = {};
    sums.forEach((s) => { sumById[s.category.id] = s; });

    txns.forEach((t) => {
      if (!inScope(t)) return;
      const cat = findCategory(t.categoryId);
      if (!cat) return;
      const s = categoryId ? (t.categoryId === categoryId ? sumById[categoryId] : null) : sumById[topLevelOf(cat).id];
      if (!s) return;
      const idx = bucketIndex[bucketKeyOf(t)];
      if (idx === undefined) return;
      if (t.direction === "in") s.in[idx] += t.amount; else s.out[idx] += t.amount;
    });

    const series = sums.map((s) => ({
      category: s.category,
      points: buckets.map((b, i) => {
        const net = s.out[i] - s.in[i];
        return { actual: Math.abs(net) };
      })
    }));

    return { buckets, series };
  }

  function populateOverviewPickers() {
    const years = availableYears();
    if (!overviewYear || !years.includes(overviewYear)) overviewYear = years[years.length - 1];
    if (!overviewMonth) overviewMonth = selectedMonth.slice(5, 7);
    document.getElementById("overviewYear").innerHTML = years
      .map((y) => '<option value="' + y + '"' + (y === overviewYear ? " selected" : "") + ">" + y + "</option>").join("");
    document.getElementById("overviewMonth").innerHTML = MONTH_NAMES
      .map((name, i) => {
        const v = String(i + 1).padStart(2, "0");
        return '<option value="' + v + '"' + (v === overviewMonth ? " selected" : "") + ">" + name + "</option>";
      }).join("");
    document.getElementById("overviewYear").style.display = overviewMode === "year" ? "none" : "";
    document.getElementById("overviewMonth").style.display = overviewMode === "week" ? "" : "none";
    document.querySelectorAll("#overviewModeGroup .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === overviewMode));
    // "All Top-Level" (default) groups by Income/Expense/Savings like before; picking one specific
    // category below drills into just that category's own trend instead of comparing groups.
    document.getElementById("overviewCategory").innerHTML =
      '<option value=""' + (overviewCategoryId ? "" : " selected") + '>All Top-Level</option>' + categorySelectOptions(overviewCategoryId);
  }

  function renderOverview() {
    populateOverviewPickers();
    const data = computeOverviewData(overviewMode, overviewYear, overviewMonth, overviewCategoryId || null);

    // Color lookup matches whichever chart this category is normally colored by: top-level ids
    // (in top-level order) when comparing groups, leaf ids (in "By Category" chart order) when
    // drilled into one specific category — so the color is never a coincidence, just consistent
    // with where you'd already recognize that category from elsewhere in the app.
    const idIndex = overviewCategoryId
      ? tracker().categories.filter((c) => isLeafCategory(c) && !c.archived).map((c) => c.id)
      : tracker().categories.filter((c) => !c.parentId).map((c) => c.id);

    const cs = getComputedStyle(document.documentElement);
    const mutedColor = cs.getPropertyValue("--muted").trim();
    const gridColor = cs.getPropertyValue("--row-line").trim();

    // Each series keeps one consistent color everywhere it appears — chart bars, legend swatch,
    // and the table cells below — rather than swapping per-bar, which made the legend (one fixed
    // swatch per dataset) mismatch bars that had switched to a different color.
    const colorById = {};
    data.series.forEach((s) => {
      const idx = idIndex.indexOf(s.category.id);
      colorById[s.category.id] = PALETTE[(idx < 0 ? 0 : idx) % PALETTE.length];
    });

    if (overviewChart) { overviewChart.destroy(); overviewChart = null; }
    if (data.buckets.length && data.series.length) {
      const datasets = data.series.map((s) => ({
        label: s.category.name,
        data: s.points.map((p) => p.actual),
        backgroundColor: colorById[s.category.id]
      }));
      const ctx = document.getElementById("overviewChart").getContext("2d");
      overviewChart = new Chart(ctx, {
        type: "bar",
        data: { labels: data.buckets.map((b) => b.label), datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            x: { ticks: { color: mutedColor, font: { size: 10 } }, grid: { display: false } },
            y: {
              ticks: {
                color: mutedColor, font: { size: 10 },
                callback: (v) => v >= 100000 ? (v / 100000) + "L" : v >= 1000 ? (v / 1000) + "k" : v
              },
              grid: { color: gridColor }
            }
          },
          plugins: {
            legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 10 }, color: mutedColor } },
            tooltip: { callbacks: { label: (c) => c.dataset.label + ": " + fmtINR(c.parsed.y) } }
          }
        }
      });
    }

    const head = '<th class="left">Period</th>' + data.series.map((s) => "<th>" + escapeHtml(s.category.name) + "</th>").join("");
    document.getElementById("overviewTableHead").innerHTML = head;
    const bodyRows = data.buckets.map((b, i) => {
      const cells = data.series.map((s) => {
        const p = s.points[i];
        const style = p.actual > 0 ? ' style="color:' + colorById[s.category.id] + '"' : "";
        return "<td" + (p.actual > 0 ? style : ' class="neu"') + ">" + (p.actual > 0 ? fmtINR(p.actual) : "—") + "</td>";
      }).join("");
      return '<tr><td class="left">' + escapeHtml(b.label) + "</td>" + cells + "</tr>";
    }).join("");
    document.getElementById("overviewTableBody").innerHTML = bodyRows ||
      '<tr><td colspan="' + (data.series.length + 1) + '" class="empty-msg">No categories yet.</td></tr>';
  }

  function acctOptions(selectedId) {
    return tracker().accounts.map((a) => '<option value="' + a.id + '"' + (a.id === selectedId ? " selected" : "") + ">" + escapeHtml(a.name) + "</option>").join("");
  }

  // Grouped by top-level category via <optgroup>, so the hierarchy is visible without extra UI.
  // A top-level category with no children of its own is included as a directly-selectable option.
  // `categories`/`newIds` let the import preview build options against its own merged
  // existing+not-yet-created list instead of the live tracker — every other caller just uses the
  // defaults (the live tracker, nothing marked "new").
  function categorySelectOptions(selectedId, categories, newIds) {
    categories = categories || tracker().categories;
    const isLeaf = (cat) => !categories.some((c) => c.parentId === cat.id);
    return categories.filter((c) => !c.parentId).map((top) => {
      const subs = categories.filter((c) => c.parentId === top.id && (!c.archived || c.id === selectedId));
      let opts = "";
      if (isLeaf(top)) {
        opts += '<option value="' + top.id + '"' + (top.id === selectedId ? " selected" : "") + ">" + escapeHtml(top.name) + " (general)" + (newIds && newIds.has(top.id) ? " — new" : "") + "</option>";
      }
      opts += subs.map((s) => '<option value="' + s.id + '"' + (s.id === selectedId ? " selected" : "") + ">" + escapeHtml(s.name) + (newIds && newIds.has(s.id) ? " — new" : "") + "</option>").join("");
      return opts ? '<optgroup label="' + escapeHtml(top.name) + '">' + opts + "</optgroup>" : "";
    }).join("");
  }

  // Selecting a top-level category (e.g. "Expense") should show every transaction filed under
  // any of its sub-categories too, not just ones literally assigned to the top-level category
  // itself — most transactions are assigned to a sub-category, never the group directly.
  function categoryMatchesFilter(categoryId, filterId) {
    if (!filterId) return true;
    if (categoryId === filterId) return true;
    const cat = findCategory(categoryId);
    const top = cat && topLevelOf(cat);
    return !!top && top.id === filterId;
  }

  function renderTransactions(d) {
    let rows = d.monthTxns.slice().sort((a, b) => {
      if (a.date === b.date) return 0;
      const newerFirst = a.date > b.date ? -1 : 1;
      return sortOrder === "oldest" ? -newerFirst : newerFirst;
    });
    if (filterCategoryId) rows = rows.filter((t) => categoryMatchesFilter(t.categoryId, filterCategoryId));
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter((t) => t.item.toLowerCase().includes(q));
    }

    const rowsHtml = rows.map((t) => {
      const amtClass = t.direction === "in" ? "neg" : "pos";
      return "<tr>" +
        '<td class="left"><input class="cell-input name-input" type="date" style="width:130px;" data-type="txn" data-id="' + t.id + '" data-field="date" value="' + t.date + '"></td>' +
        '<td class="left"><input class="cell-input name-input" data-type="txn" data-id="' + t.id + '" data-field="item" value="' + escapeAttr(t.item) + '"></td>' +
        '<td class="left"><select class="cell-input" style="width:170px;" data-type="txn" data-id="' + t.id + '" data-field="categoryId">' + categorySelectOptions(t.categoryId) + "</select></td>" +
        '<td class="left"><select class="cell-input" style="width:110px;" data-type="txn" data-id="' + t.id + '" data-field="accountId">' + acctOptions(t.accountId) + "</select></td>" +
        '<td><select class="cell-input" style="width:auto;" data-type="txn" data-id="' + t.id + '" data-field="direction">' +
        '<option value="out"' + (t.direction === "out" ? " selected" : "") + ">Out</option>" +
        '<option value="in"' + (t.direction === "in" ? " selected" : "") + ">In</option>" +
        "</select></td>" +
        '<td class="' + amtClass + '"><input class="cell-input amount" type="number" step="0.01" data-type="txn" data-id="' + t.id + '" data-field="amount" value="' + numOr0(t.amount) + '"></td>' +
        '<td><button class="icon-btn" data-action="delete-txn" data-id="' + t.id + '" title="Delete transaction">✕</button></td>' +
        "</tr>";
    }).join("");

    const emptyMsg = "No transactions " + (searchQuery || filterCategoryId ? "match your search/filter" : "this month") + ".";
    document.getElementById("txnBody").innerHTML =
      rowsHtml || ('<tr><td colspan="7" class="empty-msg">' + emptyMsg + "</td></tr>");

    // Mobile card rendering of the same rows — hidden on desktop (and vice versa) purely via
    // CSS, so both are always in the DOM. The card inputs reuse the exact data-type/data-id/
    // data-field convention, which means the one delegated "change" handler below serves both
    // representations without knowing which one the user is looking at.
    // Cards are grouped under sticky day headers (weekday + date + that day's net), so each
    // card drops its date chip; and only the first txnCardLimit cards render — "Show older"
    // extends the window, keeping heavy months cheap to re-render on every edit.
    const netByDate = {};
    rows.forEach((t) => {
      const key = t.date || "?";
      netByDate[key] = (netByDate[key] || 0) + (t.direction === "in" ? 1 : -1) * (Number(t.amount) || 0);
    });
    function dayHeadHtml(date) {
      let label = "No date";
      if (date && date !== "?") {
        const d2 = new Date(date + "T00:00:00");
        const wd = isNaN(d2.getTime()) ? "" : d2.toLocaleDateString(undefined, { weekday: "short" }) + ", ";
        label = wd + Number(date.slice(8, 10)) + " " + (MONTH_NAMES[Number(date.slice(5, 7)) - 1] || "");
      }
      const net = netByDate[date || "?"] || 0;
      // The day's net covers ALL of that day's (filtered) rows, even when "Show older" has
      // cut the day's card list short — a truncated day still shows its true total.
      const netHtml = "<b class=\"" + (net < 0 ? "net-out" : "net-in") + "\">" + (net < 0 ? "−" : "+") + fmtINR(Math.abs(net)) + "</b>";
      return '<div class="day-head"><span>' + escapeHtml(label) + "</span>" + netHtml + "</div>";
    }
    const shownRows = rows.slice(0, txnCardLimit);
    let cardsHtml = "";
    let currentDay = null;
    shownRows.forEach((t) => {
      const key = t.date || "?";
      if (key !== currentDay) { currentDay = key; cardsHtml += dayHeadHtml(t.date); }
      const cat = findCategory(t.categoryId);
      const acct = findAccount(t.accountId);
      const isIn = t.direction === "in";
      cardsHtml += '<div class="txn-card' + (t.id === expandedTxnCardId ? " expanded" : "") + '" data-txn-card="' + t.id + '">' +
        '<div class="txn-top"><span class="txn-item-label">' + escapeHtml(t.item) + '</span><span class="txn-amt ' + (isIn ? "in" : "out") + '">' + (isIn ? "+" : "−") + fmtINR(t.amount) + "</span></div>" +
        '<div class="txn-meta"><span class="tchip cat">' + escapeHtml(cat ? cat.name : "?") + '</span><span class="tchip">' + escapeHtml(acct ? acct.name : "?") + '</span><span class="tchip ' + (isIn ? "dir-in" : "dir-out") + '">' + (isIn ? "In" : "Out") + "</span></div>" +
        '<div class="txn-edit"><div class="field-grid">' +
        '<div class="field"><label>Date</label><input type="date" data-type="txn" data-id="' + t.id + '" data-field="date" value="' + t.date + '"></div>' +
        '<div class="field"><label>Amount</label><input type="number" step="0.01" data-type="txn" data-id="' + t.id + '" data-field="amount" value="' + numOr0(t.amount) + '"></div>' +
        '<div class="field" style="grid-column:1/-1;"><label>Item</label><input data-type="txn" data-id="' + t.id + '" data-field="item" value="' + escapeAttr(t.item) + '"></div>' +
        '<div class="field"><label>Category</label><select data-type="txn" data-id="' + t.id + '" data-field="categoryId">' + categorySelectOptions(t.categoryId) + "</select></div>" +
        '<div class="field"><label>Account</label><select data-type="txn" data-id="' + t.id + '" data-field="accountId">' + acctOptions(t.accountId) + "</select></div>" +
        '<div class="field"><label>In / Out</label><select data-type="txn" data-id="' + t.id + '" data-field="direction"><option value="out"' + (isIn ? "" : " selected") + '>Out</option><option value="in"' + (isIn ? " selected" : "") + ">In</option></select></div>" +
        '</div><div class="txn-edit-actions"><button class="del-link" data-action="delete-txn" data-id="' + t.id + '">✕ Delete</button><span class="tchip">changes save instantly</span></div></div>' +
        "</div>";
    });
    if (rows.length > txnCardLimit) {
      cardsHtml += '<button class="show-older" data-action="show-older-txns">Show older (' + (rows.length - txnCardLimit) + " more)</button>";
    }
    document.getElementById("txnCards").innerHTML = cardsHtml || '<div class="empty-msg">' + emptyMsg + "</div>";

    populateAddTxnSelects();
  }

  // The add-transaction modal's selects need refreshing whenever categories/accounts change;
  // current selections are preserved across refreshes so back-to-back adds keep their values.
  function populateAddTxnSelects() {
    const catSel = document.getElementById("newTxnCategory");
    const acctSel = document.getElementById("newTxnAccount");
    const firstCat = tracker().categories.find((c) => isLeafCategory(c) && !c.archived) || tracker().categories.find((c) => !c.parentId);
    const firstAcct = tracker().accounts[0];
    const prevCat = catSel.value;
    const prevAcct = acctSel.value;
    catSel.innerHTML = categorySelectOptions(prevCat || (firstCat && firstCat.id));
    if (prevCat) catSel.value = prevCat;
    acctSel.innerHTML = acctOptions(prevAcct || (firstAcct && firstAcct.id));
    if (prevAcct) acctSel.value = prevAcct;
    const dateInput = document.getElementById("newTxnDate");
    if (!dateInput.value) dateInput.value = todayStr();
  }

  function openAddTxnModal() {
    addTxnSessionCount = 0;
    const counter = document.getElementById("addTxnCount");
    counter.style.display = "none";
    counter.textContent = "";
    document.getElementById("newTxnDate").value = todayStr();
    document.getElementById("newTxnItem").value = "";
    document.getElementById("newTxnAmount").value = "";
    populateAddTxnSelects();
    document.getElementById("addTxnBackdrop").classList.add("show");
    document.getElementById("newTxnItem").focus();
  }

  // Each top-level group is itself a selectable "All <Group>" option (matches every
  // transaction under any of its sub-categories, via categoryMatchesFilter), grouped with its
  // sub-categories underneath via <optgroup> for the same at-a-glance hierarchy as the
  // add-transaction category picker.
  function renderTxnFilterOptions() {
    const optionsHtml = '<option value="">All</option>' +
      tracker().categories.filter((c) => !c.parentId).map((top) => {
        const subs = tracker().categories.filter((c) => c.parentId === top.id);
        const opts = '<option value="' + top.id + '">All ' + escapeHtml(top.name) + "</option>" +
          subs.map((s) => '<option value="' + s.id + '">' + escapeHtml(s.name) + "</option>").join("");
        return '<optgroup label="' + escapeHtml(top.name) + '">' + opts + "</optgroup>";
      }).join("");
    // Two selects share one filter state: the desktop one lives in the table header (hidden on
    // mobile along with the table), the mobile one sits in the section head next to Sort.
    const sel = document.getElementById("txnFilterCategory");
    const current = sel.value;
    sel.innerHTML = optionsHtml;
    sel.value = current;
    filterCategoryId = sel.value;
    const selM = document.getElementById("txnFilterCategoryM");
    selM.innerHTML = optionsHtml;
    selM.value = filterCategoryId;
  }

  function parentSelectOptions(categories, selectedParentId, excludeId) {
    let opts = '<option value=""' + (!selectedParentId ? " selected" : "") + ">— Top-level —</option>";
    opts += categories.filter((c) => !c.parentId && c.id !== excludeId)
      .map((c) => '<option value="' + c.id + '"' + (c.id === selectedParentId ? " selected" : "") + ">" + escapeHtml(c.name) + "</option>").join("");
    return opts;
  }

  function renderCategoriesModal() {
    // Budget targets only make sense on a leaf category (transactions are filed there, never
    // directly on a top-level group) — the checkbox is simply absent on a top-level row.
    const rows = tracker().categories.map((c) => {
      const budgetCell = c.parentId
        ? '<input type="checkbox" data-type="category" data-id="' + c.id + '" data-field="hasBudget"' + (c.hasBudget !== false ? " checked" : "") + ">"
        : "";
      return "<tr>" +
        '<td class="left"><input class="cell-input name-input" data-type="category" data-id="' + c.id + '" data-field="name" value="' + escapeAttr(c.name) + '"' + (c.archived ? ' style="opacity:.5;"' : "") + "></td>" +
        '<td class="left"><select class="cell-input" style="width:auto;" data-type="category" data-id="' + c.id + '" data-field="parentId">' + parentSelectOptions(tracker().categories, c.parentId, c.id) + "</select></td>" +
        "<td>" + budgetCell + "</td>" +
        '<td><button class="btn" style="padding:4px 8px;font-size:11px;" data-action="toggle-archive-category" data-id="' + c.id + '">' + (c.archived ? "Unarchive" : "Archive") + "</button> " +
        '<button class="icon-btn" data-action="delete-category" data-id="' + c.id + '" title="Delete category">✕</button></td>' +
        "</tr>";
    }).join("");
    const addRow = '<tr class="add-row"><td class="left"><input class="cell-input name-input" placeholder="New category name" id="newCategoryName"></td>' +
      '<td class="left"><select class="cell-input" style="width:auto;" id="newCategoryParent">' + parentSelectOptions(tracker().categories, null, null) + "</select></td>" +
      '<td><span id="newCategoryBudgetWrap" style="visibility:hidden;"><input type="checkbox" id="newCategoryHasBudget" checked></span></td>' +
      '<td><button class="btn primary" style="padding:4px 8px;font-size:11px;" data-action="add-category">+ Add</button></td></tr>';
    document.getElementById("categoriesBody").innerHTML = rows + addRow;
  }

  function monthShifted(month, delta) {
    const parts = month.split("-").map(Number);
    const d = new Date(parts[0], parts[1] - 1 + delta, 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }

  function shiftMonth(delta) {
    selectedMonth = monthShifted(selectedMonth, delta);
    txnCardLimit = TXN_CARD_CHUNK; // new month, fresh card window
    renderAll();
  }

  // ---------- CSV / Excel import-export ----------
  // "Items" (plural) matches real-world daily-tracker sheets; "Item" is still accepted on
  // import for anything exported by an earlier version of this app.
  const HEADER_ORDER = ["Date", "Items", "Income", "Expense", "Account", "Category"];

  // Spreadsheet amounts are often formatted as currency ("₹254.87", "₹3,683.00"), which
  // parseFloat can't handle at all (it returns NaN at the very first non-numeric character) —
  // strip everything except digits/decimal point/minus sign before parsing.
  function parseAmount(v) {
    if (v === "" || v === null || v === undefined) return 0;
    const n = parseFloat(String(v).replace(/[^0-9.-]/g, ""));
    return isNaN(n) ? 0 : n;
  }

  function toRows(dt) {
    const rows = dt.transactions.map((t) => {
      const cat = findCategory(t.categoryId);
      const acct = findAccount(t.accountId);
      return {
        Date: t.date, Items: t.item,
        Income: t.direction === "in" ? t.amount : "",
        Expense: t.direction === "out" ? t.amount : "",
        Account: acct ? acct.name : "",
        Category: cat ? cat.name : ""
      };
    });
    dt.transfers.forEach((t) => {
      const from = findAccount(t.fromAccountId);
      const to = findAccount(t.toAccountId);
      rows.push({
        Date: t.date, Items: t.item, Income: "", Expense: t.amount,
        Account: from ? from.name : "", Category: "Transfer to " + (to ? to.name : "?")
      });
    });
    return rows;
  }

  function parseRows(rows) {
    const dt = {
      accounts: tracker().accounts.slice(),
      categories: tracker().categories.slice(),
      transactions: [],
      transfers: tracker().transfers.slice(),
      budgets: Object.assign({}, tracker().budgets)
    };
    const catByName = {};
    dt.categories.forEach((c) => { catByName[c.name.toLowerCase()] = c; });
    const acctByName = {};
    dt.accounts.forEach((a) => { acctByName[a.name.toLowerCase()] = a; });
    const incomeGroup = dt.categories.find((c) => !c.parentId && c.name.toLowerCase() === "income") || dt.categories.find((c) => !c.parentId);
    const expenseGroup = dt.categories.find((c) => !c.parentId && c.name.toLowerCase() === "expense") || dt.categories.find((c) => !c.parentId);

    rows.forEach((r) => {
      const dateStr = String(r.Date || "").trim();
      if (!dateStr) return;
      let iso = null;
      const dmy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // sheet uses DD/MM/YYYY
      if (dmy) {
        iso = dmy[3] + "-" + dmy[2].padStart(2, "0") + "-" + dmy[1].padStart(2, "0");
      } else {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) iso = d.toISOString().slice(0, 10);
      }
      if (!iso) return; // unparseable date — skip the row rather than throw

      const income = parseAmount(r.Income);
      const expense = parseAmount(r.Expense);
      const amount = income || expense;
      if (!amount) return;
      const direction = income ? "in" : "out";

      const item = String((r.Items !== undefined ? r.Items : r.Item) || "").trim();
      const catName = String(r.Category || "Uncategorized").trim().replace(/\s+/g, " ");
      let cat = catByName[catName.toLowerCase()];
      if (!cat) {
        const parent = direction === "in" ? incomeGroup : expenseGroup;
        cat = { id: uid("cat"), name: catName, parentId: parent ? parent.id : null, archived: false, hasBudget: !!parent && direction === "out" };
        dt.categories.push(cat);
        catByName[catName.toLowerCase()] = cat;
      }

      const acctName = String(r.Account || "CASH").trim();
      let acct = acctByName[acctName.toLowerCase()];
      if (!acct) {
        acct = { id: uid("acct"), name: acctName, openingBalance: 0, openingBalances: {} };
        dt.accounts.push(acct);
        acctByName[acctName.toLowerCase()] = acct;
      }

      dt.transactions.push({ id: uid("txn"), date: iso, item, amount, direction, categoryId: cat.id, accountId: acct.id });
    });
    return dt;
  }

  function buildWorksheet(dt) { return XLSX.utils.json_to_sheet(toRows(dt), { header: HEADER_ORDER }); }

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportCSV(dt, filename) { downloadBlob(XLSX.utils.sheet_to_csv(buildWorksheet(dt)), filename, "text/csv"); }
  function exportXLSX(dt, filename) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildWorksheet(dt), "Transactions");
    XLSX.writeFile(wb, filename);
  }

  function sampleTrackerTemplate() {
    const t = seedTracker();
    const groceries = t.categories.find((c) => c.name === "Groceries");
    const paycheck = t.categories.find((c) => c.name === "Paycheck");
    const salary = t.accounts.find((a) => a.name === "SALARY");
    t.transactions = [
      { id: uid("txn"), date: todayStr(), item: "Sample grocery run", amount: 850, direction: "out", categoryId: groceries.id, accountId: salary.id },
      { id: uid("txn"), date: todayStr(), item: "Sample salary credit", amount: 50000, direction: "in", categoryId: paycheck.id, accountId: salary.id }
    ];
    return t;
  }

  // ---------- Bank statement import ----------
  // Real bank statement exports (tested against an Axis Bank CSV) aren't the app's own tidy
  // template — they open with several lines of account-holder preamble, the real transaction
  // table starts wherever a "Date / Particulars / Debit / Credit" style header happens to land,
  // and end with pages of legal disclaimer text and a legend. There's also no Account column
  // (the whole file is one account) or Category column, so both are supplied by the caller
  // instead of read per row. Column names are matched loosely (Dr/Debit, Cr/Credit, Particulars/
  // Narration/Description) since Indian bank statements commonly vary this way, but this has only
  // been verified against the one Axis Bank sample — a bank using very different headers may need
  // this adjusted.
  function findStatementColumn(cells, patterns) {
    for (let i = 0; i < cells.length; i++) {
      const h = String(cells[i]).trim().toLowerCase();
      if (patterns.some((p) => p.test(h))) return i;
    }
    return -1;
  }

  function parseBankStatementGrid(grid, accountName) {
    let headerIdx = -1, dateCol = -1, particularsCol = -1, drCol = -1, crCol = -1;
    for (let i = 0; i < grid.length; i++) {
      const cells = grid[i] || [];
      const d = findStatementColumn(cells, [/date/]);
      const p = findStatementColumn(cells, [/particulars|narration|description/]);
      const dr = findStatementColumn(cells, [/^dr$/, /debit/]);
      const cr = findStatementColumn(cells, [/^cr$/, /credit/]);
      if (d !== -1 && p !== -1 && dr !== -1 && cr !== -1) {
        headerIdx = i; dateCol = d; particularsCol = p; drCol = dr; crCol = cr;
        break;
      }
    }
    if (headerIdx === -1) return [];

    // DD-MM-YYYY (dashes) — distinct from the app's own template, which uses DD/MM/YYYY. Any
    // line that doesn't start with a date in this column is skipped rather than erroring out,
    // which is what naturally filters out the preamble, blank lines, and the legal/legend text.
    const dateRe = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;
    const rows = [];
    for (let i = headerIdx + 1; i < grid.length; i++) {
      const cells = grid[i];
      if (!cells || cells.length <= Math.max(dateCol, particularsCol, drCol, crCol)) continue;
      const m = dateRe.exec(String(cells[dateCol]).trim());
      if (!m) continue;
      rows.push({
        Date: m[1].padStart(2, "0") + "/" + m[2].padStart(2, "0") + "/" + m[3],
        Items: String(cells[particularsCol]).replace(/\s+/g, " ").trim(),
        Income: String(cells[crCol] || ""),
        Expense: String(cells[drCol] || ""),
        Account: accountName,
        Category: ""
      });
    }
    return rows;
  }

  function handleStatementImportFile(file, accountName) {
    const reader = new FileReader();
    const isCsv = /\.csv$/i.test(file.name);
    reader.onload = (e) => {
      try {
        const workbook = isCsv ? XLSX.read(e.target.result, { type: "string", raw: true }) : XLSX.read(e.target.result, { type: "array", raw: true });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
        const rows = parseBankStatementGrid(grid, accountName);
        if (rows.length === 0) {
          toast("Couldn't find a transaction table in this file — expected columns like Date, Particulars, Debit, and Credit.");
          return;
        }
        const preExistingCategoryIds = new Set(tracker().categories.map((c) => c.id));
        // Every row defaults to "Uncategorized" (parseRows()'s own fallback, since Category is
        // always blank here) — the review screen is where the user actually assigns categories.
        const parsed = parseRows(rows);
        const newCategoryIds = new Set(parsed.categories.filter((c) => !preExistingCategoryIds.has(c.id)).map((c) => c.id));
        openImportPreview(parsed, newCategoryIds);
      } catch (err) {
        toast("Import failed: " + err.message);
      }
    };
    if (isCsv) reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  }

  function handleImportFile(file) {
    const reader = new FileReader();
    const isCsv = /\.csv$/i.test(file.name);
    reader.onload = (e) => {
      try {
        // raw: true stops SheetJS from auto-detecting DD/MM/YYYY-style dates as US MM/DD/YYYY
        // and silently misreading them (e.g. "01/07/2026" — 1 July — becoming 7 January).
        // parseRows() above still parses the resulting plain string itself via its own regex.
        const workbook = isCsv ? XLSX.read(e.target.result, { type: "string", raw: true }) : XLSX.read(e.target.result, { type: "array", raw: true });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        // Snapshot which category ids existed before this import, so the preview below can tell
        // apart "genuinely new" categories (candidates for pruning if left unused) from ones the
        // user already had (always kept, even if this particular import ends up not using them).
        const preExistingCategoryIds = new Set(tracker().categories.map((c) => c.id));
        const parsed = parseRows(rows);
        if (parsed.transactions.length === 0) {
          toast("No recognizable rows found. Check the template format.");
          return;
        }
        const newCategoryIds = new Set(parsed.categories.filter((c) => !preExistingCategoryIds.has(c.id)).map((c) => c.id));
        openImportPreview(parsed, newCategoryIds);
      } catch (err) {
        toast("Import failed: " + err.message);
      }
    };
    if (isCsv) reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  }

  // Lets the user check the parsed rows and re-categorize any of them before anything is
  // actually added — a raw bank statement rarely has a matching Category column, so most rows
  // land on an auto-created guess (or "Uncategorized") that's worth a quick look first.
  // Flags a parsed row as a likely duplicate if an EXISTING transaction (already saved, not
  // another row in this same import) matches on date, account, amount, and direction — direction
  // is included even though the user only asked for date/account/amount, since a same-day
  // same-amount refund and purchase on the same account are clearly not duplicates of each other.
  function isDuplicateTxn(t) {
    return tracker().transactions.some((x) =>
      x.date === t.date && x.accountId === t.accountId && x.amount === t.amount && x.direction === t.direction);
  }

  function openImportPreview(parsed, newCategoryIds) {
    pendingImport = { categories: parsed.categories, accounts: parsed.accounts, transactions: parsed.transactions, newCategoryIds };
    document.getElementById("importPreviewBody").innerHTML = parsed.transactions.map((t) => {
      const acct = parsed.accounts.find((a) => a.id === t.accountId);
      const dup = isDuplicateTxn(t);
      const dupBadge = dup ? ' <span class="dup-badge" title="An existing transaction already matches this date, account, and amount">Possible duplicate</span>' : "";
      return '<tr class="' + (dup ? "import-dup-row" : "") + '">' +
        '<td><input type="checkbox" class="import-include" checked></td>' +
        '<td class="left">' + t.date + "</td>" +
        '<td class="left"><input class="cell-input name-input import-item" style="width:100%;" value="' + escapeAttr(t.item) + '">' + dupBadge + "</td>" +
        '<td class="left"><select class="cell-input import-category" style="width:170px;">' + categorySelectOptions(t.categoryId, parsed.categories, newCategoryIds) + "</select></td>" +
        '<td class="left">' + escapeHtml(acct ? acct.name : "") + "</td>" +
        "<td>" + (t.direction === "in" ? "In" : "Out") + "</td>" +
        '<td class="' + (t.direction === "in" ? "neg" : "pos") + '">' + fmtINR(t.amount) + "</td>" +
        "</tr>";
    }).join("");
    updateImportPreviewSummary();
    document.getElementById("importPreviewBackdrop").classList.add("show");
  }

  function updateImportPreviewSummary() {
    const rows = Array.from(document.querySelectorAll("#importPreviewBody tr"));
    const included = rows.filter((r) => r.querySelector(".import-include").checked).length;
    const usedIds = new Set();
    rows.forEach((r) => {
      if (r.querySelector(".import-include").checked) usedIds.add(r.querySelector(".import-category").value);
    });
    const newUsedCount = Array.from(pendingImport.newCategoryIds).filter((id) => usedIds.has(id)).length;
    const dupCount = rows.filter((r) => r.classList.contains("import-dup-row")).length;
    document.getElementById("importPreviewSummary").textContent =
      included + " of " + rows.length + " transaction" + (rows.length === 1 ? "" : "s") + " selected" +
      (newUsedCount > 0 ? " — " + newUsedCount + " new categor" + (newUsedCount === 1 ? "y" : "ies") + " will be created" : "") +
      (dupCount > 0 ? " — " + dupCount + " possible duplicate" + (dupCount === 1 ? "" : "s") + " found, highlighted below" : "") + ".";
    const confirmBtn = document.getElementById("importPreviewConfirm");
    confirmBtn.textContent = "Import " + included + " Transaction" + (included === 1 ? "" : "s");
    confirmBtn.disabled = included === 0;
    const ignoreDupBtn = document.getElementById("importIgnoreDuplicates");
    const includedDupCount = rows.filter((r) => r.classList.contains("import-dup-row") && r.querySelector(".import-include").checked).length;
    ignoreDupBtn.disabled = includedDupCount === 0;
    ignoreDupBtn.textContent = includedDupCount > 0 ? "Ignore All Duplicates (" + includedDupCount + ")" : "Ignore All Duplicates";
  }

  // ---------- event wiring ----------
  document.addEventListener("DOMContentLoaded", () => {
    renderAll();

    // Toolbar dropdown menus (Import / Export / Manage): toggle on the button, close on any
    // other click — including a click on one of the menu's own items, so picking an action
    // closes the menu too, since that click bubbles to this same document-level listener after
    // the item's own handler (e.g. opening the file picker) has already run.
    document.querySelectorAll("[data-menu-toggle]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = document.getElementById(btn.dataset.menuToggle);
        const isOpen = menu.classList.contains("show");
        document.querySelectorAll(".menu-dropdown.show").forEach((m) => m.classList.remove("show"));
        if (!isOpen) menu.classList.add("show");
      });
    });
    document.addEventListener("click", () => {
      document.querySelectorAll(".menu-dropdown.show").forEach((m) => m.classList.remove("show"));
    });

    document.getElementById("monthJump").addEventListener("change", (e) => {
      if (!e.target.value) return; // cleared rather than a real month picked — ignore, keep the current month
      selectedMonth = e.target.value;
      txnCardLimit = TXN_CARD_CHUNK;
      renderAll();
    });
    // On mobile the month input is visually hidden and this icon opens its native picker wheel
    // instead; showPicker() needs a user gesture and isn't universal, so fall back to focus().
    document.getElementById("btnMonthCal").addEventListener("click", () => {
      const inp = document.getElementById("monthJump");
      try { if (inp.showPicker) inp.showPicker(); else inp.focus(); } catch (err) { inp.focus(); }
    });

    // On phones the month switcher relocates from the toolbar into #monthBarSlot, a sticky
    // strip at the top of the viewport — position:sticky can't stick beyond its parent's box,
    // so the element itself has to move out of the toolbar. Listeners survive the move (they
    // sit on elements inside .month-switch or on delegated document handlers).
    function placeMonthBar() {
      const bar = document.querySelector(".month-switch");
      if (MOBILE_MQ.matches) document.getElementById("monthBarSlot").appendChild(bar);
      else document.querySelector(".toolbar").appendChild(bar);
    }
    placeMonthBar();
    if (MOBILE_MQ.addEventListener) {
      MOBILE_MQ.addEventListener("change", () => {
        placeMonthBar();
        renderAll(); // charts re-draw so the donut legend flips between right (desktop) and bottom (mobile)
      });
    }

    // Collapsible review sections (mobile): tap a header with data-mcollapse to fold that
    // section. The class toggles everywhere, but the CSS that hides content lives inside the
    // ≤720px media query, so desktop never changes visually.
    const collapsedMap = loadCollapsedSections();
    Object.keys(collapsedMap).forEach((id) => {
      const el = document.getElementById(id);
      if (el && collapsedMap[id]) el.classList.add("mcollapsed");
    });
    document.querySelectorAll("[data-mcollapse]").forEach((head) => {
      head.addEventListener("click", (e) => {
        if (e.target.closest("input,select,button:not(.msec-toggle),a")) return;
        const sec = document.getElementById(head.dataset.mcollapse);
        if (!sec) return;
        sec.classList.toggle("mcollapsed");
        collapsedMap[head.dataset.mcollapse] = sec.classList.contains("mcollapsed") ? 1 : 0;
        saveCollapsedSections(collapsedMap);
      });
    });

    // Mobile budget group cards: tap a group row to expand/collapse its categories. Pure view
    // state — toggled directly on the DOM, and re-applied from the Set on every re-render.
    document.getElementById("budgetCards").addEventListener("click", (e) => {
      const head = e.target.closest(".bgroup-head");
      if (!head || e.target.closest("input,select,button")) return;
      const grp = head.closest(".bgroup");
      const id = grp.dataset.bgroup;
      if (expandedBudgetGroups.has(id)) expandedBudgetGroups.delete(id); else expandedBudgetGroups.add(id);
      grp.classList.toggle("open");
    });

    // The ⋯ overflow's Clear Month simply relays to the real button so the confirm flow,
    // counts, and deletion logic stay in one place.
    document.getElementById("btnClearMonthM").addEventListener("click", () => {
      document.getElementById("btnClearMonth").click();
    });

    document.getElementById("fabAddTxn").addEventListener("click", openAddTxnModal);
    document.getElementById("addTxnCancel").addEventListener("click", () => {
      document.getElementById("addTxnBackdrop").classList.remove("show");
    });
    // Enter anywhere in the add modal = "Add Another" — supports keyboard-only rapid entry
    // (item → tab → amount → Enter → repeat). Buttons are exempt so Enter still activates a
    // focused button normally. The global Enter-to-commit handler below only targets
    // .cell-input fields, so it never fires for these modal fields.
    document.getElementById("addTxnBackdrop").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName !== "BUTTON") {
        e.preventDefault();
        document.querySelector('#addTxnBackdrop [data-action="add-txn-another"]').click();
      }
    });

    // Tapping a mobile transaction card toggles its inline editor; taps on the editor's own
    // fields/buttons must not re-collapse it.
    document.getElementById("txnCards").addEventListener("click", (e) => {
      if (e.target.closest("input, select, button, label")) return;
      const card = e.target.closest("[data-txn-card]");
      if (!card) return;
      const id = card.dataset.txnCard;
      expandedTxnCardId = expandedTxnCardId === id ? null : id;
      document.querySelectorAll("#txnCards .txn-card").forEach((c) => {
        c.classList.toggle("expanded", c.dataset.txnCard === expandedTxnCardId);
      });
    });

    document.getElementById("txnFilterCategoryM").addEventListener("change", (e) => {
      filterCategoryId = e.target.value;
      document.getElementById("txnFilterCategory").value = filterCategoryId;
      txnCardLimit = TXN_CARD_CHUNK;
      renderTransactions(computeDerivedTracker());
    });

    document.getElementById("btnImport").addEventListener("click", () => document.getElementById("fileInput").click());
    document.getElementById("fileInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handleImportFile(file);
      e.target.value = "";
    });

    document.getElementById("btnImportStatement").addEventListener("click", () => {
      const sel = document.getElementById("statementAccountSelect");
      sel.innerHTML = acctOptions(tracker().accounts[0] && tracker().accounts[0].id) + '<option value="__new__">+ New Account…</option>';
      document.getElementById("statementNewAccountName").style.display = "none";
      document.getElementById("statementNewAccountName").value = "";
      document.getElementById("statementAccountBackdrop").classList.add("show");
    });
    document.getElementById("statementAccountSelect").addEventListener("change", (e) => {
      document.getElementById("statementNewAccountName").style.display = e.target.value === "__new__" ? "" : "none";
    });
    document.getElementById("statementAccountCancel").addEventListener("click", () => {
      document.getElementById("statementAccountBackdrop").classList.remove("show");
    });
    document.getElementById("statementAccountContinue").addEventListener("click", () => {
      const sel = document.getElementById("statementAccountSelect");
      let accountName;
      if (sel.value === "__new__") {
        accountName = document.getElementById("statementNewAccountName").value.trim();
        if (!accountName) { toast("Enter a name for the new account."); return; }
      } else {
        const acct = findAccount(sel.value);
        if (!acct) return;
        accountName = acct.name;
      }
      pendingStatementAccountName = accountName;
      document.getElementById("statementAccountBackdrop").classList.remove("show");
      document.getElementById("statementFileInput").click();
    });
    document.getElementById("statementFileInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file && pendingStatementAccountName) handleStatementImportFile(file, pendingStatementAccountName);
      e.target.value = "";
    });
    document.getElementById("importPreviewBody").addEventListener("change", (e) => {
      if (e.target.classList.contains("import-include") || e.target.classList.contains("import-category")) {
        updateImportPreviewSummary();
      }
    });
    document.getElementById("importIgnoreDuplicates").addEventListener("click", () => {
      document.querySelectorAll("#importPreviewBody tr.import-dup-row .import-include").forEach((cb) => { cb.checked = false; });
      updateImportPreviewSummary();
    });
    document.getElementById("importPreviewCancel").addEventListener("click", () => {
      document.getElementById("importPreviewBackdrop").classList.remove("show");
      pendingImport = null;
    });
    document.getElementById("importPreviewConfirm").addEventListener("click", () => {
      if (!pendingImport) return;
      const rows = Array.from(document.querySelectorAll("#importPreviewBody tr"));
      const finalTxns = [];
      rows.forEach((row, i) => {
        if (!row.querySelector(".import-include").checked) return;
        const t = pendingImport.transactions[i];
        t.categoryId = row.querySelector(".import-category").value;
        t.item = row.querySelector(".import-item").value.trim();
        finalTxns.push(t);
      });
      if (finalTxns.length === 0) { toast("No transactions selected."); return; }
      // Only newly-discovered categories are subject to pruning — a category the user already
      // had is always kept, even if this particular import ends up not using it.
      const usedCategoryIds = new Set(finalTxns.map((t) => t.categoryId));
      const finalCategories = pendingImport.categories.filter((c) => !pendingImport.newCategoryIds.has(c.id) || usedCategoryIds.has(c.id));
      tracker().categories = finalCategories;
      tracker().accounts = pendingImport.accounts;
      tracker().transactions = tracker().transactions.concat(finalTxns);
      persist();
      renderAll();
      toast(finalTxns.length + " transaction(s) imported.");
      document.getElementById("importPreviewBackdrop").classList.remove("show");
      pendingImport = null;
    });
    document.getElementById("btnTemplate").addEventListener("click", () => {
      exportCSV(sampleTrackerTemplate(), "FinTrack_Tracker_Template.csv");
      toast("Template downloaded — edit in Excel/Sheets and re-import.");
    });
    document.getElementById("btnExportCsv").addEventListener("click", () => {
      exportCSV(tracker(), "FinTrack_Tracker_" + todayStr() + ".csv");
      toast("CSV exported.");
    });
    document.getElementById("btnExportXlsx").addEventListener("click", () => {
      exportXLSX(tracker(), "FinTrack_Tracker_" + todayStr() + ".xlsx");
      toast("Excel file exported.");
    });

    document.getElementById("btnAddAccount").addEventListener("click", () => {
      document.getElementById("newAccountName").value = "";
      document.getElementById("newAccountOpening").value = "";
      document.getElementById("addAccountBackdrop").classList.add("show");
      document.getElementById("newAccountName").focus();
    });
    document.getElementById("addAccountCancel").addEventListener("click", () => {
      document.getElementById("addAccountBackdrop").classList.remove("show");
    });

    document.getElementById("btnManageCategories").addEventListener("click", () => {
      renderCategoriesModal();
      document.getElementById("categoriesBackdrop").classList.add("show");
    });
    document.getElementById("categoriesClose").addEventListener("click", () => {
      document.getElementById("categoriesBackdrop").classList.remove("show");
      renderAll(); // category name/parent/archive changes affect budget/chart/transaction rendering
    });

    document.getElementById("btnManageTransfers").addEventListener("click", () => {
      renderTransfers();
      document.getElementById("transfersBackdrop").classList.add("show");
    });
    document.getElementById("transfersClose").addEventListener("click", () => {
      document.getElementById("transfersBackdrop").classList.remove("show");
    });

    document.getElementById("btnOverview").addEventListener("click", () => {
      renderOverview();
      document.getElementById("overviewBackdrop").classList.add("show");
    });
    document.getElementById("overviewClose").addEventListener("click", () => {
      document.getElementById("overviewBackdrop").classList.remove("show");
    });
    document.getElementById("overviewModeGroup").addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn) return;
      overviewMode = btn.dataset.mode;
      renderOverview();
    });
    document.getElementById("overviewYear").addEventListener("change", (e) => {
      overviewYear = e.target.value;
      renderOverview();
    });
    document.getElementById("overviewMonth").addEventListener("change", (e) => {
      overviewMonth = e.target.value;
      renderOverview();
    });
    document.getElementById("overviewCategory").addEventListener("change", (e) => {
      overviewCategoryId = e.target.value;
      renderOverview();
    });

    // Delegated (not attached per-button) since the Total Expenses stat card — and its customize
    // icon along with it — is rebuilt from scratch by renderStats() on every renderAll(), unlike
    // the two chart cards' buttons which are static HTML and would work with a direct listener.
    document.body.addEventListener("click", (e) => {
      const btn = e.target.closest('[data-action="open-chart-customize"]');
      if (!btn) return;
      chartCustomizeTarget = btn.dataset.target;
      renderChartCustomizeModal();
      document.getElementById("chartCustomizeBackdrop").classList.add("show");
    });
    document.getElementById("chartCustomizeClose").addEventListener("click", () => {
      document.getElementById("chartCustomizeBackdrop").classList.remove("show");
    });
    document.getElementById("chartCustomizeSelectAll").addEventListener("click", () => {
      tracker().chartExclusions[chartCustomizeTarget] = [];
      persist();
      renderChartCustomizeModal();
      renderAll();
    });
    document.getElementById("chartCustomizeClearAll").addEventListener("click", () => {
      const target = chartCustomizeTarget;
      const ids = target === "topLevel"
        ? tracker().categories.filter((c) => !c.parentId).map((c) => c.id)
        : tracker().categories.filter((c) => isLeafCategory(c) && !c.archived).map((c) => c.id);
      tracker().chartExclusions[target] = ids;
      persist();
      renderChartCustomizeModal();
      renderAll();
    });
    document.getElementById("chartCustomizeList").addEventListener("change", (e) => {
      const t = e.target;
      if (!t.dataset || !t.dataset.chartCatId) return;
      const id = t.dataset.chartCatId;
      const arr = tracker().chartExclusions[chartCustomizeTarget];
      const idx = arr.indexOf(id);
      if (t.checked && idx !== -1) arr.splice(idx, 1);
      else if (!t.checked && idx === -1) arr.push(id);
      persist();
      renderAll();
    });

    document.getElementById("txnSearch").addEventListener("input", (e) => {
      searchQuery = e.target.value;
      txnCardLimit = TXN_CARD_CHUNK;
      renderTransactions(computeDerivedTracker());
    });
    document.getElementById("txnFilterCategory").addEventListener("change", (e) => {
      filterCategoryId = e.target.value;
      document.getElementById("txnFilterCategoryM").value = filterCategoryId;
      txnCardLimit = TXN_CARD_CHUNK;
      renderTransactions(computeDerivedTracker());
    });
    document.getElementById("txnSortOrder").addEventListener("change", (e) => {
      sortOrder = e.target.value;
      txnCardLimit = TXN_CARD_CHUNK;
      renderTransactions(computeDerivedTracker());
    });
    document.getElementById("btnClearMonth").addEventListener("click", async () => {
      const monthTxns = tracker().transactions.filter((t) => t.date && t.date.slice(0, 7) === selectedMonth);
      // Transfers are cleared alongside transactions — both move money and both show up in an
      // account's all-time balance, so leaving a transfer behind after "clearing the month" would
      // still show as a leftover amount in Accounts, which defeats the point of a clean slate.
      const monthTransfers = tracker().transfers.filter((t) => t.date && t.date.slice(0, 7) === selectedMonth);
      if (monthTxns.length === 0 && monthTransfers.length === 0) { toast("No transactions in " + fmtMonthLabel(selectedMonth) + " to clear."); return; }
      const parts = [];
      if (monthTxns.length > 0) parts.push(monthTxns.length + " transaction(s)");
      if (monthTransfers.length > 0) parts.push(monthTransfers.length + " transfer(s)");
      const ok = await confirmDialog(
        "Clear all transactions for " + fmtMonthLabel(selectedMonth) + "?",
        "This permanently deletes " + parts.join(" and ") + " from this month, so every account's balance updates accordingly. Other months, accounts, and budgets are not affected.",
        "Delete All", "Cancel", true
      );
      if (!ok) return;
      const txnIdsToRemove = new Set(monthTxns.map((t) => t.id));
      const transferIdsToRemove = new Set(monthTransfers.map((t) => t.id));
      tracker().transactions = tracker().transactions.filter((t) => !txnIdsToRemove.has(t.id));
      tracker().transfers = tracker().transfers.filter((t) => !transferIdsToRemove.has(t.id));
      persist();
      renderAll();
      toast(parts.join(" and ") + " cleared.");
    });

    // Enter commits an edit the same way clicking away does — blur() triggers the existing
    // "change" handler below rather than duplicating its logic.
    document.body.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.classList.contains("cell-input")) {
        e.preventDefault();
        e.target.blur();
      }
    });

    document.body.addEventListener("change", (e) => {
      const t = e.target;
      if (t.id === "newCategoryParent") {
        const wrap = document.getElementById("newCategoryBudgetWrap");
        if (wrap) wrap.style.visibility = t.value ? "visible" : "hidden";
        return;
      }
      if (!t.dataset || !t.dataset.field) return;
      const type = t.dataset.type;
      const id = t.dataset.id;
      const field = t.dataset.field;
      const numericFields = ["openingBalance", "openingBalanceMonth", "amount"];
      const checkboxFields = ["hasBudget"];
      const val = numericFields.includes(field) ? (parseFloat(t.value) || 0) : checkboxFields.includes(field) ? t.checked : t.value;

      if (type === "account") {
        const a = findAccount(id);
        if (!a) return;
        if (field === "openingBalanceMonth") {
          if (!a.openingBalances) a.openingBalances = {};
          a.openingBalances[selectedMonth] = val;
        } else {
          a[field] = val;
        }
        persist();
        renderAll();
      } else if (type === "txn") {
        const tx = tracker().transactions.find((x) => x.id === id);
        if (!tx) return;
        tx[field] = val;
        persist();
        renderAll();
      } else if (type === "transfer") {
        const tr = tracker().transfers.find((x) => x.id === id);
        if (!tr) return;
        tr[field] = val;
        persist();
        renderAll(); // transfers affect account balances, shown outside the modal
        renderTransfers(); // refresh the modal's own table without closing it
      } else if (type === "category") {
        const c = findCategory(id);
        if (!c) return;
        if (field === "parentId" && val === id) { toast("A category can't be its own parent."); renderCategoriesModal(); return; }
        c[field] = field === "parentId" ? (val || null) : val;
        if (field === "parentId" && !c.parentId) c.hasBudget = false; // no budget toggle for top-level groups
        persist();
        renderCategoriesModal();
      } else if (type === "budget") {
        tracker().budgets[id] = parseFloat(t.value) || 0;
        persist();
        renderAll();
      }
    });

    document.body.addEventListener("click", async (e) => {
      const actionEl = e.target.closest("[data-action]");
      if (!actionEl) return;
      const action = actionEl.dataset.action;

      if (action === "show-older-txns") {
        txnCardLimit += 100;
        renderTransactions(computeDerivedTracker());
        return;
      }
      if (action === "prev-month") { shiftMonth(-1); return; }
      if (action === "next-month") { shiftMonth(1); return; }

      if (action === "add-account") {
        const name = document.getElementById("newAccountName").value.trim();
        if (!name) { toast("Enter a name for the new account."); return; }
        const opening = parseFloat(document.getElementById("newAccountOpening").value) || 0;
        tracker().accounts.push({ id: uid("acct"), name, openingBalance: opening, openingBalances: {} });
        persist();
        renderAll();
        document.getElementById("addAccountBackdrop").classList.remove("show");
        toast("Account added.");
        return;
      }
      if (action === "copy-previous-balances") {
        if (tracker().accounts.length === 0) { toast("No accounts to copy."); return; }
        const prevMonth = monthShifted(selectedMonth, -1);
        const prevBalances = computeAccountBalances(prevMonth);
        const ok = await confirmDialog(
          "Copy last month's closing balances?",
          "Sets each account's opening balance for " + fmtMonthLabel(selectedMonth) + " to its closing balance from " + fmtMonthLabel(prevMonth) + ". This overwrites any opening balance you've already set for " + fmtMonthLabel(selectedMonth) + ".",
          "Copy", "Cancel", false
        );
        if (!ok) return;
        tracker().accounts.forEach((a) => {
          if (!a.openingBalances) a.openingBalances = {};
          a.openingBalances[selectedMonth] = prevBalances[a.id] || 0;
        });
        persist();
        renderAll();
        toast("Opening balances copied from " + fmtMonthLabel(prevMonth) + ".");
        return;
      }
      if (action === "delete-account") {
        const id = actionEl.dataset.id;
        const inUse = tracker().transactions.some((t) => t.accountId === id) ||
          tracker().transfers.some((t) => t.fromAccountId === id || t.toAccountId === id);
        if (inUse) { toast("Can't delete an account with transactions or transfers — move or delete those first."); return; }
        const ok = await confirmDialog("Delete account?", "This removes the account.");
        if (!ok) return;
        tracker().accounts = tracker().accounts.filter((a) => a.id !== id);
        persist();
        renderAll();
        return;
      }

      if (action === "add-txn" || action === "add-txn-another") {
        // "add-txn" (+ Add & Done) commits and closes; "add-txn-another" commits, then clears
        // just Item and Amount and keeps the modal open for rapid back-to-back entry — Date,
        // Category, Account, and In/Out deliberately stay filled, since consecutive entries
        // usually share them. A counter chip in the modal header tracks the running session.
        const keepOpen = action === "add-txn-another";
        const date = document.getElementById("newTxnDate").value || todayStr();
        const item = document.getElementById("newTxnItem").value.trim();
        const categoryId = document.getElementById("newTxnCategory").value;
        const accountId = document.getElementById("newTxnAccount").value;
        const direction = document.getElementById("newTxnDirection").value;
        const amount = parseFloat(document.getElementById("newTxnAmount").value) || 0;
        if (!item) { toast("Enter a description for the transaction."); return; }
        if (!amount) { toast("Enter an amount."); return; }
        if (isDuplicateTxn({ date, accountId, amount, direction })) {
          const acct = findAccount(accountId);
          const ok = await confirmDialog(
            "Possible duplicate transaction",
            "An existing transaction already matches this date, account (" + (acct ? acct.name : "") + "), and amount. Add it anyway?",
            "Add Anyway", "Cancel", false
          );
          if (!ok) return;
        }
        tracker().transactions.push({ id: uid("txn"), date, item, amount, direction, categoryId, accountId });
        persist();
        renderAll();
        if (keepOpen) {
          addTxnSessionCount++;
          const counter = document.getElementById("addTxnCount");
          counter.style.display = "";
          counter.textContent = addTxnSessionCount + " added";
          document.getElementById("newTxnItem").value = "";
          document.getElementById("newTxnAmount").value = "";
          document.getElementById("newTxnItem").focus();
        } else {
          document.getElementById("addTxnBackdrop").classList.remove("show");
          toast("Transaction added.");
        }
        return;
      }
      if (action === "delete-txn") {
        const ok = await confirmDialog("Delete transaction?", "This removes the transaction.", "Delete", "Cancel", true);
        if (!ok) return;
        tracker().transactions = tracker().transactions.filter((t) => t.id !== actionEl.dataset.id);
        persist();
        renderAll();
        return;
      }

      if (action === "add-transfer") {
        const date = document.getElementById("newTransferDate").value || todayStr();
        const item = document.getElementById("newTransferItem").value.trim();
        const fromAccountId = document.getElementById("newTransferFrom").value;
        const toAccountId = document.getElementById("newTransferTo").value;
        const amount = parseFloat(document.getElementById("newTransferAmount").value) || 0;
        if (!item) { toast("Enter a description for the transfer."); return; }
        if (!amount) { toast("Enter an amount."); return; }
        if (fromAccountId === toAccountId) { toast("Pick two different accounts."); return; }
        tracker().transfers.push({ id: uid("tr"), date, item, amount, fromAccountId, toAccountId });
        persist();
        renderAll();
        renderTransfers();
        toast("Transfer added.");
        return;
      }
      if (action === "delete-transfer") {
        const ok = await confirmDialog("Delete transfer?", "This removes the transfer.", "Delete", "Cancel", true);
        if (!ok) return;
        tracker().transfers = tracker().transfers.filter((t) => t.id !== actionEl.dataset.id);
        persist();
        renderAll();
        renderTransfers();
        return;
      }

      if (action === "add-category") {
        const name = document.getElementById("newCategoryName").value.trim();
        if (!name) { toast("Enter a name for the new category."); return; }
        const parentId = document.getElementById("newCategoryParent").value || null;
        const hasBudget = parentId ? document.getElementById("newCategoryHasBudget").checked : false;
        tracker().categories.push({ id: uid("cat"), name, parentId, archived: false, hasBudget });
        persist();
        renderCategoriesModal();
        return;
      }
      if (action === "toggle-archive-category") {
        const c = findCategory(actionEl.dataset.id);
        if (!c) return;
        c.archived = !c.archived;
        persist();
        renderCategoriesModal();
        return;
      }
      if (action === "delete-category") {
        const id = actionEl.dataset.id;
        const hasChildren = tracker().categories.some((c) => c.parentId === id);
        if (hasChildren) { toast("This category has sub-categories under it — move or delete those first."); return; }
        const inUse = tracker().transactions.some((t) => t.categoryId === id);
        if (inUse) { toast("Can't delete a category with transactions — archive it instead, or move/delete those transactions first."); return; }
        const ok = await confirmDialog("Delete category?", "This removes the category.", "Delete", "Cancel", true);
        if (!ok) return;
        tracker().categories = tracker().categories.filter((c) => c.id !== id);
        delete tracker().budgets[id];
        persist();
        renderCategoriesModal();
        return;
      }
    });
  });

  // ---------- bridge for optional drive-sync.js (loaded after this script, if present) ----------
  window.fintrack = {
    getState: () => state,
    setState: (s) => { state = s; },
    setExpanded: () => {}, // no collapsible groups on this page — kept as a no-op for bridge-shape parity
    persist,
    renderAll,
    toast,
    confirmDialog
  };
})();
