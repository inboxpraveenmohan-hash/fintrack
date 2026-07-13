/* FinTrack — Daily Tracker & Monthly Budgeting
   Second page of FinTrack. Shares the same localStorage blob and Google Drive sync mechanism
   as the Portfolio page (app.js), under a new top-level state.dailyTracker key — see the
   persist() contract note below, which must stay behaviorally identical to app.js's persist()
   so a shared _rev/updated stamp and Drive-sync notification work the same regardless of which
   page last saved. Independent ledger: never writes into state.assetClasses/otherAssets. */

(function () {
  "use strict";

  const STORAGE_KEY = "fintrack_portfolio_v1"; // same blob as app.js — see load()/persist() below
  const PALETTE = ["#4f46e5", "#0ea5a4", "#f59e0b", "#ef4444", "#8b5cf6", "#0f9d58", "#0284c7", "#d946ef", "#84cc16", "#f97316"];

  // Theme toggle logic lives in theme.js (shared with index.html). It calls window.onThemeChange
  // after every change, since Chart.js bakes colors in at creation time and needs an explicit
  // redraw — everything else updates for free via CSS custom properties.
  window.onThemeChange = () => { if (typeof renderChart === "function") renderChart(computeDerivedTracker()); };

  let idCounter = 0;
  function uid(prefix) {
    idCounter += 1;
    return prefix + "_" + idCounter + "_" + Math.random().toString(36).slice(2, 8);
  }

  // ---------- seed data ----------
  function defaultAccounts() {
    return [
      { id: uid("acct"), name: "SALARY", type: "asset", openingBalance: 0 },
      { id: uid("acct"), name: "SAVINGS", type: "asset", openingBalance: 0 },
      { id: uid("acct"), name: "CASH", type: "asset", openingBalance: 0 },
      { id: uid("acct"), name: "CC", type: "liability", openingBalance: 0 }
    ];
  }

  function defaultCategories() {
    const mk = (name, type) => ({ id: uid("cat"), name, type, archived: false });
    return [
      mk("Groceries", "expense"), mk("EMI", "expense"), mk("Dining out", "expense"),
      mk("Rent & Maintenance", "expense"), mk("Meds & Supp", "expense"), mk("Charges", "expense"),
      mk("Entertainment", "expense"), mk("Food delivery", "expense"), mk("Transport (Fuel)", "expense"),
      mk("Online shopping", "expense"), mk("Essential Spends", "expense"), mk("Adhoc", "expense"),
      mk("Money lent", "expense"), mk("Travel", "expense"),
      mk("CC Bills", "transfer"), mk("Just transfer", "transfer"),
      mk("Investments", "savings"), mk("Emergency Fund", "savings"), mk("Chit", "savings"),
      mk("Paycheck", "income"), mk("Returns", "income"), mk("Inv/savings returns", "income")
    ];
  }

  function seedTracker() {
    return { accounts: defaultAccounts(), categories: defaultCategories(), transactions: [], budgets: {} };
  }

  function isValidTracker(t) {
    return !!t && Array.isArray(t.accounts) && Array.isArray(t.categories) &&
      Array.isArray(t.transactions) && t.budgets && typeof t.budgets === "object";
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
      if (!isValidTracker(parsed.dailyTracker)) parsed.dailyTracker = seedTracker();
      return parsed;
    } catch (e) {
      return { dailyTracker: seedTracker() };
    }
  }

  let state = load();
  let selectedMonth = todayStr().slice(0, 7);
  let searchQuery = "";
  let filterCategoryId = "";
  let chartCategory = null;

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
  // Every account has a type: "asset" (money you hold) or "liability" (money you owe, e.g. CC).
  // Spending on an asset account reduces it; spending on a liability account increases what's
  // owed. Paying a CC bill isn't an expense — it's a transfer from an asset account to the
  // liability account, which must move both balances in the correct, opposite-of-naive
  // direction simultaneously (this is exactly what the original spreadsheet's #REF! formulas
  // failed to do).
  function balanceSign(account) { return account.type === "liability" ? -1 : 1; }

  function applyTxnToBalances(balances, txn) {
    const cat = findCategory(txn.categoryId);
    const acct = findAccount(txn.accountId);
    if (!cat || !acct) return;
    if (cat.type === "income" || cat.type === "savings") {
      balances[acct.id] = (balances[acct.id] || 0) + balanceSign(acct) * txn.amount;
    } else if (cat.type === "expense") {
      balances[acct.id] = (balances[acct.id] || 0) - balanceSign(acct) * txn.amount;
    } else if (cat.type === "transfer") {
      const toAcct = findAccount(txn.toAccountId);
      if (!toAcct) return;
      balances[acct.id] = (balances[acct.id] || 0) - balanceSign(acct) * txn.amount;
      balances[toAcct.id] = (balances[toAcct.id] || 0) + balanceSign(toAcct) * txn.amount;
    }
  }

  function computeAccountBalances() {
    const balances = {};
    tracker().accounts.forEach((a) => { balances[a.id] = numOr0(a.openingBalance); });
    tracker().transactions.forEach((txn) => applyTxnToBalances(balances, txn));
    return balances;
  }

  // ---------- derived (month-scoped) ----------
  function computeDerivedTracker() {
    const monthTxns = tracker().transactions.filter((t) => t.date && t.date.slice(0, 7) === selectedMonth);
    let totalIncome = 0;
    let totalExpense = 0;
    const spendByCategory = {};
    monthTxns.forEach((t) => {
      const cat = findCategory(t.categoryId);
      if (!cat) return;
      if (cat.type === "income" || cat.type === "savings") {
        totalIncome += t.amount;
      } else if (cat.type === "expense") {
        totalExpense += t.amount;
        spendByCategory[t.categoryId] = (spendByCategory[t.categoryId] || 0) + t.amount;
      }
      // "transfer" category transactions move money between the user's own accounts — they're
      // not real income or spend, so they're intentionally excluded from both totals.
    });
    const budgetRows = tracker().categories
      .filter((c) => c.type === "expense" && !c.archived)
      .map((c) => {
        const actual = spendByCategory[c.id] || 0;
        const budget = numOr0(tracker().budgets[c.id]);
        const pct = budget > 0 ? (actual / budget) * 100 : (actual > 0 ? 100 : 0);
        return { category: c, actual, budget, pct };
      });
    return {
      monthTxns, totalIncome, totalExpense, net: totalIncome - totalExpense,
      txnCount: monthTxns.length, spendByCategory, budgetRows, balances: computeAccountBalances()
    };
  }

  // ---------- rendering ----------
  function renderAll() {
    const d = computeDerivedTracker();
    renderMonthLabel();
    renderAccounts(d);
    renderStats(d);
    renderBudget(d);
    renderChart(d);
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
  }

  function card(label, value, hintHtml) {
    return '<div class="stat-card"><div class="label">' + label + '</div><div class="value">' + value + "</div>" + (hintHtml || "") + "</div>";
  }

  function renderAccounts(d) {
    let rows = tracker().accounts.map((a) => {
      const bal = d.balances[a.id] || 0;
      let balClass, balText;
      if (a.type === "liability") {
        balClass = bal > 0 ? "pos" : "neu";
        balText = bal > 0 ? "Owes " + fmtINR(bal) : (bal < 0 ? "Credit " + fmtINR(Math.abs(bal)) : fmtINR(0));
      } else {
        balClass = bal < 0 ? "pos" : "neu";
        balText = bal < 0 ? "-" + fmtINR(Math.abs(bal)) : fmtINR(bal);
      }
      return "<tr>" +
        '<td class="left"><input class="cell-input name-input" data-type="account" data-id="' + a.id + '" data-field="name" value="' + escapeAttr(a.name) + '"></td>' +
        '<td><select class="cell-input" style="width:auto;" data-type="account" data-id="' + a.id + '" data-field="type">' +
        '<option value="asset"' + (a.type === "asset" ? " selected" : "") + ">Asset</option>" +
        '<option value="liability"' + (a.type === "liability" ? " selected" : "") + ">Liability</option>" +
        "</select></td>" +
        '<td><input class="cell-input" type="number" step="0.01" data-type="account" data-id="' + a.id + '" data-field="openingBalance" value="' + numOr0(a.openingBalance) + '"></td>' +
        '<td class="' + balClass + '">' + balText + "</td>" +
        '<td><button class="icon-btn" data-action="delete-account" data-id="' + a.id + '" title="Delete account">✕</button></td>' +
        "</tr>";
    }).join("");
    if (!rows) rows = '<tr><td colspan="5" class="empty-msg">No accounts yet.</td></tr>';
    rows += '<tr class="add-row"><td class="left"><input class="cell-input name-input" placeholder="New account name" id="newAccountName"></td>' +
      '<td><select class="cell-input" style="width:auto;" id="newAccountType"><option value="asset">Asset</option><option value="liability">Liability</option></select></td>' +
      '<td><input class="cell-input" type="number" placeholder="Opening" id="newAccountOpening"></td><td></td>' +
      '<td><button class="btn" style="padding:5px 10px;font-size:11px;" data-action="add-account">+ Add</button></td></tr>';
    document.getElementById("accountsBody").innerHTML = rows;
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
    if (d.budgetRows.length === 0) {
      document.getElementById("budgetBody").innerHTML = '<tr><td colspan="4" class="empty-msg">No expense categories yet — add one via Manage Categories.</td></tr>';
      return;
    }
    document.getElementById("budgetBody").innerHTML = d.budgetRows.map((row, i) => {
      const barPct = Math.min(row.pct, 100);
      const over = row.pct > 100;
      return "<tr>" +
        '<td class="left"><div class="name-cell"><span class="swatch" style="background:' + PALETTE[i % PALETTE.length] + '"></span>' + escapeHtml(row.category.name) + "</div></td>" +
        '<td><input class="cell-input small" type="number" step="1" data-type="budget" data-id="' + row.category.id + '" value="' + numOr0(tracker().budgets[row.category.id]) + '"></td>' +
        '<td class="' + (over ? "pos" : "neu") + '">' + fmtINR(row.actual) + "</td>" +
        '<td style="min-width:110px;"><div class="budget-bar-track"><div class="budget-bar-fill' + (over ? " over" : "") + '" style="width:' + barPct + '%"></div></div></td>' +
        "</tr>";
    }).join("");
  }

  function renderChart(d) {
    const cs = getComputedStyle(document.documentElement);
    const cssVar = (name) => cs.getPropertyValue(name).trim();
    const mutedColor = cssVar("--muted");
    const cardBg = cssVar("--card");

    const labels = [];
    const data = [];
    const colors = [];
    tracker().categories.filter((c) => c.type === "expense" && !c.archived).forEach((c, i) => {
      const amt = d.spendByCategory[c.id] || 0;
      if (amt > 0) { labels.push(c.name); data.push(amt); colors.push(PALETTE[i % PALETTE.length]); }
    });

    const ctx = document.getElementById("chartCategory").getContext("2d");
    if (chartCategory) { chartCategory.destroy(); chartCategory = null; }
    if (labels.length === 0) return; // nothing to chart this month

    chartCategory = new Chart(ctx, {
      type: "doughnut",
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: cardBg }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "right", labels: { boxWidth: 10, font: { size: 10 }, color: mutedColor } } }
      }
    });
  }

  function catOptions(selectedId) {
    return tracker().categories.filter((c) => !c.archived || c.id === selectedId)
      .map((c) => '<option value="' + c.id + '"' + (c.id === selectedId ? " selected" : "") + ">" + escapeHtml(c.name) + "</option>").join("");
  }
  function acctOptions(selectedId) {
    return tracker().accounts.map((a) => '<option value="' + a.id + '"' + (a.id === selectedId ? " selected" : "") + ">" + escapeHtml(a.name) + "</option>").join("");
  }

  function renderTransactions(d) {
    let rows = d.monthTxns.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (filterCategoryId) rows = rows.filter((t) => t.categoryId === filterCategoryId);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter((t) => t.item.toLowerCase().includes(q));
    }
    const anyTransfer = tracker().categories.some((c) => c.type === "transfer" && !c.archived);
    document.getElementById("toAccountHeader").classList.toggle("show", anyTransfer);

    let html = rows.map((t) => {
      const cat = findCategory(t.categoryId);
      const isTransfer = cat && cat.type === "transfer";
      const amtClass = !cat ? "neu" : cat.type === "expense" ? "pos" : (cat.type === "income" || cat.type === "savings") ? "neg" : "neu";
      return "<tr>" +
        '<td class="left"><input class="cell-input name-input" type="date" style="width:130px;" data-type="txn" data-id="' + t.id + '" data-field="date" value="' + t.date + '"></td>' +
        '<td class="left"><input class="cell-input name-input" data-type="txn" data-id="' + t.id + '" data-field="item" value="' + escapeAttr(t.item) + '"></td>' +
        '<td class="left"><select class="cell-input" style="width:150px;" data-type="txn" data-id="' + t.id + '" data-field="categoryId">' + catOptions(t.categoryId) + "</select></td>" +
        '<td class="left"><select class="cell-input" style="width:110px;" data-type="txn" data-id="' + t.id + '" data-field="accountId">' + acctOptions(t.accountId) + "</select></td>" +
        '<td class="left to-account-cell' + (anyTransfer ? " show" : "") + '">' +
        (isTransfer ? '<select class="cell-input" style="width:110px;" data-type="txn" data-id="' + t.id + '" data-field="toAccountId">' + acctOptions(t.toAccountId) + "</select>" : "—") +
        "</td>" +
        '<td class="' + amtClass + '"><input class="cell-input small" type="number" step="0.01" data-type="txn" data-id="' + t.id + '" data-field="amount" value="' + numOr0(t.amount) + '"></td>' +
        '<td><button class="icon-btn" data-action="delete-txn" data-id="' + t.id + '" title="Delete transaction">✕</button></td>' +
        "</tr>";
    }).join("");

    if (!html) {
      html = '<tr><td colspan="7" class="empty-msg">No transactions ' + (searchQuery || filterCategoryId ? "match your search/filter" : "this month") + ".</td></tr>";
    }

    const firstCat = tracker().categories.find((c) => !c.archived);
    const firstAcct = tracker().accounts[0];
    const firstIsTransfer = firstCat && firstCat.type === "transfer";
    html += '<tr class="add-row">' +
      '<td class="left"><input class="cell-input name-input" type="date" style="width:130px;" id="newTxnDate" value="' + todayStr() + '"></td>' +
      '<td class="left"><input class="cell-input name-input" placeholder="Item" id="newTxnItem"></td>' +
      '<td class="left"><select class="cell-input" style="width:150px;" id="newTxnCategory">' + catOptions(firstCat && firstCat.id) + "</select></td>" +
      '<td class="left"><select class="cell-input" style="width:110px;" id="newTxnAccount">' + acctOptions(firstAcct && firstAcct.id) + "</select></td>" +
      '<td class="left to-account-cell' + (anyTransfer ? " show" : "") + '" id="newTxnToAccountCell">' +
      (firstIsTransfer ? '<select class="cell-input" style="width:110px;" id="newTxnToAccount">' + acctOptions() + "</select>" : "—") +
      "</td>" +
      '<td><input class="cell-input small" type="number" placeholder="Amount" id="newTxnAmount"></td>' +
      '<td><button class="btn" style="padding:5px 10px;font-size:11px;" data-action="add-txn">+ Add</button></td>' +
      "</tr>";

    document.getElementById("txnBody").innerHTML = html;
    wireAddTxnRow();
  }

  // The add-row is regenerated on every render, but its own category picker must update the
  // "to account" cell live, without a full re-render — otherwise the user's in-progress typed
  // item/amount would be wiped before they click Add.
  function wireAddTxnRow() {
    const catSel = document.getElementById("newTxnCategory");
    const toCell = document.getElementById("newTxnToAccountCell");
    if (!catSel || !toCell) return;
    catSel.addEventListener("change", () => {
      const cat = findCategory(catSel.value);
      toCell.innerHTML = (cat && cat.type === "transfer")
        ? '<select class="cell-input" style="width:110px;" id="newTxnToAccount">' + acctOptions() + "</select>"
        : "—";
    });
  }

  function renderTxnFilterOptions() {
    const sel = document.getElementById("txnFilterCategory");
    const current = sel.value;
    sel.innerHTML = '<option value="">All categories</option>' +
      tracker().categories.map((c) => '<option value="' + c.id + '">' + escapeHtml(c.name) + "</option>").join("");
    sel.value = current;
    filterCategoryId = sel.value;
  }

  function renderCategoriesModal() {
    const rows = tracker().categories.map((c) => {
      return "<tr>" +
        '<td class="left"><input class="cell-input name-input" data-type="category" data-id="' + c.id + '" data-field="name" value="' + escapeAttr(c.name) + '"' + (c.archived ? ' style="opacity:.5;"' : "") + "></td>" +
        '<td class="left"><select class="cell-input" style="width:auto;" data-type="category" data-id="' + c.id + '" data-field="type">' +
        ["expense", "income", "savings", "transfer"].map((t) => '<option value="' + t + '"' + (c.type === t ? " selected" : "") + '>' + t.charAt(0).toUpperCase() + t.slice(1) + "</option>").join("") +
        "</select></td>" +
        '<td><button class="btn" style="padding:4px 8px;font-size:11px;" data-action="toggle-archive-category" data-id="' + c.id + '">' + (c.archived ? "Unarchive" : "Archive") + "</button></td>" +
        "</tr>";
    }).join("");
    const addRow = '<tr class="add-row"><td class="left"><input class="cell-input name-input" placeholder="New category name" id="newCategoryName"></td>' +
      '<td class="left"><select class="cell-input" style="width:auto;" id="newCategoryType"><option value="expense">Expense</option><option value="income">Income</option><option value="savings">Savings</option><option value="transfer">Transfer</option></select></td>' +
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
  const HEADER_ORDER = ["Date", "Item", "Income", "Expense", "Account", "Category"];

  function toRows(dt) {
    return dt.transactions.map((t) => {
      const cat = findCategory(t.categoryId);
      const acct = findAccount(t.accountId);
      const isIncome = !!cat && (cat.type === "income" || cat.type === "savings");
      return {
        Date: t.date,
        Item: t.item,
        Income: isIncome ? t.amount : "",
        Expense: !isIncome ? t.amount : "",
        Account: acct ? acct.name : "",
        Category: cat ? cat.name : ""
      };
    });
  }

  function parseRows(rows) {
    const dt = {
      accounts: tracker().accounts.slice(),
      categories: tracker().categories.slice(),
      transactions: [],
      budgets: Object.assign({}, tracker().budgets)
    };
    const catByName = {};
    dt.categories.forEach((c) => { catByName[c.name.toLowerCase()] = c; });
    const acctByName = {};
    dt.accounts.forEach((a) => { acctByName[a.name.toLowerCase()] = a; });

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

      const income = parseFloat(r.Income) || 0;
      const expense = parseFloat(r.Expense) || 0;
      const amount = income || expense;
      if (!amount) return;

      const item = String(r.Item || "").trim();
      const catName = String(r.Category || "Uncategorized").trim();
      let cat = catByName[catName.toLowerCase()];
      if (!cat) {
        cat = { id: uid("cat"), name: catName, type: income ? "income" : "expense", archived: false };
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

      dt.transactions.push({ id: uid("txn"), date: iso, item, amount, categoryId: cat.id, accountId: acct.id, toAccountId: null });
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
      { id: uid("txn"), date: todayStr(), item: "Sample grocery run", amount: 850, categoryId: groceries.id, accountId: salary.id, toAccountId: null },
      { id: uid("txn"), date: todayStr(), item: "Sample salary credit", amount: 50000, categoryId: paycheck.id, accountId: salary.id, toAccountId: null }
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
        // parseRows() below still parses the resulting plain string itself via its own regex.
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
      renderAll(); // category name/type/archive changes affect budget/transaction rendering
    });

    document.getElementById("txnSearch").addEventListener("input", (e) => {
      searchQuery = e.target.value;
      renderTransactions(computeDerivedTracker());
    });
    document.getElementById("txnFilterCategory").addEventListener("change", (e) => {
      filterCategoryId = e.target.value;
      renderTransactions(computeDerivedTracker());
    });

    document.body.addEventListener("change", (e) => {
      const t = e.target;
      if (!t.dataset || !t.dataset.field) return;
      const type = t.dataset.type;
      const id = t.dataset.id;
      const field = t.dataset.field;
      const numericFields = ["openingBalance", "amount"];
      const val = numericFields.includes(field) ? (parseFloat(t.value) || 0) : t.value;

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
        if (field === "categoryId") {
          const cat = findCategory(val);
          if (!cat || cat.type !== "transfer") tx.toAccountId = null;
        }
        persist();
        renderAll();
      } else if (type === "category") {
        const c = findCategory(id);
        if (!c) return;
        c[field] = val;
        if (field === "type" && val !== "transfer") {
          tracker().transactions.forEach((tx) => { if (tx.categoryId === id) tx.toAccountId = null; });
        }
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
        const type = document.getElementById("newAccountType").value;
        const opening = parseFloat(document.getElementById("newAccountOpening").value) || 0;
        tracker().accounts.push({ id: uid("acct"), name, type, openingBalance: opening });
        persist();
        renderAll();
        return;
      }
      if (action === "delete-account") {
        const inUse = tracker().transactions.some((t) => t.accountId === actionEl.dataset.id || t.toAccountId === actionEl.dataset.id);
        if (inUse) { toast("Can't delete an account with transactions — move or delete those first."); return; }
        const ok = await confirmDialog("Delete account?", "This removes the account.");
        if (!ok) return;
        tracker().accounts = tracker().accounts.filter((a) => a.id !== actionEl.dataset.id);
        persist();
        renderAll();
        return;
      }

      if (action === "add-txn") {
        const date = document.getElementById("newTxnDate").value || todayStr();
        const item = document.getElementById("newTxnItem").value.trim();
        const categoryId = document.getElementById("newTxnCategory").value;
        const accountId = document.getElementById("newTxnAccount").value;
        const amount = parseFloat(document.getElementById("newTxnAmount").value) || 0;
        const toAccountEl = document.getElementById("newTxnToAccount");
        const cat = findCategory(categoryId);
        if (!item) { toast("Enter a description for the transaction."); return; }
        if (!amount) { toast("Enter an amount."); return; }
        if (cat && cat.type === "transfer" && (!toAccountEl || !toAccountEl.value)) { toast("Pick a destination account for this transfer."); return; }
        tracker().transactions.push({
          id: uid("txn"), date, item, amount, categoryId, accountId,
          toAccountId: (cat && cat.type === "transfer" && toAccountEl) ? toAccountEl.value : null
        });
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

      if (action === "add-category") {
        const name = document.getElementById("newCategoryName").value.trim();
        if (!name) { toast("Enter a name for the new category."); return; }
        const type = document.getElementById("newCategoryType").value;
        tracker().categories.push({ id: uid("cat"), name, type, archived: false });
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
