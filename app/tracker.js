/* FinTrack — Daily Tracker & Monthly Budgeting
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
  function defaultAccounts() {
    return [
      { id: uid("acct"), name: "SALARY", openingBalance: 0 },
      { id: uid("acct"), name: "SAVINGS", openingBalance: 0 },
      { id: uid("acct"), name: "CASH", openingBalance: 0 },
      { id: uid("acct"), name: "CC", openingBalance: 0 }
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

  function seedTracker() {
    return { accounts: defaultAccounts(), categories: defaultCategories(), transactions: [], transfers: [], budgets: {} };
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

  // ---------- account balances (all-time, not scoped to the selected month) ----------
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

  function computeAccountBalances() {
    const balances = {};
    tracker().accounts.forEach((a) => { balances[a.id] = numOr0(a.openingBalance); });
    tracker().transactions.forEach((txn) => applyTxnToBalances(balances, txn));
    tracker().transfers.forEach((tr) => applyTransferToBalances(balances, tr));
    return balances;
  }

  // ---------- derived (month-scoped) ----------
  function computeDerivedTracker() {
    const monthTxns = tracker().transactions.filter((t) => t.date && t.date.slice(0, 7) === selectedMonth);
    const monthTransfers = tracker().transfers.filter((t) => t.date && t.date.slice(0, 7) === selectedMonth);
    let totalIncome = 0;
    let totalExpense = 0;
    const spendByTopLevel = {};
    const spendBySub = {};
    const incomeBySub = {};
    monthTxns.forEach((t) => {
      const cat = findCategory(t.categoryId);
      if (!cat) return;
      if (t.direction === "in") {
        totalIncome += t.amount;
        incomeBySub[cat.id] = (incomeBySub[cat.id] || 0) + t.amount; // always a plain, non-negative sum
      } else {
        totalExpense += t.amount;
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
      monthTxns, monthTransfers, totalIncome, totalExpense, net: totalIncome - totalExpense,
      txnCount: monthTxns.length, spendByTopLevel, spendBySub, incomeBySub, budgetGroups, balances: computeAccountBalances()
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
  }

  function card(label, value, hintHtml) {
    return '<div class="stat-card"><div class="label">' + label + '</div><div class="value">' + value + "</div>" + (hintHtml || "") + "</div>";
  }

  function renderAccounts(d) {
    let rows = tracker().accounts.map((a) => {
      const bal = d.balances[a.id] || 0;
      const balClass = bal < 0 ? "pos" : "neu";
      const balText = bal < 0 ? "-" + fmtINR(Math.abs(bal)) : fmtINR(bal);
      return "<tr>" +
        '<td class="left"><input class="cell-input name-input" data-type="account" data-id="' + a.id + '" data-field="name" value="' + escapeAttr(a.name) + '"></td>' +
        '<td><input class="cell-input amount" type="number" step="0.01" data-type="account" data-id="' + a.id + '" data-field="openingBalance" value="' + numOr0(a.openingBalance) + '"></td>' +
        '<td class="' + balClass + '">' + balText + "</td>" +
        '<td><button class="icon-btn" data-action="delete-account" data-id="' + a.id + '" title="Delete account">✕</button></td>' +
        "</tr>";
    }).join("");
    if (!rows) rows = '<tr><td colspan="4" class="empty-msg">No accounts yet.</td></tr>';
    rows += '<tr class="add-row"><td class="left"><input class="cell-input name-input" placeholder="New account name" id="newAccountName"></td>' +
      '<td><input class="cell-input" type="number" placeholder="Opening" id="newAccountOpening"></td><td></td>' +
      '<td><button class="btn" style="padding:5px 10px;font-size:11px;" data-action="add-account">+ Add</button></td></tr>';
    document.getElementById("accountsBody").innerHTML = rows;
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

  function renderStats(d) {
    document.getElementById("statCards").innerHTML = [
      card("Total Income", fmtINR(d.totalIncome), '<span class="hint">' + fmtMonthLabel(selectedMonth) + "</span>"),
      card("Total Expenses", fmtINR(d.totalExpense), '<span class="hint">' + fmtMonthLabel(selectedMonth) + "</span>"),
      card("Net", fmtINR(d.net), '<span class="hint ' + (d.net >= 0 ? "ok" : "warn") + '">' + (d.net >= 0 ? "Positive" : "Negative") + "</span>"),
      card("Transactions", String(d.txnCount), '<span class="hint">this month</span>')
    ].join("");
  }

  function renderBudget(d) {
    const totalRows = d.budgetGroups.reduce((n, g) => n + g.rows.length, 0);
    if (totalRows === 0) {
      document.getElementById("budgetBody").innerHTML = '<tr><td colspan="4" class="empty-msg">No categories yet — add one via Manage Categories.</td></tr>';
      return;
    }
    // Top-level accent bar color matches that group's own color in the "By Top-Level Category"
    // chart (same PALETTE, same index order) — see renderCharts() below.
    const topLevelIds = tracker().categories.filter((c) => !c.parentId).map((c) => c.id);
    let i = 0;
    document.getElementById("budgetBody").innerHTML = d.budgetGroups.map((g) => {
      const topIdx = topLevelIds.indexOf(g.topLevel.id);
      const topColor = PALETTE[(topIdx < 0 ? 0 : topIdx) % PALETTE.length];
      const header = '<tr class="budget-group-head"><td colspan="4"><span class="accent-bar" style="background:' + topColor + '"></span>' + escapeHtml(g.topLevel.name) + "</td></tr>";
      const rows = g.rows.map((row) => {
        const idx = i++;
        const barPct = Math.min(row.pct, 100);
        const over = row.hasBudget && row.budget > 0 && row.pct > 100 && !row.netNegative;
        const budgetCell = row.hasBudget
          ? '<input class="cell-input amount" type="number" step="1" data-type="budget" data-field="budget" data-id="' + row.category.id + '" value="' + numOr0(tracker().budgets[row.category.id]) + '">'
          : "";
        const barClass = row.netNegative ? " negative" : (over ? " over" : "");
        const barCell = row.hasBudget
          ? '<div class="budget-bar-track"><div class="budget-bar-fill' + barClass + '" style="width:' + barPct + '%"></div></div>'
          : "";
        return "<tr>" +
          '<td class="left"><div class="name-cell"><span class="swatch" style="background:' + PALETTE[idx % PALETTE.length] + '"></span>' + escapeHtml(row.category.name) + "</div></td>" +
          "<td>" + budgetCell + "</td>" +
          '<td class="' + (over ? "pos" : "neu") + '">' + fmtINR(row.actual) + "</td>" +
          '<td style="min-width:110px;">' + barCell + "</td>" +
          "</tr>";
      }).join("");
      return header + rows;
    }).join("");
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
          plugins: { legend: { position: "right", labels: { boxWidth: 10, font: { size: 10 }, color: mutedColor } } }
        }
      });
    }

    const topLabels = [], topData = [], topColors = [];
    tracker().categories.filter((c) => !c.parentId).forEach((c, i) => {
      const amt = d.spendByTopLevel[c.id] || 0;
      if (amt > 0) { topLabels.push(c.name); topData.push(amt); topColors.push(PALETTE[i % PALETTE.length]); }
    });
    chartTopLevel = draw(chartTopLevel, "chartTopLevel", topLabels, topData, topColors);

    const subLabels = [], subData = [], subColors = [];
    tracker().categories.filter((c) => isLeafCategory(c) && !c.archived).forEach((c, i) => {
      const amt = d.spendBySub[c.id] || 0;
      if (amt > 0) { subLabels.push(c.name); subData.push(amt); subColors.push(PALETTE[i % PALETTE.length]); }
    });
    chartCategory = draw(chartCategory, "chartCategory", subLabels, subData, subColors);
  }

  // ---------- Category Overview modal (week/month/year, all-time — not scoped to selectedMonth) ----------
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function availableYears() {
    const years = Array.from(new Set(tracker().transactions.map((t) => (t.date || "").slice(0, 4)).filter(Boolean))).sort();
    return years.length ? years : [String(new Date().getFullYear())];
  }

  // Same net-out-minus-in convention as Budget vs Actual, but per top-level category and bucketed
  // by week/month/year instead of per-leaf-category for a single month — "actual" is always a
  // non-negative magnitude (a category dominated by "In", like Income, still just shows its size).
  function computeOverviewData(mode, year, month) {
    const topLevels = tracker().categories.filter((c) => !c.parentId);
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

    const sums = topLevels.map((tl) => ({ topLevel: tl, out: new Array(buckets.length).fill(0), in: new Array(buckets.length).fill(0) }));
    const sumByTop = {};
    sums.forEach((s) => { sumByTop[s.topLevel.id] = s; });

    txns.forEach((t) => {
      if (!inScope(t)) return;
      const cat = findCategory(t.categoryId);
      if (!cat) return;
      const s = sumByTop[topLevelOf(cat).id];
      if (!s) return;
      const idx = bucketIndex[bucketKeyOf(t)];
      if (idx === undefined) return;
      if (t.direction === "in") s.in[idx] += t.amount; else s.out[idx] += t.amount;
    });

    const series = sums.map((s) => ({
      topLevel: s.topLevel,
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
  }

  function renderOverview() {
    populateOverviewPickers();
    const data = computeOverviewData(overviewMode, overviewYear, overviewMonth);
    const topLevelIds = tracker().categories.filter((c) => !c.parentId).map((c) => c.id);

    const cs = getComputedStyle(document.documentElement);
    const mutedColor = cs.getPropertyValue("--muted").trim();
    const gridColor = cs.getPropertyValue("--row-line").trim();

    // Each top-level category keeps one consistent color everywhere it appears — chart bars,
    // legend swatch, and the table cells below — rather than swapping per-bar, which made the
    // legend (one fixed swatch per dataset) mismatch bars that had switched to a different color.
    const colorByTopId = {};
    data.series.forEach((s) => {
      const idx = topLevelIds.indexOf(s.topLevel.id);
      colorByTopId[s.topLevel.id] = PALETTE[(idx < 0 ? 0 : idx) % PALETTE.length];
    });

    if (overviewChart) { overviewChart.destroy(); overviewChart = null; }
    if (data.buckets.length && data.series.length) {
      const datasets = data.series.map((s) => ({
        label: s.topLevel.name,
        data: s.points.map((p) => p.actual),
        backgroundColor: colorByTopId[s.topLevel.id]
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

    const head = '<th class="left">Period</th>' + data.series.map((s) => "<th>" + escapeHtml(s.topLevel.name) + "</th>").join("");
    document.getElementById("overviewTableHead").innerHTML = head;
    const bodyRows = data.buckets.map((b, i) => {
      const cells = data.series.map((s) => {
        const p = s.points[i];
        const style = p.actual > 0 ? ' style="color:' + colorByTopId[s.topLevel.id] + '"' : "";
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
  function categorySelectOptions(selectedId) {
    return tracker().categories.filter((c) => !c.parentId).map((top) => {
      const subs = tracker().categories.filter((c) => c.parentId === top.id && (!c.archived || c.id === selectedId));
      let opts = "";
      if (isLeafCategory(top)) {
        opts += '<option value="' + top.id + '"' + (top.id === selectedId ? " selected" : "") + ">" + escapeHtml(top.name) + " (general)</option>";
      }
      opts += subs.map((s) => '<option value="' + s.id + '"' + (s.id === selectedId ? " selected" : "") + ">" + escapeHtml(s.name) + "</option>").join("");
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

    const firstCat = tracker().categories.find((c) => isLeafCategory(c) && !c.archived) || tracker().categories.find((c) => !c.parentId);
    const firstAcct = tracker().accounts[0];
    let html = '<tr class="add-row">' +
      '<td class="left"><input class="cell-input name-input" type="date" style="width:130px;" id="newTxnDate" value="' + todayStr() + '"></td>' +
      '<td class="left"><input class="cell-input name-input" placeholder="Item" id="newTxnItem"></td>' +
      '<td class="left"><select class="cell-input" style="width:170px;" id="newTxnCategory">' + categorySelectOptions(firstCat && firstCat.id) + "</select></td>" +
      '<td class="left"><select class="cell-input" style="width:110px;" id="newTxnAccount">' + acctOptions(firstAcct && firstAcct.id) + "</select></td>" +
      '<td><select class="cell-input" style="width:auto;" id="newTxnDirection"><option value="out" selected>Out</option><option value="in">In</option></select></td>' +
      '<td><input class="cell-input amount" type="number" placeholder="Amount" id="newTxnAmount"></td>' +
      '<td><button class="btn primary" style="padding:5px 10px;font-size:11px;" data-action="add-txn">+ Add</button></td>' +
      "</tr>";

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

    html += rowsHtml || ('<tr><td colspan="7" class="empty-msg">No transactions ' + (searchQuery || filterCategoryId ? "match your search/filter" : "this month") + ".</td></tr>");

    document.getElementById("txnBody").innerHTML = html;
  }

  // Each top-level group is itself a selectable "All <Group>" option (matches every
  // transaction under any of its sub-categories, via categoryMatchesFilter), grouped with its
  // sub-categories underneath via <optgroup> for the same at-a-glance hierarchy as the
  // add-transaction category picker.
  function renderTxnFilterOptions() {
    const sel = document.getElementById("txnFilterCategory");
    const current = sel.value;
    sel.innerHTML = '<option value="">All</option>' +
      tracker().categories.filter((c) => !c.parentId).map((top) => {
        const subs = tracker().categories.filter((c) => c.parentId === top.id);
        const opts = '<option value="' + top.id + '">All ' + escapeHtml(top.name) + "</option>" +
          subs.map((s) => '<option value="' + s.id + '">' + escapeHtml(s.name) + "</option>").join("");
        return '<optgroup label="' + escapeHtml(top.name) + '">' + opts + "</optgroup>";
      }).join("");
    sel.value = current;
    filterCategoryId = sel.value;
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

  function shiftMonth(delta) {
    const parts = selectedMonth.split("-").map(Number);
    const d = new Date(parts[0], parts[1] - 1 + delta, 1);
    selectedMonth = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
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
        acct = { id: uid("acct"), name: acctName, type: "asset", openingBalance: 0 };
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

  function handleImportFile(file) {
    const reader = new FileReader();
    const isCsv = /\.csv$/i.test(file.name);
    reader.onload = async (e) => {
      try {
        // raw: true stops SheetJS from auto-detecting DD/MM/YYYY-style dates as US MM/DD/YYYY
        // and silently misreading them (e.g. "01/07/2026" — 1 July — becoming 7 January).
        // parseRows() above still parses the resulting plain string itself via its own regex.
        const workbook = isCsv ? XLSX.read(e.target.result, { type: "string", raw: true }) : XLSX.read(e.target.result, { type: "array", raw: true });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        const parsed = parseRows(rows);
        if (parsed.transactions.length === 0) {
          toast("No recognizable rows found. Check the template format.");
          return;
        }
        // Unlike the Portfolio page's import (a point-in-time snapshot, replaced wholesale), the
        // tracker is an ongoing log — importing a month's data should add to history, not erase it.
        const ok = await confirmDialog(
          "Import transactions?",
          "This adds " + parsed.transactions.length + " transaction(s) from \"" + file.name + "\" to your existing log (any new categories/accounts are created automatically). Existing transactions are not removed.",
          "Import", "Cancel", false
        );
        if (!ok) return;
        tracker().categories = parsed.categories;
        tracker().accounts = parsed.accounts;
        tracker().transactions = tracker().transactions.concat(parsed.transactions);
        persist();
        renderAll();
        toast(parsed.transactions.length + " transaction(s) imported.");
      } catch (err) {
        toast("Import failed: " + err.message);
      }
    };
    if (isCsv) reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  }

  // ---------- event wiring ----------
  document.addEventListener("DOMContentLoaded", () => {
    renderAll();

    document.getElementById("btnImport").addEventListener("click", () => document.getElementById("fileInput").click());
    document.getElementById("fileInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handleImportFile(file);
      e.target.value = "";
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

    document.getElementById("txnSearch").addEventListener("input", (e) => {
      searchQuery = e.target.value;
      renderTransactions(computeDerivedTracker());
    });
    document.getElementById("txnFilterCategory").addEventListener("change", (e) => {
      filterCategoryId = e.target.value;
      renderTransactions(computeDerivedTracker());
    });
    document.getElementById("txnSortOrder").addEventListener("change", (e) => {
      sortOrder = e.target.value;
      renderTransactions(computeDerivedTracker());
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
      const numericFields = ["openingBalance", "amount"];
      const checkboxFields = ["hasBudget"];
      const val = numericFields.includes(field) ? (parseFloat(t.value) || 0) : checkboxFields.includes(field) ? t.checked : t.value;

      if (type === "account") {
        const a = findAccount(id);
        if (!a) return;
        a[field] = val;
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

      if (action === "prev-month") { shiftMonth(-1); return; }
      if (action === "next-month") { shiftMonth(1); return; }

      if (action === "add-account") {
        const name = document.getElementById("newAccountName").value.trim();
        if (!name) { toast("Enter a name for the new account."); return; }
        const opening = parseFloat(document.getElementById("newAccountOpening").value) || 0;
        tracker().accounts.push({ id: uid("acct"), name, openingBalance: opening });
        persist();
        renderAll();
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

      if (action === "add-txn") {
        const date = document.getElementById("newTxnDate").value || todayStr();
        const item = document.getElementById("newTxnItem").value.trim();
        const categoryId = document.getElementById("newTxnCategory").value;
        const accountId = document.getElementById("newTxnAccount").value;
        const direction = document.getElementById("newTxnDirection").value;
        const amount = parseFloat(document.getElementById("newTxnAmount").value) || 0;
        if (!item) { toast("Enter a description for the transaction."); return; }
        if (!amount) { toast("Enter an amount."); return; }
        tracker().transactions.push({ id: uid("txn"), date, item, amount, direction, categoryId, accountId });
        persist();
        renderAll();
        toast("Transaction added.");
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
