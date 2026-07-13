/* FinTrack — shared theme (light / dark / system) toggle. Loaded by every page.
   Fully self-contained: wires its own #btnThemeToggle click handler and applies any saved
   preference on load, so a page only needs the button markup and this script tag.

   Pages that render charts should set window.onThemeChange = fn (any time — this only reads
   it lazily, when the user actually changes theme, which can't happen before the page is
   interactive). Chart.js bakes colors in at creation time rather than reading CSS, so it needs
   an explicit redraw on theme change; everything else on the page updates for free via CSS
   custom properties. */

(function () {
  "use strict";

  const THEME_KEY = "fintrack_theme";
  const THEME_COLORS = { light: "#4338ca", dark: "#9089f5" };
  const THEME_ICONS = { system: "🌓", light: "☀️", dark: "🌙" };
  const THEME_LABELS = { system: "Match system", light: "Light", dark: "Dark" };

  function safeGetTheme() { try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; } }
  function safeSetTheme(v) { try { localStorage.setItem(THEME_KEY, v); } catch (e) { /* ignore */ } }

  function resolvedTheme(pref) {
    if (pref === "light" || pref === "dark") return pref;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme(pref) {
    const root = document.documentElement;
    if (pref === "light" || pref === "dark") root.setAttribute("data-theme", pref);
    else root.removeAttribute("data-theme");

    const meta = document.getElementById("themeColorMeta");
    if (meta) meta.setAttribute("content", THEME_COLORS[resolvedTheme(pref)]);

    const btn = document.getElementById("btnThemeToggle");
    if (btn) {
      btn.textContent = THEME_ICONS[pref];
      btn.title = "Theme: " + THEME_LABELS[pref] + " (click to change)";
    }
    if (typeof window.onThemeChange === "function") window.onThemeChange();
  }

  function cycleTheme() {
    const order = ["system", "light", "dark"];
    const current = safeGetTheme() || "system";
    const next = order[(order.indexOf(current) + 1) % order.length];
    safeSetTheme(next);
    applyTheme(next);
  }

  function initTheme() {
    applyTheme(safeGetTheme() || "system");
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if ((safeGetTheme() || "system") === "system") applyTheme("system");
      });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    const btn = document.getElementById("btnThemeToggle");
    if (btn) btn.addEventListener("click", cycleTheme);
  });
})();
