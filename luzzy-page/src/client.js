// LuzzyPage — the third entry in the conversation view ring, beside Chat and Trajectory.
//
// Two sub-pages inside one view:
//   1. README   — this plugin's README.md, rendered as Markdown
//   2. Usage    — token usage over the local session logs
//
// Source of truth for this file. tools/build-font-css.py scans it (plus README.md) for
// non-ASCII characters, subsets the CJK face to exactly that set, inlines every font as
// base64 into the placeholder below, and writes the result to lib/client.js.
//
// WHY THE PAGE LIVES IN AN IFRAME (this is the third architecture, and the one that works):
//
//   Attempt 1 — React component with hooks via `require('react')`:
//     React error #321 (invalid hook call). The host renderer runs its OWN inlined React;
//     the static module table holds a DIFFERENT copy, so hooks called from the copy inside
//     a renderer-owned tree throw, and the slot error boundary replaces the page with an
//     empty div — a silent blank view.
//
//   Attempt 2 — hooks-free React component with a slot store:
//     `TypeError: useStore is not a function`. The store share did not reach the props of a
//     `conversation.view` entry, so the sanctioned state channel was simply absent.
//
//   Attempt 3 — this file. The slot entry renders ONE <iframe>. Inside the frame is a
//     self-contained document: its own CSS, its own vanilla JS, zero React, zero hooks,
//     zero framework state. The outer component is a pure function that returns an element.
//     Nothing about the host's React internals can break it.
//
// Data still comes from the host's own routes (verified reachable: the renderer's fetch
// lands in the host — see the flight recorder below), and the frame talks to them directly.
//
// Register through `ctx.effect` / `ctx.slots.inject` so unload rolls back.

window.__ModuleLoader__.load({
  // This id MUST be the package name: after the bundle executes, the loader checks
  // factories.has(<graph row id>) where the row id is the package name. The patch
  // layer's `id` (luzzy-page) is a different namespace and must not be used here.
  id: 'dsh-luzzy-page',
  factory: (require) => {
    // Flight recorder: each stage reports separately, so a blank page is diagnosable from
    // the host's diag directory rather than guessed at.
    const ping = (stage, detail) => {
      try {
        fetch('/__luzzy/diag', {
          method: 'POST',
          body: JSON.stringify({ stage, detail: detail ?? null, at: Date.now() }),
        }).catch(() => {})
      } catch {}
    }
    ping('bundle-executed')

    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const { jsx } = require('react/jsx-runtime')
    ping('requires-ok')

    const NS = 'luzzy-page'

    const zh = {
      'view.luzzy': 'LuzzyPage',
      'frame.title': 'LuzzyPage',
    }

    const en = {
      'view.luzzy': 'LuzzyPage',
      'frame.title': 'LuzzyPage',
    }

    // ---------------------------------------------------------------- the frame document

    // The inlined @font-face rules. tools/build-font-css.py replaces the placeholder below
    // with the subset fonts, base64-encoded, at build time — so the frame document embeds
    // the same typeface as everything else and needs no network.
    const FONT_FACE_CSS = `
/*__FONT_FACE_CSS__*/
`

    /**
     * The inner document. Everything the page needs lives here: styles, markdown
     * rendering, charts, and the fetch calls. No React, no host imports.
     *
     * Built as a function of the inlined font CSS so the frame shares one typeface
     * definition (and one subset) with the rest of the plugin.
     *
     * @param {string} fontFaceCss inlined @font-face rules
     * @param {'light'|'dark'} theme which token block the frame should start in
     */
    function buildFrameDocument(fontFaceCss, theme) {
      return `<!doctype html>
<html data-theme="${theme === 'dark' ? 'dark' : 'light'}"><head><meta charset="utf-8">
<style>
${fontFaceCss}

/* Theme tokens.
 *
 * An iframe is a SEPARATE DOCUMENT: CSS custom properties do NOT inherit across it, so
 * every \`var(--dsw-*)\` below would otherwise fall back to its hardcoded light value and
 * the page would stay light in dark mode. The values are therefore injected from the
 * parent (see THEME_TOKENS / buildFrameDocument) rather than inherited.
 *
 * Every name here is one the shipped frontend actually defines — verified against
 * dsh-web-frontend/dist CSS. \`--dsw-alias-bg-skeleton\` was NOT among them (it was
 * invented) and is replaced by the real \`--dsw-alias-interactive-bg-hover\`. */
:root {
  --dsw-alias-label-primary: #080808;
  --dsw-alias-label-secondary: #666666;
  --dsw-alias-label-tertiary: #999999;
  --dsw-alias-border-l2: #eeeeee;
  --dsw-alias-border-l4: #dddddd;
  --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-bg-layer-2: #f5f5f5;
  --dsw-alias-interactive-bg-hover: rgba(0, 0, 0, 0.04);
  --dsw-alias-markdown-code-block: rgba(0, 0, 0, 0.04);
  --dsw-static-deepseek-500: #4d6bfe;
  /* State colours.
   *
   * These four are the ones DSH actually ships (defined in dsh-client-ui-theme's injected
   * sheet, as --dsw-alias-state-*-primary). They replaced an earlier set of
   * \`--dsw-alias-label-error\` / \`-warning\` / \`-success\` references which **exist nowhere
   * in DSH at all** — searched the theme sheet and the frontend dist: zero definitions. All
   * nine of those references silently fell back to their hardcoded literal, so light and
   * dark rendered the SAME red/amber/green. On the dark canvas the green in particular was
   * too dim to read. Naming a token that does not exist is worse than not using one: it
   * looks tokenised and is not.
   *
   * The dark block below is not a copy of this one on purpose: DSH shifts the hue, not just
   * the lightness — error goes red-600 to red-400, business goes deepseek-500 to
   * deepseek-400. Success and warn keep their hue in both. */
  --dsw-alias-state-success-primary: #22c55e;
  --dsw-alias-state-warn-primary: #f59e0b;
  --dsw-alias-state-warn-label: #dd8629;
  --dsw-alias-state-error-primary: #ec1313;
  --dsw-alias-state-business-primary: #4176e6;
}
:root[data-theme='dark'] {
  --dsw-alias-label-primary: #ffffff;
  --dsw-alias-label-secondary: #aaaaaa;
  --dsw-alias-label-tertiary: #6f6f6f;
  --dsw-alias-border-l2: #1a1a1a;
  --dsw-alias-border-l4: #2a2a2a;
  --dsw-alias-bg-layer-1: #0d0d0d;
  --dsw-alias-bg-layer-2: #1a1a1a;
  --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.06);
  --dsw-alias-markdown-code-block: rgba(255, 255, 255, 0.06);
  --dsw-static-deepseek-500: #6b83ff;
  --dsw-alias-state-success-primary: #22c55e;
  --dsw-alias-state-warn-primary: #f59e0b;
  --dsw-alias-state-warn-label: #dd8629;
  --dsw-alias-state-error-primary: #f25a5a;
  --dsw-alias-state-business-primary: #679efe;
}

/* The page paints NO ambient colour field.
   It used to: a blue + violet radial glow behind the cards, "so the glass has something to
   refract". Three reasons it is gone:
     1. The violet was a hard-coded hex, and the design system's rule is that components read
        semantic tokens and hard-code nothing — that colour had no token behind it at all.
     2. A violet radial glow is the single most recognisable "AI product" default; the house
        style is a near-neutral canvas where colour carries state, never decoration.
     3. It could not answer "what does this communicate?". A soft blur that only makes the
        background prettier is ornament, and ornament that cannot justify itself is removed.
   The glass cards keep their backdrop-filter; they now sit on the real app background
   rather than on a painted one, which is what a translucent surface wants anyway. */

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  min-height: 100%;
  background: transparent;
}

body {
  font-family: 'Luzzy Sans', 'Luzzy PuHuiTi', system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.5714;
  color: var(--dsw-alias-label-primary, #080808);
  -webkit-font-smoothing: antialiased;
}

.page { min-height: 100vh; display: flex; flex-direction: column; }

/* ---- sub-page switch ---- */
/* \`.tabs\` is a bare row: the inner section headers use it too, and they must line up with
   the card edges. Only the outer bar carries padding. */
.tabs { display: flex; align-items: center; gap: 8px; min-width: 0; }
.topbar { padding: 16px 24px 0; }
.segment {
  display: inline-flex; align-items: center; gap: 2px; padding: 2px;
  border: 0.5px solid var(--dsw-alias-border-l2, #eee);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.02));
}
.segment button {
  height: 28px; padding: 0 12px; border: none; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary, #666);
  font: inherit; font-size: 14px; cursor: pointer;
  transition: background-color 160ms cubic-bezier(0.23,1,0.32,1);
}
.segment button:hover { color: var(--dsw-alias-label-primary, #080808); }
.segment button[aria-selected='true'] {
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #080808);
  box-shadow: 0 1px 2px rgba(0,0,0,0.06);
}
.segment button:focus-visible {
  outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: 1px;
}

.goalNoticeBar {
  position: sticky; bottom: 0; z-index: 20;
  padding: 0 24px;
  pointer-events: none;
}
.goalNoticeBar span {
  display: block; max-width: 1280px; margin: 0 auto 12px;
  padding: 8px 12px; border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l4, #ddd);
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: 0 8px 16px -4px rgba(0,0,0,0.2);
  font-size: 14px; line-height: 1.5;
  color: var(--dsw-alias-label-primary, #080808);
  overflow-wrap: anywhere;
}
.goalNoticeBar span[hidden] { display: none; }
@media (min-width: 1024px) { .goalNoticeBar { padding-left: 32px; padding-right: 32px; } }
@media (min-width: 1360px) { .goalNoticeBar { padding-left: 40px; padding-right: 40px; } }

/* ---- goal sub-page ----
 *
 * Everything here reuses the vocabulary the other tabs already established (.card, .note,
 * .status, .segment, .btn). Only three things are genuinely new and each has a reason:
 *
 *   .chip     a status badge. The design system requires state to carry a label as well as
 *             a colour, and there was no badge anywhere in the frame to reuse.
 *   .goalGrid a two-column split for the plan overview, collapsing to one column. The other
 *             tabs are single-column because their content is a list or a chart; a goal has
 *             two genuinely parallel halves (what must be true / what is being done).
 *   .rawView  the Markdown artifact, which must be monospaced and scrollable rather than
 *             rendered — its whole purpose is to show the bytes.
 */
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 8px; border-radius: 999px;
  font-size: 12px; line-height: 17px; font-weight: 500; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, #999);
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #999) 10%, transparent);
}
/* State is carried by colour AND by the word inside the chip, never by colour alone. The
   glyph is an inline SVG so it survives a font that lacks the character. */
.chip[data-state='ok'] {
  color: var(--dsw-alias-state-success-primary, #22c55e);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 10%, transparent);
}
.chip[data-state='active'] {
  color: var(--dsw-alias-state-business-primary, #4176e6);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 10%, transparent);
}
.chip[data-state='warn'] {
  color: var(--dsw-alias-state-warn-label, #dd8629);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 12%, transparent);
}
.chip[data-state='bad'] {
  color: var(--dsw-alias-state-error-primary, #ec1313);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 10%, transparent);
}
.chip svg { flex: none; }

.goalGrid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
@media (max-width: 900px) { .goalGrid { grid-template-columns: minmax(0, 1fr); } }

.goalObjective { margin: 0 0 12px; font-size: 16px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.goalMeta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.goalMetaItem { font-size: 12px; color: var(--dsw-alias-label-tertiary, #999); }

/* One list row shape shared by acceptance, tasks, evidence, decisions and blockers. Using
   one class for all of them is what keeps five sections from drifting apart visually. */
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.row {
  display: flex; gap: 8px; align-items: flex-start;
  padding: 8px 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2, #eee);
}
.row:first-child { border-top: none; }
.rowId {
  flex: none; min-width: 46px;
  font-family: ui-monospace, Consolas, monospace; font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #999); padding-top: 4px;
}
.rowBody { min-width: 0; flex: 1; }
.rowText { margin: 0; font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
.rowSub { margin: 4px 0 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #999); overflow-wrap: anywhere; }
.rowSub code {
  font-family: ui-monospace, Consolas, monospace;
  padding: 0.1em 0.35em; border-radius: 4px;
  background: var(--dsw-alias-markdown-code-block, rgba(0,0,0,0.05));
}
.rowChips { flex: none; display: flex; gap: 4px; align-items: center; padding-top: 1px; }
.rowDone .rowText { color: var(--dsw-alias-label-secondary, #666); }

.focusBox {
  padding: 12px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #f5f5f5);
  border-left: 2px solid var(--dsw-static-deepseek-500, #4d6bfe);
  font-size: 14px; line-height: 1.6; overflow-wrap: anywhere;
}
.focusBox[data-empty='true'] { color: var(--dsw-alias-label-tertiary, #999); border-left-color: var(--dsw-alias-border-l4, #ddd); }

.nextList { margin: 0; padding-left: 24px; font-size: 14px; line-height: 1.7; }
.nextList li { overflow-wrap: anywhere; }

.rawView {
  margin: 0; max-height: 520px; overflow: auto;
  padding: 12px 16px; border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l2, #eee);
  background: var(--dsw-alias-markdown-code-block, rgba(0,0,0,0.04));
  font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.6;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.goalBar {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  margin-top: 12px; padding-top: 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l2, #eee);
}
.goalBar .spacer { flex: 1; }
.proposal {
  padding: 12px; margin-bottom: 8px; border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-state-warn-primary, #f59e0b);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 8%, transparent);
}
.proposal:last-child { margin-bottom: 0; }
.proposalHead { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.proposalActions { display: flex; gap: 8px; margin-top: 8px; }

.scroll { flex: 1; overflow-y: auto; padding: 16px 24px 32px; }
/* LuzzyPage is a whole-pane view, NOT a message in the chat column — so it fills the tab
   instead of copying the chat measure (the earlier 748px cap was copied from the chat
   column and left most of the width empty). Centred, with side padding that grows at
   wider breakpoints, per DESIGN.md Layout: "Center primary content and let side padding
   grow at wider breakpoints." The cap only bites on very wide monitors. */
.column { display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 1280px; margin: 0 auto; }
@media (min-width: 1024px) {
  .scroll { padding-left: 32px; padding-right: 32px; }
  .topbar { padding-left: 32px; padding-right: 32px; }
}
@media (min-width: 1360px) {
  .scroll { padding-left: 40px; padding-right: 40px; }
  .topbar { padding-left: 40px; padding-right: 40px; }
}

/* ---- glass card ---- */
.card {
  display: flex; flex-direction: column; gap: 16px;
  padding: 16px 20px;
  border: 0.5px solid var(--dsw-alias-border-l2, #eee);
  border-radius: 12px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) 72%, transparent);
  /* The design system's own glass recipe (lobe-ui customStylish). */
  backdrop-filter: saturate(150%) blur(10px);
  -webkit-backdrop-filter: saturate(150%) blur(10px);
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
.card h2, .card h3 { margin: 0; font-size: 16px; font-weight: 700; line-height: 1.4; }
.cardHead { display: flex; align-items: center; gap: 12px; }
.spacer { flex: 1; }
.note {
  margin: 0; color: var(--dsw-alias-label-tertiary, #999);
  font-size: 12px; line-height: 1.6;
}

/* Six equal tracks gave "1051.2万" and "21" the same width, so the two narrow readouts sat in
   visibly half-empty boxes and the row looked like it had gaps in it. They are not equal facts:
   the first four are token volumes (7 digits), then a percentage, then a small count. Giving
   the volume columns the space they need and letting the narrow ones take what is left makes
   the row read as four dense figures plus two compact ones, without wrapping. */
.metrics { display: grid; grid-template-columns: repeat(4, minmax(120px, 1.5fr)) repeat(2, minmax(84px, 1fr)); gap: 12px; }
@media (max-width: 900px) { .metrics { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 560px) { .metrics { grid-template-columns: repeat(2, 1fr); } }
.metric { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.metricLabel { color: var(--dsw-alias-label-tertiary, #999); font-size: 12px; }
.metricValue {
  font-size: 20px; font-weight: 700; line-height: 1.3;
  font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
}

/* The activity strip is always one month, so the cell count is fixed (28–31) and a
   fixed 1fr track is right — auto-fill was for the old "whatever the unit produced"
   version, where the count ranged from 22 to 174. */
.activityGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14px, 1fr)); gap: 4px; }
.cell {
  width: 100%; aspect-ratio: 1 / 1; max-height: 22px;
  border-radius: 4px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.04));
}
.cell[data-level='1'] { background: color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 24%, transparent); }
.cell[data-level='2'] { background: color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 44%, transparent); }
.cell[data-level='3'] { background: color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 66%, transparent); }
.cell[data-level='4'] { background: var(--dsw-static-deepseek-500, #4d6bfe); }
/* A day that has not arrived yet is left BLANK — no fill, no border.
   The cell still occupies its track, so the row keeps the month's shape (31 days in
   September means 31 positions) while the tail simply reads as "not yet".
   An earlier version drew a dashed outline here, which made the future look like a
   distinct kind of *measured* day rather than an empty slot. */
.cellFuture { background: transparent; border: none; }
.legend {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  color: var(--dsw-alias-label-tertiary, #999); font-size: 12px;
}
.legendCells { display: inline-flex; gap: 4px; }
.legendCells .cell { width: 10px; height: 10px; aspect-ratio: auto; }

/* The chart is drawn at a fixed 720x220 viewBox and scaled by the box, so axis text stays
   proportional. preserveAspectRatio is deliberately NOT "none" here: stretching would
   distort the stroke widths and the labels along with the curves. */
.chartWrap { position: relative; }
.chart { width: 100%; height: auto; display: block; overflow: visible; }
.chartGrid { stroke: var(--dsw-alias-border-l2, #eee); stroke-width: 1; stroke-dasharray: 3 4; }
.chartAxis { fill: var(--dsw-alias-label-tertiary, #999); font-size: 12px; font-variant-numeric: tabular-nums; }
.chartAxisSub { font-size: 12px; opacity: 0.85; }

/* Entering/changing animation for the plot, so switching the window or the mode is a
   visible transition rather than an instant swap. Kept to a fade plus a short rise —
   the curves are the content, and a longer or bouncier motion would fight the reading.
   Motion is dropped entirely under prefers-reduced-motion (DESIGN.md requires that). */
@keyframes chartIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.chartWrap[data-animate] { animation: chartIn 260ms cubic-bezier(0.23, 1, 0.32, 1) both; }
@media (prefers-reduced-motion: reduce) {
  .chartWrap[data-animate] { animation: none; }
}

/* The curves and bars draw themselves in with a brief opacity fade, so a mode switch reads
   as a change of representation rather than as a flicker. */
.chartWrap[data-animate] svg.chart g > path,
.chartWrap[data-animate] svg.chart g > rect:not(.chartHit) {
  animation: chartIn 300ms cubic-bezier(0.23, 1, 0.32, 1) both;
}
@media (prefers-reduced-motion: reduce) {
  .chartWrap[data-animate] svg.chart g > path,
  .chartWrap[data-animate] svg.chart g > rect:not(.chartHit) { animation: none; }
}

/* Hover affordances. The hit rects must receive the pointer despite a transparent fill. */
.chartHit { pointer-events: all; cursor: crosshair; }
.chartGuide { stroke: var(--dsw-alias-border-l4, #ddd); stroke-width: 1; stroke-dasharray: 3 3; pointer-events: none; }
.chartDot { pointer-events: none; transition: r 120ms cubic-bezier(0.23, 1, 0.32, 1); }
@media (prefers-reduced-motion: reduce) { .chartDot { transition: none; } }
.chartWrap:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: 2px; border-radius: 8px; }

/* The tooltip. Follows the pointer, so it must not intercept it. */
.chartTip {
  position: absolute; z-index: 2; pointer-events: none;
  min-width: 168px; max-width: 260px;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-border-l2, #eee);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) 92%, transparent);
  backdrop-filter: saturate(150%) blur(10px);
  -webkit-backdrop-filter: saturate(150%) blur(10px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.10);
}
.chartTip[hidden] { display: none; }
.chartTipHead {
  display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px;
  padding-bottom: 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, #eee);
}
.chartTipTitle { font-weight: 700; font-size: 12px; white-space: nowrap; }
.chartTipTotal { color: var(--dsw-alias-label-tertiary, #999); font-size: 12px; font-variant-numeric: tabular-nums; margin-left: auto; white-space: nowrap; }
.chartTipRows { display: flex; flex-direction: column; gap: 4px; }
.chartTipRow { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: 8px; }
.chartTipRow .chartSwatch { width: 8px; height: 8px; border-radius: 4px; }
.chartTipName { font-size: 12px; color: var(--dsw-alias-label-secondary, #666); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chartTipValue { font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }

.chartLegend { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 12px; }
.chartLegendItem { display: inline-flex; align-items: center; gap: 8px; min-width: 0; font-size: 12px; }
.chartSwatch { width: 10px; height: 10px; border-radius: 4px; flex: none; }
.chartLegendName {
  color: var(--dsw-alias-label-secondary, #666);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px;
}
.chartLegendValue { color: var(--dsw-alias-label-tertiary, #999); font-variant-numeric: tabular-nums; }

.models { display: grid; grid-template-columns: minmax(170px, 220px) 1fr; gap: 20px; align-items: center; }
@media (max-width: 620px) { .models { grid-template-columns: 1fr; } }
.donutWrap { position: relative; display: grid; place-items: center; }
.donutCenter { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 2px; pointer-events: none; }
.donutTotal { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.donutCaption { color: var(--dsw-alias-label-tertiary, #999); font-size: 12px; }
.modelList { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.modelRow { display: grid; grid-template-columns: 10px minmax(0,1fr) auto auto; align-items: center; gap: 8px; min-width: 0; }
.modelSwatch { width: 10px; height: 10px; border-radius: 4px; }
.modelName { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #666); font-size: 14px; }
.modelValue, .modelShare { font-size: 14px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.modelShare { color: var(--dsw-alias-label-tertiary, #999); min-width: 44px; text-align: right; }

/* ---- status ---- */
.status {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 32px 20px; color: var(--dsw-alias-label-tertiary, #999);
  font-size: 14px; text-align: center;
}
.status button {
  height: 32px; padding: 0 14px; border: 0.5px solid var(--dsw-alias-border-l4, #ddd);
  border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary, #080808);
  font: inherit; font-size: 14px; cursor: pointer;
}
.status button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); }
/* The machine-readable half of a failure: present, collapsed, and clearly secondary. */
.statusDetail { max-width: 100%; font-size: 12px; text-align: left; }
.statusDetail summary { cursor: pointer; color: var(--dsw-alias-label-tertiary, #999); }
.statusDetail summary:hover { color: var(--dsw-alias-label-secondary, #666); }
.statusDetail code {
  display: block; margin-top: 8px; padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l2, #eee); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.03));
  font-family: ui-monospace, Consolas, monospace; font-size: 12px;
  color: var(--dsw-alias-label-secondary, #666); overflow-wrap: anywhere;
}
.skeleton {
  border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.55 } }
@media (prefers-reduced-motion: reduce) { .skeleton { animation: none } }

/* ---- markdown ---- */
/* A readable measure for long-form prose. 72ch lands in the 50–75 the design system asks for
   (and ch, not px, so it tracks the font rather than the zoom level). */
.prose { max-width: 72ch; }
.markdown { min-width: 0; overflow-wrap: anywhere; }
.markdown h1, .markdown h2, .markdown h3 { margin: 1.2em 0 0.5em; line-height: 1.35; font-weight: 700; }
.markdown h1 { font-size: 24px; margin-top: 0; }
.markdown h2 { font-size: 20px; }
.markdown h3 { font-size: 16px; }
.markdown p { margin: 0.6em 0; }
.markdown ul, .markdown ol { margin: 0.6em 0; padding-left: 1.4em; }
.markdown li { margin: 0.25em 0; }
.markdown code {
  font-family: ui-monospace, Consolas, monospace; font-size: 0.92em;
  padding: 0.15em 0.4em; border-radius: 4px;
  background: var(--dsw-alias-markdown-code-block, rgba(0,0,0,0.05));
}
.markdown pre {
  margin: 0.8em 0; padding: 12px 14px; overflow-x: auto;
  border: 0.5px solid var(--dsw-alias-border-l2, #eee); border-radius: 8px;
  background: var(--dsw-alias-markdown-code-block, rgba(0,0,0,0.03));
}
.markdown pre code { padding: 0; background: none; font-size: 12px; line-height: 1.6; }
.markdown table { border-collapse: collapse; margin: 0.8em 0; width: 100%; font-size: 14px; }
.markdown th, .markdown td {
  border: 0.5px solid var(--dsw-alias-border-l2, #eee); padding: 8px 12px; text-align: left;
}
.markdown th { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.03)); font-weight: 700; }
.markdown strong { font-weight: 700; }
.markdown hr { border: none; border-top: 0.5px solid var(--dsw-alias-border-l2, #eee); margin: 1.2em 0; }

/* ---- preset sub-page ----
   A two-column editor: the roster on the left, the selected agent's prompt on the right.
   It reuses the page's existing vocabulary (.card / .note / .status / .segment) and adds
   only what a list-plus-editor needs. Every colour is a semantic token with the same
   light-mode fallback pattern the rest of this sheet uses, so dark mode is one attribute
   change and no rule here needs its own dark variant. */
.presetLayout {
  display: grid; grid-template-columns: 320px minmax(0, 1fr);
  gap: 16px; align-items: start;
}
@media (max-width: 860px) {
  /* One column below 860px: a 320px rail plus an editor does not fit a narrow pane, and
     a horizontally scrolling roster is worse than a stacked one. */
  .presetLayout { grid-template-columns: minmax(0, 1fr); }
}

.roster { display: flex; flex-direction: column; gap: 4px; max-height: 60vh; overflow-y: auto; padding-right: 2px; }
.rosterGroup { margin-top: 12px; }
.rosterGroup:first-child { margin-top: 0; }
.rosterGroupHead {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 6px; border-radius: 6px;
  color: var(--dsw-alias-label-tertiary, #999); font-size: 12px; font-weight: 700;
}
.rosterGroupHead:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); }
.rosterGroupName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.rosterGroupCount { font-variant-numeric: tabular-nums; font-weight: 400; }

/* The group's delete affordance: hidden until the row is hovered or focused, neutral until the
   pointer is actually on the button, and dangerous only then. Three states, because a
   destructive action should not shout from every row at once — and a keyboard user must still
   be able to reach it, which is what :focus-visible covers. */
.rosterGroupDel {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-tertiary, #999);
  cursor: pointer; opacity: 0;
  transition: opacity 140ms ease, background-color 140ms ease, color 140ms ease;
}
.rosterGroupHead:hover .rosterGroupDel,
.rosterGroupDel:focus-visible { opacity: 1; }
.rosterGroupDel:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04));
  color: var(--dsw-alias-state-error-primary, #d44);
}
.rosterGroupDel:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: 1px; }
.rosterGroupDel svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }

/* Touch and keyboard-only environments have no hover, so the control must not be a ghost
   there — reveal it whenever hover cannot be relied on. */
@media (hover: none) { .rosterGroupDel { opacity: 1; } }

.rosterItem {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 8px; border: 0.5px solid transparent; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary, #666);
  font: inherit; font-size: 14px; text-align: left; cursor: pointer;
}
.rosterItem:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); }
.rosterItem[aria-selected='true'] {
  border-color: var(--dsw-alias-border-l4, #ddd);
  background: color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 10%, transparent);
  color: var(--dsw-alias-label-primary, #080808);
}
.rosterItem:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: 1px; }
/* The active agent is a different fact from the selected one: selecting edits it,
   activating makes the model use it. They are marked separately on purpose. */
.rosterItemName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rosterItemActive {
  flex: none; padding: 1px 6px; border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 22%, transparent);
  color: var(--dsw-static-deepseek-500, #4d6bfe); font-size: 12px; font-weight: 700;
}
.rosterItemHandle {
  flex: none; cursor: grab; color: var(--dsw-alias-label-tertiary, #999);
  line-height: 1; user-select: none;
  display: inline-flex; align-items: center;
}
.rosterItem[data-dragging='true'] { opacity: 0.5; }
.rosterItem[data-dropBefore='true'] { box-shadow: 0 -2px 0 0 var(--dsw-static-deepseek-500, #4d6bfe); }
.rosterItem[data-dropAfter='true'] { box-shadow: 0 2px 0 0 var(--dsw-static-deepseek-500, #4d6bfe); }
.rosterUngrouped { margin-top: 12px; }

.editor { display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 8px; }
.fieldLabel { color: var(--dsw-alias-label-tertiary, #999); font-size: 12px; }
.input, .textarea, .select {
  width: 100%; padding: 8px 12px; border: 0.5px solid var(--dsw-alias-border-l4, #ddd);
  border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #080808); font: inherit; font-size: 14px;
}
.textarea {
  min-height: 320px; resize: vertical;
  font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.6;
}
.input:focus-visible, .textarea:focus-visible, .select:focus-visible {
  outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: 1px;
}
.fieldRow { display: flex; flex-wrap: wrap; gap: 12px; }
.fieldRow .field { flex: 1; min-width: 160px; }

/* ---- markdown editor ----
   One bordered box holding three bands, matching the reference editor: a format toolbar on
   top, the writing surface in the middle, a status line with the mode picker at the bottom.

   The toolbar is ICON-based and split into groups by hairline dividers. The icons are
   hand-written SVG paths (MD_ICONS) rather than an icon package: this frame has no React,
   no bundler and no network, so a dependency would be one more thing to keep alive inside a
   template literal. Every button carries a title AND an aria-label, because an icon alone
   is not a name. */
.mdEditor {
  border: 0.5px solid var(--dsw-alias-border-l4, #ddd); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  overflow: hidden;
}
.mdBar {
  display: flex; align-items: center; flex-wrap: wrap; gap: 1px;
  padding: 4px 6px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, #eee);
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.02));
}
.mdBtn {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 28px; height: 28px; padding: 0 4px;
  border: none; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-secondary, #666);
  font: inherit; font-size: 12px; font-weight: 700; letter-spacing: 0.01em;
  cursor: pointer;
  transition: background-color 160ms cubic-bezier(0.23,1,0.32,1), color 160ms cubic-bezier(0.23,1,0.32,1);
}
.mdBtn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05));
  color: var(--dsw-alias-label-primary, #080808);
}
/* Press feedback: the same sub-1 scale the reference uses, so a press is acknowledged
   before the textarea re-reads. */
.mdBtn:active:not(:disabled) { transform: scale(0.94); }
.mdBtn:disabled { opacity: 0.4; cursor: not-allowed; }
.mdBtn:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: 1px; }
/* The active tint is derived from the caret's own line (see activeToolsFor), so it reports
   what the text actually is — it is never set speculatively. */
.mdBtn[data-on='true'] {
  background: color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 15%, transparent);
  color: var(--dsw-static-deepseek-500, #4d6bfe);
}
.mdBtn svg {
  width: 15px; height: 15px; display: block;
  fill: none; stroke: currentColor; stroke-width: 2;
  stroke-linecap: round; stroke-linejoin: round;
}
@media (prefers-reduced-motion: reduce) {
  .mdBtn { transition: none; }
  .mdBtn:active:not(:disabled) { transform: none; }
}
.mdDivider { flex: none; width: 1px; height: 16px; margin: 0 4px; background: var(--dsw-alias-border-l4, #ddd); }

/* ---- one surface, rendered and editable ----
   The reference editor's 'visual' mode is not "markers dimmed" — it is the RENDERED form: the
   markers are gone, headings are headings, bold is bold, lists are lists. You edit that.

   HOW: the rendered document itself is the editable surface (a contenteditable element). There
   is no mirror layer and no alignment constraint, because there is only one layer — the same
   HTML you would otherwise be reading. That is why this is simpler AND more correct than the
   marker-dimming version it replaces.

   Two surfaces exist in total: the rendered one (editable in live mode, read-only in reading
   mode) and the raw textarea (source mode). Exactly one is visible per mode. */
.mdArea { display: flex; min-width: 0; min-height: 0; height: clamp(280px, 44vh, 560px); }

/* The rendered surface. Full typography is allowed here — nothing has to stay aligned with a
   textarea any more, so headings get their real size and weight, and bold gets real weight. */
.mdVisual {
  flex: 1; min-width: 0; min-height: 0; overflow: auto;
  padding: 12px 16px;
  outline: none;
  /* Positions the empty-state hint (below), which overlays the first line rather than
     occupying a line of its own. */
  position: relative;
  font-family: 'Luzzy Sans', 'Luzzy PuHuiTi', system-ui, sans-serif;
  font-size: 14px; line-height: 1.72;
  color: var(--dsw-alias-label-primary, #080808);
}
.mdVisual[contenteditable='false'] { cursor: default; }
.mdVisual:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: -2px; }
/* An empty block still needs a line box, or the caret has nowhere to sit and the document
   collapses when every line is deleted. */
.mdVisual > * { min-height: 1.72em; }
.mdVisual p:empty::after,
.mdVisual h1:empty::after, .mdVisual h2:empty::after, .mdVisual h3:empty::after,
.mdVisual h4:empty::after, .mdVisual h5:empty::after, .mdVisual h6:empty::after,
.mdVisual li:empty::after, .mdVisual blockquote:empty::after {
  content: '\\200b';   /* zero-width space: keeps the line box without showing anything */
}

/* The empty-editor hint.
   Generated content, not an element, and that placement is the whole point: CSS content is not
   in the DOM, so serializeMarkdown reading childNodes can never pick it up. A real placeholder
   node would have to be excluded by hand, and the day someone forgot would be the day a hint
   got written into a user's system prompt.
   Absolute rather than in-flow, because the focus handler seeds an empty paragraph to give the
   caret a home — an in-flow hint would push that line down and leave a gap under the text.
   Driven by data-empty from the renderer, NOT by :empty: the seeded paragraph makes the
   container non-empty, so a :empty selector would drop the hint the moment the box was focused.
   The textarea carries its own placeholder for source mode; this covers live mode, where the
   textarea is display:none and that hint is therefore invisible. */
.mdVisual[data-empty='true']::before {
  content: '在这里写这个智能体的 system prompt…';
  position: absolute; top: 12px; left: 16px;
  color: var(--dsw-alias-label-tertiary, #999);
  pointer-events: none;
}

.mdArea[data-mode='source'] .mdVisual,
.mdArea[data-mode='live'] textarea.mdLayer,
.mdArea[data-mode='reading'] textarea.mdLayer { display: none; }

/* Source mode is the raw Markdown, monospaced. */
textarea.mdLayer {
  flex: 1; min-width: 0; min-height: 0;
  margin: 0; padding: 12px 14px;
  border: none; resize: none; outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary, #080808);
  font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.6;
  white-space: pre-wrap; overflow-wrap: break-word;
}
textarea.mdLayer::placeholder { color: var(--dsw-alias-label-tertiary, #999); }
textarea.mdLayer:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: -2px; }

/* ---- editor status line ---- */
.mdFoot {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l2, #eee);
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.02));
  font-size: 12px; color: var(--dsw-alias-label-tertiary, #999);
}
.mdFootCount { font-variant-numeric: tabular-nums; }
.mdMode { position: relative; }
.mdModeBtn {
  display: inline-flex; align-items: center; gap: 4px;
  height: 26px; padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l4, #ddd); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-secondary, #666);
  font: inherit; font-size: 12px; cursor: pointer;
  transition: color 160ms cubic-bezier(0.23,1,0.32,1);
}
.mdModeBtn:hover { color: var(--dsw-alias-label-primary, #080808); }
.mdModeBtn:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: 1px; }
.mdModeBtn svg {
  width: 12px; height: 12px; fill: none; stroke: currentColor;
  stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round;
}
@media (prefers-reduced-motion: reduce) { .mdModeBtn { transition: none; } }
/* The menu opens UPWARD: it is anchored to the bottom edge of the box, so there is no room
   below it. */
.mdMenu {
  position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 20;
  display: flex; flex-direction: column; gap: 1px;
  min-width: 136px; padding: 4px;
  border: 0.5px solid var(--dsw-alias-border-l2, #eee); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: 0 8px 24px rgba(0,0,0,0.16);
}
.mdMenu[hidden] { display: none; }
.mdMenuItem {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 8px; border: none; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-primary, #080808);
  font: inherit; font-size: 12px; text-align: left; cursor: pointer;
}
.mdMenuItem:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }
.mdMenuItem:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: 1px; }
.mdCheck {
  flex: none; width: 13px; height: 13px;
  fill: none; stroke: currentColor; stroke-width: 2.5;
  stroke-linecap: round; stroke-linejoin: round;
}
.mdMenuItemLabel { flex: 1; }

/* ---- markdown inline the renderer now emits ---- */
.markdown del { color: var(--dsw-alias-label-tertiary, #999); }
.markdown .mdTask { display: flex; align-items: flex-start; gap: 8px; list-style: none; }
.markdown .mdTask .mdBox {
  flex: none; width: 12px; height: 12px; margin-top: 4px;
  border: 1.5px solid var(--dsw-alias-border-l4, #ddd); border-radius: 4px;
}
.markdown .mdTask .mdBox[data-done='1'] {
  border-color: var(--dsw-static-deepseek-500, #4d6bfe);
  background: var(--dsw-static-deepseek-500, #4d6bfe);
}
/* Links are real links in the preview; keep the frame's own colour ramp so they read as
   links in both themes without introducing a new accent. */
.markdown a { color: var(--dsw-static-deepseek-500, #4d6bfe); text-decoration: none; }
.markdown a:hover { text-decoration: underline; }
.markdown blockquote {
  margin: 0.6em 0; padding: 2px 0 2px 12px;
  border-left: 3px solid var(--dsw-alias-border-l4, #ddd);
  color: var(--dsw-alias-label-secondary, #666);
}
.markdown blockquote p { margin: 0.3em 0; }

.btnRow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.btn {
  height: 32px; padding: 0 14px; border: 0.5px solid var(--dsw-alias-border-l4, #ddd);
  border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary, #080808);
  font: inherit; font-size: 14px; cursor: pointer;
}
.btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: 1px; }
.btnPrimary {
  border-color: transparent; background: var(--dsw-static-deepseek-500, #4d6bfe); color: #fff;
}
.btnPrimary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 86%, #000);
}
.btnDanger { color: var(--dsw-alias-state-error-primary, #d44); }
/* A destructive action that is not the view's primary one: it keeps the danger colour but
   drops the border, so it stops competing with the filled action beside it. Hover is where
   the colour earns its place. */
.btnText {
  height: auto; padding: 4px 8px; border: none; background: transparent;
  color: var(--dsw-alias-label-tertiary, #999);
}
.btnText.btnDanger { color: var(--dsw-alias-label-tertiary, #999); }
.btnText.btnDanger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04));
  color: var(--dsw-alias-state-error-primary, #d44);
}
/* A state, not a control: it reports what is already true. Sized like a button so the row
   keeps its rhythm, but with no border, no hover and no pointer. */
.stateBadge {
  display: inline-flex; align-items: center; height: 32px; padding: 0 12px;
  border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.03));
  color: var(--dsw-alias-label-tertiary, #999); font-size: 14px;
}
.btnSmall { height: 26px; padding: 0 10px; font-size: 12px; }

.saveState { font-size: 12px; color: var(--dsw-alias-label-tertiary, #999); }
.saveState[data-kind='dirty'] { color: var(--dsw-alias-state-warn-primary, #a60); }
.saveState[data-kind='saved'] { color: var(--dsw-alias-state-success-primary, #287); }
.saveState[data-kind='failed'] { color: var(--dsw-alias-state-error-primary, #d44); }

.callout {
  padding: 12px; border: 0.5px solid var(--dsw-alias-border-l2, #eee);
  border-left: 3px solid var(--dsw-alias-label-tertiary, #999); border-radius: 8px;
  font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #666);
}
.callout[data-kind='warn'] { border-left-color: var(--dsw-alias-state-warn-primary, #a60); }
.callout[data-kind='error'] { border-left-color: var(--dsw-alias-state-error-primary, #d44); }
.callout[data-kind='ok'] { border-left-color: var(--dsw-alias-state-success-primary, #287); }

.sessionRow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.sessionPreset {
  padding: 2px 8px; border-radius: 999px; font-family: ui-monospace, Consolas, monospace;
  font-size: 12px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.04));
}

/* ---- preset dialogs ----
   In-frame replacements for the native alert / confirm / prompt.

   WHY THESE EXIST

   The native dialogs are OS-level modals owned by the Electron window, and closing one does
   NOT hand keyboard focus back to the web contents. The reported symptom was exact: click a
   button, the modal opens and closes, and then the composer at the bottom is dead — clicking
   it does nothing. Focus only comes back after switching away from DSH and returning, which
   forces the OS to re-activate the window.

   Nothing inside the page can fix that, because the focus was never the page's to lose: the
   modal took it at the window level. So the page stops asking for native dialogs at all.

   The replacements are ordinary DOM inside the frame: they cannot take window focus, they
   inherit the frame's theme, and they close with Escape or a click on the scrim. */
.dialogScrim {
  position: fixed; inset: 0; z-index: 100;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, #000 42%, transparent);
}
.dialogScrim[hidden] { display: none; }
.dialog {
  display: flex; flex-direction: column; gap: 12px;
  width: 100%; max-width: 460px; max-height: 80vh; overflow: auto;
  padding: 16px 20px;
  border: 0.5px solid var(--dsw-alias-border-l2, #eee);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: 0 12px 32px rgba(0,0,0,0.18);
}
.dialogTitle { margin: 0; font-size: 16px; font-weight: 700; line-height: 1.4; }
.dialogBody { margin: 0; font-size: 14px; line-height: 1.65; color: var(--dsw-alias-label-secondary, #666); overflow-wrap: anywhere; }
.dialogBody code {
  font-family: ui-monospace, Consolas, monospace; font-size: 12px;
  padding: 0.1em 0.35em; border-radius: 4px;
  background: var(--dsw-alias-markdown-code-block, rgba(0,0,0,0.05));
}
.dialogInput {
  width: 100%; padding: 8px 12px; border: 0.5px solid var(--dsw-alias-border-l4, #ddd);
  border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #080808); font: inherit; font-size: 14px;
}
.dialogInput:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: 1px; }
.dialogActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
</style></head>
<body>
<div class="page">
  <div class="tabs topbar">
    <div class="segment" role="tablist">
      <button type="button" role="tab" data-tab="readme" aria-selected="true">说明</button>
      <button type="button" role="tab" data-tab="usage" aria-selected="false">用量</button>
      <button type="button" role="tab" data-tab="preset" aria-selected="false">预设</button>
      <button type="button" role="tab" data-tab="goal" aria-selected="false">目标</button>
    </div>
  </div>
  <div class="scroll"><div class="column" id="content"></div></div>
  <div class="goalNoticeBar"><span id="goalNotice" hidden></span></div>
</div>
<script>
'use strict'

// ---------------------------------------------------------------- flight recorder
//
// The frame is a separate document: nothing it throws reaches the host's console, and a
// stalled fetch leaves the page on its skeleton forever with no trace anywhere. Every
// stage and every failure therefore reports to the host's diag route, which writes FILES
// (a bare console call does not reach the desktop log set — see AGENTS.md §5.3).
//
// This is the black box the previous round lacked: it had no reporting inside the frame
// at all, which is exactly why a stuck usage page could not be told apart from a slow one.
function report(stage, detail) {
  try {
    fetch('/__luzzy/diag', {
      method: 'POST',
      keepalive: true,
      body: JSON.stringify({ from: 'frame', stage, detail: detail ?? null, at: Date.now() }),
    }).catch(function () {})
  } catch (error) {
    /* diagnostics must never break the page */
  }
}

window.addEventListener('error', function (event) {
  report('frame-error', String(event && event.message) + ' @' + String(event && event.filename) + ':' + String(event && event.lineno))
})
window.addEventListener('unhandledrejection', function (event) {
  var reason = event && event.reason
  report('frame-unhandled-rejection', String((reason && reason.message) || reason))
})

report('frame-boot', location.href)

// ---------------------------------------------------------------- helpers

const COLORS = ['#4c8dff','#38b26b','#c084fc','#f0a132','#ec5e41','#22b8cf','#8f7bf0','#7f8ea3']

function formatTokens(v) {
  if (!isFinite(v) || v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿'
  if (a >= 1e4) return (v / 1e4).toFixed(1) + '万'
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return String(Math.round(v))
}
function formatExact(v) { return isFinite(v) ? v.toLocaleString('en-US') : '0' }

/**
 * An epoch millisecond as MM-DD HH:mm, in the reader's own timezone.
 *
 * Local time here, NOT UTC — unlike the goal artifact's own renderer, which is UTC because
 * that document is a deterministic projection and two machines must produce identical
 * bytes. This is a timestamp shown to the person looking at the screen, and telling them a
 * file was written at 03:00 when their clock says 11:00 helps nobody. The two are separate
 * functions on purpose; neither is a copy of the other.
 */
function formatStamp(ms) {
  const value = Number(ms)
  if (!isFinite(value) || value <= 0) return '—'
  const d = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}
/**
 * Round an axis maximum up to a readable value.
 *
 * Fine-grained steps (1 / 1.25 / 1.5 / 2 / …) rather than powers of ten: with the coarse
 * 1-2-5-10 ladder a peak of 10.8亿 was rounded to 20亿, so the line sat in the bottom half
 * of the plot and the gridlines read 0 / 10亿 / 20亿 for data that never reached 11亿.
 */
function niceMax(v) {
  if (!isFinite(v) || v <= 0) return 1
  const magnitude = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / magnitude
  const steps = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
  for (const step of steps) {
    if (n <= step) return step * magnitude
  }
  return 10 * magnitude
}
function levelOf(v, max) {
  if (v <= 0) return 0
  if (max <= 0) return 1
  const r = v / max
  return r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

// ---------------------------------------------------------------- markdown

// Scope: headings (h1-h3 rendered, deeper clamped), fenced code, tables, bullet + ordered +
// TASK lists, blockquotes, bold, italic, strike, inline code, links, hr. The first six were
// what this repo's README needed (tools/analyze-readme.cjs); the rest were added when a real
// 57 KB prompt file was measured and turned out to use them — 861 bold runs, 157 table rows,
// 365 bullets, 91 ordered items, 17 blockquotes, 2 links. A preview that dropped those would
// misrepresent the prompt.
//
// SAFETY: every piece of text goes through esc() BEFORE any markup is inserted, so user text
// can never introduce a tag. Links are the one exception that needs more than escaping — a
// javascript: href would survive esc() — so the scheme is checked and anything that is not
// http/https/mailto is rendered as plain text instead of becoming a link.
function renderMarkdown(src) {
  const lines = String(src).replace(/\\r\\n/g, '\\n').split('\\n')
  const out = []
  let i = 0
  let inCode = false
  let codeLines = []
  // 'ul' | 'ol' | null. A single flag cannot express this: a bullet list followed by an
  // ordered list has to close one tag and open the other, and with a boolean the second
  // <ol> would nest inside the still-open <ul>.
  let listKind = null
  let tableRows = []

  const link = (text, href) => {
    // Already-escaped text and href. Only these schemes may become a real link.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)
    if (scheme === null || !/^(https?|mailto)$/i.test(scheme[1])) return text + ' (' + href + ')'
    return '<a href="' + href + '" target="_blank" rel="noreferrer noopener">' + text + '</a>'
  }

  const inline = (s) =>
    esc(s)
      .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      // Strikethrough runs after bold has consumed its pairs, and before italic, so a
      // doubled tilde can never be mistaken for emphasis.
      .replace(/~~([^~\\n]+)~~/g, '<del>$1</del>')
      // Italic runs after bold has consumed every ** pair, so a single asterisk here is
      // unambiguous. The content must start and end on non-space: without that, ordinary
      // prose like "3 * 4 * 5" would turn into emphasis.
      .replace(/\\*(\\S(?:[^*\\n]*\\S)?)\\*/g, '<em>$1</em>')
      .replace(/\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)/g, (m, text, href) => link(text, href))

  const flushList = () => { if (listKind !== null) { out.push('</' + listKind + '>'); listKind = null } }
  const flushTable = () => {
    if (tableRows.length === 0) return
    const rows = tableRows.filter((r) => !/^\\|[\\s|:-]+\\|$/.test(r))
    const cells = (r) => r.replace(/^\\||\\|$/g, '').split('|').map((c) => c.trim())
    out.push('<table>')
    rows.forEach((r, index) => {
      const tag = index === 0 ? 'th' : 'td'
      out.push('<tr>' + cells(r).map((c) => '<' + tag + '>' + inline(c) + '</' + tag + '>').join('') + '</tr>')
    })
    out.push('</table>')
    tableRows = []
  }

  while (i < lines.length) {
    const line = lines[i]

    if (/^\`\`\`/.test(line)) {
      if (inCode) {
        out.push('<pre><code>' + esc(codeLines.join('\\n')) + '</code></pre>')
        codeLines = []
        inCode = false
      } else {
        flushList(); flushTable()
        inCode = true
      }
      i++; continue
    }
    if (inCode) { codeLines.push(line); i++; continue }

    if (/^\\|/.test(line)) { flushList(); tableRows.push(line); i++; continue }
    flushTable()

    const h = /^(#{1,6}) (.*)$/.exec(line)
    if (h) {
      flushList()
      // Depth is honoured up to h6 so a real document's structure survives — the toolbar only
      // produces h1-h3, but a prompt written by hand may use deeper levels and flattening
      // them would misreport the document it is meant to preview.
      const n = h[1].length
      out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>')
      i++; continue
    }

    // A task list item is checked BEFORE the plain bullet, because "- [x] text" also matches
    // the bullet pattern. It is its own <li> shape — a box plus the text — rather than a
    // <ul> item with a literal "[x]" left in it.
    const task = /^\\s*[-*] \\[([ xX])\\] (.*)$/.exec(line)
    if (task) {
      if (listKind !== 'ul') { flushList(); out.push('<ul>'); listKind = 'ul' }
      out.push('<li class="mdTask"><span class="mdBox" data-done="' +
        (task[1].toLowerCase() === 'x' ? '1' : '0') + '"></span><span>' + inline(task[2]) + '</span></li>')
      i++; continue
    }

    if (/^\\s*[-*] /.test(line)) {
      // Nesting is deliberately NOT attempted: this renderer has one indent level, and a
      // nested item is rendered as a sibling. That is a known, visible ceiling rather than a
      // silent lie — the alternative (guessing depth from leading spaces) needs a real
      // CommonMark parser, which is more than a preview needs.
      if (listKind !== 'ul') { flushList(); out.push('<ul>'); listKind = 'ul' }
      out.push('<li>' + inline(line.replace(/^\\s*[-*] /, '')) + '</li>')
      i++; continue
    }
    const ordered = /^\\s*(\\d+)\\. /.exec(line)
    if (ordered) {
      if (listKind !== 'ol') { flushList(); out.push('<ol>'); listKind = 'ol' }
      out.push('<li>' + inline(line.replace(/^\\s*\\d+\\. /, '')) + '</li>')
      i++; continue
    }
    flushList()

    // A blockquote is only the outer '>' level; nested '>>' keeps its extra markers as text,
    // which is truthful — the prompt files use a single level.
    if (/^> ?/.test(line)) {
      out.push('<blockquote>' + inline(line.replace(/^> ?/, '')) + '</blockquote>')
      i++; continue
    }

    if (/^---+$/.test(line)) { out.push('<hr>'); i++; continue }
    if (line.trim() === '') { i++; continue }

    out.push('<p>' + inline(line) + '</p>')
    i++
  }

  if (inCode && codeLines.length) out.push('<pre><code>' + esc(codeLines.join('\\n')) + '</code></pre>')
  flushList(); flushTable()
  return '<div class="markdown">' + out.join('') + '</div>'
}

// ---------------------------------------------------------------- charts

/**
 * The plot's geometry, in viewBox units.
 *
 * Named constants rather than literals inside trendChart because the hover layer has to
 * convert between viewBox coordinates and client coordinates to place the tooltip, and two
 * copies of these numbers would drift apart silently — the tooltip would land in the wrong
 * place the moment one of them changed.
 */
const CHART = { W: 720, H: 220, PL: 56, PR: 16, PT: 16, PB: 30, PB_WIDE: 42 }

/**
 * The activity strip: one cell per day of the current natural month.
 *
 * The strip is always a MONTH — one cell per day, sized to the month's day count — not
 * "whatever buckets the current unit produced". Days still in the future are left blank
 * rather than filled as zero-usage days, so the strip reads as "this month so far".
 */
function activityGrid(activity) {
  if (!activity || !Array.isArray(activity.days)) return ''
  const days = activity.days
  const max = days.reduce((b, x) => Math.max(b, x.isFuture ? 0 : x.tokens || 0), 0)
  const cells = days.map((d) => {
    if (d.isFuture) {
      // Blank but PRESENT: the cell holds its track so the row still shows the whole month
      // (31 positions in a 31-day month) and the tail reads as "not yet". Marked
      // aria-hidden because there is nothing to announce.
      return '<div class="cell cellFuture" aria-hidden="true"></div>'
    }
    const label = esc(d.key) + ' · ' + formatExact(d.tokens || 0)
    return '<div class="cell" data-level="' + levelOf(d.tokens || 0, max) + '" title="' + label +
      '" aria-label="' + label + '"></div>'
  }).join('')
  const legend = [0, 1, 2, 3, 4].map((l) => '<span class="cell" data-level="' + l + '"></span>').join('')
  const elapsed = days.filter((d) => !d.isFuture).length

  return '<section class="card"><div class="cardHead"><h3>Token 活动</h3>' +
    '<span class="note">' + esc(activity.month) + ' · 每格一天 · 已过 ' + elapsed + '/' + days.length + ' 天</span></div>' +
    '<div class="activityGrid">' + cells + '</div>' +
    '<div class="legend"><span>少</span><span class="legendCells">' + legend + '</span><span>多</span></div></section>'
}

/**
 * A smooth path through the given points, WITHOUT overshoot.
 *
 * Monotone cubic interpolation (Fritsch–Carlson), which is what the reference chart's
 * curves are: they pass through every data point, have no corners, and never leave the
 * range of the data they interpolate.
 *
 * The obvious choice — Catmull-Rom — was tried first and is WRONG here. It overshoots
 * between points, and with non-negative data that means the curve dips below the zero
 * axis: a token-usage line drawn under zero is reporting negative tokens between two
 * positive hours. It was visible in the day window at 03:00–04:00.
 *
 * Monotone interpolation guarantees the curve stays inside the data's own range, so a
 * series is never drawn above its maximum or below its minimum.
 */
function smoothPath(points) {
  if (points.length === 0) return ''
  if (points.length === 1) return 'M' + points[0].x.toFixed(1) + ',' + points[0].y.toFixed(1)
  if (points.length === 2) {
    return 'M' + points[0].x.toFixed(1) + ',' + points[0].y.toFixed(1) +
      ' L' + points[1].x.toFixed(1) + ',' + points[1].y.toFixed(1)
  }

  const n = points.length

  // Secant slopes between consecutive points. The x spacing is uniform here (the slots are
  // evenly spread), so dx is a constant, but the slope still uses the real dx.
  const dx = []
  const slope = []
  for (let i = 0; i < n - 1; i += 1) {
    const run = points[i + 1].x - points[i].x
    dx.push(run)
    slope.push(run === 0 ? 0 : (points[i + 1].y - points[i].y) / run)
  }

  // Initial tangents: the average of the neighbouring secants.
  const tangent = new Array(n)
  tangent[0] = slope[0]
  tangent[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i += 1) {
    if (slope[i - 1] * slope[i] <= 0) {
      // A local extremum: flatten the tangent, or the curve would bulge past the point.
      tangent[i] = 0
    } else {
      tangent[i] = (slope[i - 1] + slope[i]) / 2
    }
  }

  // Fritsch–Carlson: shrink any tangent that would let the cubic overshoot its interval.
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) {
      tangent[i] = 0
      tangent[i + 1] = 0
      continue
    }
    const alpha = tangent[i] / slope[i]
    const beta = tangent[i + 1] / slope[i]
    const magnitude = alpha * alpha + beta * beta
    if (magnitude > 9) {
      const tau = 3 / Math.sqrt(magnitude)
      tangent[i] = tau * alpha * slope[i]
      tangent[i + 1] = tau * beta * slope[i]
    }
  }

  let d = 'M' + points[0].x.toFixed(1) + ',' + points[0].y.toFixed(1)
  for (let i = 0; i < n - 1; i += 1) {
    const third = dx[i] / 3
    const c1x = points[i].x + third
    const c1y = points[i].y + tangent[i] * third
    const c2x = points[i + 1].x - third
    const c2y = points[i + 1].y - tangent[i + 1] * third
    d += ' C' + c1x.toFixed(1) + ',' + c1y.toFixed(1) +
      ' ' + c2x.toFixed(1) + ',' + c2y.toFixed(1) +
      ' ' + points[i + 1].x.toFixed(1) + ',' + points[i + 1].y.toFixed(1)
  }
  return d
}

/**
 * The trend chart: one smooth curve per model across the current window.
 *
 * The window is a natural time unit (see lib/usage-window.mjs) — today's 24 hours, this
 * week's 7 days, or this month's weeks — and every slot in the window is drawn, including
 * slots that have not happened yet. Future slots carry null, which BREAKS the curve
 * rather than dropping it to zero: a line drawn down to the axis for hours that have not
 * arrived would show a collapse that never occurred.
 *
 * Returns markup only; wireChartHover attaches the pointer behaviour afterwards. Keeping
 * the two apart means this stays a pure function of its inputs.
 *
 * @param {object[]} series
 * @param {object[]} slots
 * @param {'line'|'bar'} mode
 * @param {boolean} animate mark the plot for an entrance animation
 */
function trendChart(series, slots, mode, animate) {
  const W = CHART.W, H = CHART.H, PL = CHART.PL, PR = CHART.PR, PT = CHART.PT
  // The month window labels two lines (week number + date span), so it needs a deeper
  // bottom gutter; the others label one line. Sized here rather than in the constant so the
  // hover layer and the drawing code still share one source of truth for the plot area.
  const PB = slots.some((s) => s.range !== undefined) ? CHART.PB_WIDE : CHART.PB
  const pw = W - PL - PR, ph = H - PT - PB

  const slotCount = slots.length
  const xAt = (index) => (slotCount === 1 ? PL + pw / 2 : PL + (index / (slotCount - 1)) * pw)

  // Scale to the data that exists; future slots are null and must not affect the axis.
  let peak = 0
  for (const s of series) {
    for (const v of s.values) {
      if (typeof v === 'number' && isFinite(v) && v > peak) peak = v
    }
  }
  const max = niceMax(peak)
  const yAt = (v) => PT + ph - (v / max) * ph

  const grid = [0, max / 2, max].map((v) => {
    const y = yAt(v)
    return '<line class="chartGrid" x1="' + PL + '" x2="' + (W - PR) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>' +
      '<text class="chartAxis" x="' + (PL - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + formatTokens(v) + '</text>'
  }).join('')

  // Split each series at its null slots so a gap is a gap. In bar mode a null slot simply
  // draws no bar, which needs no splitting.
  const shapes = series.map((s, seriesIndex) => {
    const color = COLORS[seriesIndex % COLORS.length]
    const runs = []
    let run = []
    for (let i = 0; i < slotCount; i += 1) {
      const v = s.values[i]
      if (typeof v === 'number' && isFinite(v)) run.push({ x: xAt(i), y: yAt(v), i: i })
      else if (run.length > 0) { runs.push(run); run = [] }
    }
    if (run.length > 0) runs.push(run)

    if (mode === 'bar') {
      // Grouped bars: each model gets a slice of the slot, so models sit side by side
      // instead of covering each other. With many models the slice gets thin, which is
      // why the count is capped before this point.
      const groupCount = Math.max(series.length, 1)
      const slotWidth = slotCount === 1 ? pw : pw / slotCount
      const barW = Math.max(1.5, Math.min(14, (slotWidth * 0.7) / groupCount))
      const offset = (seriesIndex - (groupCount - 1) / 2) * barW
      return slots.map((slot, i) => {
        const v = s.values[i]
        if (slot.isFuture || typeof v !== 'number' || !isFinite(v) || v <= 0) return ''
        const x = xAt(i) + offset
        const y = yAt(v)
        return '<rect x="' + (x - barW / 2).toFixed(1) + '" y="' + y.toFixed(1) +
          '" width="' + barW.toFixed(1) + '" height="' + Math.max(0, PT + ph - y).toFixed(1) +
          '" rx="1.5" fill="' + color + '"/>'
      }).join('')
    }

    return runs.map((points) => {
      const d = smoothPath(points)
      // Dots carry the slot index so the hover layer can highlight the exact point the
      // pointer is nearest, rather than only the column.
      const dots = points.map((p) =>
        '<circle class="chartDot" data-dot="' + p.i + '" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) +
        '" r="2.5" fill="' + color + '"/>').join('')
      // The area fill is only honest for a single-series chart: stacking translucent fills
      // per model turns the plot into mud. With one model it reads as emphasis.
      const area = series.length === 1 && points.length > 1
        ? '<path d="' + d + ' L' + points[points.length - 1].x.toFixed(1) + ',' + (PT + ph) +
          ' L' + points[0].x.toFixed(1) + ',' + (PT + ph) + ' Z" fill="' + color + '" opacity="0.12"/>'
        : ''
      return area + '<path d="' + d + '" fill="none" stroke="' + color +
        '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' + dots
    }).join('')
  }).join('')

  // Label every slot when they are few, otherwise thin them out evenly. The last label is
  // always kept so the axis ends on a real value rather than an arbitrary interior one.
  //
  // A slot carrying a date range (the month window's natural weeks) shows the week number
  // with its date span underneath, e.g. 第1周 / 8.31 - 9.6 — without the dates a 第1周 that
  // happens to start in the previous month is unreadable.
  const everyN = Math.max(1, Math.ceil(slotCount / 8))
  const labels = slots.map((slot, i) => {
    if (i % everyN !== 0 && i !== slotCount - 1) return ''
    const x = xAt(i).toFixed(1)
    const main = '<text class="chartAxis" x="' + x + '" y="' + (H - (slot.range === undefined ? 10 : 18)) +
      '" text-anchor="middle">' + esc(slot.label) + '</text>'
    if (slot.range === undefined) return main
    return main + '<text class="chartAxis chartAxisSub" x="' + x + '" y="' + (H - 6) +
      '" text-anchor="middle">' + esc(slot.range) + '</text>'
  }).join('')

  // ---- hover layer
  //
  // One invisible rect per slot spanning the full plot height. Columns (not points) are the
  // hit target: a 2.5px dot is unhittable, and every model in a slot shares the same x, so
  // the column is the only sensible unit. The pointer-events rule is required because a
  // transparent fill would otherwise not receive the pointer.
  const step = slotCount > 1 ? pw / (slotCount - 1) : pw
  const half = step / 2
  const hits = slots.map((slot, i) => {
    const left = Math.max(PL, xAt(i) - half)
    const right = Math.min(W - PR, xAt(i) + half)
    return '<rect class="chartHit" data-slot="' + i + '" x="' + left.toFixed(1) + '" y="' + PT +
      '" width="' + Math.max(1, right - left).toFixed(1) + '" height="' + ph + '" fill="transparent"/>'
  }).join('')

  // The guide line and the highlighted dots are moved by JS on hover; the line starts
  // hidden so it never flashes at x=0 before the first pointer event.
  const guide =
    '<line class="chartGuide" x1="0" x2="0" y1="' + PT + '" y2="' + (PT + ph) + '" style="display:none"/>'

  const legend = series.map((s, i) =>
    '<span class="chartLegendItem"><span class="chartSwatch" style="background:' + COLORS[i % COLORS.length] + '"></span>' +
    '<span class="chartLegendName">' + esc(s.key) + '</span>' +
    '<span class="chartLegendValue">' + formatTokens(s.windowTotal) + '</span></span>').join('')

  return '<div class="chartWrap" data-chart' + (animate ? ' data-animate' : '') + '>' +
    '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img">' +
    '<g>' + grid + '</g><g>' + guide + '</g><g>' + shapes + '</g><g>' + labels + '</g>' +
    '<g class="chartHits">' + hits + '</g>' +
    '</svg>' +
    '<div class="chartTip" role="tooltip" hidden></div>' +
    '</div>' +
    (series.length > 0 ? '<div class="chartLegend">' + legend + '</div>' : '')
}

/**
 * Turn a slot index into the tooltip's markup.
 *
 * Same shape as the reference: a header with the slot and its TOTAL, then one row per model
 * that contributed, largest first. Models with nothing in this slot are omitted — a list of
 * zeros would bury the two lines that matter.
 */
function chartTipHtml(slots, series, index) {
  const slot = slots[index]
  if (slot === undefined) return ''

  const rows = series
    .map((s, i) => ({ key: s.key, value: s.values[index], color: COLORS[i % COLORS.length] }))
    .filter((r) => typeof r.value === 'number' && isFinite(r.value) && r.value > 0)
    .sort((a, b) => b.value - a.value)

  const total = rows.reduce((sum, r) => sum + r.value, 0)

  // The month window's slots name a date span (which may cross a month edge), so the header
  // shows both the week number and the dates.
  const title = slot.range === undefined ? slot.label : slot.label + ' · ' + slot.range

  if (rows.length === 0) {
    return '<div class="chartTipHead"><span class="chartTipTitle">' + esc(title) + '</span>' +
      '<span class="chartTipTotal">无用量</span></div>'
  }

  return '<div class="chartTipHead"><span class="chartTipTitle">' + esc(title) + '</span>' +
    '<span class="chartTipTotal">' + formatTokens(total) + ' tokens</span></div>' +
    '<div class="chartTipRows">' +
    rows.map((r) =>
      '<div class="chartTipRow">' +
      '<span class="chartSwatch" style="background:' + r.color + '"></span>' +
      '<span class="chartTipName">' + esc(r.key) + '</span>' +
      '<span class="chartTipValue">' + formatTokens(r.value) + '</span>' +
      '</div>').join('') +
    '</div>'
}

/**
 * Attach hover behaviour to a rendered chart.
 *
 * Called after the markup is in the DOM (the chart is built as a string, so there is nothing
 * to attach to until then).
 *
 * @param {HTMLElement} root the element containing the chart, i.e. the chartWrap div
 */
function wireChartHover(root, slots, series) {
  const svg = root.querySelector('svg.chart')
  const tip = root.querySelector('.chartTip')
  const guide = root.querySelector('.chartGuide')
  if (svg === null || tip === null) return

  const dots = Array.prototype.slice.call(svg.querySelectorAll('.chartDot'))
  const hits = Array.prototype.slice.call(svg.querySelectorAll('.chartHit'))
  let shownFor = -1

  const show = (index, clientX, clientY) => {
    if (index === shownFor) {
      // Same column: only the tooltip's position needs to follow the pointer.
      if (clientX !== undefined) position(clientX, clientY)
      return
    }
    shownFor = index
    tip.innerHTML = chartTipHtml(slots, series, index)
    tip.hidden = false

    // Guide line + enlarged dots at this column.
    const x = hits[index] === undefined ? 0 : Number(hits[index].getAttribute('x')) +
      Number(hits[index].getAttribute('width')) / 2
    guide.setAttribute('x1', String(x))
    guide.setAttribute('x2', String(x))
    guide.style.display = ''
    dots.forEach((dot) => {
      const active = Number(dot.getAttribute('data-dot')) === index
      dot.setAttribute('r', active ? '4' : '2.5')
    })
    if (clientX !== undefined) position(clientX, clientY)
  }

  /**
   * Place the tooltip near the pointer, clamped to the chart box.
   *
   * Clamping matters: without it the panel runs off the right edge on the last slots and off
   * the top on tall peaks, which is exactly where a user is most likely to be looking.
   */
  const position = (clientX, clientY) => {
    const box = root.getBoundingClientRect()
    const x = clientX - box.left
    const y = clientY - box.top
    // Measure after the content is set; the hidden attribute must be off for the size to
    // be real.
    const tw = tip.offsetWidth
    const th = tip.offsetHeight
    let left = x + 14
    let top = y - th - 12
    if (left + tw > box.width - 4) left = x - tw - 14
    if (left < 4) left = 4
    if (top < 0) top = y + 16
    if (top + th > box.height) top = Math.max(0, box.height - th)
    tip.style.left = left + 'px'
    tip.style.top = top + 'px'
  }

  const hide = () => {
    if (shownFor === -1) return
    shownFor = -1
    tip.hidden = true
    guide.style.display = 'none'
    dots.forEach((dot) => dot.setAttribute('r', '2.5'))
  }

  hits.forEach((hit) => {
    const index = Number(hit.getAttribute('data-slot'))
    hit.addEventListener('mouseenter', (event) => show(index, event.clientX, event.clientY))
    hit.addEventListener('mousemove', (event) => show(index, event.clientX, event.clientY))
  })
  svg.addEventListener('mouseleave', hide)
  // Keyboard access: focusing the chart and using arrow keys walks the slots. Without this
  // the values are unreachable without a mouse, which the reference design does not solve
  // but this page should.
  root.setAttribute('tabindex', '0')
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const count = slots.length
    if (count === 0) return
    event.preventDefault()
    const next = shownFor === -1
      ? 0
      : Math.min(count - 1, Math.max(0, shownFor + (event.key === 'ArrowRight' ? 1 : -1)))
    const hit = hits[next]
    if (hit === undefined) return
    const box = root.getBoundingClientRect()
    const svgBox = svg.getBoundingClientRect()
    // Convert the hit column's viewBox x into a client x for positioning.
    const viewX = Number(hit.getAttribute('x')) + Number(hit.getAttribute('width')) / 2
    const clientX = svgBox.left + (viewX / CHART.W) * svgBox.width
    show(next, clientX, box.top + box.height / 2)
  })
  root.addEventListener('blur', hide)
}

function modelDonut(models) {
  const SIZE = 200, STROKE = 26, R = (SIZE - STROKE) / 2, C = SIZE / 2, CIRC = 2 * Math.PI * R
  let series = models.slice(0, 7).map((m) => ({ key: m.key, totalTokens: m.totalTokens }))
  if (models.length > 7) {
    const tail = models.slice(7).reduce((s, m) => s + (m.totalTokens || 0), 0)
    if (tail > 0) series.push({ key: '__other__', totalTokens: tail })
  }
  const total = series.reduce((s, m) => s + (m.totalTokens || 0), 0)
  let offset = 0
  const arcs = series.map((m, idx) => {
    const share = total > 0 ? m.totalTokens / total : 0
    const len = share * CIRC
    const arc = { key: m.key, share: share, len: len, offset: offset, color: COLORS[idx % COLORS.length] }
    offset += len
    return arc
  })
  const rings = arcs.map((a) =>
    '<circle cx="' + C + '" cy="' + C + '" r="' + R + '" fill="none" stroke="' + a.color + '" stroke-width="' + STROKE +
    '" stroke-dasharray="' + a.len + ' ' + (CIRC - a.len) + '" stroke-dashoffset="' + (-a.offset) + '"/>').join('')
  const rows = arcs.map((a) =>
    '<div class="modelRow"><span class="modelSwatch" style="background:' + a.color + '"></span>' +
    '<span class="modelName">' + esc(a.key === '__other__' ? '其他模型' : a.key) + '</span>' +
    '<span class="modelValue">' + formatTokens(series.find((x) => x.key === a.key).totalTokens || 0) + '</span>' +
    '<span class="modelShare">' + (a.share * 100).toFixed(1) + '%</span></div>').join('')

  return '<div class="models"><div class="donutWrap">' +
    '<svg width="' + SIZE + '" height="' + SIZE + '" viewBox="0 0 ' + SIZE + ' ' + SIZE + '" role="img">' +
    '<g transform="rotate(-90 ' + C + ' ' + C + ')">' + rings + '</g></svg>' +
    '<div class="donutCenter"><span class="donutTotal">' + formatTokens(total) + '</span><span class="donutCaption">tokens</span></div>' +
    '</div><div class="modelList">' + rows + '</div></div>'
}

// ---------------------------------------------------------------- pages

const content = document.getElementById('content')
// The window drives the trend chart (day = today's hours, week = this week's days, month =
// this month's weeks); it is switched client-side from the payload, so it never refetches.
let state = { tab: 'readme', window: 'day', mode: 'line', payload: null, status: 'idle', error: null, elapsed: 0 }
// What the chart showed last time, so an entrance animation fires on a real CHANGE (window
// or mode switched) and not on the initial paint, a retry, or a data refresh — animating
// those would make the page feel twitchy rather than responsive.
let lastChartKey = null
let readmeHtml = null

/**
 * A centred status block: one plain sentence, an optional retry, and optional detail.
 *
 * The detail argument exists because failure states used to interpolate a raw exception into
 * the sentence itself ("用量统计失败 — Cannot read properties of undefined"), which tells the
 * user nothing they can act on and leaks a stack-shaped message into the UI. The house rule is
 * that every message says what to do next; the machine text still has to be reachable for a bug
 * report, so it goes behind a disclosure rather than into the headline.
 */
function statusBlock(message, retry, detail) {
  const detailHtml = detail
    ? '<details class="statusDetail"><summary>诊断细节</summary><code>' + esc(String(detail)) + '</code></details>'
    : ''
  return '<div class="status"><span>' + esc(message) + '</span>' +
    (retry ? '<button type="button" id="retry">重试</button>' : '') +
    detailHtml + '</div>'
}

/** The summary metrics card. Shared so both the normal and the stale-payload paths show
 *  the same numbers — an outdated host half still reports totals correctly. */
function metricsCard(t, cacheRate, attempts) {
  return '<section class="card"><div class="metrics">' +
    '<div class="metric"><span class="metricLabel">Token 总量</span><span class="metricValue">' + formatTokens(t.totalTokens) + '</span></div>' +
    '<div class="metric"><span class="metricLabel">缓存命中</span><span class="metricValue">' + formatTokens(t.cacheReadTokens) + '</span></div>' +
    '<div class="metric"><span class="metricLabel">输入</span><span class="metricValue">' + formatTokens(t.inputTokens) + '</span></div>' +
    '<div class="metric"><span class="metricLabel">输出</span><span class="metricValue">' + formatTokens(t.outputTokens) + '</span></div>' +
    '<div class="metric"><span class="metricLabel">缓存命中率</span><span class="metricValue">' + cacheRate.toFixed(1) + '%</span></div>' +
    '<div class="metric"><span class="metricLabel">请求</span><span class="metricValue">' + formatExact(attempts) + '</span></div>' +
  '</div><p class="note">数据来自本机会话日志，按每次请求的最终用量统计（不重复计入流式分片）。</p></section>'
}

function render() {
  document.querySelectorAll('[data-tab]').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)))

  if (state.tab === 'readme') {
    // The prose gets its own measure. The card still spans the column, but running a paragraph
    // the full 1280px would put ~150 characters on a line, which is roughly double what is
    // readable; the design system asks for 50–75. Constraining the TEXT rather than the card
    // keeps the card aligned with its siblings above and below.
    if (readmeHtml !== null) { content.innerHTML = '<div class="card"><div class="prose">' + readmeHtml + '</div></div>'; return }
    content.innerHTML = '<div class="status"><span>正在读取 README…</span>' +
      '<div class="skeleton" style="width:60%;height:20px"></div>' +
      '<div class="skeleton" style="width:100%;height:160px"></div></div>'
    return
  }

  if (state.tab === 'preset') { renderPreset(); return }

  if (state.tab === 'goal') { renderGoal(); return }

  if (state.status === 'idle' || state.status === 'loading') {
    content.innerHTML = '<div class="status"><span>正在统计用量…</span>' +
      '<span class="note" id="elapsed">已用时 ' + (state.elapsed || 0) + ' 秒</span>' +
      '<div class="skeleton" style="width:60%;height:20px"></div>' +
      '<div class="skeleton" style="width:100%;height:160px"></div>' +
      '<p class="note">首次统计要读完本机全部会话日志，约需 20–30 秒；之后切换视图是即时的。</p></div>'
    return
  }
  if (state.status === 'error') {
    content.innerHTML = statusBlock('用量数据读不出来，可以重试。', true, state.error)
    const btn = document.getElementById('retry')
    if (btn) btn.addEventListener('click', () => loadUsage(true))
    return
  }

  const p = state.payload
  if (!p || p.attempts === 0) { content.innerHTML = statusBlock('还没有可统计的用量记录。'); return }

  // The trend chart needs the windows payload, which only the host half from this build
  // returns. An OUTDATED host half (DSH not restarted since the client was rebuilt) answers
  // with the old shape — totals and models are present, the windows field is absent — and
  // the page then said "今天还没有用量记录", which reads as "you have no usage" when the
  // real problem is a version mismatch. Name it instead of disguising it.
  //
  // This is a real trap, not a hypothetical: only the client half hot-reloads (see
  // AGENTS.md §5.3), so a rebuilt client against a stale host is the NORMAL state right
  // after an edit until DSH is restarted.
  const windowsMissing = p.windows === undefined || p.windows === null
  if (windowsMissing) {
    report('usage-payload-stale', { hasBuckets: p.buckets !== undefined, attempts: p.attempts })
  }

  const t = p.totals
  const cacheRate = t.totalTokens > 0 ? (t.cacheReadTokens / t.totalTokens) * 100 : 0

  // The window selector drives the TREND CHART only, so it lives in that card's header
  // rather than above the whole page: a control that changes one chart belongs with it.
  //
  // There is no hourly option. A window is a natural time unit — today's hours, this week's
  // days, this month's weeks — so hours are already how "day" is drawn; a separate hourly
  // option would be the same shape under a second name.
  const windows = [['day', '日'], ['week', '周'], ['month', '月']]
  const windowBtns = windows.map((w) =>
    '<button type="button" data-window="' + w[0] + '" aria-pressed="' + (state.window === w[0]) + '">' + w[1] + '</button>').join('')
  const modeBtns = [['line', '折线'], ['bar', '条形']].map((m) =>
    '<button type="button" data-mode="' + m[0] + '" aria-pressed="' + (state.mode === m[0]) + '">' + m[1] + '</button>').join('')

  // A stale host half cannot draw the trend chart at all, so say that — and hide the window
  // and mode controls, which would be dead buttons over a message that is not about data.
  //
  // Everything else IS valid in the old payload (totals, models), so the page still shows
  // it: the point is to name what is broken, not to blank the page.
  if (windowsMissing) {
    content.innerHTML =
      metricsCard(t, cacheRate, p.attempts) +
      '<section class="card"><h3>模型趋势</h3>' +
      '<div class="status"><span>宿主半是本插件更新前的版本，还没提供趋势数据。</span>' +
      '<p class="note">客户端会随文件改动热重载，宿主半不会——它需要重启 DSH 才生效。<br>' +
      '本次已读到 ' + formatExact(p.attempts) + ' 条用量记录，所以不是没有数据，是响应结构对不上。</p>' +
      '<button type="button" id="retry-stale">重试</button></div></section>' +
      '<section class="card"><h3>模型用量</h3>' + modelDonut(p.models) + '</section>'
    const retryStale = document.getElementById('retry-stale')
    if (retryStale !== null) retryStale.addEventListener('click', () => loadUsage(true))
    return
  }

  const active = (p.windows && p.windows[state.window]) || null
  const windowCaption =
    state.window === 'day' ? '今天的 24 小时'
      : state.window === 'week' ? '本周（周一起）'
        : '本月各周'

  // Animate only when the chart's identity actually changed. The key is intentionally
  // (window, mode) and not the payload: a refresh returns new data for the same chart, and
  // re-animating that would look like a glitch.
  const chartKey = state.window + '/' + state.mode
  const animateChart = lastChartKey !== null && lastChartKey !== chartKey
  lastChartKey = chartKey

  content.innerHTML =
    metricsCard(t, cacheRate, p.attempts) +
    activityGrid(p.activity) +
    '<section class="card"><div class="cardHead"><h3>模型趋势</h3>' +
    '<span class="note">' + esc(windowCaption) + '</span><span class="spacer"></span>' +
    '<div class="segment" role="group">' + windowBtns + '</div>' +
    '<div class="segment" role="group">' + modeBtns + '</div></div>' +
    (active !== null && active.series.length > 0
      ? trendChart(active.series, active.slots, state.mode, animateChart)
      : '<p class="note">这个' + (state.window === 'day' ? '今天' : state.window === 'week' ? '本周' : '本月') + '还没有用量记录。</p>') +
    '</section>' +
    '<section class="card"><h3>模型用量</h3>' + modelDonut(p.models) + '</section>'

  content.querySelectorAll('[data-window]').forEach((b) =>
    b.addEventListener('click', () => { state.window = b.dataset.window; render() }))
  content.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => { state.mode = b.dataset.mode; render() }))

  // The chart is inserted as a string, so its pointer behaviour is attached afterwards.
  // Guarded because a window with no data renders a message instead of a chart.
  const chartRoot = content.querySelector('[data-chart]')
  if (chartRoot !== null) {
    if (active !== null) wireChartHover(chartRoot, active.slots, active.series)
    // data-animate is an entrance, so it is retired once the entrance is over. Left in place
    // it would read as "this chart is animating" forever, and it would re-fire if the frame
    // were ever re-rendered in place instead of rebuilt. A timer rather than animationend
    // because under prefers-reduced-motion no animation runs and that event never fires —
    // the attribute would then be stranded permanently. The captured node is the one this
    // render created, so a later render's timer cannot strip a live chart's attribute.
    if (animateChart) setTimeout(() => chartRoot.removeAttribute('data-animate'), 400)
  }
}

function loadUsage(refresh) {
  state.status = 'loading'
  state.error = null
  state.elapsed = 0
  render()

  // A cold aggregate walks every session log (~20 s on this machine), so the wait is
  // expected — but a request that never settles must not leave the skeleton up forever.
  // The first version had no abort and no clock, which is why "stuck loading" could not
  // be told apart from "still working".
  const started = Date.now()
  report('usage-fetch-start', { refresh: !!refresh })

  const ticker = setInterval(function () {
    if (state.status !== 'loading') return
    state.elapsed = Math.round((Date.now() - started) / 1000)
    const node = document.getElementById('elapsed')
    if (node !== null) node.textContent = '已用时 ' + state.elapsed + ' 秒'
  }, 1000)

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  // Generous: a cold pass is ~20-35 s, so this only fires when something is genuinely wrong.
  const timeout = setTimeout(function () {
    if (controller !== null) controller.abort()
  }, 90000)

  const settle = function () {
    clearInterval(ticker)
    clearTimeout(timeout)
  }

  // One request returns every window, so this never refetches on a window switch.
  fetch(
    '/__luzzy/usage' + (refresh ? '?refresh=1' : ''),
    controller === null ? undefined : { signal: controller.signal },
  )
    .then((r) => r.ok ? r.json() : r.text().then((b) => Promise.reject(new Error(b))))
    .then((payload) => {
      settle()
      report('usage-fetch-ok', {
        ms: Date.now() - started,
        attempts: payload.attempts,
        windows: payload.windows ? Object.keys(payload.windows) : null,
        series: payload.windows && payload.windows.day ? payload.windows.day.series.length : null,
      })
      state.payload = payload
      state.status = 'ready'
      state.error = null
      render()
    })
    .catch((err) => {
      settle()
      const message = String(err && err.message || err)
      report('usage-fetch-failed', { ms: Date.now() - started, message: message })
      state.status = 'error'
      state.error = message
      render()
    })
}

fetch('/__luzzy/readme')
  .then((r) => r.ok ? r.text() : r.text().then((b) => Promise.reject(new Error(b))))
  .then((text) => {
    report('readme-ok', { bytes: text.length })
    readmeHtml = renderMarkdown(text)
    if (state.tab === 'readme') render()
  })
  .catch((err) => {
    report('readme-failed', String(err && err.message || err))
    readmeHtml = '<p class="note">README 读取失败</p>'
    if (state.tab === 'readme') render()
  })

// ---------------------------------------------------------------- preset sub-page
//
// The roster lives on the host (files under the DSH home); this side is a plain form over
// two routes: GET for the whole picture, POST for one change at a time. Nothing is cached
// across a mutation — every POST answers with the next snapshot, so the page never has to
// guess what the store looks like now.
//
// Two facts the page must never blur together, because they are the whole feature:
//
//   * SELECTED — which agent's prompt the editor is showing. Local to this page.
//   * ACTIVE   — which agent's prompt the model is actually sending. Lives in the store,
//                is shared by every session, and takes effect on the next request.
//
// A third fact belongs to the session rather than the store: whether THIS session can be
// moved onto LuzzyMode. DSH refuses that once a session has produced content, so the
// button is disabled with the real reason instead of failing after the click.

let presetSnapshot = null
let presetStatus = 'idle' // idle | loading | ready | error
let presetError = null
let selectedAgentId = null
// The editor's contents. \`promptDirty\` is what makes an unsaved edit visible — silently
// discarding a 100 KB prompt on a tab switch would be the worst behaviour here.
let promptText = ''
let promptDirty = false
let promptExists = true
let promptInherited = false
/**
 * Which of the three display modes the editor is in: 'live' | 'source' | 'reading'.
 *
 * 'live' is the DEFAULT, matching the reference prompt editor's default ('visual'): you type
 * into one surface and see the formatting as you go. There is no side-by-side split — the
 * reference has none, and a split pane halves the width of the thing you are actually writing.
 *
 * This is DISPLAY-ONLY state and must never feed back into promptText: nothing outside the one
 * textarea is editable, and if a rendering wrote back, merely looking at it would rewrite a
 * 57 KB prompt.
 */
let promptMode = 'live'
/** Whether the mode menu is open. Rendering state, kept out of the store. */
let modeMenuOpen = false

/**
 * The toolbar's commands, grouped exactly as the reference editor groups them, and the icons.
 *
 * The icons are raw SVG inner markup written here rather than an icon package: the frame has
 * no React, no bundler and no network, so a dependency would be one more thing to keep alive
 * inside a template literal. They are drawn on a 24x24 grid in the same stroke style the
 * reference uses (2px, round caps) — see the .mdBtn svg rule for the shared attributes.
 *
 * TEXT BUTTONS: headings and the clear-formatting button render a short glyph instead of an
 * icon. "H1" is clearer at 15px than any heading pictogram, and the reference does the same.
 *
 * WHAT IS NOT HERE, AND WHY:
 *   - underline: Markdown has no syntax for it. Emitting HTML would work only if the renderer
 *     allowed raw tags through, which it must not — that is the XSS hole the renderer
 *     deliberately closes. A button whose output the preview drops is worse than no button.
 *   - undo / redo: the textarea's own undo stack already works (toolbar edits go through
 *     setRangeText precisely to keep it intact), so Ctrl+Z and Ctrl+Y do this today. Adding a
 *     second implementation behind a button would be the least valuable thing here to get
 *     wrong.
 */
const MD_ICONS = {
  bold: '<path d="M7 5h5.5a3.5 3.5 0 0 1 0 7H7z"/><path d="M7 12h6.5a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M15 5H9"/><path d="M15 19H9"/><path d="M13.5 5 10 19"/>',
  strike: '<path d="M4 12h16"/><path d="M16.5 7.5A4 4 0 0 0 13 5h-2.2a3 3 0 0 0-1.1 5.8"/><path d="M7.6 16.5A4 4 0 0 0 11 19h2.2a3 3 0 0 0 1.1-5.8"/>',
  code: '<path d="m9 5-5 7 5 7"/><path d="m15 5 5 7-5 7"/>',
  bullet: '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>',
  ordered: '<path d="M10 6h10"/><path d="M10 12h10"/><path d="M10 18h10"/><path d="M4 4.4h1.4V9"/><path d="M3.4 12.1h2.5L3.6 15h2.5"/><path d="M3.4 17.5h2.3c.7 0 1 .9.4 1.4l-2.4 1.6h2.5"/>',
  task: '<path d="M11 6h10"/><path d="M11 12h10"/><path d="M11 18h10"/><path d="m2.6 6 1.7 1.7L8 4.3"/><rect x="2.5" y="15.6" width="5.4" height="5.4" rx="1.3"/>',
  codeblock: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 10-2 2 2 2"/><path d="m14 14 2-2-2-2"/>',
  quote: '<path d="M6 5v14"/><path d="M11 8h9"/><path d="M11 12h9"/><path d="M11 16h6"/>',
  table: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 10h18"/><path d="M9.5 10v9.5"/>',
  link: '<path d="M9.5 14.5a3.5 3.5 0 0 1 0-5l2-2a3.5 3.5 0 0 1 5 5l-1 1"/><path d="M14.5 9.5a3.5 3.5 0 0 1 0 5l-2 2a3.5 3.5 0 0 1-5-5l1-1"/>',
  rule: '<path d="M4 12h16"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 6.5"/>',
  // Used by the group header's delete affordance. Same stroke language as the toolbar icons
  // (24x24 viewBox, no fill, round caps come from the CSS): lid, body, and the two lid ticks.
  trash: '<path d="M4 7h16"/><path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l1 12a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-12"/><path d="M10.5 11v6"/><path d="M13.5 11v6"/>',
}

const MD_GROUPS = [
  [
    { id: 'bold', label: '加粗', icon: 'bold' },
    { id: 'italic', label: '斜体', icon: 'italic' },
    { id: 'strike', label: '删除线', icon: 'strike' },
  ],
  [
    { id: 'code', label: '行内代码', icon: 'code' },
    { id: 'clear', label: '清除行内格式', text: 'T' },
  ],
  [
    { id: 'h1', label: '一级标题', text: 'H1' },
    { id: 'h2', label: '二级标题', text: 'H2' },
    { id: 'h3', label: '三级标题', text: 'H3' },
  ],
  [
    { id: 'bullet', label: '无序列表', icon: 'bullet' },
    { id: 'ordered', label: '有序列表', icon: 'ordered' },
    { id: 'task', label: '任务列表', icon: 'task' },
  ],
  [
    { id: 'codeblock', label: '代码块', icon: 'codeblock' },
    { id: 'quote', label: '引用', icon: 'quote' },
  ],
  [
    { id: 'table', label: '插入表格', icon: 'table' },
    { id: 'hr', label: '插入分割线', icon: 'rule' },
  ],
  [{ id: 'link', label: '插入链接', icon: 'link' }],
]

/** The three display modes. The live one is the default, matching the reference editor. */
const MD_MODES = [
  { id: 'live', label: '实时预览' },
  { id: 'source', label: '源码模式' },
  { id: 'reading', label: '阅读模式' },
]

/** Flat view of MD_GROUPS, for the wiring and the tests. */
const MD_TOOLS = MD_GROUPS.reduce(function (all, group) { return all.concat(group) }, [])

// Session facts, resolved by the host when it knows which session this page belongs to.
let sessionId = null

/**
 * POST one operation, with the revision this page last saw attached automatically.
 *
 * The revision is added HERE rather than at each call site, because a guard each caller has
 * to remember is a guard that is absent exactly where it matters. It was: every roster write
 * (add / rename / delete / reorder / regroup) omitted it, so the host's 409 concurrency
 * check could never fire and two windows editing the same roster would silently clobber each
 * other — the loser's change vanishing with no error anywhere.
 *
 * Operations that do not touch the roster (readPrompt, setPrompt, ensureStore,
 * switchSession, newSession) are not given one. Sending a revision to a route that does
 * not compare it is harmless, but sending it to one that does NOT mutate would start
 * rejecting a pure read after an unrelated write.
 */
const REVISION_GUARDED = { upsertAgent: 1, removeAgent: 1, reorderAgents: 1, upsertGroup: 1, removeGroup: 1, reorderGroups: 1, setActive: 1 }

function presetPost(body) {
  const payload = { ...body }
  if (REVISION_GUARDED[payload.op] === 1 && payload.revision === undefined && presetSnapshot !== null) {
    payload.revision = presetSnapshot.revision
  }
  return fetch('/__luzzy/preset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(function (r) {
    return r.json().catch(function () { return {} }).then(function (payload) {
      if (r.ok) return payload
      const error = new Error(payload && payload.error ? payload.error : ('HTTP ' + r.status))
      error.status = r.status
      error.payload = payload
      // A conflict means this page's copy of the roster is stale. Adopt the state the host
      // sent back immediately, so the UI stops showing a list that no longer exists — the
      // alternative is the user editing a roster that was already overwritten.
      if (r.status === 409 && payload && payload.snapshot) {
        applySnapshot(payload.snapshot)
        if (state.tab === 'preset') render()
      }
      throw error
    })
  })
}

function loadPreset() {
  presetStatus = 'loading'
  presetError = null
  report('preset-fetch-start', { sessionId: sessionId })
  const url = '/__luzzy/preset' + (sessionId === null ? '' : '?sessionId=' + encodeURIComponent(sessionId))
  return fetch(url)
    .then(function (r) { return r.ok ? r.json() : r.text().then(function (b) { throw new Error(b) }) })
    .then(function (payload) {
      report('preset-fetch-ok', {
        revision: payload.revision,
        agents: payload.agents ? payload.agents.length : null,
        groups: payload.groups ? payload.groups.length : null,
        promptSource: payload.promptSource,
      })
      applySnapshot(payload)
      presetStatus = 'ready'
      if (state.tab === 'preset') render()
      return payload
    })
    .catch(function (err) {
      const message = String(err && err.message || err)
      report('preset-fetch-failed', message)
      presetStatus = 'error'
      presetError = message
      if (state.tab === 'preset') render()
    })
}

// ---------------------------------------------------------------- goal sub-page
//
// The 「目标」 page answers the questions a long task makes you ask: what am I finishing,
// what has to be true for it to count, what have I actually done, what is stopping me, and
// what happens next. It reads TWO states that stay separate all the way through:
//
//   * the RUNTIME goal — objective, phase, revision, round budget. Owned by DSH
//     (dsh-goal), persisted in the session log, edited by update_goal or /goal.
//   * the DELIVERY PLAN — acceptance criteria, tasks, evidence, focus, next action,
//     blockers, decisions. Owned by the plugin, stored per session under DSH home.
//
// The page NEVER writes the runtime goal. Objective, scope and mandatory acceptance are
// human authority: the agent may only propose changes to them, and adopting a proposal is
// a button here rather than something a model can do.
//
// Everything is fetched in one request, because the overview card, the lists and the raw
// view are views of the same state and a split fetch would let them disagree.

let goalSnapshot = null
let goalStatus = 'idle' // idle | loading | ready | error
let goalError = null
let goalDetail = null
let goalRawOpen = false
let goalRawText = null
let goalRawLoading = false

/** Health and status labels. Kept beside the renderer so the two cannot drift. */
const GOAL_HEALTH = { healthy: '正常', 'needs-attention': '需要注意', blocked: '已阻塞', verifying: '待验证', completed: '已完成' }
const GOAL_HEALTH_STATE = { healthy: 'ok', 'needs-attention': 'warn', blocked: 'bad', verifying: 'active', completed: 'ok' }
const GOAL_PHASE = { active: '进行中', paused: '已暂停', blocked: '已阻塞', complete: '已完成' }

/**
 * One status badge: an icon, a colour and a WORD.
 *
 * All three, every time. A colour alone is not allowed to carry state — that is a design
 * rule, and it is also the only version that survives a user who cannot distinguish the
 * hues. The glyphs are inline SVG paths rather than characters, because the frame's own
 * subset font may not contain a tick.
 */
function chip(state, label, title) {
  const paths = {
    ok: '<path d="M1.5 5.5 4 8l5-5.5"/>',
    bad: '<path d="M4 1.5 4 6"/><circle cx="4" cy="8.2" r=".7" fill="currentColor" stroke="none"/>',
    warn: '<path d="M4 1.8 4 6"/><circle cx="4" cy="8.2" r=".7" fill="currentColor" stroke="none"/>',
    active: '<circle cx="4" cy="5" r="2.2"/>',
    idle: '<circle cx="4" cy="5" r="2.2"/>',
  }
  const glyph = paths[state] || paths.idle
  return '<span class="chip" data-state="' + esc(state) + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
    '<svg width="8" height="10" viewBox="0 0 8 10" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" aria-hidden="true">' + glyph + '</svg>' + esc(label) + '</span>'
}

/** Acceptance / task / proposal status → (chip state, label). */
const GOAL_STATUS_CHIP = {
  pending: ['idle', '待开始'],
  in_progress: ['active', '进行中'],
  ready: ['idle', '就绪'],
  verified: ['ok', '已验证'],
  rejected: ['bad', '不满足'],
  blocked: ['bad', '受阻'],
  completed: ['ok', '已完成'],
  cancelled: ['idle', '已取消'],
  adopted: ['ok', '已采纳'],
  withdrawn: ['idle', '已撤回'],
  superseded: ['idle', '已被取代'],
}

function statusChip(status) {
  const entry = GOAL_STATUS_CHIP[status] || ['idle', status]
  return chip(entry[0], entry[1])
}

/** A done / total pair, with the two numbers tabular so they line up across cards. */
function tally(done, total) {
  return '<span style="font-variant-numeric:tabular-nums">' + done + ' / ' + total + '</span>'
}

function goalRow(id, text, chips, sub) {
  const done = chips !== undefined && /rowDone/.test(chips) ? ' rowDone' : ''
  return '<li class="row' + done + '">' +
    '<span class="rowId">' + esc(id) + '</span>' +
    '<div class="rowBody"><p class="rowText">' + esc(text) + '</p>' +
    (sub ? '<p class="rowSub">' + sub + '</p>' : '') + '</div>' +
    (chips ? '<div class="rowChips">' + chips + '</div>' : '') +
    '</li>'
}

/** A section card with an optional count on the right of its title. */
function goalSection(title, body, count) {
  return '<section class="card"><div class="cardHead"><h3>' + esc(title) + '</h3>' +
    '<span class="spacer"></span>' +
    (count === undefined ? '' : '<span class="goalMetaItem">' + count + '</span>') +
    '</div>' + body + '</section>'
}

function emptyLine(text) {
  return '<p class="note">' + esc(text) + '</p>'
}

/**
 * The overview card: what the goal IS, right now.
 *
 * Reported as pairs rather than a percentage, and the health is a NAMED STATE rather than a
 * score — "4 / 6 verified" tells you what is left and "67%" does not, and a number out of
 * 100 would be precise about something nobody can measure.
 */
function goalOverviewCard(snapshot) {
  const goal = snapshot.goal
  const s = snapshot.summary
  const health = s.health
  const parts = []

  if (goal === null) {
    // Two very different reasons there is no goal, and they must not read the same. One is
    // "nothing has been started"; the other is "the goal exists but this process cannot see
    // it", which is the normal state right after a DSH restart until the session is opened.
    const why = snapshot.goalState === 'unavailable'
      ? '当前会话没有加载在本进程里，读不到它的运行时目标。'
      : '这个会话还没有目标。'
    const hint = snapshot.goalState === 'unavailable'
      ? '在左侧打开这个会话后回到这里，目标就会出现。下面的计划是这个会话上次留下的记录。'
      : '让 Agent 开始一个长任务，它会用 create_goal 建立目标；你也可以在输入框里直接说「把这件事做成一个目标」。'
    return '<section class="card"><div class="cardHead"><h3>目标</h3><span class="spacer"></span>' +
      chip('idle', '没有目标') + '</div>' +
      '<p class="goalObjective" style="color:var(--dsw-alias-label-secondary,#666);font-weight:400">' + esc(why) + '</p>' +
      '<p class="note">' + esc(hint) + '</p>' +
      (snapshot.goalReason ? '<details class="statusDetail"><summary>诊断细节</summary><code>' + esc(snapshot.goalReason) + '</code></details>' : '') +
      '</section>'
  }

  parts.push('<section class="card"><div class="cardHead"><h3>目标</h3><span class="spacer"></span>' +
    chip(GOAL_HEALTH_STATE[health] || 'idle', GOAL_HEALTH[health] || health) + '</div>')
  parts.push('<p class="goalObjective">' + esc(goal.objective) + '</p>')
  parts.push('<div class="goalMeta">' +
    chip(goal.phase === 'active' ? 'active' : goal.phase === 'complete' ? 'ok' : 'idle', GOAL_PHASE[goal.phase] || goal.phase) +
    (goal.phase === 'active' ? chip(goal.activation === 'armed' ? 'active' : 'idle', goal.activation === 'armed' ? '续行已启用' : '续行未启用') : '') +
    '<span class="goalMetaItem">修订 ' + goal.revision + '</span>' +
    '<span class="goalMetaItem">轮次 ' + goal.roundsStarted + ' / ' + goal.maxGoalRounds + '</span>' +
    '</div>')

  if (goal.blockedReason !== undefined) {
    parts.push('<div class="callout" data-kind="error"><strong>' + esc(goal.blockedReason.code) + '</strong> ' +
      esc(goal.blockedReason.message) + '</div>')
  }

  // The four counts. Two columns rather than four equal boxes: a metric and its caption
  // read as one unit, and four equal cards is the layout the design review singled out as
  // having no judgement behind it.
  parts.push('<div class="metrics" style="grid-template-columns:repeat(2,minmax(0,1fr))">' +
    '<div class="metric"><span class="metricLabel">验收标准</span><span class="metricValue">' + tally(s.acceptance.verified, s.acceptance.total) + '</span></div>' +
    '<div class="metric"><span class="metricLabel">任务</span><span class="metricValue">' + tally(s.tasks.completed, s.tasks.total) + '</span></div>' +
    '<div class="metric"><span class="metricLabel">证据</span><span class="metricValue">' + s.evidence.total + '</span></div>' +
    '<div class="metric"><span class="metricLabel">未解决阻塞</span><span class="metricValue">' + s.blockers.open + '</span></div>' +
    '</div>')

  parts.push('<div class="goalBar">' +
    '<button type="button" class="btn btnSmall" id="goalRefresh">刷新</button>' +
    '<button type="button" class="btn btnSmall" id="goalRawToggle" aria-expanded="' + String(goalRawOpen) + '">' +
    (goalRawOpen ? '收起 goal.md' : '查看 goal.md') + '</button>' +
    '<span class="spacer"></span>' +
    (snapshot.artifact.enabled
      ? '<span class="goalMetaItem">goal.md 已开启</span>'
      : '<button type="button" class="btn btnSmall" id="goalArtifactOn">在项目里写 goal.md</button>') +
    '</div>')

  // A refusal is the most actionable thing on the page, so it is stated in the overview
  // rather than buried: this is exactly why the goal is not finished yet.
  if (snapshot.integrity && snapshot.integrity.errors && snapshot.integrity.errors.length > 0) {
    parts.push('<div class="goalBar"><span class="goalMetaItem">' +
      snapshot.integrity.errors.length + ' 项完整性问题</span>' +
      '<span class="spacer"></span><button type="button" class="btn btnSmall" id="goalIntegrityToggle">查看</button></div>')
  }

  parts.push('</section>')
  return parts.join('')
}

/** The drift banner: the plan was written against a different objective or revision. */
function goalDriftCard(snapshot) {
  if (snapshot.drift === null || snapshot.drift === undefined) return ''
  const d = snapshot.drift
  return '<section class="card"><div class="cardHead"><h3>目标已变化</h3><span class="spacer"></span>' +
    chip('warn', '需要对账') + '</div>' +
    '<p class="rowSub" style="font-size:14px;color:var(--dsw-alias-label-secondary,#666)">' +
    '这份计划是在目标还是另一个样子的时候写的（' + esc(d.fields.join('、')) + ' 发生了变化）。' +
    '先把计划对齐到当前目标，再继续执行——否则后面做的可能已经不是用户要的事。</p>' +
    '<div class="goalBar"><span class="goalMetaItem">' +
    (d.before.objective !== undefined ? '原：' + esc(String(d.before.objective).slice(0, 80)) : '修订 ' + esc(String(d.before.revision))) +
    ' → ' + (d.after.objective !== undefined ? '现：' + esc(String(d.after.objective).slice(0, 80)) : '修订 ' + esc(String(d.after.revision))) +
    '</span><span class="spacer"></span>' +
    '<button type="button" class="btn btnSmall btnPrimary" id="goalReconcile">对齐到当前目标</button></div></section>'
}

/** Pending change proposals. Only a human may adopt one — that is the whole mechanism. */
function goalProposalsCard(snapshot) {
  const pending = (snapshot.delivery.proposals || []).filter((p) => p.status === 'pending')
  if (pending.length === 0) return ''
  const body = pending.map((p) =>
    '<div class="proposal"><div class="proposalHead">' + chip('warn', '待确认') +
    '<span class="rowId">' + esc(p.id) + '</span>' +
    '<span class="goalMetaItem">字段 ' + esc(p.field) + (p.target ? ' · ' + esc(p.target) : '') + '</span>' +
    '</div>' +
    '<p class="rowText">' + esc(p.proposed) + '</p>' +
    (p.current ? '<p class="rowSub">当前：' + esc(p.current) + '</p>' : '') +
    (p.reason ? '<p class="rowSub">理由：' + esc(p.reason) + '</p>' : '') +
    (p.impact ? '<p class="rowSub">影响：' + esc(p.impact) + '</p>' : '') +
    '<div class="proposalActions">' +
    '<button type="button" class="btn btnSmall btnPrimary" data-proposal="' + esc(p.id) + '" data-proposal-op="adoptProposal">采纳</button>' +
    '<button type="button" class="btn btnSmall" data-proposal="' + esc(p.id) + '" data-proposal-op="rejectProposal">不采纳</button>' +
    '</div></div>').join('')
  return '<section class="card"><div class="cardHead"><h3>变更提案</h3><span class="spacer"></span>' +
    chip('warn', pending.length + ' 待确认') + '</div>' +
    '<p class="note">Agent 不能自己改目标、范围、约束和必须满足的验收标准——它只能提出来，由你决定。</p>' +
    body + '</section>'
}

function goalAcceptanceCard(snapshot) {
  const rows = snapshot.delivery.acceptance
  if (rows.length === 0) {
    return goalSection('验收标准', emptyLine('还没有定义验收标准。没有它，「做完了」就只是一句话。'), '0')
  }
  const body = '<ul class="rows">' + rows.map((row) => {
    const chips = statusChip(row.status) + (row.mandatory ? chip('warn', '必须') : '')
    const sub = []
    if (row.evidence.length > 0) sub.push('证据 ' + row.evidence.join('、'))
    if (row.verifiedAt) sub.push('验证于 ' + formatStamp(row.verifiedAt))
    return goalRow(row.id, row.description, chips + (row.status === 'verified' || row.status === 'completed' ? '<span class="rowDone"></span>' : ''), sub.join(' · '))
  }).join('') + '</ul>'
  const s = snapshot.summary.acceptance
  return goalSection('验收标准', body, tally(s.verified, s.total) + ' 已验证')
}

function goalTasksCard(snapshot) {
  const rows = snapshot.delivery.tasks
  if (rows.length === 0) return goalSection('任务拆解', emptyLine('还没有拆解任务。'), '0')
  const body = '<ul class="rows">' + rows.map((row) => {
    const sub = []
    if (row.acceptance.length > 0) sub.push('服务 ' + row.acceptance.join('、'))
    if (row.dependsOn.length > 0) sub.push('依赖 ' + row.dependsOn.join('、'))
    if (row.artifacts.length > 0) sub.push('产出 ' + row.artifacts.map((a) => '<code>' + esc(a) + '</code>').join('、'))
    return goalRow(row.id, row.title, statusChip(row.status), sub.join(' · '))
  }).join('') + '</ul>'
  const s = snapshot.summary.tasks
  return goalSection('任务拆解', body, tally(s.completed, s.total) + ' 已完成')
}

function goalFocusCard(snapshot) {
  const focus = snapshot.delivery.focus
  const next = snapshot.delivery.next
  const focusHtml = '<div class="focusBox" data-empty="' + (focus === '' ? 'true' : 'false') + '">' +
    esc(focus === '' ? '（未设置当前焦点）' : focus) + '</div>'
  const nextHtml = next.length === 0
    ? emptyLine('（未设置下一步）')
    : '<ol class="nextList">' + next.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ol>'
  return '<section class="card"><div class="cardHead"><h3>焦点与下一步</h3></div>' +
    '<p class="metricLabel" style="display:block;margin-bottom:8px">当前焦点</p>' + focusHtml +
    '<p class="metricLabel" style="display:block;margin:16px 0 8px">下一步行动</p>' + nextHtml +
    '</section>'
}

function goalEvidenceCard(snapshot) {
  const rows = snapshot.delivery.evidence
  if (rows.length === 0) {
    return goalSection('验证与证据', emptyLine('还没有记录证据。完成状态要靠证据支撑，而不是靠声明。'), '0')
  }
  const body = '<ul class="rows">' + rows.map((row) => {
    const targets = snapshot.delivery.acceptance.filter((a) => (a.evidence || []).includes(row.id)).map((a) => a.id)
    const sub = []
    if (row.detail) sub.push(esc(row.detail))
    if (row.ref) sub.push('<code>' + esc(row.ref) + '</code>')
    sub.push(targets.length > 0 ? '关联 ' + targets.join('、') : '未关联到验收标准')
    return goalRow(row.id, row.summary, chip('idle', row.kind), sub.join(' · '))
  }).join('') + '</ul>'
  return goalSection('验证与证据', body, String(rows.length))
}

function goalBlockersCard(snapshot) {
  const open = snapshot.delivery.blockers.filter((b) => b.resolvedAt === null)
  const resolved = snapshot.delivery.blockers.filter((b) => b.resolvedAt !== null)
  if (snapshot.delivery.blockers.length === 0) return ''
  const body = '<ul class="rows">' + snapshot.delivery.blockers.map((row) =>
    goalRow(row.id, row.message, row.resolvedAt === null ? chip('bad', '未解决') : chip('ok', '已解决'),
      '<code>' + esc(row.code) + '</code> · ' + formatStamp(row.at) + (row.resolvedAt ? ' · 解决于 ' + formatStamp(row.resolvedAt) : ''))).join('') + '</ul>'
  return goalSection('风险与阻塞', body, open.length + ' 未解决' + (resolved.length > 0 ? ' · ' + resolved.length + ' 已解决' : ''))
}

function goalDecisionsCard(snapshot) {
  const rows = snapshot.delivery.decisions
  if (rows.length === 0) return ''
  const body = '<ul class="rows">' + rows.map((row) => {
    const sub = []
    if (row.reason) sub.push('理由：' + esc(row.reason))
    if (row.alternatives) sub.push('备选：' + esc(row.alternatives))
    if (row.rejectedBecause) sub.push('未采纳原因：' + esc(row.rejectedBecause))
    return goalRow(row.id, row.decision, '', sub.join('<br>'))
  }).join('') + '</ul>'
  return goalSection('决策记录', body, String(rows.length))
}

function goalScopeCard(snapshot) {
  const scope = snapshot.delivery.scope
  const constraints = snapshot.delivery.constraints
  const list = (items, empty) => items.length === 0
    ? emptyLine(empty)
    : '<ul class="nextList">' + items.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul>'
  return '<section class="card"><div class="cardHead"><h3>范围与约束</h3></div>' +
    '<p class="metricLabel" style="display:block;margin-bottom:8px">包含</p>' + list(scope.included, '（未填写）') +
    '<p class="metricLabel" style="display:block;margin:16px 0 8px">不包含</p>' + list(scope.excluded, '（未填写）') +
    '<p class="metricLabel" style="display:block;margin:16px 0 8px">约束条件</p>' + list(constraints, '（未填写）') +
    '</section>'
}

function goalHistoryCard(snapshot) {
  const rows = snapshot.delivery.changes
  if (rows.length === 0) return ''
  // Newest first: the log reads as a history, and the most recent change is the one being
  // looked for.
  const recent = rows.slice(-60).reverse()
  const body = '<ul class="rows">' + recent.map((row) =>
    goalRow(formatStamp(row.at).slice(5), row.action, chip(row.actor === 'human' ? 'active' : 'idle', row.actor === 'human' ? '用户' : row.actor === 'agent' ? 'Agent' : '系统'),
      row.detail ? esc(row.detail) : '')).join('') + '</ul>'
  return goalSection('变更记录', body, rows.length + ' 条' + (rows.length > recent.length ? '（显示最近 ' + recent.length + '）' : ''))
}

function goalIntegrityCard(snapshot) {
  const integrity = snapshot.integrity
  if (integrity === undefined || integrity === null) return ''
  const errors = integrity.errors || []
  const warnings = integrity.warnings || []
  if (errors.length === 0 && warnings.length === 0) {
    return goalSection('完整性检查', '<p class="note">结构性检查通过：目标、验收标准、任务依赖与证据引用都成立。</p>')
  }
  const render = (rows, state, label) => '<ul class="rows">' + rows.map((row) =>
    goalRow(row.code.replace(/^GOAL_/, ''), row.detail, chip(state, label), '对象 ' + esc(row.target))).join('') + '</ul>'
  return goalSection('完整性检查',
    (errors.length > 0 ? render(errors, 'bad', '需修复') : '') +
    (warnings.length > 0 ? render(warnings, 'warn', '提示') : ''),
    errors.length + ' 错误 · ' + warnings.length + ' 提示')
}

function goalArtifactCard(snapshot) {
  const artifact = snapshot.artifact
  const head = '<section class="card"><div class="cardHead"><h3>goal.md</h3><span class="spacer"></span>' +
    (artifact.enabled ? chip(artifact.stale ? 'warn' : 'ok', artifact.stale ? '与状态不一致' : '与状态一致') : chip('idle', '未开启')) +
    '</div>'
  if (!artifact.enabled) {
    return head + '<p class="note">' +
      '开启后，每次打开这一页都会把当前目标与计划写成 <code>' + esc(snapshot.artifactPath) + '</code>，' +
      '放在这个会话的工作目录里。它是一份可读、可提交、可 review 的投影——' +
      '运行时状态仍然是唯一权威，这个文件只是它的渲染结果。</p>' +
      '<div class="goalBar"><span class="goalMetaItem">落点：' + (artifact.cwd ? '<code>' + esc(artifact.cwd) + '</code>' : '未知（会话没有工作目录）') + '</span>' +
      '<span class="spacer"></span><button type="button" class="btn btnSmall" id="goalArtifactOn">开启</button></div></section>'
  }
  const lines = []
  lines.push('<p class="note">' + (artifact.exists
    ? '文件在 <code>' + esc(artifact.path) + '</code>，' + artifact.bytes + ' 字节' + (artifact.mtime ? '，最后写入 ' + formatStamp(artifact.mtime) : '') + '。'
    : '还没有写入过。<code>' + esc(String(artifact.path || snapshot.artifactPath)) + '</code> 在下次刷新时建立。') + '</p>')
  if (artifact.stale) {
    lines.push('<div class="callout" data-kind="warn">文件内容与当前状态不一致——多半是状态在上次写入之后又改过。刷新即可重新投影。</div>')
  }
  lines.push('<div class="goalBar">' +
    '<button type="button" class="btn btnSmall" id="goalArtifactWrite">立即写入</button>' +
    '<span class="spacer"></span>' +
    '<button type="button" class="btn btnSmall" id="goalArtifactOff">关闭</button></div>')
  return head + lines.join('') + '</section>'
}

function goalRawCard() {
  if (!goalRawOpen) return ''
  return '<section class="card"><div class="cardHead"><h3>goal.md 原文</h3><span class="spacer"></span>' +
    '<span class="goalMetaItem">Markdown</span></div>' +
    (goalRawLoading
      ? '<div class="skeleton" style="width:100%;height:200px"></div>'
      : goalRawText === null
        ? emptyLine('还没有 goal.md。先在上一张卡里开启或点「立即写入」。')
        : '<pre class="rawView">' + esc(goalRawText) + '</pre>') +
    '</section>'
}

function renderGoal() {
  if (goalStatus === 'idle' || goalStatus === 'loading') {
    content.innerHTML = '<div class="status"><span>正在读取目标状态…</span>' +
      '<div class="skeleton" style="width:50%;height:20px"></div>' +
      '<div class="skeleton" style="width:100%;height:160px"></div></div>'
    return
  }
  if (goalStatus === 'error') {
    content.innerHTML = statusBlock('目标状态读不出来，可以重试。', true, goalDetail) +
      '<div class="status"><button type="button" id="goalRetry">重试</button></div>'
    const retry = document.getElementById('goalRetry')
    if (retry !== null) retry.addEventListener('click', function () { loadGoal(true) })
    return
  }

  const snapshot = goalSnapshot
  if (snapshot === null) { content.innerHTML = statusBlock('目标状态为空。'); return }

  // A read failure is its own thing: the plan file exists but could not be parsed. Saying
  // "no plan" here would be a false statement about the user's own data, so it is named.
  if (snapshot.readError !== undefined) {
    content.innerHTML = statusBlock('这个会话的目标状态文件读不出来。', true, snapshot.readError.reason)
    const retry = document.getElementById('retry')
    if (retry !== null) retry.addEventListener('click', function () { loadGoal(true) })
    return
  }

  content.innerHTML =
    goalOverviewCard(snapshot) +
    goalDriftCard(snapshot) +
    goalProposalsCard(snapshot) +
    '<div class="goalGrid">' +
      '<div style="display:flex;flex-direction:column;gap:16px">' +
        goalAcceptanceCard(snapshot) + goalEvidenceCard(snapshot) +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:16px">' +
        goalTasksCard(snapshot) + goalFocusCard(snapshot) +
      '</div>' +
    '</div>' +
    goalBlockersCard(snapshot) +
    goalScopeCard(snapshot) +
    goalDecisionsCard(snapshot) +
    goalIntegrityCard(snapshot) +
    goalArtifactCard(snapshot) +
    goalRawCard() +
    (snapshot.warnings && snapshot.warnings.length > 0
      ? goalSection('读取提示', '<ul class="nextList">' + snapshot.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>')
      : '')

  wireGoal()
}

/** Attach the sub-page's listeners. Called after every render of the goal tab. */
function wireGoal() {
  const on = function (id, handler) {
    const node = document.getElementById(id)
    if (node !== null) node.addEventListener('click', handler)
  }

  on('goalRefresh', function () { loadGoal(true) })
  on('goalRetry', function () { loadGoal(true) })
  on('goalArtifactOn', function () { goalPost('enableArtifact') })
  on('goalArtifactOff', function () { goalPost('disableArtifact') })
  on('goalArtifactWrite', function () { goalPost('writeArtifact') })
  on('goalReconcile', function () {
    const goal = goalSnapshot && goalSnapshot.goal
    if (goal === null || goal === undefined) return
    goalPost('reconcile', { goalId: goal.id, goalRevision: goal.revision, objective: goal.objective })
  })
  on('goalRawToggle', function () {
    goalRawOpen = !goalRawOpen
    if (goalRawOpen && goalRawText === null) {
      goalRawLoading = true
      renderGoal()
      fetchGoalArtifact()
      return
    }
    renderGoal()
  })
  on('goalIntegrityToggle', function () {
    const node = document.getElementById('goalIntegrity')
    if (node !== null) node.scrollIntoView({ block: 'start' })
  })

  document.querySelectorAll('[data-proposal]').forEach(function (node) {
    node.addEventListener('click', function () {
      goalPost(node.dataset.proposalOp, { id: node.dataset.proposal })
    })
  })
}

/** Read the artifact text for the raw view. Separate from the snapshot because it is bulky. */
function fetchGoalArtifact() {
  const sessionId = goalSnapshot === null ? null : goalSnapshot.sessionId
  fetch('/__luzzy/goal?artifact=1' + (sessionId ? '&sessionId=' + encodeURIComponent(sessionId) : ''))
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)) })
    .then(function (payload) {
      goalSnapshot = payload
      goalRawText = payload.artifact && payload.artifact.text ? payload.artifact.text : null
      goalRawLoading = false
      if (state.tab === 'goal') renderGoal()
    })
    .catch(function (err) {
      report('goal-artifact-failed', String(err && err.message || err))
      goalRawLoading = false
      goalRawText = null
      if (state.tab === 'goal') renderGoal()
    })
}

function loadGoal(refresh) {
  goalStatus = 'loading'
  goalError = null
  goalDetail = null
  renderGoal()
  report('goal-fetch-start', { refresh: !!refresh })

  // NOTE the name: sessionId is the frame's own module-level value, and a local const
  // reusing that name would shadow it AND self-reference inside its own initializer —
  // "Cannot access 'sessionId' before initialization", thrown from the first line that
  // touches it. The black box caught this; reading the code did not.
  const goalSessionId = goalSnapshot === null ? sessionId : goalSnapshot.sessionId
  const url = '/__luzzy/goal' + (goalSessionId ? '?sessionId=' + encodeURIComponent(goalSessionId) : '')
  const started = Date.now()

  fetch(url)
    .then(function (r) { return r.ok ? r.json() : r.text().then(function (b) { throw new Error(b) }) })
    .then(function (payload) {
      report('goal-fetch-ok', {
        ms: Date.now() - started,
        goalState: payload.goalState,
        phase: payload.goal ? payload.goal.phase : null,
        acceptance: payload.summary ? payload.summary.acceptance.total : null,
        health: payload.summary ? payload.summary.health : null,
      })
      goalSnapshot = payload
      goalStatus = 'ready'
      // The raw view caches the text it was given; a refresh must not keep showing an old
      // document next to a fresh state.
      goalRawText = null
      if (state.tab === 'goal') renderGoal()
    })
    .catch(function (err) {
      const message = String(err && err.message || err)
      report('goal-fetch-failed', message)
      goalStatus = 'error'
      goalDetail = message
      if (state.tab === 'goal') renderGoal()
    })
}

/**
 * One plan mutation through the host route, then re-render from the returned snapshot.
 *
 * The POST answers with the whole next state, so this never re-fetches and never paints a
 * combination that never existed on disk. A 409 or 422 still carries a snapshot — that is
 * the point: the loser of a race shows the truth rather than guessing at it.
 */
function goalPost(op, payload) {
  const goalSessionId = goalSnapshot === null ? sessionId : goalSnapshot.sessionId
  report('goal-post', { op: op })
  return fetch('/__luzzy/goal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: op, payload: payload || {}, sessionId: goalSessionId, artifact: goalRawOpen }),
  })
    .then(function (r) { return r.json().catch(function () { return null }).then(function (body) { return { ok: r.ok, status: r.status, body: body } }) })
    .then(function (result) {
      const body = result.body
      if (body !== null && body !== undefined && body.snapshot !== undefined) {
        goalSnapshot = body.snapshot
        goalStatus = 'ready'
      } else if (body !== null && body !== undefined && body.delivery !== undefined) {
        goalSnapshot = body
        goalStatus = 'ready'
      }
      report('goal-post-result', { op: op, ok: result.ok, status: result.status, code: body ? body.code : null })
      if (state.tab === 'goal') renderGoal()
      if (!result.ok && body && body.error) goalNotify(body.error)
      return result
    })
    .catch(function (err) {
      report('goal-post-failed', String(err && err.message || err))
      goalNotify('写入失败：' + String(err && err.message || err))
    })
}

/**
 * A transient message at the top of the goal tab.
 *
 * Not a native dialog: those are OS-level modals on the Electron window and closing one
 * does not return keyboard focus to the page (see the dialogScrim note). Not a status
 * block either — that is for a page that has nothing to show, and here the page is fine.
 */
function goalNotify(text) {
  const node = document.getElementById('goalNotice')
  if (node === null) return
  node.textContent = text
  node.hidden = false
  clearTimeout(goalNotifyTimer)
  goalNotifyTimer = setTimeout(function () { node.hidden = true }, 8000)
}
let goalNotifyTimer = null


//
// Replaces every native alert / confirm / prompt. See the CSS block for why: a native dialog
// is an OS-level modal on the Electron window and closing it does not return keyboard focus
// to the app — the composer stays dead until the user switches windows and comes back.
//
// One dialog at a time, created on demand and removed on close. Every path resolves exactly
// once, including Escape and the scrim, so a caller's \`.then\` cannot be left hanging.

/** The currently open dialog's teardown, or null. */
let closeActiveDialog = null

/**
 * Show one dialog and resolve when it closes.
 *
 * @param {{title: string, body?: string, input?: string|null, confirmLabel?: string,
 *          cancelLabel?: string|null, danger?: boolean}} spec
 * @returns {Promise<{confirmed: boolean, value: string}>}
 */
function showDialog(spec) {
  return new Promise(function (resolve) {
    // Supersede any open dialog: two scrims stacked would both be clickable and the lower
    // one's buttons would be unreachable.
    if (closeActiveDialog !== null) closeActiveDialog({ confirmed: false, value: '' })

    const scrim = document.createElement('div')
    scrim.className = 'dialogScrim'
    scrim.setAttribute('role', 'dialog')
    scrim.setAttribute('aria-modal', 'true')

    const box = document.createElement('div')
    box.className = 'dialog'

    const title = document.createElement('h3')
    title.className = 'dialogTitle'
    title.textContent = spec.title
    box.appendChild(title)

    if (spec.body) {
      const body = document.createElement('p')
      body.className = 'dialogBody'
      // Bodies carry file paths and quoted error text, so they are built from a string with
      // one escape hatch for <code>. \`esc\` everything else.
      body.innerHTML = spec.body
      box.appendChild(body)
    }

    let input = null
    if (typeof spec.input === 'string') {
      input = document.createElement('input')
      input.className = 'dialogInput'
      input.value = spec.input
      input.setAttribute('aria-label', spec.title)
      box.appendChild(input)
    }

    const actions = document.createElement('div')
    actions.className = 'dialogActions'

    let settled = false
    function finish(confirmed) {
      if (settled) return
      settled = true
      closeActiveDialog = null
      document.removeEventListener('keydown', onKey, true)
      scrim.remove()
      // Returning focus to the frame's body is the whole point: with a native dialog this is
      // exactly the step that could not be done, which left the host's composer dead.
      try {
        if (document.body !== null) document.body.focus()
      } catch (error) {
        /* focus is best-effort */
      }
      resolve({ confirmed: confirmed, value: input !== null ? input.value : '' })
    }

    if (spec.cancelLabel !== null) {
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'btn'
      cancel.textContent = spec.cancelLabel || '取消'
      cancel.addEventListener('click', function () { finish(false) })
      actions.appendChild(cancel)
    }

    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = spec.danger ? 'btn btnPrimary btnDanger' : 'btn btnPrimary'
    confirm.textContent = spec.confirmLabel || '确定'
    confirm.addEventListener('click', function () { finish(true) })
    actions.appendChild(confirm)
    box.appendChild(actions)

    scrim.appendChild(box)

    // A click on the scrim — but not inside the box — dismisses. \`mousedown\` rather than
    // \`click\`: a drag that starts inside the textarea and ends on the scrim would otherwise
    // close the dialog and lose the text.
    scrim.addEventListener('mousedown', function (event) {
      if (event.target === scrim) finish(false)
    })

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      } else if (event.key === 'Enter' && input !== null && event.target === input) {
        event.preventDefault()
        finish(true)
      }
    }
    document.addEventListener('keydown', onKey, true)

    closeActiveDialog = finish

    document.body.appendChild(scrim)
    if (input !== null) {
      input.focus()
      input.select()
    } else {
      confirm.focus()
    }
  })
}

/** A message with one OK button. Resolves immediately; callers may ignore it. */
function showMessage(title, body) {
  return showDialog({ title: title, body: body || '', cancelLabel: null, confirmLabel: '确定' })
}

/** A yes/no question. @returns {Promise<boolean>} */
function showConfirm(title, body, confirmLabel) {
  return showDialog({ title: title, body: body || '', confirmLabel: confirmLabel || '确定' }).then(function (result) {
    return result.confirmed === true
  })
}

/** A one-line text question. @returns {Promise<string|null>} null when cancelled. */
function showPrompt(title, initial, confirmLabel) {
  return showDialog({ title: title, input: initial, confirmLabel: confirmLabel || '确定' }).then(function (result) {
    return result.confirmed ? result.value : null
  })
}

/** Render one line of dialog body text with the value in a code span. */
function dialogLine(label, value) {
  return esc(label) + ' <code>' + esc(value) + '</code>'
}

/** Take a snapshot as the new truth, keeping the local selection if it still exists. */
function applySnapshot(payload) {
  presetSnapshot = payload
  const agents = payload.agents || []
  if (selectedAgentId !== null && !agents.some(function (a) { return a.id === selectedAgentId })) {
    selectedAgentId = null
  }
  if (selectedAgentId === null && agents.length > 0) {
    // Prefer the active agent, so opening the tab shows what the model is using.
    const active = payload.settings && payload.settings.activeAgentId
    selectedAgentId = active !== null && active !== undefined && agents.some(function (a) { return a.id === active })
      ? active
      : agents[0].id
  }
  if (promptDirty === false) loadPrompt(selectedAgentId)
}

/** Pull one agent's full prompt text into the editor. */
function loadPrompt(agentId) {
  return presetPost({ op: 'readPrompt', agentId: agentId })
    .then(function (payload) {
      promptText = payload.text || ''
      promptDirty = false
      promptExists = payload.exists !== false
      promptInherited = payload.inherited === true
      if (state.tab === 'preset') render()
    })
    .catch(function (err) {
      report('preset-prompt-failed', String(err && err.message || err))
    })
}

function agentById(id) {
  if (presetSnapshot === null) return null
  return (presetSnapshot.agents || []).find(function (a) { return a.id === id }) || null
}

function groupById(id) {
  if (presetSnapshot === null || id === null || id === undefined) return null
  return (presetSnapshot.groups || []).find(function (g) { return g.id === id }) || null
}

/** The callouts the snapshot asks for: warnings from the store, and session truth. */
function calloutsHtml() {
  const parts = []
  const session = presetSnapshot && presetSnapshot.session
  const caps = (presetSnapshot && presetSnapshot.capabilities) || {}

  if (session !== null && session !== undefined) {
    if (session.known === false) {
      parts.push('<div class="callout">' + esc(session.reason || '没有拿到会话信息。') +
        '（切换智能体仍然有效，它对所有会话生效。）</div>')
    } else if (session.preset === 'luzzy-mode') {
      parts.push('<div class="callout" data-kind="ok">这个会话已经在 <b>LuzzyMode</b> 上。' +
        '切换下方激活的智能体，下一次请求立即生效。</div>')
    } else if (session.canSwitchToLuzzy === true) {
      parts.push('<div class="callout" data-kind="warn">这个会话当前用的是 <b>' +
        esc(session.preset || '其他预设') + '</b>。它还没有产生内容，可以切到 LuzzyMode。</div>')
    } else {
      parts.push('<div class="callout" data-kind="warn">' + esc(session.reason || '这个会话无法切换预设。') +
        '</div>')
    }
  }

  const warnings = (presetSnapshot && presetSnapshot.warnings) || []
  for (const warning of warnings) parts.push('<div class="callout" data-kind="warn">' + esc(warning) + '</div>')

  if (caps.sessionPresetSwitch === false) {
    parts.push('<div class="callout">这个部署没有提供预设服务，因此无法把会话切到 LuzzyMode。提示词编辑仍然可用。</div>')
  }
  return parts.join('')
}

function sessionBlockHtml() {
  const session = presetSnapshot && presetSnapshot.session
  const caps = (presetSnapshot && presetSnapshot.capabilities) || {}
  const buttons = []

  if (session !== null && session !== undefined && session.known !== false && session.preset !== 'luzzy-mode') {
    buttons.push('<button type="button" class="btn" id="presetSwitch"' +
      (session.canSwitchToLuzzy === true ? '' : ' disabled') + '>切到 LuzzyMode</button>')
  }
  if (caps.newSession !== false) {
    buttons.push('<button type="button" class="btn" id="presetNew">新建 LuzzyMode 会话</button>')
  }
  if (buttons.length === 0) return ''

  return '<section class="card"><div class="cardHead"><h3>会话</h3><span class="spacer"></span>' +
    (session !== null && session !== undefined && session.preset
      ? '<span class="sessionPreset">' + esc(session.preset) + '</span>'
      : '<span class="note">' + (sessionId === null ? '未拿到会话标识' : '预设未知') + '</span>') +
    '</div><div class="sessionRow">' + buttons.join('') + '</div></section>'
}

/** Group the roster into its columns: named groups in order, then everything ungrouped. */
function rosterColumns() {
  const groups = (presetSnapshot.groups || []).slice()
  const agents = (presetSnapshot.agents || []).slice()
  const columns = groups.map(function (group) {
    return {
      id: group.id,
      name: group.name,
      agents: agents.filter(function (a) { return a.groupId === group.id }),
    }
  })
  const ungrouped = agents.filter(function (a) {
    return a.groupId === null || a.groupId === undefined || !groups.some(function (g) { return g.id === a.groupId })
  })
  if (ungrouped.length > 0) columns.push({ id: null, name: '未分组', agents: ungrouped })
  return columns
}

function rosterHtml() {
  const active = presetSnapshot.settings && presetSnapshot.settings.activeAgentId
  const columns = rosterColumns()

  if ((presetSnapshot.agents || []).length === 0) {
    return '<p class="note">还没有智能体。点「＋ 智能体」新建一个；不建也可以——「默认提示词」是所有智能体的兜底。</p>'
  }

  const parts = columns.map(function (column) {
    // The group header carries its own delete affordance, and three things about how it is
    // shown were wrong before:
    //
    //   1. It sat in the same row as the group NAME and count, in the same vertical list as the
    //      agents. "默认 1 删" reads as "delete the agent called 默认", not "delete this group".
    //      It now sits at the far end of the row, after the count, so it belongs to the row's
    //      trailing edge rather than to the name.
    //   2. Its label was the bare verb 「删」 — ambiguous on its own, and it collided with the
    //      agent editor's own 「删除」 button at the bottom of the page. The design system's rule
    //      is verb + noun, so the accessible name is 「删除分组 <名>」 and the visible glyph is
    //      an icon; the title carries the consequence.
    //   3. It was permanently red. A destructive colour on every group heading turns the list
    //      into a row of alarms; the danger colour now appears only on hover/focus, where the
    //      action is actually available.
    //
    // Note the ungrouped column (id === null) is a synthetic bucket, not a stored group, so it
    // gets no delete button — there is nothing to delete.
    const head = column.id === null
      ? '<div class="rosterGroupHead"><span class="rosterGroupName">' + esc(column.name) + '</span></div>'
      : '<div class="rosterGroupHead" data-group="' + esc(column.id) + '">' +
        '<span class="rosterGroupName" data-rename="' + esc(column.id) + '" title="点击改名">' + esc(column.name) + '</span>' +
        '<span class="rosterGroupCount">' + column.agents.length + '</span>' +
        '<button type="button" class="rosterGroupDel" data-delgroup="' + esc(column.id) + '"' +
        ' title="删除分组（里面的智能体会移到未分组）"' +
        ' aria-label="删除分组 ' + esc(column.name) + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true">' + MD_ICONS.trash + '</svg>' +
        '</button>' +
        '</div>'

    const items = column.agents.map(function (agent) {
      const selected = agent.id === selectedAgentId
      return '<div class="rosterItem" role="option" tabindex="0" draggable="true" ' +
        'data-agent="' + esc(agent.id) + '" aria-selected="' + (selected ? 'true' : 'false') + '">' +
        '<span class="rosterItemHandle" title="拖动排序" aria-hidden="true">' +
        '<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">' +
        '<circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/>' +
        '<circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/>' +
        '<circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/>' +
        '</svg></span>' +
        '<span class="rosterItemName" data-pick="' + esc(agent.id) + '">' + esc(agent.name) + '</span>' +
        (agent.id === active ? '<span class="rosterItemActive">当前</span>' : '') +
        '</div>'
    }).join('')

    return '<div class="rosterGroup">' + head + items + '</div>'
  }).join('')

  return '<div class="roster" role="listbox" aria-label="智能体">' + parts + '</div>'
}

function editorHtml() {
  const agent = agentById(selectedAgentId)
  const isDefault = agent === null
  const active = presetSnapshot.settings && presetSnapshot.settings.activeAgentId
  const groups = presetSnapshot.groups || []

  const groupOptions = ['<option value="">未分组</option>'].concat(groups.map(function (group) {
    const selected = agent !== null && agent.groupId === group.id ? ' selected' : ''
    return '<option value="' + esc(group.id) + '"' + selected + '>' + esc(group.name) + '</option>'
  })).join('')

  // One subject per sentence. The four saved-states used to switch between 「改动」, 「提示词」
  // and 「内容」 as if they were different things, so the same slot described a different object
  // depending on which branch fired. All four now speak about the prompt itself, and the
  // longest one is shortened so the slot does not resize on every toggle.
  const stateText = promptDirty
    ? '有未保存的改动'
    : (promptInherited
      ? '沿用默认提示词'
      : (promptExists ? '已保存' : '还没有内容'))

  return '<section class="card"><div class="cardHead">' +
    '<h3>' + (isDefault ? '默认提示词' : '编辑智能体') + '</h3>' +
    '<span class="spacer"></span>' +
    '<span class="saveState" id="presetSaveState" data-kind="' + (promptDirty ? 'dirty' : 'saved') + '">' + esc(stateText) + '</span>' +
    '</div>' +

    (isDefault
      ? '<p class="note">没有激活任何智能体时，模型用的就是这份提示词。</p>'
      : '<div class="fieldRow">' +
        '<div class="field"><label class="fieldLabel" for="presetName">名称</label>' +
        '<input class="input" id="presetName" value="' + esc(agent.name) + '" maxlength="80"></div>' +
        '<div class="field"><label class="fieldLabel" for="presetGroup">分组</label>' +
        '<select class="select" id="presetGroup">' + groupOptions + '</select></div>' +
        '<div class="field"><label class="fieldLabel" for="presetId">id</label>' +
        '<input class="input" id="presetId" value="' + esc(agent.id) + '" readonly></div>' +
        '</div>') +

    '<div class="field"><label class="fieldLabel" for="presetPrompt">System prompt' +
    (promptInherited ? '<span class="note"> · 正在沿用默认提示词</span>' : '') + '</label>' +
    // One bordered box: toolbar, ONE surface, status line.
    //
    // The surface is the RENDERED document, made editable — that is what "live preview" means
    // here: the Markdown markers are gone and you type straight into the formatted result.
    // Source mode swaps in the raw textarea. Exactly one is visible per mode, and the textarea
    // is never removed from the DOM (doing so would throw away its scroll position and undo
    // stack on every mode change).
    '<div class="mdEditor">' +
    markdownToolsHtml() +
    '<div class="mdArea" data-mode="' + esc(promptMode) + '" id="presetArea">' +
    // contenteditable only in live mode; reading mode shows the same markup, immutable.
    // data-empty drives the hint below; it is rendered here and re-synced on every edit, so
    // the hint tracks the document rather than the focus state.
    '<div class="mdVisual" id="presetVisual" data-empty="' + (promptText.trim() === '' ? 'true' : 'false') + '" contenteditable="' +
    (promptMode === 'live' ? 'true' : 'false') + '" role="textbox" aria-multiline="true" ' +
    'aria-label="System prompt（Markdown 渲染视图）">' +
    renderMarkdown(promptText) + '</div>' +
    '<textarea class="mdLayer" id="presetPrompt" spellcheck="false" ' +
    'aria-label="System prompt（源码）" placeholder="在这里写这个智能体的 system prompt…">' +
    esc(promptText) + '</textarea>' +
    '</div>' +
    markdownFootHtml() +
    '</div></div>' +

    // Button hierarchy: exactly one emphasised action per view.
    //
    // 保存 is the only filled button. It used to share the row with a bordered red 删除 of
    // similar weight, and with 已是当前 rendered as a dead button — so the row read as three
    // peer choices when only one of them was the thing to do. Now:
    //   - 保存        filled (the one action)
    //   - 设为当前    bordered (an ordinary action)
    //   - 停用        bordered (ordinary, and reversible)
    //   - 已是当前    a STATE, not a button — it says what is already true, so it is a badge
    //   - 删除        text weight, not a bordered peer; it is destructive but it is not primary
    '<div class="btnRow">' +
    '<button type="button" class="btn btnPrimary" id="presetSave">保存</button>' +
    (isDefault ? '' : (agent.id === active
      ? '<span class="stateBadge" title="这个智能体已经生效">已是当前</span>'
      : '<button type="button" class="btn" id="presetActivate">设为当前（立即生效）</button>')) +
    (isDefault ? '' : '<button type="button" class="btn" id="presetActivateNone"' + (active === null || active === undefined ? ' disabled' : '') + '>停用（回到默认）</button>') +
    '<span class="spacer"></span>' +
    (isDefault ? '' : '<button type="button" class="btn btnText btnDanger" id="presetDelete">删除</button>') +
    '</div>' +
    '</section>'
}

/**
 * The Markdown toolbar: icon buttons in divider-separated groups.
 *
 * Buttons are rendered from MD_GROUPS, so the icon, the accessible name and the
 * "what does this insert" rule cannot drift apart — and so a test can assert the set without
 * depending on rendered markup.
 *
 * Every button carries a title attribute AND an aria-label: an icon alone is not a name, and
 * the title attribute is not exposed to assistive technology consistently.
 */
function markdownToolsHtml() {
  return '<div class="mdBar" role="toolbar" aria-label="Markdown 格式">' +
    MD_GROUPS.map(function (group) {
      return group.map(function (tool) {
        const glyph = tool.text !== undefined
          ? esc(tool.text)
          : '<svg viewBox="0 0 24 24" aria-hidden="true">' + (MD_ICONS[tool.icon] || '') + '</svg>'
        // data-on is written by the renderer from the caret's own line, never speculatively.
        return '<button type="button" class="mdBtn" data-md="' + tool.id + '" data-on="false"' +
          ' title="' + esc(tool.label) + '" aria-label="' + esc(tool.label) + '">' + glyph + '</button>'
      }).join('')
    }).join('<span class="mdDivider" aria-hidden="true"></span>') +
    '</div>'
}

/** The status line: character count on the left, the mode picker on the right. */
function markdownFootHtml() {
  const current = MD_MODES.filter(function (mode) { return mode.id === promptMode })[0] || MD_MODES[0]
  return '<div class="mdFoot">' +
    '<span class="mdFootCount" id="presetCount">字符：' + promptText.length + '</span>' +
    '<span class="spacer"></span>' +
    '<div class="mdMode">' +
    '<button type="button" class="mdModeBtn" id="presetModeBtn" aria-haspopup="menu" aria-expanded="false">' +
    '<span id="presetModeLabel">' + esc(current.label) + '</span>' +
    '<svg viewBox="0 0 24 24" aria-hidden="true">' + MD_ICONS.chevron + '</svg>' +
    '</button>' +
    '<div class="mdMenu" id="presetModeMenu" role="menu" hidden>' +
    MD_MODES.map(function (mode) {
      return '<button type="button" class="mdMenuItem" role="menuitemradio" data-mode="' + mode.id + '"' +
        ' aria-checked="' + (mode.id === promptMode ? 'true' : 'false') + '">' +
        '<svg class="mdCheck" viewBox="0 0 24 24" aria-hidden="true">' +
        (mode.id === promptMode ? MD_ICONS.check : '') + '</svg>' +
        '<span class="mdMenuItemLabel">' + esc(mode.label) + '</span>' +
        '</button>'
    }).join('') +
    '</div></div></div>'
}

/**
 * Apply one toolbar command to a textarea, returning the next value plus where the caret
 * and selection should land.
 *
 * Kept pure — it takes a value and a range and returns the next ones, touching no DOM — so
 * the wrap / unwrap / line-prefix rules can be asserted directly instead of through a
 * browser. The three cases that are easy to get wrong and are covered here:
 *
 *   1. **Round trip.** Pressing 加粗 on text that is already bold removes the markers. A
 *      toolbar that only adds markers makes bold impossible to undo without hand-editing.
 *   2. **Empty selection.** Wrapping nothing produces four asterisks with the caret in the
 *      middle, not a marker pair the user has to find and split.
 *   3. **Line prefixes** (heading, quote, list) apply to every line the selection touches,
 *      and toggle off if all of them already have it.
 *
 * @param {string} value - current textarea contents.
 * @param {number} start - selection start.
 * @param {number} end - selection end.
 * @param {string} id - one of the ids in MD_TOOLS.
 * @returns {{value: string, start: number, end: number}}
 */
function applyMarkdownTool(value, start, end, id) {
  const text = String(value)
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(end, text.length))
  const selected = text.slice(from, to)

  const wrap = function (marker) {
    const len = marker.length
    const before = text.slice(Math.max(0, from - len), from)
    const after = text.slice(to, to + len)
    // Toggle off only when the SAME marker immediately brackets the selection — so bold
    // inside italics unwraps cleanly instead of eating the wrong pair.
    if (before === marker && after === marker) {
      return { value: text.slice(0, from - len) + selected + text.slice(to + len), start: from - len, end: to - len }
    }
    // An already-wrapped selection whose range sits inside the markers also toggles off.
    if (selected.length >= 2 * len && selected.slice(0, len) === marker && selected.slice(-len) === marker) {
      const inner = selected.slice(len, selected.length - len)
      return { value: text.slice(0, from) + inner + text.slice(to), start: from, end: from + inner.length }
    }
    return {
      value: text.slice(0, from) + marker + selected + marker + text.slice(to),
      start: from + len,
      end: to + len,
    }
  }

  const prefixLines = function (prefix, marker) {
    const lineStart = text.lastIndexOf('\\n', from - 1) + 1
    const lineEndRaw = text.indexOf('\\n', to)
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw
    const block = text.slice(lineStart, lineEnd)
    const lines = block.split('\\n')
    // The marker is a regex, not a function — it has to be applied with .test(). It is also
    // deliberately non-global: a global regex carries lastIndex between .test() calls and
    // would report alternating results for the same line.
    const allPrefixed = lines.every(function (line) { return marker.test(line) })
    const next = lines.map(function (line) {
      const bare = line.replace(marker, '')
      return allPrefixed ? bare : prefix + bare
    }).join('\\n')
    return { value: text.slice(0, lineStart) + next + text.slice(lineEnd), start: lineStart, end: lineStart + next.length }
  }

  /**
   * Set (or clear) the ATX heading level over the selected lines.
   *
   * Distinct from prefixLines because a heading has a LEVEL, not just a marker: applying it
   * must replace whatever level was there. Treating it as a plain prefix made H3 on "## x"
   * produce "x" — the heading was deleted, which is the opposite of what was asked.
   */
  const setHeading = function (level) {
    const prefix = '#'.repeat(level) + ' '
    const lineStart = text.lastIndexOf('\\n', from - 1) + 1
    const lineEndRaw = text.indexOf('\\n', to)
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw
    const lines = text.slice(lineStart, lineEnd).split('\\n')
    // Already this exact level on every touched line -> the press removes it.
    const same = lines.every(function (line) { return line.indexOf(prefix) === 0 })
    const next = lines.map(function (line) {
      const bare = line.replace(/^#{1,6} /, '')
      return same ? bare : prefix + bare
    }).join('\\n')
    return { value: text.slice(0, lineStart) + next + text.slice(lineEnd), start: lineStart, end: lineStart + next.length }
  }

  switch (id) {
    case 'bold': return wrap('**')
    case 'italic': return wrap('*')
    case 'code': return wrap('\`')
    case 'strike': return wrap('~~')
    // h1/h2/h3 SET the level rather than toggling. Pressing H3 on "## x" must produce
    // "### x" — the naive toggle (strip any heading, then add) produced "x" instead, silently
    // deleting the heading when the user asked to change its level. Pressing the SAME level
    // again is the only case that removes it, which is what makes it feel like a toggle.
    case 'h1': return setHeading(1)
    case 'h2': return setHeading(2)
    case 'h3': return setHeading(3)
    case 'quote': return prefixLines('> ', /^> ?/)
    case 'bullet': return prefixLines('- ', /^\\s*[-*] /)
    case 'ordered': return prefixLines('1. ', /^\\s*\\d+\\. /)
    case 'task': return prefixLines('- [ ] ', /^\\s*[-*] \\[[ xX]\\] /)
    case 'link': {
      const label = selected === '' ? '链接文字' : selected
      const inserted = '[' + label + '](https://)'
      // Caret lands inside the href, so the URL is the next thing typed.
      return { value: text.slice(0, from) + inserted + text.slice(to), start: from + label.length + 3, end: from + inserted.length - 1 }
    }
    case 'hr': {
      const inserted = '\\n\\n---\\n\\n'
      return { value: text.slice(0, from) + inserted + text.slice(to), start: from + inserted.length, end: from + inserted.length }
    }
    case 'codeblock': {
      // Fences go on their own lines, so an inline selection becomes a block rather than a
      // run of stray fence characters glued to the surrounding prose.
      const block = '\\n\\n\`\`\`\\n' + (selected === '' ? '' : selected) + '\\n\`\`\`\\n\\n'
      const caret = from + 5 + (selected === '' ? 0 : selected.length)
      return { value: text.slice(0, from) + block + text.slice(to), start: caret, end: caret }
    }
    case 'table': {
      // A minimal 2x2 table with the header row already formatted, caret in the first cell.
      const rows = '\\n\\n| 列 1 | 列 2 |\\n| --- | --- |\\n|  |  |\\n\\n'
      const caret = from + 5
      return { value: text.slice(0, from) + rows + text.slice(to), start: caret, end: caret }
    }
    case 'clear': {
      // This button is labelled 清除行内格式 ("clear INLINE formatting"), so it strips inline
      // markers only — bold, italic, strike, inline code. Line-anchored markers (headings,
      // quotes, lists) are structure, not decoration, and are deliberately left alone.
      //
      // An empty selection strips the whole current line, because that is what "clear the
      // formatting here" means when the caret is simply sitting in the text; stripping only
      // the caret's own two characters would do nothing at all.
      const strip = (s) => s
        .replace(/\\*\\*([^*\\n]+)\\*\\*/g, '$1')
        .replace(/~~([^~\\n]+)~~/g, '$1')
        .replace(/\`([^\`\\n]+)\`/g, '$1')
        .replace(/\\*(\\S(?:[^*\\n]*\\S)?)\\*/g, '$1')
      if (selected !== '') {
        const next = strip(selected)
        return { value: text.slice(0, from) + next + text.slice(to), start: from, end: from + next.length }
      }
      const lineStart = text.lastIndexOf('\\n', from - 1) + 1
      const lineEndRaw = text.indexOf('\\n', from)
      const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw
      const next = strip(text.slice(lineStart, lineEnd))
      return { value: text.slice(0, lineStart) + next + text.slice(lineEnd), start: lineStart, end: lineStart + next.length }
    }
    default: return { value: text, start: from, end: to }
  }
}


/**
 * Serialize an edited rendered document back to Markdown — the ONE direction that can damage
 * the user's prompt, so it is deliberately conservative.
 *
 * WHY THIS IS THE RISKY HALF
 *
 * Rendering is lossy in one direction only: Markdown -> HTML can drop nothing the reader needs.
 * HTML -> Markdown cannot recover formatting the browser invented. So this serializer:
 *
 *   - reads ONLY the semantic tags renderMarkdown itself emits (p, h1-h6, ul, ol, li, blockquote,
 *     pre, code, strong, em, del, a, hr, table, thead, tbody, tr, th, td, br);
 *   - emits the SAME text for anything else, so an unknown element degrades to its text rather
 *     than disappearing;
 *   - never rewrites the WHOLE document from the DOM unless the rendered surface was actually
 *     edited. The caller keeps the original string and replaces it only on a real edit — that
 *     is what protects constructs this serializer does not model (unusual spacing, tables with
 *     padded separators, anything hand-written) from being normalized the moment someone merely
 *     LOOKS at the visual view.
 *
 * ROUND-TRIP CONTRACT, asserted by tools/test-preset-markdown.mjs: for every Markdown sample in
 * that suite, serialize(render(md)) must produce Markdown that renders back to the same HTML.
 * It does not have to be byte-identical to the input — a browser cannot promise that — but it
 * must not lose content or structure.
 *
 * @param {Node} root - the rendered container.
 * @returns {string} Markdown.
 */
function serializeMarkdown(root) {
  const out = []

  /** Inline content of a node, as Markdown. */
  const inline = (node) => {
    let text = ''
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {                       // text
        // Newlines inside a text node would break block structure, so they become spaces.
        text += child.nodeValue.replace(/\\s*\\n\\s*/g, ' ')
        continue
      }
      if (child.nodeType !== 1) continue                // comments and the like are dropped
      const tag = child.tagName.toLowerCase()
      const inner = inline(child)
      switch (tag) {
        case 'strong': case 'b': text += '**' + inner + '**'; break
        case 'em': case 'i': text += '*' + inner + '*'; break
        case 'del': case 's': case 'strike': text += '~~' + inner + '~~'; break
        case 'code': {
          // A code span containing a backtick needs a longer fence; using the shortest fence
          // that cannot appear inside is what keeps it a single span on the way back.
          const fence = inner.includes('\`') ? '\`\`' : '\`'
          text += fence + inner + fence
          break
        }
        case 'a': {
          const href = child.getAttribute('href') || ''
          // Only the schemes renderMarkdown turns into links; anything else was never a link,
          // so it stays as its own text and no syntax is invented for it.
          text += /^(https?:|mailto:)/i.test(href) ? '[' + inner + '](' + href + ')' : inner
          break
        }
        case 'br': text += '  \\n'; break
        // Anything unknown keeps its text; dropping it would lose the user's words.
        default: text += inner
      }
    }
    return text
  }

  /** One block-level node, appended as Markdown. */
  const block = (node, indent) => {
    const tag = node.tagName.toLowerCase()
    const pad = indent || ''

    if (/^h[1-6]$/.test(tag)) {
      out.push(pad + '#'.repeat(Number(tag[1])) + ' ' + inline(node).trim())
      return
    }
    if (tag === 'p') {
      out.push(pad + inline(node).trim())
      return
    }
    if (tag === 'hr') {
      out.push(pad + '---')
      return
    }
    if (tag === 'pre') {
      // The language marker is not preserved: renderMarkdown does not emit one, so inventing a
      // language here would be a guess written into the user's file.
      const code = node.textContent.replace(/\\n$/, '')
      out.push(pad + '\`\`\`')
      for (const line of code.split('\\n')) out.push(line)
      out.push(pad + '\`\`\`')
      return
    }
    if (tag === 'blockquote') {
      for (const line of blocksOf(node, '')) out.push(pad + '> ' + line)
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(node.children).filter((c) => c.tagName.toLowerCase() === 'li')
      items.forEach((li, index) => {
        const box = li.querySelector ? li.querySelector('.mdBox') : null
        const done = box !== null && box.getAttribute('data-done') === '1'
        let marker = tag === 'ol' ? (index + 1) + '. ' : '- '
        if (box !== null) marker += '[' + (done ? 'x' : ' ') + '] '
        // Nested lists are indented under their parent rather than flattened, so a nested
        // structure is not silently lost.
        //
        // The item's own text excludes the nested list, so the inline walker is handed a
        // SHALLOW wrapper object rather than a real element: building one with
        // document.createElement would make this function depend on a DOM that only exists in
        // the browser, and it is lifted out of the bundle and exercised directly by the tests.
        const nested = Array.from(li.children).filter((c) => /^(ul|ol)$/.test(c.tagName.toLowerCase()))
        const own = { childNodes: Array.from(li.childNodes).filter((child) => !nested.includes(child)) }
        out.push(pad + marker + inline(own).trim())
        for (const sub of nested) block(sub, pad + '  ')
      })
      return
    }
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr'))
      if (rows.length === 0) return
      const cellsOf = (tr) => Array.from(tr.children).map((c) => inline(c).trim().replace(/\\|/g, '\\\\|'))
      const header = cellsOf(rows[0])
      out.push(pad + '| ' + header.join(' | ') + ' |')
      out.push(pad + '|' + header.map(() => '---').join('|') + '|')
      for (const tr of rows.slice(1)) out.push(pad + '| ' + cellsOf(tr).join(' | ') + ' |')
      return
    }
    // Anything else is not a block this serializer knows; its text is kept as a paragraph so
    // nothing the user wrote can vanish.
    const text = inline(node).trim()
    if (text !== '') out.push(pad + text)
  }

  /**
   * Walk a container's children, returning one Markdown line per block-level child.
   *
   * A container may hold BARE TEXT rather than elements — renderMarkdown puts a blockquote's
   * words directly inside it, with no paragraph wrapper. Returning an empty list for that case
   * silently dropped the text, so the container's own inline content is used as the fallback.
   */
  const blocksOf = (node, indent) => {
    const saved = out.length
    let sawElement = false
    for (const child of node.childNodes) {
      if (child.nodeType === 1) { sawElement = true; block(child, indent) }
      else if (child.nodeType === 3 && child.nodeValue.trim() !== '') {
        out.push((indent || '') + child.nodeValue.trim())
      }
    }
    let produced = out.slice(saved)
    if (!sawElement) {
      const text = inline(node).trim()
      produced = text === '' ? [] : [text]
    }
    out.length = saved
    return produced
  }

  // renderMarkdown wraps its output in a div carrying the markdown class, and the frame injects
  // that into the visual surface — so the element handed to this function holds a wrapper whose
  // children ARE the blocks. Without unwrapping it, the walk hits the wrapper, falls into the
  // unknown-element branch, and flattens the whole document into one line of glued-together
  // text: a heading and the paragraph after it became "Titleplain paragraph". Descending one
  // level when the root has a single container child keeps the walk on real blocks.
  let container = root
  const onlyChild = root.childNodes.length === 1 ? root.childNodes[0] : null
  if (onlyChild !== null && onlyChild.nodeType === 1 && /^(div|section|article)$/i.test(onlyChild.tagName)) {
    container = onlyChild
  }

  for (const child of container.childNodes) {
    if (child.nodeType === 1) block(child, '')
    else if (child.nodeType === 3 && child.nodeValue.trim() !== '') out.push(child.nodeValue.trim())
  }

  // Blocks are separated by exactly one blank line — that is what keeps a heading from being
  // glued onto the paragraph after it, which is how they would otherwise re-render as ONE
  // paragraph and lose the heading entirely.
  const text = out.join('\\n').replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]+$/gm, '').trimEnd()
  return text === '' ? '' : text + '\\n'
}

/**
 * Which tool buttons describe the caret's current line, so the toolbar can tint them.
 *
 * This is read from the text rather than tracked as state: the line under the caret IS the
 * fact, and a cached "is bold" flag would drift from it the moment the user typed a marker by
 * hand. Cheap enough to recompute on every caret move — it looks at one line.
 *
 * @param {string} value - textarea contents.
 * @param {number} caret - selection start.
 * @returns {Record<string, boolean>}
 */
function activeToolsFor(value, caret) {
  const text = String(value)
  const at = Math.max(0, Math.min(caret, text.length))
  const lineStart = text.lastIndexOf('\\n', at - 1) + 1
  const lineEndRaw = text.indexOf('\\n', at)
  const line = text.slice(lineStart, lineEndRaw === -1 ? text.length : lineEndRaw)
  const heading = /^(#{1,6}) /.exec(line)
  return {
    bold: /\\*\\*[^*\\n]+\\*\\*/.test(line),
    italic: /(^|[^*])\\*[^*\\n]+\\*(?!\\*)/.test(line),
    strike: /~~[^~\\n]+~~/.test(line),
    code: /\`[^\`\\n]+\`/.test(line),
    h1: heading !== null && heading[1].length === 1,
    h2: heading !== null && heading[1].length === 2,
    h3: heading !== null && heading[1].length === 3,
    quote: /^> ?/.test(line),
    bullet: /^\\s*[-*] \\[[ xX]\\] /.test(line) ? false : /^\\s*[-*] /.test(line),
    ordered: /^\\s*\\d+\\. /.test(line),
    task: /^\\s*[-*] \\[[ xX]\\] /.test(line),
  }
}


function renderPreset() {
  if (presetStatus === 'idle' || presetStatus === 'loading') {
    content.innerHTML = '<div class="status"><span>正在读取预设设置…</span>' +
      '<div class="skeleton" style="width:40%;height:20px"></div>' +
      '<div class="skeleton" style="width:100%;height:200px"></div></div>'
    return
  }
  if (presetStatus === 'error') {
    content.innerHTML = statusBlock('预设设置读不出来，可以重试。', false, presetError) +
      '<div class="status"><button type="button" id="presetRetry">重试</button></div>'
    const retry = document.getElementById('presetRetry')
    if (retry !== null) retry.addEventListener('click', function () { loadPreset() })
    return
  }

  content.innerHTML =
    calloutsHtml() +
    sessionBlockHtml() +
    '<div class="presetLayout">' +
      '<section class="card"><div class="cardHead"><h3>智能体</h3><span class="spacer"></span>' +
      '<button type="button" class="btn btnSmall" id="presetAddGroup">＋ 分组</button>' +
      '<button type="button" class="btn btnSmall" id="presetAddAgent">＋ 智能体</button>' +
      '</div>' +
      '<button type="button" class="rosterItem" id="pickDefault" aria-selected="' +
      (selectedAgentId === null ? 'true' : 'false') + '">' +
      '<span class="rosterItemName">默认提示词</span>' +
      ((presetSnapshot.settings.activeAgentId === null || presetSnapshot.settings.activeAgentId === undefined)
        ? '<span class="rosterItemActive">当前</span>' : '') +
      '</button>' +
      rosterHtml() +
      '</section>' +
      '<div class="editor">' + editorHtml() + '</div>' +
    '</div>'

  wirePreset()
}

/** Attach the sub-page's listeners. Called after every render of the preset tab. */
function wirePreset() {
  const saveState = document.getElementById('presetSaveState')

  const textarea = document.getElementById('presetPrompt')

  // ---- markdown editor
  //
  // Two surfaces, one string. The visual surface IS the rendered document; the textarea holds
  // the raw Markdown. Whichever one the user is typing into owns the truth, and the other is
  // re-rendered from it on a mode switch — never simultaneously, so they cannot fight.
  //
  // The serializer is the risky direction (see its own note), so the visual surface is only
  // allowed to REPLACE promptText when it was genuinely edited. Merely opening the tab or
  // switching modes never round-trips the document through HTML, which is what protects any
  // construct the serializer does not model.
  const visual = document.getElementById('presetVisual')
  const count = document.getElementById('presetCount')
  const syncCount = function () {
    if (count !== null) count.textContent = '字符：' + promptText.length
  }
  const markDirty = function () {
    promptDirty = true
    if (saveState !== null) { saveState.textContent = '有未保存的改动'; saveState.dataset.kind = 'dirty' }
    syncCount()
  }

  /**
   * Re-render the visual surface from the current Markdown.
   *
   * This is the ONLY place that assigns the rendered HTML, because the empty-state hint has to
   * move in lockstep with it: the hint shows when the document is empty, so every path that
   * redraws the document must also restate whether it is empty. Three call sites used to assign
   * innerHTML directly, and one of them would eventually have forgotten the flag.
   *
   * Declared OUT here rather than inside the conditional below, because the toolbar's handler
   * also redraws the surface and is wired outside that block — a block-scoped version would be
   * invisible there and the guard would silently skip the redraw.
   */
  const syncVisual = function () {
    if (visual === null) return
    visual.innerHTML = renderMarkdown(promptText)
    visual.dataset.empty = promptText.trim() === '' ? 'true' : 'false'
  }

  if (visual !== null && textarea !== null) {
    visual.addEventListener('input', function () {
      // Reading the edited DOM back is the only way to learn what was typed into it, and it is
      // done HERE — on a real edit — rather than on render.
      promptText = serializeMarkdown(visual)
      // The textarea is what 保存 reads from (and what the rig asserts on), so it has to carry
      // the same string. Writing it here — not in a render — keeps the two surfaces from ever
      // disagreeing about the document.
      textarea.value = promptText
      // Keep the empty-state hint honest without a re-render: after the last character is
      // deleted the hint must come back, and after the first one is typed it must go.
      visual.dataset.empty = promptText.trim() === '' ? 'true' : 'false'
      markDirty()
      syncActive()
    })
    // Pasting arrives as HTML by default, which would smuggle in styling the serializer does
    // not model. Forcing plain text keeps the paste to characters the user can see.
    visual.addEventListener('paste', function (event) {
      const text = (event.clipboardData || window.clipboardData)
      if (text === undefined || text === null) return
      event.preventDefault()
      const plain = text.getData('text/plain')
      if (plain !== '') document.execCommand('insertText', false, plain)
    })
    // The caret can land in a fresh empty block; give it a placeholder so the box does not look
    // broken when the document is empty.
    visual.addEventListener('focus', function () {
      if (visual.textContent.trim() === '' && visual.querySelector('p') === null) {
        visual.innerHTML = '<p><br></p>'
      }
    })
    visual.addEventListener('blur', function () { syncActive() })
  }

  /** Tint the buttons that describe the caret's current line. */
  const activeButtons = Array.prototype.slice.call(document.querySelectorAll('[data-md]'))
  const syncActive = function () {
    if (textarea === null) return
    // In live mode the caret lives in the visual surface, which has no line numbers, so the
    // tint is derived from the Markdown the caret's block corresponds to. In source mode the
    // textarea is the caret's home and its own selection is the truth.
    const on = activeToolsFor(promptText, textarea.selectionStart)
    for (const node of activeButtons) node.dataset.on = on[node.dataset.md] === true ? 'true' : 'false'
  }

  if (textarea !== null) {
    textarea.addEventListener('input', function () {
      promptText = textarea.value
      // The rendered surface is not redrawn on every keystroke in source mode (it is hidden),
      // but the empty flag is cheap and keeps the two surfaces from disagreeing the moment the
      // user switches back to live.
      if (visual !== null) visual.dataset.empty = promptText.trim() === '' ? 'true' : 'false'
      markDirty()
      syncActive()
    })
  }

  document.querySelectorAll('[data-md]').forEach(function (node) {
    // A toolbar button must not steal focus from the textarea: mousedown is what moves it,
    // and losing focus would collapse the selection the command is about to act on.
    node.addEventListener('mousedown', function (event) { event.preventDefault() })
    node.addEventListener('click', function () {
      if (textarea === null) return
      const result = applyMarkdownTool(textarea.value, textarea.selectionStart, textarea.selectionEnd, node.dataset.md)
      if (typeof textarea.setRangeText === 'function') {
        // Replace the whole value in one undoable edit, then place the caret.
        textarea.focus()
        textarea.setRangeText(result.value, 0, textarea.value.length, 'end')
      } else {
        textarea.value = result.value
        textarea.focus()
      }
      textarea.setSelectionRange(result.start, result.end)
      // Reuse the input handler's bookkeeping so the dirty badge and character count cannot
      // disagree with the textarea's actual contents.
      promptText = textarea.value
      markDirty()
      // The toolbar's transforms are string-based, so they always run against the Markdown and
      // the visual surface is re-rendered from the result. Doing it here — rather than trying to
      // apply rich-text commands to the DOM — is what keeps one authoring path for both modes.
      // The hint flag rides along inside syncVisual, so it cannot fall out of step.
      if (promptMode === 'live') syncVisual()
      syncActive()
      report('preset-md-tool', node.dataset.md)
    })
  })

  // In live mode the preview tracks the text as it is typed. Reading mode and source mode do
  // not need this, so the work is skipped rather than done and thrown away.
  if (textarea !== null) {
    const onCaret = function () { syncActive() }
    textarea.addEventListener('keyup', onCaret)
    textarea.addEventListener('click', onCaret)
    textarea.addEventListener('select', onCaret)
    syncActive()
  }

  // ---- the mode menu
  const modeBtn = document.getElementById('presetModeBtn')
  const modeMenu = document.getElementById('presetModeMenu')
  const closeModeMenu = function () {
    modeMenuOpen = false
    if (modeMenu !== null) modeMenu.hidden = true
    if (modeBtn !== null) modeBtn.setAttribute('aria-expanded', 'false')
  }
  if (modeBtn !== null && modeMenu !== null) {
    modeBtn.addEventListener('click', function (event) {
      event.stopPropagation()
      modeMenuOpen = !modeMenuOpen
      modeMenu.hidden = !modeMenuOpen
      modeBtn.setAttribute('aria-expanded', modeMenuOpen ? 'true' : 'false')
    })
    // A click anywhere else closes it. Registered on the document, removed with the frame's
    // own lifetime — the frame is torn down wholesale, so no explicit teardown is needed.
    document.addEventListener('click', closeModeMenu)
    modeMenu.addEventListener('click', function (event) { event.stopPropagation() })
  }

  // ONLY the menu items may switch modes.
  //
  // The selector here used to be the bare data-mode attribute selector, and the AREA ITSELF
  // carries that same attribute (see the .mdArea element in the editor markup, tagged with the
  // current mode). Selecting the area as well made every click inside the editor bubble up to
  // its own mode handler, which re-rendered the surface and re-focused it — wiping the caret
  // the click had just placed. The symptoms were exactly "typing always lands at the very
  // start" and "no other paragraph can be reached", because the caret was reset to position 0
  // on every click.
  document.querySelectorAll('.mdMenuItem[data-mode]').forEach(function (node) {
    node.addEventListener('click', function () {
      const next = node.dataset.mode
      if (MD_MODES.filter(function (m) { return m.id === next }).length === 0) return
      // The textarea is the source of truth; read it rather than trusting the cached copy.
      if (textarea !== null && textarea.value !== promptText) promptText = textarea.value
      promptMode = next
      // Visibility is carried by the area's data-mode only. Toggling a hidden property as
      // well would be a second source of truth that the next re-render overwrites — the two
      // would eventually disagree and the panes would show both or neither.
      const area = document.getElementById('presetArea')
      if (area !== null) area.dataset.mode = next
      const label = document.getElementById('presetModeLabel')
      const current = MD_MODES.filter(function (m) { return m.id === next })[0]
      if (label !== null && current) label.textContent = current.label
      document.querySelectorAll('.mdMenuItem').forEach(function (item) {
        const isOn = item.dataset.mode === next
        item.setAttribute('aria-checked', isOn ? 'true' : 'false')
        const check = item.querySelector('.mdCheck')
        if (check !== null) check.innerHTML = isOn ? MD_ICONS.check : ''
      })
      // Each mode is refreshed on the way IN, so nothing can show content older than the text
      // it claims to describe.
      if (visual !== null) {
        // Live and reading show the same rendered document; only editability differs. It is
        // re-rendered from promptText on entry, because a source-mode edit may have changed it.
        // syncVisual, not a direct assignment: it also restates the empty-state flag.
        syncVisual()
        visual.setAttribute('contenteditable', next === 'live' ? 'true' : 'false')
      }
      closeModeMenu()
      if (next === 'live' && visual !== null) visual.focus()
      report('preset-md-mode', next)
    })
  })

  const pickDefault = document.getElementById('pickDefault')
  if (pickDefault !== null) {
    pickDefault.addEventListener('click', function () {
      confirmDiscard().then(function (ok) {
        if (!ok) return
        selectedAgentId = null
        loadPrompt(null)
      })
    })
  }
  document.querySelectorAll('[data-pick]').forEach(function (node) {
    node.addEventListener('click', function () {
      const id = node.dataset.pick
      if (id === selectedAgentId) return
      confirmDiscard().then(function (ok) {
        if (!ok) return
        selectedAgentId = id
        loadPrompt(id)
      })
    })
  })

  const save = document.getElementById('presetSave')
  if (save !== null) {
    save.addEventListener('click', function () {
      save.disabled = true
      if (saveState !== null) { saveState.textContent = '正在保存…'; saveState.dataset.kind = '' }
      presetPost({ op: 'setPrompt', agentId: selectedAgentId, text: promptText, sessionId: sessionId })
        .then(function (payload) {
          promptDirty = false
          report('preset-save-ok', { agentId: selectedAgentId, bytes: promptText.length })
          applySnapshot(payload)
          if (state.tab === 'preset') render()
        })
        .catch(function (err) {
          report('preset-save-failed', String(err && err.message || err))
          if (saveState !== null) {
            saveState.textContent = '保存失败：' + String(err && err.message || err)
            saveState.dataset.kind = 'failed'
          }
          save.disabled = false
        })
    })
  }

  const activate = document.getElementById('presetActivate')
  if (activate !== null) {
    activate.addEventListener('click', function () {
      activate.disabled = true
      presetPost({ op: 'setActive', agentId: selectedAgentId, sessionId: sessionId })
        .then(function (payload) {
          report('preset-switch-ok', { agentId: selectedAgentId })
          applySnapshot(payload)
          if (state.tab === 'preset') render()
        })
        .catch(function (err) {
          report('preset-switch-failed', String(err && err.message || err))
          showMessage('切换失败', esc(String(err && err.message || err)))
          activate.disabled = false
        })
    })
  }

  const activateNone = document.getElementById('presetActivateNone')
  if (activateNone !== null) {
    activateNone.addEventListener('click', function () {
      activateNone.disabled = true
      presetPost({ op: 'setActive', agentId: null, sessionId: sessionId })
        .then(function (payload) { applySnapshot(payload); if (state.tab === 'preset') render() })
        .catch(function (err) { showMessage('停用失败', esc(String(err && err.message || err))); activateNone.disabled = false })
    })
  }

  const name = document.getElementById('presetName')
  const group = document.getElementById('presetGroup')
  const applyMeta = function () {
    if (selectedAgentId === null) return
    presetPost({
      op: 'upsertAgent',
      id: selectedAgentId,
      name: name !== null ? name.value : undefined,
      groupId: group !== null ? (group.value === '' ? null : group.value) : undefined,
      sessionId: sessionId,
    })
      .then(function (payload) { applySnapshot(payload); if (state.tab === 'preset') render() })
      .catch(function (err) { showMessage('保存失败', esc(String(err && err.message || err))) })
  }
  if (name !== null) name.addEventListener('change', applyMeta)
  if (group !== null) group.addEventListener('change', applyMeta)

  const del = document.getElementById('presetDelete')
  if (del !== null) {
    del.addEventListener('click', function () {
      const agent = agentById(selectedAgentId)
      if (agent === null) return
      // Says what actually happens: the row goes, the prompt file is MOVED to archive/ so it
      // is recoverable. The earlier text promised an unrecoverable deletion of a file that
      // was not deleted at all — wrong in both directions at once.
      showConfirm(
        '删除智能体「' + agent.name + '」？',
        '提示词会移到 store 的 <code>archive/</code> 目录（可以手动找回），不再是激活名单的一部分。',
        '删除',
      ).then(function (confirmed) {
        if (!confirmed) return
        presetPost({ op: 'removeAgent', id: selectedAgentId, sessionId: sessionId })
          .then(function (payload) {
            selectedAgentId = null
            promptDirty = false
            applySnapshot(payload)
            if (state.tab === 'preset') render()
            const archived = payload && payload.archived
            if (archived && archived.moved === true) {
              showMessage('已删除', dialogLine('提示词备份在', archived.to))
            } else if (archived && archived.reason) {
              // The roster write succeeded and the file move did not — report the real state
              // rather than a success the user would discover was false later.
              showMessage('智能体已移除，但提示词文件没能移动', esc(archived.reason))
            }
          })
          .catch(function (err) { showMessage('删除失败', esc(String(err && err.message || err))) })
      })
    })
  }

  const addAgent = document.getElementById('presetAddAgent')
  if (addAgent !== null) {
    addAgent.addEventListener('click', function () {
      showPrompt('新智能体的名字', '新智能体', '新建').then(function (name) {
        if (name === null) return
        const group = groupById(selectedAgentId === null ? null : (agentById(selectedAgentId) || {}).groupId)
        presetPost({
          op: 'upsertAgent',
          name: name,
          groupId: group === null ? null : group.id,
          sessionId: sessionId,
        })
          .then(function (payload) {
            applySnapshot(payload)
            const created = (payload.agents || []).find(function (a) { return a.name === name })
            if (created) { selectedAgentId = created.id; promptDirty = false; loadPrompt(created.id) }
            if (state.tab === 'preset') render()
          })
          .catch(function (err) { showMessage('新建失败', esc(String(err && err.message || err))) })
      })
    })
  }

  const addGroup = document.getElementById('presetAddGroup')
  if (addGroup !== null) {
    addGroup.addEventListener('click', function () {
      showPrompt('新分组的名字', '分组', '新建').then(function (name) {
        if (name === null) return
        presetPost({ op: 'upsertGroup', name: name, sessionId: sessionId })
          .then(function (payload) { applySnapshot(payload); if (state.tab === 'preset') render() })
          .catch(function (err) { showMessage('新建分组失败', esc(String(err && err.message || err))) })
      })
    })
  }

  document.querySelectorAll('[data-rename]').forEach(function (node) {
    node.addEventListener('click', function () {
      const id = node.dataset.rename
      const group = groupById(id)
      if (group === null) return
      showPrompt('分组改名', group.name, '保存').then(function (name) {
        if (name === null) return
        presetPost({ op: 'upsertGroup', id: id, name: name, sessionId: sessionId })
          .then(function (payload) { applySnapshot(payload); if (state.tab === 'preset') render() })
          .catch(function (err) { showMessage('改名失败', esc(String(err && err.message || err))) })
      })
    })
  })

  document.querySelectorAll('[data-delgroup]').forEach(function (node) {
    node.addEventListener('click', function () {
      const id = node.dataset.delgroup
      const group = groupById(id)
      if (group === null) return
      showConfirm('删除分组「' + group.name + '」？', '里面的智能体会移到未分组，提示词不受影响。', '删除').then(function (confirmed) {
        if (!confirmed) return
        presetPost({ op: 'removeGroup', id: id, sessionId: sessionId })
          .then(function (payload) { applySnapshot(payload); if (state.tab === 'preset') render() })
          .catch(function (err) { showMessage('删除失败', esc(String(err && err.message || err))) })
      })
    })
  })

  const switchSession = document.getElementById('presetSwitch')
  if (switchSession !== null) {
    switchSession.addEventListener('click', function () {
      switchSession.disabled = true
      presetPost({ op: 'switchSession', sessionId: sessionId })
        .then(function (payload) { applySnapshot(payload); if (state.tab === 'preset') render() })
        .catch(function (err) {
          report('preset-session-switch-failed', String(err && err.message || err))
          // The host sends the current snapshot with a refusal; take it, so the page shows
          // the real state rather than leaving a dead button.
          if (err.payload && err.payload.snapshot) applySnapshot(err.payload.snapshot)
          showMessage('无法切换预设', esc(String(err && err.message || err)))
          if (state.tab === 'preset') render()
        })
    })
  }

  const newSession = document.getElementById('presetNew')
  if (newSession !== null) {
    newSession.addEventListener('click', function () {
      // GUARDED AGAINST DOUBLE FIRE. The button is disabled first, but \`disabled\` only stops
      // pointer events once the element is re-rendered OR the click is checked against state
      // — a rapid double click (or a click plus an Enter keypress on the focused button) can
      // reach the handler twice before any render happens. The diag log showed exactly this:
      // two \`preset-new-session-ok\` lines ~5.7 s apart, and two sessions where the user
      // wanted one.
      if (newSessionInFlight) return
      newSessionInFlight = true
      newSession.disabled = true
      createSessionViaHost().then(function (result) {
        if (state.tab === 'preset') render()
        if (result.ok) {
          showMessage('已新建 LuzzyMode 会话', esc(result.detail))
        } else {
          showMessage('新建会话失败', esc(result.detail))
        }
      }).catch(function (err) {
        if (state.tab === 'preset') render()
        showMessage('新建会话失败', esc(String(err && err.message || err)))
      }).then(function () {
        newSessionInFlight = false
      })
    })
  }

  wireRosterDrag()
}

/** Guards the new-session button against a double fire. See its handler. */
let newSessionInFlight = false

/**
 * Create a LuzzyMode session by asking the HOST HALF of this plugin to do it.
 *
 * WHY IT IS NOT A FETCH
 *
 * A host route can create a session but cannot make it VISIBLE: a blank session is rendered
 * by the sidebar only while it is the selected one, and selection is client-side state. The
 * client half holds the app's own session service, which attaches the workspace AND selects
 * the session — the same two steps the sidebar's 「新会话」 button takes. The frame is a
 * separate document with no handle on app navigation, so it asks over postMessage and
 * waits for the answer.
 *
 * The timeout exists because a missing reply would otherwise leave the button disabled
 * forever with no explanation. Five seconds is far longer than a local create takes.
 *
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
function createSessionViaHost() {
  return new Promise(function (resolve) {
    let settled = false
    const finish = function (result) {
      if (settled) return
      settled = true
      window.removeEventListener('message', onReply)
      clearTimeout(timer)
      resolve(result)
    }

    const onReply = function (event) {
      const data = event && event.data
      if (data === null || typeof data !== 'object') return
      if (data.source !== 'luzzy-page-host' || data.type !== 'session-created') return
      report('preset-new-session-result', { ok: data.ok === true, sessionId: data.sessionId, opened: data.opened })
      finish({ ok: data.ok === true, detail: String(data.detail || (data.ok ? '会话已创建。' : '新建会话失败。')) })
    }

    const timer = setTimeout(function () {
      report('preset-new-session-timeout')
      finish({ ok: false, detail: '宿主半没有回应新建会话的请求。可能是插件版本不一致 —— 重启 DSH 后再试。' })
    }, 5000)

    window.addEventListener('message', onReply)
    try {
      if (!window.parent || window.parent === window) {
        finish({ ok: false, detail: '当前页面不在宿主窗口里，无法新建会话。' })
        return
      }
      report('preset-new-session-request', { sessionId: sessionId })
      window.parent.postMessage({ source: 'luzzy-page-frame', type: 'create-session', sessionId: sessionId }, '*')
    } catch (error) {
      finish({ ok: false, detail: String(error && error.message || error) })
    }
  })
}

/** Promise-based discard prompt, so a caller can await the answer. */
function confirmDiscard() {
  if (!promptDirty) return Promise.resolve(true)
  return showConfirm(
    '提示词有未保存的改动',
    '切走会丢掉这些改动。要放弃它们吗？',
    '放弃改动',
  )
}

/**
 * Drag-to-reorder the roster.
 *
 * Order is persisted as explicit indices for every agent in the list, not as a swap: a
 * swap between two agents in different groups would leave both group memberships stale,
 * and the host's \`reorderAgents\` op takes the whole order anyway.
 *
 * HTML5 drag events are used rather than pointer events because they give keyboard-free
 * dragging for free and need no coordinate math; the drop target is shown with a top/bottom
 * edge marker instead of a gap, which keeps the list from reflowing under the pointer.
 */
function wireRosterDrag() {
  const items = Array.prototype.slice.call(document.querySelectorAll('.rosterItem[draggable]'))
  if (items.length === 0) return
  let draggedId = null

  const clearMarkers = function () {
    items.forEach(function (node) {
      delete node.dataset.dropBefore
      delete node.dataset.dropAfter
    })
  }

  items.forEach(function (node) {
    node.addEventListener('dragstart', function (event) {
      draggedId = node.dataset.agent
      node.dataset.dragging = 'true'
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move'
        // Firefox refuses to start a drag without data set.
        event.dataTransfer.setData('text/plain', draggedId)
      }
    })
    node.addEventListener('dragend', function () {
      delete node.dataset.dragging
      clearMarkers()
      draggedId = null
    })
    node.addEventListener('dragover', function (event) {
      if (draggedId === null || node.dataset.agent === draggedId) return
      event.preventDefault()
      const box = node.getBoundingClientRect()
      const after = event.clientY > box.top + box.height / 2
      clearMarkers()
      node.dataset[after ? 'dropAfter' : 'dropBefore'] = 'true'
    })
    node.addEventListener('drop', function (event) {
      event.preventDefault()
      const targetId = node.dataset.agent
      const after = node.dataset.dropAfter === 'true'
      clearMarkers()
      if (draggedId === null || targetId === draggedId) return
      reorderRoster(draggedId, targetId, after)
    })
  })
}

/** Move one agent to sit before/after another, then persist the resulting order. */
function reorderRoster(draggedId, targetId, after) {
  const columns = rosterColumns()
  const flat = []
  for (const column of columns) {
    for (const agent of column.agents) flat.push({ id: agent.id, groupId: column.id })
  }
  const from = flat.findIndex(function (entry) { return entry.id === draggedId })
  if (from === -1) return

  const moved = flat.splice(from, 1)[0]
  const targetIndex = flat.findIndex(function (entry) { return entry.id === targetId })
  if (targetIndex === -1) return

  // Dropping across groups adopts the target's group — that is what the gesture means when
  // the pointer crosses a group heading.
  const targetGroup = flat[targetIndex].groupId
  moved.groupId = targetGroup
  flat.splice(after ? targetIndex + 1 : targetIndex, 0, moved)

  presetPost({
    op: 'reorderAgents',
    order: flat.map(function (entry, index) {
      return { id: entry.id, order: index, groupId: entry.groupId }
    }),
    sessionId: sessionId,
  })
    .then(function (payload) { applySnapshot(payload); if (state.tab === 'preset') render() })
    .catch(function (err) {
      report('preset-reorder-failed', String(err && err.message || err))
      showMessage('排序保存失败', esc(String(err && err.message || err)))
    })
}

document.querySelectorAll('[data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab
    if (state.tab === 'usage' && state.status === 'idle') loadUsage(false)
    else if (state.tab === 'preset' && presetStatus === 'idle') loadPreset()
    else if (state.tab === 'goal' && goalStatus === 'idle') loadGoal(false)
    else render()
  }))

// The session id cannot come from the URL. This frame is an \`about:srcdoc\` document, so
// \`window.location\` is the PARENT's URL, not anything this plugin controls — putting a
// sessionId in a \`src\` attribute would do nothing, because \`srcDoc\` wins over \`src\`.
//
// So the frame asks instead: it posts a request to its parent, and the host half of this
// plugin answers with the session id the slot entry injected into the component (see the
// \`message\` listener in apply()). Until an answer arrives, \`sessionId\` stays null and the
// host's snapshot reports \`session: null\` — an honest "unknown" rather than a session that
// silently cannot switch.
//
// The core feature does not depend on it: the ACTIVE AGENT is a global setting, so
// switching it changes every session's next request whether or not this page knows which
// session it is looking at.
function askForSession() {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ source: 'luzzy-page-frame', type: 'want-session' }, '*')
    }
  } catch (error) {
    report('preset-sessionid-request-failed', String(error && error.message || error))
  }
}

window.addEventListener('message', function (event) {
  const data = event && event.data
  if (data === null || typeof data !== 'object') return
  if (data.source !== 'luzzy-page-host') return
  // ONLY the session answer may change the session id.
  //
  // This listener used to accept any host message, which meant the reply to a create request
  // (a session-created message, carrying no sessionId) was read as "your session is null".
  // The diag log shows it exactly: the id flipped from the real session to null one
  // millisecond after a create attempt, and the page then went on to fetch preset state for a
  // session that does not exist. Requiring a type is what keeps the two conversations apart.
  if (data.type !== 'session') return
  const next = typeof data.sessionId === 'string' && data.sessionId !== '' ? data.sessionId : null
  if (next === sessionId) return
  sessionId = next
  report('preset-sessionid', { sessionId: sessionId })
  // Re-read rather than patch: the session's preset facts come from the host, and a stale
  // "cannot switch" badge is exactly the kind of wrong statement this page must not show.
  if (state.tab === 'preset') loadPreset()
})

askForSession()

render()
</script>
</body></html>`
    }

    // ---------------------------------------------------------------- the outer component
    // A pure function of props: it returns an <iframe> element with the document injected
    // as srcDoc. No hooks, no store, no host React internals — none of the three
    // architectures that failed can be reached from here.

    /**
     * Which theme the app is currently in.
     *
     * The frame cannot read this for itself (separate document), so the parent resolves
     * it and bakes it into the document it hands over. The app expresses the preference
     * on <html> as `data-theme` / `class="dark"`; `prefers-color-scheme` is the fallback
     * when neither is present.
     *
     * @returns {'light'|'dark'}
     */
    function readTheme() {
      try {
        const root = document.documentElement
        if (root !== null && root !== undefined) {
          const declared = root.getAttribute('data-theme')
          if (declared === 'dark' || declared === 'light') return declared
          if (root.classList && root.classList.contains('dark')) return 'dark'
        }
        if (typeof window !== 'undefined' && window.matchMedia) {
          return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
        }
      } catch (error) {
        ping('theme-probe-failed', String(error && error.message))
      }
      return 'light'
    }

    function LuzzyPage(props) {
      try {
        // Record the session id for the handshake listener. The frame asks for it once it
        // boots, which is always after this render, so the value is already here.
        currentSessionId = props && typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null

        // Report the FIRST render only. This sits in the component body, so pinging on
        // every call means a ping per re-render — the host's diag route writes a file per
        // ping, and 384 of them accumulated in one session. One line at first paint is the
        // evidence that matters; the rest is noise that buries it.
        if (!firstRenderReported) {
          firstRenderReported = true
          ping('luzzy-page-render', { frameBytes: FRAME_LENGTH, session: currentSessionId === null ? 'absent' : 'present' })
        }
        return jsx('iframe', {
          className: 'luzzy-page-frame',
          title: 'LuzzyPage',
          // THE FRAME DOCUMENT IS BUILT ONCE AND NEVER REBUILT.
          //
          // This used to be `buildFrameDocument(FONT_FACE_CSS, theme)`, which produced a NEW
          // 394 KB string on every render. React compares `srcDoc` by value, so every
          // re-render looked like a new document and RELOADED the iframe — killing whatever
          // the frame was doing and starting over. The symptom was the page sitting at
          // "正在统计用量… 已用时 45 秒" forever: each reload restarted the ~20 s cold
          // aggregation from zero, and the diag log showed `frame-boot` firing twice.
          //
          // The theme does not belong in this string anyway: the frame picks it up from its
          // own root attribute (see followTheme), so a theme change costs one attribute
          // write instead of a document rebuild.
          srcDoc: FRAME_DOCUMENT,
          style: {
            width: '100%',
            height: '100%',
            border: 'none',
            display: 'block',
            background: 'transparent',
          },
        })
      } catch (error) {
        ping('luzzy-page-render-failed', String(error && error.message))
        return jsx('div', {
          style: { padding: '24px', color: '#ec5e41', fontSize: '13px' },
          children: 'LuzzyPage 渲染失败：' + String(error && error.message),
        })
      }
    }

    // The frame needs the full viewport height; the slot outlet is a contents-anchor, so
    // the sizing comes from the frame itself plus this one rule.
    const FRAME_CSS =
      '.luzzy-page-frame{box-sizing:border-box;width:100%;height:100%;min-height:100%;border:0;display:block;background:transparent}' +
      // The slot outlet must actually give the frame a height to fill: `height:100%`
      // resolves against the parent, and a contents-anchor parent has no box of its own.
      '.luzzy-page-frame{min-height:calc(100vh - 48px)}'

    // Built exactly once, at module load. The document is ~394 KB (fonts inlined) and is
    // identical for every render and every theme — see the note in LuzzyPage. Rebuilding it
    // reloaded the iframe and threw away in-flight work.
    const FRAME_DOCUMENT = buildFrameDocument(FONT_FACE_CSS, 'light')
    const FRAME_LENGTH = FRAME_DOCUMENT.length

    // Set by the first render so the flight recorder reports it once, not on every re-render.
    let firstRenderReported = false

    function injectStyles() {
      if (document.querySelector('style[data-plugin-css="luzzy-page"]') !== null) return
      const style = document.createElement('style')
      style.dataset.pluginCss = 'luzzy-page'
      style.textContent = FRAME_CSS
      document.head.appendChild(style)
    }

    /**
     * Keep the frame's theme in step with the app's.
     *
     * The frame owns its own `:root`, so it cannot inherit a theme change; the parent
     * mirrors the current value onto the frame document through its `data-theme`
     * attribute. A MutationObserver on <html> is what makes the toggle take effect
     * without a reload, and it is torn down through ctx.effect like everything else.
     */
    function followTheme(ctx) {
      const apply = () => {
        const theme = readTheme()
        // `querySelectorAll` may be absent under a minimal DOM (the test harness stubs one),
        // and the frame may not be in the document yet — neither is an error.
        if (typeof document.querySelectorAll !== 'function') return
        for (const frame of document.querySelectorAll('iframe.luzzy-page-frame')) {
          try {
            const inner = frame.contentDocument
            if (inner && inner.documentElement) inner.documentElement.setAttribute('data-theme', theme)
          } catch (error) {
            // Cross-document access can fail while the frame is still loading.
          }
        }
      }

      apply()

      // The document is a fixed string that always starts light (it cannot be built per
      // theme without reloading the frame — see LuzzyPage). So the frame has to be handed
      // the current theme once it actually exists, or a dark-mode user would see a light
      // page until the next theme change. `load` fires per frame document.
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('load', apply, true) // capture: iframe load doesn't bubble
        ctx.effect(() => () => document.removeEventListener('load', apply, true), 'luzzy-page: frame load listener')
      }

      if (typeof MutationObserver === 'function' && document.documentElement) {
        const observer = new MutationObserver(apply)
        try {
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
          ctx.effect(() => () => observer.disconnect(), 'luzzy-page: theme observer')
        } catch (error) {
          ping('theme-observer-failed', String(error && error.message))
        }
      }

      // The OS-level preference, for when the app follows the system rather than an
      // explicit choice.
      try {
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
          const media = window.matchMedia('(prefers-color-scheme: dark)')
          if (typeof media.addEventListener === 'function') {
            media.addEventListener('change', apply)
            ctx.effect(() => () => media.removeEventListener('change', apply), 'luzzy-page: system theme listener')
          }
        }
      } catch (error) {
        ping('theme-media-failed', String(error && error.message))
      }
    }

    const inject = ['slots', 'locale', 'sessions', 'workspaces']

    /**
     * The app's client session and workspace services, captured for the frame to use.
     *
     * Creating a session that the user can actually SEE requires the app's own session
     * service: it attaches the workspace and then selects the session, and a blank session is
     * only rendered while it is the selected one. The workspace service is here because
     * resolving which workspace owns a directory is a client-side lookup — doing it on the
     * host made the whole path depend on the host bundle being current, which it is not until
     * DSH restarts.
     *
     * The frame cannot call either — it is a separate document with no handle on client-side
     * navigation — so it asks over postMessage and these values satisfy the request.
     *
     * Held as module-level values rather than per-frame state because there is one client
     * service per app, shared by every mounted LuzzyPage.
     */
    let appSessions = null
    let appWorkspaces = null

    /**
     * Answer the frame's postMessage requests.
     *
     * Two kinds, both things the frame cannot do for itself:
     *
     *   1. `want-session` — which session am I? The frame is an `about:srcdoc` document, so
     *      its `window.location` is the parent app's URL and `srcDoc` overrides any `src`; a
     *      sessionId in the URL is not available to it.
     *   2. `create-session` — make a new session. This MUST run on the client side: a blank
     *      session is rendered by the sidebar only while it is the selected one, so creating
     *      it without selecting it produces something the user cannot see. The app's own
     *      client service does both, and only this half of the plugin holds it.
     *
     * The listener is installed through `ctx.effect`, so unloading removes it instead of
     * leaving a handler that writes into a disposed context.
     *
     * Replies are addressed to `event.source` — the asking window — so a frame this plugin
     * does not own cannot read a session id or drive a create by posting a message.
     */
    function followSession(ctx) {
      const onMessage = (event) => {
        const data = event && event.data
        if (data === null || typeof data !== 'object') return
        if (data.source !== 'luzzy-page-frame') return
        const source = event.source
        if (source === null || source === undefined) return

        if (data.type === 'want-session') {
          try {
            source.postMessage({ source: 'luzzy-page-host', type: 'session', sessionId: currentSessionId ?? null }, '*')
          } catch (error) {
            ping('session-handshake-failed', String(error && error.message))
          }
          return
        }

        if (data.type === 'create-session') {
          createSessionForFrame(source, data)
          return
        }
      }

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('message', onMessage)
        ctx.effect(() => () => window.removeEventListener('message', onMessage), 'luzzy-page: session handshake')
      }
    }

    /**
     * Create a LuzzyMode session on the client side, where it can also be SELECTED.
     *
     * This is the fix for "新建会话始终无法在 DSH 内显示". Two independent reasons a session
     * created on the host is invisible, and both are structural:
     *
     *   1. `sessionController.create` attaches a workspace ONLY from `workspaceId`. Creating
     *      with `cwd` produces a session belonging to no workspace, so it enters no
     *      workspace's `sessionIds` — and the sidebar lists sessions per workspace.
     *   2. Even when attached, the sidebar renders a BLANK session only while it is the
     *      selected one (`sessionVisible`: `!session.blank || session.id === current`). A
     *      freshly created session is blank by definition, so attaching without selecting
     *      still shows the user nothing.
     *
     * The app's own client service does both — `create` then `open` — which is exactly why
     * the sidebar's 「新会话」 button works. Running it here is not a workaround: it is the
     * harness's own path, and the frame cannot take it because the selection is client-side
     * state it has no handle on.
     *
     * THE WORKSPACE IS RESOLVED HERE, NOT ON THE HOST
     *
     * An earlier version asked the host half through a `resolveWorkspace` route. That route
     * is part of the HOST bundle, which does not hot-reload — so between the client fix and
     * the next DSH restart, the page called an operation the running host had never heard of
     * and got `未知操作 "resolveWorkspace"`. Nothing about this resolution needs the host: the
     * client's own `workspaces` service exposes every workspace's `workspaceId` and `path`,
     * which is all that is required to find the one owning a directory. Doing it here means
     * the whole create path lives in one half and has no version skew to get wrong.
     *
     * @param {Window} source - the asking frame, which receives the result.
     * @param {object} request - the frame's message.
     */
    function createSessionForFrame(source, request) {
      const reply = (payload) => {
        try {
          source.postMessage({ source: 'luzzy-page-host', type: 'session-created', ...payload }, '*')
        } catch (error) {
          ping('session-create-reply-failed', String(error && error.message))
        }
      }

      const sessions = appSessions
      if (sessions === null || typeof sessions.create !== 'function') {
        ping('session-create-unavailable')
        reply({ ok: false, detail: '这个界面没有把会话服务暴露给插件。请在左侧工作区用「新会话」按钮，再把预设切到 LuzzyMode。' })
        return
      }

      const fromSessionId = typeof request.sessionId === 'string' && request.sessionId !== '' ? request.sessionId : currentSessionId

      // Which registered workspace owns this session's directory? Read from the client's own
      // list, which carries both the id and the canonical path for every workspace.
      let cwd = null
      try {
        const summaries = sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : null
        const summary = summaries && fromSessionId !== null ? summaries.byId && summaries.byId[fromSessionId] : null
        cwd = summary && typeof summary.cwd === 'string' ? summary.cwd : null
      } catch (error) {
        ping('session-create-cwd-failed', String(error && error.message))
      }

      let workspaceId = null
      let seen = []
      if (cwd !== null) {
        try {
          const snapshot = appWorkspaces && appWorkspaces.list && typeof appWorkspaces.list.getSnapshot === 'function'
            ? appWorkspaces.list.getSnapshot()
            : null
          const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
          seen = items.map((item) => item.path)
          // Paths are compared case-insensitively: Windows spellings differ in case routinely
          // (`C:\Users\...` vs `c:\users\...`), and the host canonicalizes the same way.
          const owner = items.find((item) => typeof item.path === 'string' && item.path.toLowerCase() === cwd.toLowerCase())
          workspaceId = owner ? owner.workspaceId : null
        } catch (error) {
          ping('session-create-workspace-failed', String(error && error.message))
        }
      }

      const createRequest = workspaceId ? { workspaceId } : (cwd ? { cwd } : {})
      ping('session-create-start', JSON.stringify({ workspaceId, cwd, known: seen.length }))

      sessions.create(createRequest).then((created) => {
        const id = typeof created === 'string' ? created : created && (created.sessionId || created.id)
        if (typeof id !== 'string' || id === '') throw new Error('会话创建了，但没拿到它的 id')
        ping('session-create-ok', JSON.stringify({ sessionId: id, workspaceId }))

        // Select it. Without this step the session stays blank and therefore invisible.
        let opened = false
        try {
          if (typeof sessions.open === 'function') {
            sessions.open(id)
            opened = true
          }
        } catch (error) {
          ping('session-create-open-failed', String(error && error.message || error))
        }

        // Put it on LuzzyMode while it is still empty — the only window in which DSH permits a
        // preset change. A failure here is reported, not hidden: the session exists and IS
        // visible; only its preset needs one more click.
        presetPostViaHost(id).then((switched) => {
          if (switched.ok) {
            reply({ ok: true, sessionId: id, opened, detail: opened ? '会话已创建并切换过去。' : '会话已创建，请在左侧会话列表里打开它。' })
          } else {
            reply({
              ok: true,
              sessionId: id,
              opened,
              detail: '会话已创建' + (opened ? '并切换过去' : '') + '，但没能自动切到 LuzzyMode：' + switched.detail +
                '。在「预设」页对新会话点「切到 LuzzyMode」即可。',
            })
          }
        })
      }).catch((error) => {
        const why = String(error && error.message || error)
        ping('session-create-failed', why)
        reply({ ok: false, detail: why })
      })
    }

    /**
     * Ask the host half to move a session onto LuzzyMode, and report the outcome.
     *
     * A fetch rather than a message because this is the host's own domain: the preset lock is
     * a host-side projection, and the page already reads its state through that route. The
     * reply is read from the response body, so a refusal arrives with its reason.
     *
     * @returns {Promise<{ok: boolean, detail: string}>}
     */
    function presetPostViaHost(sessionId) {
      return fetch('/__luzzy/preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'switchSession', sessionId }),
      })
        .then((response) => (response.ok ? response.json() : response.text().then((body) => Promise.reject(new Error(body)))))
        .then(() => ({ ok: true, detail: '' }))
        .catch((error) => ({ ok: false, detail: String(error && error.message || error) }))
    }

    // The session id the slot entry injects. Set on every render — see LuzzyPage.
    let currentSessionId = null

    function apply(ctx) {
      injectStyles()
      ping('apply-entered')

      // The app's session and workspace services. Captured so the frame's create request can
      // reach them; creating a session anywhere else cannot make it visible (see
      // createSessionForFrame).
      appSessions = ctx.sessions ?? null
      appWorkspaces = ctx.workspaces ?? null
      ping('sessions-service', appSessions === null ? 'absent' : 'present')

      const t = ctx.locale.bind(NS)

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'luzzy-page: dictionaries')

      followTheme(ctx)
      followSession(ctx)

      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'luzzy-page',
            order: 100,
            label: () => t('view.luzzy'),
            locale: NS,
            // `sessionId` is not among the props `conversation.view` passes by default
            // (those are `viewRequest` / `openView` / `completeViewRequest`). A per-entry
            // `inject` is how a registration asks for it — this is the same mechanism
            // `dsh-client-ui-trajectory` uses for its own view. The returned object is
            // spread into the component's props, so `props.sessionId` is available below.
            inject: (sessionId) => ({ sessionId }),
          },
          LuzzyPage,
        ),
      )
      ping('registered')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
