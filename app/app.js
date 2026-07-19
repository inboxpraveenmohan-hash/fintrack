/* FinTrack — Portfolio Manager
   Single-page, offline, browser-local portfolio dashboard.
   Data model persisted to localStorage. Import/export via SheetJS (CSV/XLSX). */

(function () {
  "use strict";

  const STORAGE_KEY = "fintrack_portfolio_v1";
  const DEVIATION_THRESHOLD = 2; // percentage points before flagging "off target"
  const PALETTE = ["#4f46e5", "#0ea5a4", "#f59e0b", "#ef4444", "#8b5cf6", "#0f9d58", "#0284c7", "#d946ef", "#84cc16", "#f97316"];

  // Theme toggle logic lives in theme.js (shared with tracker.html). It calls
  // window.onThemeChange after every change, since Chart.js bakes colors in at creation time
  // and needs an explicit redraw — everything else updates for free via CSS custom properties.
  window.onThemeChange = () => { if (typeof renderCharts === "function") renderCharts(computeDerived(state)); };

  let idCounter = 0;
  function uid(prefix) {
    idCounter += 1;
    return prefix + "_" + idCounter + "_" + Math.random().toString(36).slice(2, 8);
  }

  // Illustrative sample data only — not any real person's portfolio. Structured to
  // demonstrate every feature (multi-holding classes, a zero-value holding, an Other
  // Assets subsection, SIP splits) with clearly generic names and round numbers.
  function seedData() {
    return {
      updated: "2026-01-01",
      monthlyInvestment: 10000,
      sipMode: "target",
      assetClasses: [
        {
          id: uid("ac"), name: "Indian Equity", targetPct: 55, manualSipPct: 55,
          holdings: [
            { id: uid("h"), name: "Sample Large Cap Fund", currentValue: 30000, sipPct: 25, isin: null },
            { id: uid("h"), name: "Sample Mid Cap Fund", currentValue: 25000, sipPct: 25, isin: null },
            { id: uid("h"), name: "Sample Tax Saver Fund", currentValue: 20000, sipPct: 0, isin: null },
            { id: uid("h"), name: "Sample Index Fund", currentValue: 25000, sipPct: 25, isin: null },
            { id: uid("h"), name: "Sample Small Cap Fund", currentValue: 15000, sipPct: 25, isin: null }
          ]
        },
        {
          id: uid("ac"), name: "Foreign Equity", targetPct: 20, manualSipPct: 20,
          holdings: [
            { id: uid("h"), name: "Sample US Equity Fund", currentValue: 28000, sipPct: 100, isin: null },
            { id: uid("h"), name: "Sample Clean Energy Fund", currentValue: 0, sipPct: 0, isin: null }
          ]
        },
        {
          id: uid("ac"), name: "Debt", targetPct: 10, manualSipPct: 10,
          holdings: [
            { id: uid("h"), name: "Sample Short Duration Fund", currentValue: 18000, sipPct: 100, isin: null }
          ]
        },
        {
          id: uid("ac"), name: "Commodities", targetPct: 15, manualSipPct: 15,
          holdings: [
            { id: uid("h"), name: "Sample Gold Savings Fund", currentValue: 14000, sipPct: 40, isin: null },
            { id: uid("h"), name: "Sample Gold Jewellery Scheme", currentValue: 6000, sipPct: 60, isin: null },
            { id: uid("h"), name: "Sample Gold ETF", currentValue: 12000, sipPct: 0, isin: null }
          ]
        }
      ],
      otherAssets: [
        {
          id: uid("o"), name: "Bonds", monthlyContribution: 3000,
          holdings: [
            { id: uid("oh"), name: "Sample Corporate Bond A", currentValue: 10000, isin: null },
            { id: uid("oh"), name: "Sample Corporate Bond B", currentValue: 10000, isin: null },
            { id: uid("oh"), name: "Sample Corporate Bond C", currentValue: 8000, isin: null }
          ]
        },
        { id: uid("o"), name: "Chit", currentValue: 50000, monthlyContribution: 5000 },
        { id: uid("o"), name: "NPS", currentValue: 25000, monthlyContribution: 3000 },
        { id: uid("o"), name: "Physical Gold", currentValue: 20000, monthlyContribution: 0 }
      ]
    };
  }

  function emptyData() {
    return { updated: new Date().toISOString().slice(0, 10), monthlyInvestment: 0, sipMode: "target", assetClasses: [], otherAssets: [], priceWorkerUrl: "" };
  }

  function allGroupIds(data) {
    return [
      ...data.assetClasses.map((a) => a.id),
      ...data.otherAssets.filter((o) => Array.isArray(o.holdings)).map((o) => o.id)
    ];
  }

  // One-time fixup for browsers that persisted state from before Bonds moved under Other
  // Assets: if a top-level asset class named like "Bonds" exists, move it (and its holdings)
  // into an Other Assets subsection instead, so it drops out of the target%/deviation math.
  function migrateLegacyBondsClass(data) {
    const idx = data.assetClasses.findIndex((ac) => /bond/i.test(ac.name));
    if (idx === -1) return false;
    const bondsClass = data.assetClasses[idx];
    data.assetClasses.splice(idx, 1);
    let targetGroup = data.otherAssets.find((o) => Array.isArray(o.holdings) && /bond/i.test(o.name));
    if (!targetGroup) {
      targetGroup = { id: uid("o"), name: bondsClass.name, monthlyContribution: 0, holdings: [] };
      data.otherAssets.push(targetGroup);
    }
    bondsClass.holdings.forEach((h) => {
      targetGroup.holdings.push({ id: uid("oh"), name: h.name, currentValue: h.currentValue, isin: h.isin || null });
    });
    return true;
  }

  // ---------- state ----------
  let state = load();
  const migrated = migrateLegacyBondsClass(state);
  let expanded = new Set(); // start collapsed
  let chartAllocation = null;
  let chartNetWorth = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return seedData();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return seedData();
      // Repair only the keys this page owns — never discard unrelated top-level keys (e.g. a
      // dailyTracker object written by tracker.html) just because portfolio data is missing/corrupt.
      const seed = seedData();
      if (!Array.isArray(parsed.assetClasses)) parsed.assetClasses = seed.assetClasses;
      if (!Array.isArray(parsed.otherAssets)) parsed.otherAssets = seed.otherAssets;
      if (typeof parsed.monthlyInvestment !== "number") parsed.monthlyInvestment = seed.monthlyInvestment;
      if (!parsed.sipMode) parsed.sipMode = seed.sipMode;
      if (!parsed.updated) parsed.updated = seed.updated;
      if (typeof parsed.priceWorkerUrl !== "string") parsed.priceWorkerUrl = "";
      return parsed;
    } catch (e) {
      return seedData();
    }
  }

  let storageWarned = false;
  function persist() {
    state._rev = new Date().toISOString();
    state.updated = todayStr(); // "Last updated" is derived from real edits, not manually set
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

  // ---------- derived calculations ----------
  function computeDerived(data) {
    data.assetClasses.forEach((ac) => {
      ac.currentValue = ac.holdings.reduce((s, h) => s + (Number(h.currentValue) || 0), 0);
    });
    data.otherAssets.forEach((o) => {
      if (Array.isArray(o.holdings)) o.currentValue = o.holdings.reduce((s, h) => s + (Number(h.currentValue) || 0), 0);
    });
    const totalAssets = data.assetClasses.reduce((s, ac) => s + ac.currentValue, 0);
    const otherTotal = data.otherAssets.reduce((s, o) => s + (Number(o.currentValue) || 0), 0);
    const netWorth = totalAssets + otherTotal;
    const monthlyInvestment = Number(data.monthlyInvestment) || 0;
    const sipMode = data.sipMode || "target";

    data.assetClasses.forEach((ac) => {
      ac.currentPct = totalAssets ? (ac.currentValue / totalAssets) * 100 : 0;
      ac.targetAmount = (ac.targetPct / 100) * totalAssets;
      ac.deviation = ac.currentPct - ac.targetPct;
      ac.correction = ac.targetAmount - ac.currentValue;
    });

    // How the monthly SIP splits across classes: same as Target %, weighted toward
    // under-target classes ("deviation"), or a manually typed split.
    if (sipMode === "manual") {
      data.assetClasses.forEach((ac) => { ac.sipAllocPct = Number(ac.manualSipPct) || 0; });
    } else if (sipMode === "deviation") {
      const weights = data.assetClasses.map((ac) => Math.max(ac.correction, 0));
      const totalWeight = weights.reduce((s, w) => s + w, 0);
      data.assetClasses.forEach((ac, i) => {
        // If nothing is under target (perfectly balanced), fall back to Target % split.
        ac.sipAllocPct = totalWeight > 0 ? (weights[i] / totalWeight) * 100 : (Number(ac.targetPct) || 0);
      });
    } else {
      data.assetClasses.forEach((ac) => { ac.sipAllocPct = Number(ac.targetPct) || 0; });
    }

    data.assetClasses.forEach((ac) => {
      ac.sipAmount = (ac.sipAllocPct / 100) * monthlyInvestment;
      ac.holdings.forEach((h) => {
        h.currentPct = ac.currentValue ? (h.currentValue / ac.currentValue) * 100 : 0;
        h.sipAmount = ac.sipAmount * ((Number(h.sipPct) || 0) / 100);
      });
    });

    const targetPctSum = data.assetClasses.reduce((s, ac) => s + (Number(ac.targetPct) || 0), 0);
    const sipAllocPctSum = data.assetClasses.reduce((s, ac) => s + (Number(ac.sipAllocPct) || 0), 0);
    const offTargetCount = data.assetClasses.filter((ac) => Math.abs(ac.deviation) > DEVIATION_THRESHOLD).length;

    return { totalAssets, otherTotal, netWorth, monthlyInvestment, targetPctSum, sipAllocPctSum, offTargetCount, sipMode };
  }

  // ---------- formatting ----------
  const inrFmt = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
  function fmtINR(n) { return inrFmt.format(Number(n) || 0); }
  function fmtPct(n) { return (Number(n) || 0).toFixed(1) + "%"; }
  function fmtSigned(n, unit) {
    const v = Number(n) || 0;
    const s = unit === "%" ? Math.abs(v).toFixed(1) + "%" : fmtINR(Math.abs(v));
    return (v > 0 ? "+" : v < 0 ? "-" : "") + s;
  }

  // ---------- rendering ----------
  function renderAll() {
    const d = computeDerived(state);
    renderStats(d);
    renderAllocationTable(d);
    renderOtherTable(d);
    renderCharts(d);
  }

  function renderStats(d) {
    const offMsg = d.offTargetCount === 0
      ? '<span class="hint ok">All classes within ' + DEVIATION_THRESHOLD + '% of target ✓</span>'
      : '<span class="hint warn">' + d.offTargetCount + " class(es) off target (>" + DEVIATION_THRESHOLD + "%)</span>";

    const otherItemCount = state.otherAssets.reduce((s, o) => s + (Array.isArray(o.holdings) ? o.holdings.length : 1), 0);
    document.getElementById("statCards").innerHTML = [
      card("Net Worth", fmtINR(d.netWorth), '<span class="hint">Updated ' + escapeHtml(fmtDate(state.updated)) + "</span>"),
      card("Total Investments", fmtINR(d.totalAssets), '<span class="hint">Across ' + state.assetClasses.length + " asset classes</span>"),
      card("Other Assets", fmtINR(d.otherTotal), '<span class="hint">' + otherItemCount + " items (bonds, chit, NPS, gold…)</span>"),
      card("Monthly SIP / Investment", fmtINR(d.monthlyInvestment), offMsg)
    ].join("");

    const updatedDisplay = document.getElementById("updatedDisplay");
    if (updatedDisplay) updatedDisplay.textContent = fmtDate(state.updated);
  }

  function card(label, value, hintHtml) {
    return '<div class="stat-card"><div class="label">' + label + '</div><div class="value">' + value + "</div>" + (hintHtml || "") + "</div>";
  }

  function renderAllocationTable(d) {
    const rows = [];
    state.assetClasses.forEach((ac, acIdx) => {
      const isOpen = expanded.has(ac.id);
      const devClass = ac.deviation > DEVIATION_THRESHOLD ? "pos" : ac.deviation < -DEVIATION_THRESHOLD ? "neg" : "neu";
      const color = PALETTE[acIdx % PALETTE.length];
      rows.push(
        '<tr class="class-row" data-toggle="' + ac.id + '">' +
          '<td class="left"><div class="name-cell"><span class="chevron' + (isOpen ? " open" : "") + '">▶</span>' +
            '<span class="swatch" style="background:' + color + '"></span>' +
            '<input class="cell-input name-input" data-type="class" data-id="' + ac.id + '" data-field="name" value="' + escapeAttr(ac.name) + '" onclick="event.stopPropagation()">' +
          "</div></td>" +
          '<td><input class="cell-input small" type="number" step="0.1" data-type="class" data-id="' + ac.id + '" data-field="targetPct" value="' + numOr0(ac.targetPct) + '" onclick="event.stopPropagation()"> %</td>' +
          "<td>" + fmtINR(ac.targetAmount) + "</td>" +
          "<td>" + fmtINR(ac.currentValue) + "</td>" +
          "<td>" + fmtPct(ac.currentPct) + "</td>" +
          '<td class="' + devClass + '">' + fmtSigned(ac.deviation, "%") + "</td>" +
          '<td class="' + (ac.correction > 0 ? "neg" : ac.correction < 0 ? "pos" : "neu") + '">' + fmtSigned(ac.correction) + "</td>" +
          "<td>" + (d.sipMode === "manual"
            ? '<input class="cell-input small" type="number" step="0.1" data-type="class" data-id="' + ac.id + '" data-field="manualSipPct" value="' + numOr0(ac.manualSipPct) + '" onclick="event.stopPropagation()"> % → ' + fmtINR(ac.sipAmount)
            : fmtPct(ac.sipAllocPct) + " → " + fmtINR(ac.sipAmount)) + "</td>" +
          '<td><button class="icon-btn move-btn" data-action="move-class-to-other" data-id="' + ac.id + '" title="Move to Other Assets">⇄</button>' +
            '<button class="icon-btn" data-action="delete-class" data-id="' + ac.id + '" title="Delete asset class">✕</button></td>' +
        "</tr>"
      );
      if (isOpen) {
        const sipPctSum = ac.holdings.reduce((s, h) => s + (Number(h.sipPct) || 0), 0);
        ac.holdings.forEach((h) => {
          rows.push(
            '<tr class="holding-row">' +
              '<td class="left"><input class="cell-input name-input" data-type="holding" data-id="' + h.id + '" data-parent="' + ac.id + '" data-field="name" value="' + escapeAttr(h.name) + '"></td>' +
              "<td>—</td>" +
              "<td>—</td>" +
              '<td><input class="cell-input amount" type="number" step="0.01" data-type="holding" data-id="' + h.id + '" data-parent="' + ac.id + '" data-field="currentValue" value="' + numOr0(h.currentValue) + '"></td>' +
              "<td>" + fmtPct(h.currentPct) + "</td>" +
              "<td>—</td>" +
              "<td>—</td>" +
              '<td><input class="cell-input small" type="number" step="1" data-type="holding" data-id="' + h.id + '" data-parent="' + ac.id + '" data-field="sipPct" value="' + numOr0(h.sipPct) + '"> % → ' + fmtINR(h.sipAmount) + "</td>" +
              "<td>" + priceLinkBtn(h, ac.id, "class") +
                '<button class="icon-btn" data-action="delete-holding" data-id="' + h.id + '" data-parent="' + ac.id + '" title="Delete holding">✕</button></td>' +
            "</tr>"
          );
        });
        rows.push(
          '<tr class="add-row"><td colspan="9">' +
            '<div class="name-cell" style="gap:8px;padding-left:22px;">' +
              '<input class="cell-input name-input" placeholder="New holding name" id="newHoldingName_' + ac.id + '">' +
              '<input class="cell-input amount" type="number" placeholder="Value" id="newHoldingValue_' + ac.id + '">' +
              '<input class="cell-input small" type="number" placeholder="SIP %" id="newHoldingSip_' + ac.id + '">' +
              '<button class="btn" data-action="add-holding" data-parent="' + ac.id + '">+ Add Holding</button>' +
              '<span class="hint ' + (Math.abs(sipPctSum - 100) < 0.01 || ac.holdings.length === 0 ? "" : "warn") + '" style="font-size:11px;color:var(--muted);margin-left:auto;">SIP % total: ' + sipPctSum.toFixed(0) + "%</span>" +
            "</div>" +
          "</td></tr>"
        );
      }
    });

    if (state.assetClasses.length === 0) {
      rows.push('<tr><td colspan="9" class="empty-msg">No asset classes yet. Add one below, or import a CSV/Excel file.</td></tr>');
    }

    rows.push(
      '<tr class="add-row"><td colspan="9">' +
        '<div class="name-cell" style="gap:8px;">' +
          '<input class="cell-input name-input" placeholder="New asset class name" id="newClassName">' +
          '<input class="cell-input small" type="number" placeholder="Target %" id="newClassTarget">' +
          '<button class="btn primary" data-action="add-class">+ Add Asset Class</button>' +
        "</div>" +
      "</td></tr>"
    );

    document.getElementById("allocationBody").innerHTML = rows.join("");

    const badge = document.getElementById("targetSumBadge");
    const sumOk = Math.abs(d.targetPctSum - 100) < 0.01;
    badge.textContent = "Target % total: " + d.targetPctSum.toFixed(0) + "%";
    badge.className = "badge " + (sumOk ? "ok" : "warn");

    document.getElementById("monthlyInvestBadge").innerHTML =
      'Monthly investment: <input class="cell-input amount" style="color:inherit;font-weight:700;" type="number" data-type="meta" data-field="monthlyInvestment" value="' + numOr0(state.monthlyInvestment) + '">';

    document.getElementById("sipModeSelect").value = d.sipMode;

    const sipBadge = document.getElementById("sipSumBadge");
    if (d.sipMode === "manual") {
      const sipSumOk = Math.abs(d.sipAllocPctSum - 100) < 0.01;
      sipBadge.textContent = "SIP % total: " + d.sipAllocPctSum.toFixed(0) + "%";
      sipBadge.className = "badge " + (sipSumOk ? "ok" : "warn");
      sipBadge.style.display = "";
    } else {
      sipBadge.style.display = "none";
    }
  }

  function renderOtherTable(d) {
    const rows = [];

    state.otherAssets.forEach((o) => {
      const isGroup = Array.isArray(o.holdings);
      if (!isGroup) {
        rows.push(
          "<tr>" +
            '<td class="left"><input class="cell-input name-input" data-type="other" data-id="' + o.id + '" data-field="name" value="' + escapeAttr(o.name) + '"></td>' +
            '<td><input class="cell-input amount" type="number" data-type="other" data-id="' + o.id + '" data-field="currentValue" value="' + numOr0(o.currentValue) + '"></td>' +
            '<td><input class="cell-input amount" type="number" data-type="other" data-id="' + o.id + '" data-field="monthlyContribution" value="' + numOr0(o.monthlyContribution) + '"></td>' +
            '<td><button class="icon-btn move-btn" data-action="move-other-to-class" data-id="' + o.id + '" title="Move to Asset Allocation">⇄</button>' +
              '<button class="icon-btn" data-action="delete-other" data-id="' + o.id + '" title="Delete">✕</button></td>' +
          "</tr>"
        );
        return;
      }

      const isOpen = expanded.has(o.id);
      rows.push(
        '<tr class="class-row" data-toggle="' + o.id + '">' +
          '<td class="left"><div class="name-cell"><span class="chevron' + (isOpen ? " open" : "") + '">▶</span>' +
            '<input class="cell-input name-input" data-type="other" data-id="' + o.id + '" data-field="name" value="' + escapeAttr(o.name) + '" onclick="event.stopPropagation()">' +
          "</div></td>" +
          "<td>" + fmtINR(o.currentValue) + "</td>" +
          '<td><input class="cell-input amount" type="number" data-type="other" data-id="' + o.id + '" data-field="monthlyContribution" value="' + numOr0(o.monthlyContribution) + '" onclick="event.stopPropagation()"></td>' +
          '<td><button class="icon-btn move-btn" data-action="move-other-to-class" data-id="' + o.id + '" title="Move to Asset Allocation">⇄</button>' +
            '<button class="icon-btn" data-action="delete-other" data-id="' + o.id + '" title="Delete section (and its items)">✕</button></td>' +
        "</tr>"
      );

      if (isOpen) {
        o.holdings.forEach((h) => {
          rows.push(
            '<tr class="holding-row">' +
              '<td class="left"><input class="cell-input name-input" data-type="otherHolding" data-id="' + h.id + '" data-parent="' + o.id + '" data-field="name" value="' + escapeAttr(h.name) + '"></td>' +
              '<td><input class="cell-input amount" type="number" data-type="otherHolding" data-id="' + h.id + '" data-parent="' + o.id + '" data-field="currentValue" value="' + numOr0(h.currentValue) + '"></td>' +
              "<td>—</td>" +
              "<td>" + priceLinkBtn(h, o.id, "other") +
                '<button class="icon-btn" data-action="delete-other-holding" data-id="' + h.id + '" data-parent="' + o.id + '" title="Delete item">✕</button></td>' +
            "</tr>"
          );
        });
        rows.push(
          '<tr class="add-row"><td colspan="4">' +
            '<div class="name-cell" style="gap:8px;padding-left:22px;">' +
              '<input class="cell-input name-input" placeholder="New item name" id="newOtherHoldingName_' + o.id + '">' +
              '<input class="cell-input amount" type="number" placeholder="Value" id="newOtherHoldingValue_' + o.id + '">' +
              '<button class="btn" data-action="add-other-holding" data-parent="' + o.id + '">+ Add Item</button>' +
            "</div>" +
          "</td></tr>"
        );
      }
    });

    if (state.otherAssets.length === 0) {
      rows.push('<tr><td colspan="4" class="empty-msg">No other assets yet.</td></tr>');
    }

    rows.push(
      '<tr class="add-row"><td colspan="4">' +
        '<div class="name-cell" style="gap:8px;flex-wrap:wrap;">' +
          '<input class="cell-input name-input" placeholder="New item name" id="newOtherName">' +
          '<input class="cell-input amount" type="number" placeholder="Value" id="newOtherValue">' +
          '<input class="cell-input amount" type="number" placeholder="Monthly" id="newOtherMonthly">' +
          '<button class="btn" data-action="add-other">+ Add Other Asset</button>' +
          '<span style="width:1px;align-self:stretch;background:var(--border);"></span>' +
          '<input class="cell-input name-input" placeholder="New subsection name (e.g. Bonds)" id="newOtherGroupName">' +
          '<button class="btn" data-action="add-other-group">+ Add Subsection</button>' +
        "</div>" +
      "</td></tr>"
    );

    document.getElementById("otherBody").innerHTML = rows.join("");
  }

  function renderCharts(d) {
    // Chart.js bakes colors in at creation time rather than reading CSS, so pull the current
    // theme's values at render time — this is what makes the charts follow the light/dark toggle.
    const cs = getComputedStyle(document.documentElement);
    const cssVar = (name) => cs.getPropertyValue(name).trim();
    const primary = cssVar("--primary");
    // Deliberately not --primary-light: that token is tuned to sit *behind* bright text
    // (badges), so in dark mode it's nearly black — invisible as a bar fill on its own.
    const targetBarColor = cssVar("--chart-target");
    const cardBg = cssVar("--card");
    const mutedColor = cssVar("--muted");
    const gridColor = cssVar("--border");

    const labels = state.assetClasses.map((a) => a.name);
    const targetData = state.assetClasses.map((a) => a.targetPct);
    const currentData = state.assetClasses.map((a) => a.currentPct);
    const colors = state.assetClasses.map((a, i) => PALETTE[i % PALETTE.length]);

    const ctx1 = document.getElementById("chartAllocation").getContext("2d");
    if (chartAllocation) chartAllocation.destroy();
    chartAllocation = new Chart(ctx1, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Target %", data: targetData, backgroundColor: targetBarColor, borderRadius: 4 },
          { label: "Current %", data: currentData, backgroundColor: primary, borderRadius: 4 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 }, color: mutedColor } } },
        scales: {
          x: { ticks: { color: mutedColor }, grid: { color: gridColor } },
          y: { beginAtZero: true, ticks: { callback: (v) => v + "%", color: mutedColor }, grid: { color: gridColor } }
        }
      }
    });

    const nwLabels = [...labels, ...state.otherAssets.map((o) => o.name)];
    const nwData = [...state.assetClasses.map((a) => a.currentValue), ...state.otherAssets.map((o) => Number(o.currentValue) || 0)];
    const nwColors = [...colors, ...state.otherAssets.map((_, i) => PALETTE[(state.assetClasses.length + i) % PALETTE.length])];

    const ctx2 = document.getElementById("chartNetWorth").getContext("2d");
    if (chartNetWorth) chartNetWorth.destroy();
    chartNetWorth = new Chart(ctx2, {
      type: "doughnut",
      data: { labels: nwLabels, datasets: [{ data: nwData, backgroundColor: nwColors, borderWidth: 2, borderColor: cardBg }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "right", labels: { boxWidth: 10, font: { size: 10 }, color: mutedColor } } }
      }
    });
  }

  // ---------- helpers ----------
  function numOr0(n) { return Number.isFinite(Number(n)) ? Number(n) : 0; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function escapeAttr(s) { return escapeHtml(s); }

  function isPriceLinked(h) { return !!(h.priceSource && h.symbol); }

  function priceLinkBtn(h, parentId, kind) {
    const linked = isPriceLinked(h);
    let title = "Link live price (value = units × market price)";
    if (linked) {
      const src = h.priceSource === "mf" ? "MF" : "Stock";
      title = src + ": " + (h.symbolName || h.symbol);
      if (Number(h.units)) title += " · " + h.units + " units";
      if (Number(h.lastPrice)) title += " · last price " + h.lastPrice + (h.lastPriceCurrency && h.lastPriceCurrency !== "INR" ? " " + h.lastPriceCurrency : "") + (h.lastPriceAt ? " (" + fmtDateTime(h.lastPriceAt) + ")" : "");
    }
    return '<button class="icon-btn price-link-btn' + (linked ? " linked" : "") + '" data-action="link-price" data-id="' + h.id + '" data-parent="' + parentId + '" data-kind="' + kind + '" title="' + escapeAttr(title) + '">₹</button>';
  }

  function findClass(id) { return state.assetClasses.find((a) => a.id === id); }
  function findHolding(classId, id) { const ac = findClass(classId); return ac ? ac.holdings.find((h) => h.id === id) : null; }
  function findOther(id) { return state.otherAssets.find((o) => o.id === id); }
  function findOtherHolding(groupId, id) { const og = findOther(groupId); return og && Array.isArray(og.holdings) ? og.holdings.find((h) => h.id === id) : null; }

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

  // ---------- field updates ----------
  function updateField(ds, value) {
    const { type, id, parent, field } = ds;
    const isNumeric = ["targetPct", "currentValue", "sipPct", "monthlyContribution", "monthlyInvestment", "manualSipPct"].includes(field);
    const val = isNumeric ? (parseFloat(value) || 0) : value;

    if (type === "meta") {
      state[field] = val;
    } else if (type === "class") {
      const ac = findClass(id);
      if (ac) ac[field] = val;
    } else if (type === "holding") {
      const h = findHolding(parent, id);
      if (h) h[field] = val;
    } else if (type === "other") {
      const o = findOther(id);
      if (o) o[field] = val;
    } else if (type === "otherHolding") {
      const h = findOtherHolding(parent, id);
      if (h) h[field] = val;
    }
    persist();
    renderAll();
  }

  // ---------- CSV / XLSX import-export ----------
  const HEADER_ORDER = ["Section", "Name", "Parent", "CurrentValue", "TargetPct", "SIPPct", "MonthlyContribution", "ISIN", "ManualSipPct", "Units", "PriceSource", "Symbol", "SymbolName"];

  function emptyRow() {
    const r = {};
    HEADER_ORDER.forEach((k) => { r[k] = ""; });
    return r;
  }

  function holdingPriceCols(h) {
    return { Units: h.units != null && h.units !== "" ? h.units : "", PriceSource: h.priceSource || "", Symbol: h.symbol || "", SymbolName: h.symbolName || "" };
  }

  function toRows(data) {
    const rows = [];
    rows.push(Object.assign(emptyRow(), { Section: "Meta", Name: "MonthlyInvestment", CurrentValue: data.monthlyInvestment }));
    rows.push(Object.assign(emptyRow(), { Section: "Meta", Name: "Updated", CurrentValue: data.updated }));
    rows.push(Object.assign(emptyRow(), { Section: "Meta", Name: "SipMode", CurrentValue: data.sipMode || "target" }));
    if (data.priceWorkerUrl) rows.push(Object.assign(emptyRow(), { Section: "Meta", Name: "PriceWorkerUrl", CurrentValue: data.priceWorkerUrl }));
    data.assetClasses.forEach((ac) => {
      rows.push(Object.assign(emptyRow(), { Section: "AssetClass", Name: ac.name, TargetPct: ac.targetPct, ManualSipPct: ac.manualSipPct }));
      ac.holdings.forEach((h) => {
        rows.push(Object.assign(emptyRow(), { Section: "Holding", Name: h.name, Parent: ac.name, CurrentValue: h.currentValue, SIPPct: h.sipPct, ISIN: h.isin || "" }, holdingPriceCols(h)));
      });
    });
    data.otherAssets.forEach((o) => {
      if (Array.isArray(o.holdings)) {
        rows.push(Object.assign(emptyRow(), { Section: "OtherGroup", Name: o.name, MonthlyContribution: o.monthlyContribution }));
        o.holdings.forEach((h) => {
          rows.push(Object.assign(emptyRow(), { Section: "OtherHolding", Name: h.name, Parent: o.name, CurrentValue: h.currentValue, ISIN: h.isin || "" }, holdingPriceCols(h)));
        });
      } else {
        rows.push(Object.assign(emptyRow(), { Section: "Other", Name: o.name, CurrentValue: o.currentValue, MonthlyContribution: o.monthlyContribution }));
      }
    });
    return rows;
  }

  // Spreadsheet amounts are often formatted as currency ("₹1,20,000.00"), which parseFloat
  // can't handle at all (it returns NaN at the very first non-numeric character) — strip
  // everything except digits/decimal point/minus sign before parsing.
  function parseAmount(v) {
    if (v === "" || v === null || v === undefined) return 0;
    const n = parseFloat(String(v).replace(/[^0-9.-]/g, ""));
    return isNaN(n) ? 0 : n;
  }

  // Live-price columns are optional (older CSVs simply don't have them): a source only
  // counts as linked when both PriceSource and Symbol survive the trip.
  function parsePriceCols(r) {
    const units = parseAmount(r.Units);
    const src = String(r.PriceSource || "").trim();
    const symbol = String(r.Symbol || "").trim();
    const linked = (src === "mf" || src === "stock") && symbol !== "";
    return {
      units: units > 0 ? units : null,
      priceSource: linked ? src : null,
      symbol: linked ? symbol : null,
      symbolName: linked ? (String(r.SymbolName || "").trim() || symbol) : null
    };
  }

  function parseRows(rows) {
    const data = emptyData();
    const classMap = {};
    const otherGroupMap = {};

    rows.forEach((r) => {
      const section = String(r.Section || "").trim();
      if (section === "AssetClass") {
        const name = String(r.Name || "").trim();
        if (!name) return;
        const targetPct = parseAmount(r.TargetPct);
        const ac = { id: uid("ac"), name, targetPct, manualSipPct: r.ManualSipPct !== "" && r.ManualSipPct != null ? parseAmount(r.ManualSipPct) : targetPct, holdings: [] };
        data.assetClasses.push(ac);
        classMap[name] = ac;
      } else if (section === "OtherGroup") {
        const name = String(r.Name || "").trim();
        if (!name) return;
        const og = { id: uid("o"), name, monthlyContribution: parseAmount(r.MonthlyContribution), holdings: [] };
        data.otherAssets.push(og);
        otherGroupMap[name] = og;
      } else if (section === "Meta") {
        const name = String(r.Name || "").trim();
        if (name === "MonthlyInvestment") data.monthlyInvestment = parseAmount(r.CurrentValue);
        if (name === "Updated" && r.CurrentValue) data.updated = String(r.CurrentValue).trim();
        if (name === "SipMode" && ["target", "deviation", "manual"].includes(String(r.CurrentValue).trim())) data.sipMode = String(r.CurrentValue).trim();
        if (name === "PriceWorkerUrl" && r.CurrentValue) data.priceWorkerUrl = String(r.CurrentValue).trim();
      }
    });

    rows.forEach((r) => {
      const section = String(r.Section || "").trim();
      if (section === "Holding") {
        const name = String(r.Name || "").trim();
        if (!name) return;
        const parentName = String(r.Parent || "").trim() || "Uncategorized";
        let ac = classMap[parentName];
        if (!ac) {
          ac = { id: uid("ac"), name: parentName, targetPct: 0, manualSipPct: 0, holdings: [] };
          data.assetClasses.push(ac);
          classMap[parentName] = ac;
        }
        ac.holdings.push(Object.assign({ id: uid("h"), name, currentValue: parseAmount(r.CurrentValue), sipPct: parseAmount(r.SIPPct), isin: String(r.ISIN || "").trim() || null }, parsePriceCols(r)));
      } else if (section === "OtherHolding") {
        const name = String(r.Name || "").trim();
        if (!name) return;
        const parentName = String(r.Parent || "").trim() || "Uncategorized";
        let og = otherGroupMap[parentName];
        if (!og) {
          og = { id: uid("o"), name: parentName, monthlyContribution: 0, holdings: [] };
          data.otherAssets.push(og);
          otherGroupMap[parentName] = og;
        }
        og.holdings.push(Object.assign({ id: uid("oh"), name, currentValue: parseAmount(r.CurrentValue), isin: String(r.ISIN || "").trim() || null }, parsePriceCols(r)));
      } else if (section === "Other") {
        const name = String(r.Name || "").trim();
        if (!name) return;
        data.otherAssets.push({ id: uid("o"), name, currentValue: parseAmount(r.CurrentValue), monthlyContribution: parseAmount(r.MonthlyContribution) });
      }
    });

    return data;
  }

  function buildWorksheet(data) {
    return XLSX.utils.json_to_sheet(toRows(data), { header: HEADER_ORDER });
  }

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

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function fmtDate(dateStr) {
    if (!dateStr) return "—";
    const d = new Date(dateStr + "T00:00:00");
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function fmtDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || "");
    return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  }

  function exportCSV(data, filename) {
    const ws = buildWorksheet(data);
    downloadBlob(XLSX.utils.sheet_to_csv(ws), filename, "text/csv");
  }

  function exportXLSX(data, filename) {
    const ws = buildWorksheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Portfolio");
    XLSX.writeFile(wb, filename);
  }

  function handleImportFile(file) {
    const reader = new FileReader();
    const isCsv = /\.csv$/i.test(file.name);
    reader.onload = async (e) => {
      try {
        // raw: true stops SheetJS from auto-detecting date-like cells (e.g. the Updated field,
        // if a spreadsheet editor reformats it) as US MM/DD/YYYY and silently misreading them.
        const workbook = isCsv ? XLSX.read(e.target.result, { type: "string", raw: true }) : XLSX.read(e.target.result, { type: "array", raw: true });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        const parsed = parseRows(rows);
        if (parsed.assetClasses.length === 0 && parsed.otherAssets.length === 0) {
          toast("No recognizable rows found. Check the template format.");
          return;
        }
        const ok = await confirmDialog("Import portfolio?", "This will replace your current portfolio data with the contents of \"" + file.name + "\". Consider exporting a backup first.");
        if (!ok) return;
        const preservedTracker = state.dailyTracker;
        const preservedWorkerUrl = state.priceWorkerUrl;
        state = parsed;
        if (preservedTracker !== undefined) state.dailyTracker = preservedTracker;
        if (!state.priceWorkerUrl && preservedWorkerUrl) state.priceWorkerUrl = preservedWorkerUrl; // CSV's own URL wins; older CSVs shouldn't wipe it
        expanded = new Set();
        persist();
        renderAll();
        toast("Portfolio imported successfully.");
      } catch (err) {
        toast("Import failed: " + err.message);
      }
    };
    if (isCsv) reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  }

  // ---------- CDSL statement sync ----------
  // Parses CDSL's "Transaction cum Holding_Consolidated" export: a multi-section text/CSV
  // report (per-DP-ID demat holdings, NSDL bonds/NCDs, mutual fund folio holdings), each
  // preceded by a "STATEMENT OF HOLDINGS AS ON …" / "STATEMENT OF MUTUAL FUND FOLIO HOLDING
  // AS ON …" marker and its own header row — not a single flat table.
  let pendingCdsl = { matches: [], newEntries: [], unmatchedNames: [] };

  function parseCsvLine(line) {
    const fields = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
        } else cur += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ",") { fields.push(cur); cur = ""; }
        else cur += c;
      }
    }
    fields.push(cur);
    return fields.map((f) => f.trim());
  }

  function parseCdslStatement(text) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    let state2 = "SCAN";
    const demat = [];
    const mf = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (state2 === "SCAN") {
        if (/^STATEMENT OF HOLDINGS AS ON/i.test(line)) state2 = "AWAIT_DEMAT_HEADER";
        else if (/^STATEMENT OF MUTUAL FUND FOLIO HOLDING AS ON/i.test(line)) state2 = "AWAIT_MF_HEADER";
        continue;
      }
      if (state2 === "AWAIT_DEMAT_HEADER") {
        if (line.startsWith('"ISIN"')) state2 = "DEMAT_ROWS";
        continue;
      }
      if (state2 === "DEMAT_ROWS") {
        if (line === "" || /^\**\s*End of Statement/i.test(line)) { state2 = "SCAN"; continue; }
        if (/^No Record Found/i.test(line)) { state2 = "SCAN"; continue; }
        const f = parseCsvLine(line);
        // f[2] is "CURRENT BALANCE FREE BALANCE" — two space-separated numbers in one cell;
        // parseFloat reads the first (current balance), which is the unit count we want.
        if (f.length >= 6 && f[0]) demat.push({ isin: f[0], description: f[1], value: parseFloat(f[5]) || 0, units: parseFloat(f[2]) || 0 });
        continue;
      }
      if (state2 === "AWAIT_MF_HEADER") {
        if (line.startsWith('"AMC NAME"')) state2 = "MF_ROWS";
        continue;
      }
      if (state2 === "MF_ROWS") {
        if (line === "" || /^\**\s*End of Statement/i.test(line)) { state2 = "SCAN"; continue; }
        if (/^No Record Found/i.test(line)) { state2 = "SCAN"; continue; }
        const f = parseCsvLine(line);
        if (f.length >= 9 && f[2]) mf.push({ isin: f[2], description: f[4], value: parseFloat(f[8]) || 0, units: parseFloat(f[6]) || 0 }); // f[6] = CLOSING UNITS
        continue;
      }
    }
    return { demat, mf };
  }

  function aggregateByIsin(demat, mf) {
    const map = new Map();
    [...demat, ...mf].forEach((row) => {
      if (!row.isin || row.value <= 0) return;
      if (!map.has(row.isin)) map.set(row.isin, { isin: row.isin, value: 0, units: 0, descriptions: [] });
      const entry = map.get(row.isin);
      entry.value += row.value;
      entry.units += Number(row.units) || 0;
      if (!entry.descriptions.includes(row.description)) entry.descriptions.push(row.description);
    });
    const out = [];
    map.forEach((entry) => {
      const description = entry.descriptions.reduce((a, b) => (b.length > a.length ? b : a), "");
      const matchText = entry.descriptions.join(" | ");
      const isBond = /\bNCD\b/i.test(matchText) || /\bBOND\b/i.test(matchText) || /\bSGB\b/i.test(matchText) || /\bG-?SEC\b/i.test(matchText) || /\bT-?BILL\b/i.test(matchText) || /\bGILT\b/i.test(matchText);
      out.push({ isin: entry.isin, description, matchText, value: entry.value, units: entry.units, isBond });
    });
    return out;
  }

  const CDSL_STOPWORDS = new Set(["LIMITED", "LTD", "FUND", "DIRECT", "GROWTH", "PLAN", "OPTION", "NEW", "EQUITY", "SHARES", "SCHEME", "OF", "THE", "AFTER", "WITH", "FACE", "VALUE", "RS", "RE", "FV", "SUBDIVISION", "SUB", "DIVISION", "AND", "FOR", "GROUP", "AM", "MF", "PRIVATE", "FOLIO", "NO"]);

  function normalizeTokens(name) {
    return String(name || "").toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length >= 2 && !CDSL_STOPWORDS.has(t));
  }

  function matchScore(holdingName, candidateText) {
    const hTokens = normalizeTokens(holdingName);
    if (hTokens.length === 0) return 0;
    const cTokens = new Set(normalizeTokens(candidateText));
    let hit = 0;
    hTokens.forEach((t) => { if (cTokens.has(t)) hit++; });
    return hit / hTokens.length;
  }

  // classChoice encoding used across newEntries/select options:
  //   "class:<id>"   -> existing investment asset class
  //   "other:<id>"   -> existing Other Assets subsection
  //   "__new_class__" -> create a new investment asset class (named via newClassName)
  //   "__new_other__" -> create a new Other Assets subsection (named via newClassName)
  //   ""             -> skip / not chosen
  function buildCdslProposals(agg) {
    const aggByIsin = new Map(agg.map((e) => [e.isin, e]));
    const claimedIsins = new Set();
    const matches = [];
    const allHoldingRefs = [];
    state.assetClasses.forEach((ac) => ac.holdings.forEach((h) => allHoldingRefs.push({ h, kind: "class", parentId: ac.id, parentName: ac.name })));
    state.otherAssets.forEach((o) => {
      if (Array.isArray(o.holdings)) o.holdings.forEach((h) => allHoldingRefs.push({ h, kind: "other", parentId: o.id, parentName: o.name }));
    });

    const unmatchedHoldingRefs = [];
    allHoldingRefs.forEach((ref) => {
      const { h } = ref;
      if (h.isin && aggByIsin.has(h.isin) && !claimedIsins.has(h.isin)) {
        const entry = aggByIsin.get(h.isin);
        claimedIsins.add(h.isin);
        matches.push({ holdingId: h.id, kind: ref.kind, parentId: ref.parentId, holdingName: h.name, parentName: ref.parentName, oldValue: h.currentValue, newValue: entry.value, newUnits: entry.units, isin: entry.isin, basis: "Matched by ISIN", checked: true });
      } else {
        unmatchedHoldingRefs.push(ref);
      }
    });

    const candidates = [];
    unmatchedHoldingRefs.forEach((ref) => {
      agg.forEach((entry) => {
        if (claimedIsins.has(entry.isin)) return;
        const score = matchScore(ref.h.name, entry.matchText);
        if (score >= 0.6) candidates.push({ ref, entry, score });
      });
    });
    candidates.sort((a, b) => b.score - a.score);
    const claimedHoldingIds = new Set();
    candidates.forEach((c) => {
      if (claimedHoldingIds.has(c.ref.h.id) || claimedIsins.has(c.entry.isin)) return;
      claimedHoldingIds.add(c.ref.h.id);
      claimedIsins.add(c.entry.isin);
      matches.push({ holdingId: c.ref.h.id, kind: c.ref.kind, parentId: c.ref.parentId, holdingName: c.ref.h.name, parentName: c.ref.parentName, oldValue: c.ref.h.currentValue, newValue: c.entry.value, newUnits: c.entry.units, isin: c.entry.isin, basis: Math.round(c.score * 100) + '% name match: "' + c.entry.description + '"', checked: true });
    });

    const matchedHoldingIds = new Set(matches.map((m) => m.holdingId));
    const unmatchedNames = allHoldingRefs.filter((ref) => !matchedHoldingIds.has(ref.h.id)).map((ref) => ref.h.name);

    const bondsGroup = state.otherAssets.find((o) => Array.isArray(o.holdings) && /bond/i.test(o.name));
    const newEntries = agg.filter((e) => !claimedIsins.has(e.isin)).map((e) => ({
      isin: e.isin,
      description: e.description,
      value: e.value,
      units: e.units,
      isBond: e.isBond,
      checked: e.isBond,
      classChoice: e.isBond ? (bondsGroup ? "other:" + bondsGroup.id : "__new_other__") : "",
      newClassName: e.isBond ? "Bonds" : ""
    }));

    return { matches, newEntries, unmatchedNames };
  }

  function renderCdslModal() {
    const body = document.getElementById("cdslModalBody");
    const parts = [];

    parts.push('<div class="cdsl-section-title">Will update (' + pendingCdsl.matches.length + ")</div>");
    if (pendingCdsl.matches.length === 0) {
      parts.push('<div class="cdsl-empty">No holdings matched this statement.</div>');
    } else {
      pendingCdsl.matches.forEach((m, i) => {
        const diff = m.newValue - m.oldValue;
        const diffStr = (diff >= 0 ? "+" : "-") + fmtINR(Math.abs(diff));
        parts.push(
          '<div class="cdsl-row">' +
            '<input type="checkbox" data-list="match" data-index="' + i + '" data-field="checked"' + (m.checked ? " checked" : "") + ">" +
            '<div class="cdsl-name"><div class="primary">' + escapeHtml(m.holdingName) + ' <span style="color:var(--muted);font-weight:400;">(' + escapeHtml(m.parentName) + ")</span></div>" +
            '<div class="secondary">' + escapeHtml(m.basis) + "</div></div>" +
            '<div class="cdsl-value">' + fmtINR(m.oldValue) + " → <strong>" + fmtINR(m.newValue) + "</strong><br><span style=\"font-size:11px;color:" + (diff >= 0 ? "var(--red)" : "var(--green)") + '">' + diffStr + "</span></div>" +
          "</div>"
        );
      });
    }

    parts.push('<div class="cdsl-section-title">New in statement (' + pendingCdsl.newEntries.length + ")</div>");
    if (pendingCdsl.newEntries.length === 0) {
      parts.push('<div class="cdsl-empty">Nothing new found — everything in the statement matched an existing holding.</div>');
    } else {
      pendingCdsl.newEntries.forEach((e, i) => {
        const showNewClassInput = e.classChoice === "__new_class__" || e.classChoice === "__new_other__";
        let optionsHtml = '<option value=""' + (e.classChoice === "" ? " selected" : "") + ">— choose section / skip —</option>";
        if (state.assetClasses.length) {
          optionsHtml += '<optgroup label="Asset Classes">';
          state.assetClasses.forEach((ac) => {
            const val = "class:" + ac.id;
            optionsHtml += '<option value="' + val + '"' + (e.classChoice === val ? " selected" : "") + ">" + escapeHtml(ac.name) + "</option>";
          });
          optionsHtml += "</optgroup>";
        }
        const otherGroups = state.otherAssets.filter((o) => Array.isArray(o.holdings));
        if (otherGroups.length) {
          optionsHtml += '<optgroup label="Other Assets">';
          otherGroups.forEach((o) => {
            const val = "other:" + o.id;
            optionsHtml += '<option value="' + val + '"' + (e.classChoice === val ? " selected" : "") + ">" + escapeHtml(o.name) + "</option>";
          });
          optionsHtml += "</optgroup>";
        }
        optionsHtml += '<option value="__new_class__"' + (e.classChoice === "__new_class__" ? " selected" : "") + ">+ New asset class…</option>";
        optionsHtml += '<option value="__new_other__"' + (e.classChoice === "__new_other__" ? " selected" : "") + ">+ New Other Assets subsection…</option>";
        parts.push(
          '<div class="cdsl-row">' +
            '<input type="checkbox" data-list="new" data-index="' + i + '" data-field="checked"' + (e.checked ? " checked" : "") + ">" +
            '<div class="cdsl-name"><div class="primary">' + escapeHtml(e.description) + (e.isBond ? ' <span class="badge warn">Bond</span>' : "") + "</div>" +
            '<div class="secondary">ISIN ' + escapeHtml(e.isin) + "</div></div>" +
            '<div class="cdsl-value">' + fmtINR(e.value) + "</div>" +
            '<select data-list="new" data-index="' + i + '" data-field="classChoice">' + optionsHtml + "</select>" +
            (showNewClassInput ? '<input type="text" class="cdsl-newclass" data-list="new" data-index="' + i + '" data-field="newClassName" value="' + escapeAttr(e.newClassName) + '" placeholder="Class name">' : "") +
          "</div>"
        );
      });
    }

    if (pendingCdsl.unmatchedNames.length > 0) {
      parts.push('<div class="cdsl-unchanged">In your portfolio but not found in this statement (left unchanged): ' + pendingCdsl.unmatchedNames.map(escapeHtml).join(", ") + "</div>");
    }

    body.innerHTML = parts.join("");
  }

  function openCdslModal() {
    renderCdslModal();
    document.getElementById("cdslBackdrop").classList.add("show");
  }

  function closeCdslModal() {
    document.getElementById("cdslBackdrop").classList.remove("show");
  }

  function applyCdslSync() {
    let updatedCount = 0;
    let addedCount = 0;
    const newGroupCache = {};

    pendingCdsl.matches.forEach((m) => {
      if (!m.checked) return;
      const h = m.kind === "class" ? findHolding(m.parentId, m.holdingId) : findOtherHolding(m.parentId, m.holdingId);
      if (h) {
        h.currentValue = m.newValue;
        if (!h.isin) h.isin = m.isin;
        if (m.newUnits > 0) h.units = m.newUnits; // feeds the live-price refresh (value = units × price)
        updatedCount++;
      }
    });

    pendingCdsl.newEntries.forEach((e) => {
      if (!e.checked || !e.classChoice) return;
      const choice = e.classChoice;

      if (choice === "__new_class__" || choice === "__new_other__") {
        const name = (e.newClassName || "").trim();
        if (!name) return;
        const key = choice + ":" + name.toLowerCase();
        let target = newGroupCache[key];
        if (!target) {
          if (choice === "__new_class__") {
            target = state.assetClasses.find((ac) => ac.name.toLowerCase() === name.toLowerCase());
            if (!target) {
              target = { id: uid("ac"), name, targetPct: 0, holdings: [] };
              state.assetClasses.push(target);
            }
          } else {
            target = state.otherAssets.find((o) => Array.isArray(o.holdings) && o.name.toLowerCase() === name.toLowerCase());
            if (!target) {
              target = { id: uid("o"), name, monthlyContribution: 0, holdings: [] };
              state.otherAssets.push(target);
            }
          }
          expanded.add(target.id);
          newGroupCache[key] = target;
        }
        target.holdings.push(choice === "__new_class__"
          ? { id: uid("h"), name: e.description, currentValue: e.value, sipPct: 0, isin: e.isin, units: e.units > 0 ? e.units : null }
          : { id: uid("oh"), name: e.description, currentValue: e.value, isin: e.isin, units: e.units > 0 ? e.units : null });
        addedCount++;
      } else if (choice.startsWith("class:")) {
        const targetClass = findClass(choice.slice(6));
        if (!targetClass) return;
        targetClass.holdings.push({ id: uid("h"), name: e.description, currentValue: e.value, sipPct: 0, isin: e.isin, units: e.units > 0 ? e.units : null });
        addedCount++;
      } else if (choice.startsWith("other:")) {
        const targetGroup = findOther(choice.slice(6));
        if (!targetGroup || !Array.isArray(targetGroup.holdings)) return;
        targetGroup.holdings.push({ id: uid("oh"), name: e.description, currentValue: e.value, isin: e.isin, units: e.units > 0 ? e.units : null });
        addedCount++;
      }
    });

    persist();
    renderAll();
    closeCdslModal();
    toast("CDSL sync applied: " + updatedCount + " holding(s) updated, " + addedCount + " added.");
  }

  function handleCdslFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const { demat, mf } = parseCdslStatement(String(e.target.result));
        const agg = aggregateByIsin(demat, mf);
        if (agg.length === 0) {
          toast("No holdings with non-zero value found in this statement.");
          return;
        }
        pendingCdsl = buildCdslProposals(agg);
        openCdslModal();
      } catch (err) {
        toast("Could not parse CDSL statement: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  // ---------- live prices ----------
  // Two independent sources, chosen per holding:
  //   "mf"    -> api.mfapi.in (AMFI NAVs; CORS-open, keyless, works with zero setup)
  //   "stock" -> the user's own Cloudflare Worker relay (worker/price-proxy.js) in front of
  //              Yahoo Finance — needed because Yahoo blocks direct browser (CORS) requests.
  //              Covers NSE (.NS) / BSE (.BO) / US tickers plus the USDINR=X rate used to
  //              convert USD-quoted holdings into ₹.
  const MFAPI_BASE = "https://api.mfapi.in";
  let mfListCache = null; // full AMFI scheme list (~few MB) — kept in memory only, never persisted

  function workerBase() {
    return (state.priceWorkerUrl || "").trim().replace(/\/+$/, "");
  }

  async function fetchJson(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return resp.json();
  }

  async function fetchMfList() {
    if (!mfListCache) mfListCache = await fetchJson(MFAPI_BASE + "/mf");
    return mfListCache;
  }

  async function fetchMfNav(schemeCode) {
    const j = await fetchJson(MFAPI_BASE + "/mf/" + encodeURIComponent(schemeCode) + "/latest");
    const row = j && j.data && j.data[0];
    const nav = row && parseFloat(row.nav);
    if (!nav || !isFinite(nav)) throw new Error("no NAV published");
    return { price: nav, currency: "INR" };
  }

  async function fetchStockQuotes(symbols) {
    const base = workerBase();
    if (!base) throw new Error("no-worker");
    return fetchJson(base + "/quote?symbols=" + encodeURIComponent(symbols.join(",")));
  }

  // Every holding across both tables, with enough context to find it again.
  function allHoldingRefsForPrices() {
    const refs = [];
    state.assetClasses.forEach((ac) => ac.holdings.forEach((h) => refs.push({ h, kind: "class", parentId: ac.id })));
    state.otherAssets.forEach((o) => {
      if (Array.isArray(o.holdings)) o.holdings.forEach((h) => refs.push({ h, kind: "other", parentId: o.id }));
    });
    return refs;
  }

  function findHoldingByKind(kind, parentId, id) {
    return kind === "class" ? findHolding(parentId, id) : findOtherHolding(parentId, id);
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  async function refreshPrices() {
    const btn = document.getElementById("btnRefreshPrices");
    const linked = allHoldingRefsForPrices().filter((r) => isPriceLinked(r.h));
    if (linked.length === 0) {
      toast("No holdings linked yet — use the ₹ button on a holding row to link one.");
      return;
    }
    btn.disabled = true;
    const oldLabel = btn.textContent;
    btn.textContent = "Refreshing…";
    try {
      const failures = [];
      const ready = [];
      linked.forEach((r) => {
        if (Number(r.h.units) > 0) ready.push(r);
        else failures.push({ name: r.h.name, reason: "no units set" });
      });

      // Mutual funds: one mfapi call per unique scheme code.
      const mfRefs = ready.filter((r) => r.h.priceSource === "mf");
      const mfCodes = [...new Set(mfRefs.map((r) => String(r.h.symbol)))];
      const mfResults = {};
      await Promise.all(mfCodes.map(async (code) => {
        try { mfResults[code] = await fetchMfNav(code); }
        catch (e) { mfResults[code] = { error: e.message }; }
      }));

      // Stocks: one Worker call for all unique symbols, plus USDINR=X for ₹ conversion.
      const stockRefs = ready.filter((r) => r.h.priceSource === "stock");
      let stockResults = {};
      let workerError = null;
      if (stockRefs.length > 0) {
        const symbols = [...new Set(stockRefs.map((r) => String(r.h.symbol)))];
        try {
          stockResults = await fetchStockQuotes(symbols.concat("USDINR=X"));
        } catch (e) {
          workerError = e.message === "no-worker"
            ? "Worker not set up (Data ▾ → Live Price Settings)"
            : "Worker request failed: " + e.message;
        }
      }
      const fxQuote = stockResults["USDINR=X"];
      const usdInr = fxQuote && !fxQuote.error ? fxQuote.price : null;

      let updated = 0;
      const now = new Date().toISOString();
      ready.forEach((r) => {
        const h = r.h;
        let quote;
        if (h.priceSource === "mf") {
          quote = mfResults[String(h.symbol)];
        } else if (workerError) {
          failures.push({ name: h.name, reason: workerError });
          return;
        } else {
          quote = stockResults[String(h.symbol)];
        }
        if (!quote || quote.error) {
          failures.push({ name: h.name, reason: (quote && quote.error) || "no data" });
          return;
        }
        let fx = 1;
        if (quote.currency && quote.currency !== "INR") {
          if (quote.currency === "USD" && usdInr) fx = usdInr;
          else { failures.push({ name: h.name, reason: usdInr ? "unsupported currency " + quote.currency : "USD→INR rate unavailable" }); return; }
        }
        h.lastPrice = quote.price;
        h.lastPriceCurrency = quote.currency || "INR";
        h.lastPriceAt = now;
        h.currentValue = round2(Number(h.units) * quote.price * fx);
        updated++;
      });

      if (updated > 0) { persist(); renderAll(); }
      let msg = "Prices refreshed: " + updated + " holding(s) updated";
      if (failures.length > 0) msg += ", " + failures.length + " failed (" + failures[0].name + ": " + failures[0].reason + (failures.length > 1 ? ", …" : "") + ")";
      toast(msg + ".");
    } finally {
      btn.disabled = false;
      btn.textContent = oldLabel;
    }
  }

  // Bulk-link mutual funds using the ISINs a CDSL import stamped on holdings: the full
  // mfapi scheme list carries each scheme's growth/reinvestment ISINs, so no typing needed.
  async function autoLinkMfByIsin() {
    const candidates = allHoldingRefsForPrices().filter((r) => r.h.isin && !isPriceLinked(r.h));
    if (candidates.length === 0) {
      toast("Nothing to auto-link: every holding with an ISIN is already linked (or none has an ISIN — import a CDSL statement first).");
      return;
    }
    toast("Downloading AMFI scheme list… this takes a few seconds.");
    let list;
    try { list = await fetchMfList(); }
    catch (e) { toast("Could not download the scheme list (" + e.message + "). Check your connection and try again."); return; }
    const byIsin = new Map();
    list.forEach((s) => {
      if (s.isinGrowth) byIsin.set(String(s.isinGrowth).trim().toUpperCase(), s);
      if (s.isinDivReinvestment) byIsin.set(String(s.isinDivReinvestment).trim().toUpperCase(), s);
    });
    let linkedCount = 0;
    let missingUnits = 0;
    candidates.forEach((r) => {
      const scheme = byIsin.get(String(r.h.isin).trim().toUpperCase());
      if (!scheme) return;
      r.h.priceSource = "mf";
      r.h.symbol = String(scheme.schemeCode);
      r.h.symbolName = scheme.schemeName;
      linkedCount++;
      if (!(Number(r.h.units) > 0)) missingUnits++;
    });
    if (linkedCount === 0) {
      toast("No matches found — the ISINs on your holdings don't appear in the AMFI mutual fund list (stocks/bonds need the ₹ button instead).");
      return;
    }
    persist();
    renderAll();
    let msg = "Auto-linked " + linkedCount + " mutual fund(s) by ISIN.";
    if (missingUnits > 0) msg += " " + missingUnits + " of them have no units yet — re-import your CDSL statement or set units via the ₹ button.";
    toast(msg);
  }

  // ---------- link-price modal ----------
  let pendingPriceLink = null; // { kind, parentId, holdingId, chosenScheme: {code, name} | null }

  function openPriceLinkModal(kind, parentId, holdingId) {
    const h = findHoldingByKind(kind, parentId, holdingId);
    if (!h) return;
    pendingPriceLink = { kind, parentId, holdingId, chosenScheme: null };
    document.getElementById("plHoldingName").textContent = h.name;
    document.getElementById("plSource").value = h.priceSource || "";
    document.getElementById("plUnits").value = Number(h.units) > 0 ? h.units : "";
    document.getElementById("plMfSearch").value = h.priceSource === "mf" && h.symbolName ? h.symbolName : h.name;
    document.getElementById("plMfResults").innerHTML = "";
    document.getElementById("plMfResults").style.display = "none";
    document.getElementById("plStockSymbol").value = h.priceSource === "stock" ? h.symbol : "";
    document.getElementById("plTestResult").textContent = "";
    document.getElementById("plTestResult").className = "pl-test-result";
    if (h.priceSource === "mf" && h.symbol) {
      pendingPriceLink.chosenScheme = { code: String(h.symbol), name: h.symbolName || ("Scheme " + h.symbol) };
    }
    updatePriceLinkBlocks();
    document.getElementById("priceLinkBackdrop").classList.add("show");
  }

  function updatePriceLinkBlocks() {
    const source = document.getElementById("plSource").value;
    document.getElementById("plMfBlock").style.display = source === "mf" ? "" : "none";
    document.getElementById("plStockBlock").style.display = source === "stock" ? "" : "none";
    document.getElementById("plUnitsRow").style.display = source ? "" : "none";
    const chosenEl = document.getElementById("plMfChosen");
    const chosen = pendingPriceLink && pendingPriceLink.chosenScheme;
    chosenEl.textContent = chosen ? "✓ " + chosen.name : "";
  }

  async function searchMfSchemes() {
    const q = document.getElementById("plMfSearch").value.trim();
    if (!q) return;
    const resultsEl = document.getElementById("plMfResults");
    resultsEl.style.display = "";
    resultsEl.innerHTML = '<div class="pl-result" style="cursor:default;color:var(--muted);">Searching…</div>';
    let results;
    try { results = await fetchJson(MFAPI_BASE + "/mf/search?q=" + encodeURIComponent(q)); }
    catch (e) {
      resultsEl.innerHTML = '<div class="pl-result" style="cursor:default;color:var(--red);">Search failed (' + escapeHtml(e.message) + "). Check your connection.</div>";
      return;
    }
    if (!Array.isArray(results) || results.length === 0) {
      resultsEl.innerHTML = '<div class="pl-result" style="cursor:default;color:var(--muted);">No schemes matched — try fewer words (e.g. drop “fund”/“plan”).</div>';
      return;
    }
    resultsEl.innerHTML = results.slice(0, 20).map((s) =>
      '<label class="pl-result"><input type="radio" name="plScheme" value="' + s.schemeCode + '" data-name="' + escapeAttr(s.schemeName) + '"><span>' + escapeHtml(s.schemeName) + "</span></label>"
    ).join("");
  }

  async function testStockSymbol() {
    const sym = document.getElementById("plStockSymbol").value.trim().toUpperCase();
    const out = document.getElementById("plTestResult");
    out.className = "pl-test-result";
    if (!sym) { out.textContent = "Enter a symbol first."; return; }
    if (!workerBase()) {
      out.className = "pl-test-result err";
      out.textContent = "Set up the Worker first: Data ▾ → Live Price Settings.";
      return;
    }
    out.textContent = "Fetching…";
    try {
      const res = await fetchStockQuotes([sym]);
      const q = res[sym];
      if (!q || q.error) throw new Error((q && q.error) || "no data");
      out.className = "pl-test-result ok";
      out.textContent = "✓ " + (q.name || sym) + ": " + q.price + " " + (q.currency || "");
    } catch (e) {
      out.className = "pl-test-result err";
      out.textContent = "✗ " + e.message;
    }
  }

  function savePriceLink() {
    if (!pendingPriceLink) return;
    const h = findHoldingByKind(pendingPriceLink.kind, pendingPriceLink.parentId, pendingPriceLink.holdingId);
    if (!h) return;
    const source = document.getElementById("plSource").value;

    if (!source) {
      h.priceSource = null; h.symbol = null; h.symbolName = null;
      h.lastPrice = null; h.lastPriceCurrency = null; h.lastPriceAt = null;
      persist(); renderAll();
      document.getElementById("priceLinkBackdrop").classList.remove("show");
      toast("Live price unlinked — the value is manual again.");
      return;
    }

    const units = parseFloat(document.getElementById("plUnits").value);
    if (!(units > 0)) { toast("Enter the number of units you hold (must be more than 0)."); return; }

    if (source === "mf") {
      const chosen = pendingPriceLink.chosenScheme;
      if (!chosen) { toast("Search and pick the mutual fund scheme first."); return; }
      h.symbol = String(chosen.code);
      h.symbolName = chosen.name;
    } else {
      const sym = document.getElementById("plStockSymbol").value.trim().toUpperCase();
      if (!sym) { toast("Enter the ticker symbol (e.g. RELIANCE.NS or AAPL)."); return; }
      h.symbol = sym;
      h.symbolName = sym;
    }
    // Clear any cached quote from a previous link — it belonged to the old symbol.
    h.priceSource = source;
    h.units = units;
    h.lastPrice = null; h.lastPriceCurrency = null; h.lastPriceAt = null;
    persist(); renderAll();
    document.getElementById("priceLinkBackdrop").classList.remove("show");
    toast("Linked. Use ↻ Refresh Prices to fetch the latest value.");
  }

  // ---------- price settings modal ----------
  function openPriceSettings() {
    document.getElementById("psWorkerUrl").value = state.priceWorkerUrl || "";
    const out = document.getElementById("psTestResult");
    out.textContent = "";
    out.className = "pl-test-result";
    document.getElementById("priceSettingsBackdrop").classList.add("show");
  }

  async function testWorkerConnection() {
    const url = document.getElementById("psWorkerUrl").value.trim().replace(/\/+$/, "");
    const out = document.getElementById("psTestResult");
    out.className = "pl-test-result";
    if (!url) { out.textContent = "Enter your Worker URL first."; return; }
    out.textContent = "Testing…";
    try {
      const j = await fetchJson(url + "/");
      if (j && j.ok && j.service === "fintrack-price-proxy") {
        out.className = "pl-test-result ok";
        out.textContent = "✓ Connected — the Worker is up and ready.";
      } else {
        throw new Error("that URL responded, but not like the FinTrack price proxy");
      }
    } catch (e) {
      out.className = "pl-test-result err";
      out.textContent = "✗ " + e.message;
    }
  }

  function savePriceSettings() {
    state.priceWorkerUrl = document.getElementById("psWorkerUrl").value.trim().replace(/\/+$/, "");
    persist();
    document.getElementById("priceSettingsBackdrop").classList.remove("show");
    toast(state.priceWorkerUrl ? "Worker URL saved — stock quotes are enabled." : "Worker URL cleared — only mutual fund NAVs will refresh.");
  }

  // ---------- event wiring ----------
  document.addEventListener("DOMContentLoaded", () => {
    if (migrated) {
      persist();
    }
    renderAll();
    if (migrated) {
      toast("Moved \"Bonds\" out of Asset Allocation into Other Assets — it no longer affects target %/deviation.");
    }

    // Toolbar dropdown menus (Import / Export): toggle on the button, close on any other click —
    // including a click on one of the menu's own items, so picking an action closes the menu
    // too, since that click bubbles to this same document-level listener after the item's own
    // handler has already run. Mirrors tracker.js's identical pattern for the Ledger page.
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

    document.getElementById("btnImport").addEventListener("click", () => document.getElementById("fileInput").click());
    document.getElementById("fileInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handleImportFile(file);
      e.target.value = "";
    });

    document.getElementById("btnTemplate").addEventListener("click", () => {
      exportCSV(seedData(), "FinTrack_Template.csv");
      toast("Template downloaded — edit in Excel/Sheets and re-import.");
    });
    document.getElementById("btnExportCsv").addEventListener("click", () => {
      exportCSV(state, "FinTrack_Portfolio_" + todayStr() + ".csv");
      toast("CSV exported.");
    });
    document.getElementById("btnExportXlsx").addEventListener("click", () => {
      exportXLSX(state, "FinTrack_Portfolio_" + todayStr() + ".xlsx");
      toast("Excel file exported.");
    });

    document.getElementById("btnCdsl").addEventListener("click", () => document.getElementById("cdslFileInput").click());
    document.getElementById("cdslFileInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handleCdslFile(file);
      e.target.value = "";
    });
    document.getElementById("cdslCancel").addEventListener("click", closeCdslModal);
    document.getElementById("cdslApply").addEventListener("click", applyCdslSync);
    document.getElementById("cdslModalBody").addEventListener("change", (e) => {
      const t = e.target;
      const list = t.dataset.list;
      if (!list) return;
      const arr = list === "match" ? pendingCdsl.matches : pendingCdsl.newEntries;
      const item = arr[Number(t.dataset.index)];
      if (!item) return;
      if (t.dataset.field === "checked") item.checked = t.checked;
      else if (t.dataset.field === "classChoice") item.classChoice = t.value;
      else if (t.dataset.field === "newClassName") item.newClassName = t.value;
      renderCdslModal();
    });

    document.getElementById("btnSample").addEventListener("click", async () => {
      const ok = await confirmDialog("Load sample portfolio?", "This replaces your current data with the sample portfolio (matching the reference sheet). Export a backup first if needed.");
      if (!ok) return;
      const preservedTracker = state.dailyTracker;
      const preservedWorkerUrl = state.priceWorkerUrl;
      state = seedData();
      if (preservedTracker !== undefined) state.dailyTracker = preservedTracker;
      if (preservedWorkerUrl) state.priceWorkerUrl = preservedWorkerUrl;
      expanded = new Set();
      persist();
      renderAll();
      toast("Sample portfolio loaded.");
    });

    document.getElementById("btnReset").addEventListener("click", async () => {
      const ok = await confirmDialog("Reset all data?", "This permanently clears all asset classes, holdings and other assets. This cannot be undone.");
      if (!ok) return;
      const preservedTracker = state.dailyTracker;
      const preservedWorkerUrl = state.priceWorkerUrl;
      state = emptyData();
      if (preservedTracker !== undefined) state.dailyTracker = preservedTracker;
      if (preservedWorkerUrl) state.priceWorkerUrl = preservedWorkerUrl;
      expanded = new Set();
      persist();
      renderAll();
      toast("All data cleared.");
    });

    // Live prices: toolbar + link modal + settings modal.
    document.getElementById("btnRefreshPrices").addEventListener("click", refreshPrices);
    document.getElementById("btnAutoLinkMf").addEventListener("click", autoLinkMfByIsin);
    document.getElementById("btnPriceSettings").addEventListener("click", openPriceSettings);
    document.getElementById("plSource").addEventListener("change", updatePriceLinkBlocks);
    document.getElementById("plMfSearchBtn").addEventListener("click", searchMfSchemes);
    document.getElementById("plMfSearch").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); searchMfSchemes(); }
    });
    document.getElementById("plMfResults").addEventListener("change", (e) => {
      if (e.target.name === "plScheme" && pendingPriceLink) {
        pendingPriceLink.chosenScheme = { code: e.target.value, name: e.target.dataset.name };
        updatePriceLinkBlocks();
      }
    });
    document.getElementById("plTestBtn").addEventListener("click", testStockSymbol);
    document.getElementById("plCancel").addEventListener("click", () => document.getElementById("priceLinkBackdrop").classList.remove("show"));
    document.getElementById("plSave").addEventListener("click", savePriceLink);
    document.getElementById("psTestBtn").addEventListener("click", testWorkerConnection);
    document.getElementById("psCancel").addEventListener("click", () => document.getElementById("priceSettingsBackdrop").classList.remove("show"));
    document.getElementById("psSave").addEventListener("click", savePriceSettings);

    // Enter commits an edit the same way clicking away does — blur() triggers the existing
    // "change" handler below rather than duplicating its logic.
    document.body.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.classList.contains("cell-input")) {
        e.preventDefault();
        e.target.blur();
      }
    });

    // delegated change events for editable cells
    document.body.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.field) {
        updateField(t.dataset, t.value);
      }
    });

    // delegated click events (row toggles, add/delete buttons)
    document.body.addEventListener("click", async (e) => {
      const toggleRow = e.target.closest("[data-toggle]");
      const actionEl = e.target.closest("[data-action]");

      if (actionEl) {
        const action = actionEl.dataset.action;

        if (action === "link-price") {
          openPriceLinkModal(actionEl.dataset.kind, actionEl.dataset.parent, actionEl.dataset.id);
          return;
        }
        if (action === "add-class") {
          const name = document.getElementById("newClassName").value.trim();
          const target = parseFloat(document.getElementById("newClassTarget").value) || 0;
          if (!name) { toast("Enter a name for the new asset class."); return; }
          const ac = { id: uid("ac"), name, targetPct: target, manualSipPct: target, holdings: [] };
          state.assetClasses.push(ac);
          expanded.add(ac.id);
          persist(); renderAll();
          return;
        }
        if (action === "add-holding") {
          const parent = actionEl.dataset.parent;
          const nameEl = document.getElementById("newHoldingName_" + parent);
          const valueEl = document.getElementById("newHoldingValue_" + parent);
          const sipEl = document.getElementById("newHoldingSip_" + parent);
          const name = nameEl.value.trim();
          if (!name) { toast("Enter a name for the new holding."); return; }
          const ac = findClass(parent);
          if (ac) ac.holdings.push({ id: uid("h"), name, currentValue: parseFloat(valueEl.value) || 0, sipPct: parseFloat(sipEl.value) || 0, isin: null });
          persist(); renderAll();
          return;
        }
        if (action === "add-other") {
          const name = document.getElementById("newOtherName").value.trim();
          const value = parseFloat(document.getElementById("newOtherValue").value) || 0;
          const monthly = parseFloat(document.getElementById("newOtherMonthly").value) || 0;
          if (!name) { toast("Enter a name for the new item."); return; }
          state.otherAssets.push({ id: uid("o"), name, currentValue: value, monthlyContribution: monthly });
          persist(); renderAll();
          return;
        }
        if (action === "add-other-group") {
          const name = document.getElementById("newOtherGroupName").value.trim();
          if (!name) { toast("Enter a name for the new subsection."); return; }
          const og = { id: uid("o"), name, monthlyContribution: 0, holdings: [] };
          state.otherAssets.push(og);
          expanded.add(og.id);
          persist(); renderAll();
          return;
        }
        if (action === "add-other-holding") {
          const parent = actionEl.dataset.parent;
          const nameEl = document.getElementById("newOtherHoldingName_" + parent);
          const valueEl = document.getElementById("newOtherHoldingValue_" + parent);
          const name = nameEl.value.trim();
          if (!name) { toast("Enter a name for the new item."); return; }
          const og = findOther(parent);
          if (og && Array.isArray(og.holdings)) og.holdings.push({ id: uid("oh"), name, currentValue: parseFloat(valueEl.value) || 0, isin: null });
          persist(); renderAll();
          return;
        }
        if (action === "delete-other-holding") {
          const og = findOther(actionEl.dataset.parent);
          if (og && Array.isArray(og.holdings)) og.holdings = og.holdings.filter((h) => h.id !== actionEl.dataset.id);
          persist(); renderAll();
          return;
        }
        if (action === "delete-class") {
          const ok = await confirmDialog("Delete asset class?", "This removes the class and all its holdings.");
          if (!ok) return;
          state.assetClasses = state.assetClasses.filter((a) => a.id !== actionEl.dataset.id);
          persist(); renderAll();
          return;
        }
        if (action === "delete-holding") {
          const ac = findClass(actionEl.dataset.parent);
          if (ac) ac.holdings = ac.holdings.filter((h) => h.id !== actionEl.dataset.id);
          persist(); renderAll();
          return;
        }
        if (action === "delete-other") {
          const ok = await confirmDialog("Delete item?", "This removes it (and any items inside it) from your other assets.");
          if (!ok) return;
          state.otherAssets = state.otherAssets.filter((o) => o.id !== actionEl.dataset.id);
          persist(); renderAll();
          return;
        }
        if (action === "move-class-to-other") {
          const ac = findClass(actionEl.dataset.id);
          if (!ac) return;
          const ok = await confirmDialog(
            "Move to Other Assets?",
            "\"" + ac.name + "\" will become an Other Assets subsection. Its Target % and per-holding SIP % settings will be lost — Other Assets items don't have those.",
            "Move", "Cancel", false
          );
          if (!ok) return;
          state.assetClasses = state.assetClasses.filter((a) => a.id !== ac.id);
          const newGroup = {
            id: uid("o"), name: ac.name, monthlyContribution: 0,
            holdings: ac.holdings.map((h) => ({ id: uid("oh"), name: h.name, currentValue: h.currentValue, isin: h.isin || null }))
          };
          state.otherAssets.push(newGroup);
          expanded.delete(ac.id);
          expanded.add(newGroup.id);
          persist(); renderAll();
          toast("Moved \"" + ac.name + "\" to Other Assets.");
          return;
        }
        if (action === "move-other-to-class") {
          const o = findOther(actionEl.dataset.id);
          if (!o) return;
          const isGroup = Array.isArray(o.holdings);
          const ok = await confirmDialog(
            "Move to Asset Allocation?",
            "\"" + o.name + "\" will become an Asset Allocation class" + (isGroup ? "" : " with one holding matching its current value") + ", with Target % starting at 0% — set it afterward.",
            "Move", "Cancel", false
          );
          if (!ok) return;
          state.otherAssets = state.otherAssets.filter((x) => x.id !== o.id);
          const newClass = {
            id: uid("ac"), name: o.name, targetPct: 0, manualSipPct: 0,
            holdings: isGroup
              ? o.holdings.map((h) => ({ id: uid("h"), name: h.name, currentValue: h.currentValue, sipPct: 0, isin: h.isin || null }))
              : [{ id: uid("h"), name: o.name, currentValue: o.currentValue, sipPct: 100, isin: null }]
          };
          state.assetClasses.push(newClass);
          expanded.delete(o.id);
          expanded.add(newClass.id);
          persist(); renderAll();
          toast("Moved \"" + o.name + "\" to Asset Allocation — set its Target %.");
          return;
        }
        if (action === "expand-all-classes") {
          state.assetClasses.forEach((ac) => expanded.add(ac.id));
          renderAll();
          return;
        }
        if (action === "collapse-all-classes") {
          state.assetClasses.forEach((ac) => expanded.delete(ac.id));
          renderAll();
          return;
        }
        if (action === "expand-all-other") {
          state.otherAssets.forEach((o) => { if (Array.isArray(o.holdings)) expanded.add(o.id); });
          renderAll();
          return;
        }
        if (action === "collapse-all-other") {
          state.otherAssets.forEach((o) => { if (Array.isArray(o.holdings)) expanded.delete(o.id); });
          renderAll();
          return;
        }
        return;
      }

      if (toggleRow) {
        const id = toggleRow.dataset.toggle;
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        renderAll();
      }
    });
  });

  // ---------- bridge for optional drive-sync.js (loaded after this script, if present) ----------
  // Cloud sync is an entirely separate, optional module — see drive-sync.js. It talks to this
  // app only through this object, so the offline app works identically whether or not that
  // script is loaded (e.g. it's never loaded when opened via file://).
  window.fintrack = {
    getState: () => state,
    setState: (s) => { state = s; },
    persist,
    renderAll,
    toast,
    confirmDialog,
    allGroupIds,
    getExpanded: () => expanded,
    setExpanded: (s) => { expanded = s; }
  };
})();
