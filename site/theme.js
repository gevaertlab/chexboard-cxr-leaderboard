/* ──────────────────────────────────────────────────────────────────────────
   Colour theme. "auto" follows the operating system's light/dark setting;
   "light" and "dark" are the visitor's override from the switch in the top nav,
   kept in localStorage. Loaded from <head> so the first paint already has the
   right theme: style.css keys its dark tokens off <html data-theme="dark">, and
   app.js redraws the open chart on the "themechange" event.
   ────────────────────────────────────────────────────────────────────────── */
"use strict";
(() => {
  const KEY = "chexboard-theme";
  const os = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
  let pref = "auto";
  // storage can be blocked (private windows, embedded previews); fall back to auto
  try { const v = localStorage.getItem(KEY); if (v === "light" || v === "dark") pref = v; } catch (e) {}

  const resolved = () => pref === "dark" || (pref === "auto" && !!os && os.matches);
  function paint(dark) {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    // browser toolbar colour on mobile; both media-specific tags get the resolved value
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = dark ? "#141619" : "#0b6e99"; });
    document.dispatchEvent(new Event("themechange"));
  }
  const apply = () => paint(resolved());

  window.Theme = {
    get pref() { return pref; },
    set(p) {
      pref = p;
      try { if (p === "auto") localStorage.removeItem(KEY); else localStorage.setItem(KEY, p); } catch (e) {}
      apply();
    },
  };
  if (os && os.addEventListener) os.addEventListener("change", () => { if (pref === "auto") apply(); });
  // paper is white and browsers drop background colours when printing, so print
  // with the light tokens and light charts, then restore
  window.addEventListener("beforeprint", () => { if (resolved()) paint(false); });
  window.addEventListener("afterprint", () => { if (resolved()) paint(true); });
  apply();
})();
