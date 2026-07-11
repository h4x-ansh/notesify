/**
 * Renders the structured notes JSON (see schema.js) into the same
 * "topper's scanned notebook" visual style as the original hand-authored
 * template: Tailwind + handwriting Google Fonts + KaTeX + hand-drawn CSS
 * doodles/boxes. The interactive sidebar controls from the original file
 * are dropped since this output is only ever rendered headlessly for PDF
 * export, never opened as a live page.
 *
 * Performance note: Tailwind is a statically pre-compiled stylesheet
 * (run `npm run build:css` after changing classes in this file), inlined
 * directly rather than loaded via the CDN's live in-browser JIT compiler.
 * The scanned-paper noise texture is a pre-rasterized PNG (see
 * scripts/generate-noise-texture.mjs) instead of a live feTurbulence SVG
 * filter, which is expensive to paint repeatedly across full-page-height
 * layers. Both changes are purely about render cost — the visual output
 * is unchanged.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NOISE_TEXTURE_DATA_URI } from "./templates/noiseTexture.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAILWIND_CSS = readFileSync(path.join(__dirname, "templates", "styles.css"), "utf-8");

const DOODLE_ICONS = [
  `<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>`,
  `<path d="M9 18h6M10 21h4M12 3a6 6 0 0 1 6 6c0 2.5-2 4.5-2.5 5.5l-.5 1.5H9l-.5-1.5C8 13.5 6 11.5 6 9a6 6 0 0 1 6-6z"/>`,
  `<path d="M12 2v1M18.5 4.5l-.7.7M21 11h-1M18.5 17.5l-.7-.7M5.5 17.5l.7-.7"/>`,
  `<path d="M14 9l2 2m0 0l2-2m-2 2v6M18 9h-8m0 0H8a4 4 0 000 8h2a4 4 0 000-8z"/>`,
  `<path d="M5 13l4 4L19 7"/>`,
];

/**
 * Visual theme presets - CSS variable swaps in the existing template
 * (below), not separate templates. `classic` reproduces the original
 * hardcoded colors exactly (same hex values, same yellow-500 badge, same
 * highlight rgba) - a request with no `styleId` (every request before this
 * feature existed, and every provider fallback path) must render byte-
 * identical output to before this change, not just "a reasonable default."
 * Callout colors (Exam Tip/Common Mistake/etc., see CALLOUT_STYLE below)
 * are deliberately NOT themed - they carry meaning (red for a mistake,
 * green for a memory trick) that shouldn't shift with a color palette
 * choice, so they're constant across all three presets.
 */
export const STYLE_PRESETS = {
  classic: {
    label: "Classic Topper",
    inkColor: "#103f91",
    markerColor: "#be123c",
    paperBg: "#faf7eb",
    highlightRgb: "254, 240, 138",
    doodleColor: "#3b82f6",
    doodleOpacity: "0.85",
    badgeColor: "#eab308",
    katexColor: "#0c4a6e",
  },
  coolTones: {
    label: "Cool Tones",
    inkColor: "#3b0764",
    markerColor: "#0f766e",
    paperBg: "#f2f6fa",
    highlightRgb: "165, 243, 252",
    doodleColor: "#0891b2",
    doodleOpacity: "0.85",
    // Kept light (teal-300, not the deep purple/teal used for ink/marker)
    // so the existing dark badge text (text-slate-900, unthemed - see
    // renderNotesHtml) stays readable. The badge is a highlighter-style
    // label, same idea as .highlight - it should read as "light background,
    // dark text" in every theme, not flip to a dark badge with unreadable
    // dark-on-dark text.
    badgeColor: "#5eead4",
    katexColor: "#155e75",
  },
  minimal: {
    label: "Minimal",
    inkColor: "#1f2937",
    markerColor: "#374151",
    paperBg: "#ffffff",
    highlightRgb: "226, 232, 240",
    doodleColor: "#9ca3af",
    doodleOpacity: "0.25",
    badgeColor: "#e5e7eb",
    katexColor: "#111827",
  },
};

const DEFAULT_STYLE_ID = "classic";

const CALLOUT_STYLE = {
  "Exam Tip": { bg: "bg-yellow-100/60", border: "border-yellow-500", badge: "bg-amber-600", label: "⚡ Topper's Exam Tip" },
  "Common Mistake": { bg: "bg-red-50/50", border: "border-red-500", badge: "bg-rose-600", label: "⚠️ Common Mistake" },
  Important: { bg: "bg-blue-50/50", border: "border-blue-400", badge: "bg-blue-600", label: "💡 Important" },
  "Must Remember": { bg: "bg-rose-50", border: "border-red-400", badge: "bg-rose-600", label: "🧠 Must Remember" },
  "Memory Trick": { bg: "bg-emerald-50/50", border: "border-emerald-400", badge: "bg-emerald-600", label: "🎯 Memory Trick" },
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EXISTING_MATH_PATTERN = /\$\$[^$]+\$\$|\$[^$]+\$/g;
const PLACEHOLDER_PATTERN = /(\d+)/g;

/**
 * Gemini sometimes leaves inline LaTeX (\hat{i}, \sin\theta, t^2, N_AB,
 * S_{abs}, ...) un-delimited inside bullet/callout/table text, so KaTeX's
 * auto-render skips it and it shows up as literal backslash-text. This
 * finds contiguous non-space runs that contain a LaTeX trigger (a \command,
 * a subscript `_`, or a superscript `^`) and wraps them in $...$.
 *
 * The backslash-command branch also swallows one or more trailing
 * `{...}` groups so commands like `\text{ N}` - which contain a literal
 * space inside their argument - still get captured as a single token
 * instead of being split apart at that internal space.
 */
const LATEX_TOKEN_PATTERN = /\S*(?:\\[a-zA-Z]+(?:\{[^{}]*\})*|_\{?[^\s]+?\}?|\^\{?[^\s]+?\}?)\S*/g;

/** Replaces already-$-delimited math with sentinel placeholders so later passes don't touch or double-wrap it. */
function protectExistingMath(text) {
  const placeholders = [];
  const stripped = text.replace(EXISTING_MATH_PATTERN, (match) => {
    placeholders.push(match);
    return `${placeholders.length - 1}`;
  });
  return { stripped, placeholders };
}

function restoreMath(text, placeholders, transform = (s) => s) {
  return text.replace(PLACEHOLDER_PATTERN, (_, i) => transform(placeholders[Number(i)]));
}

/** Wraps bare LaTeX-looking tokens in a raw (unescaped) string in $...$, leaving already-delimited math untouched. */
function wrapUnescapedLatex(text) {
  if (!text) return text;
  const { stripped, placeholders } = protectExistingMath(text);
  const wrapped = stripped.replace(LATEX_TOKEN_PATTERN, (match) => `$${match}$`);
  return restoreMath(wrapped, placeholders);
}

/**
 * Finds each highlight term's first occurrence by matching against the
 * pristine, unmodified text, then builds the wrapped output in a single
 * left-to-right pass. Matching every term against the original string
 * (rather than mutating it term-by-term) means one term's injected
 * `<span class="highlight ...">` markup can never itself get matched and
 * re-wrapped by a later term (e.g. a bare "F" highlight matching the "f" in
 * an earlier term's own "font-bold" class name, corrupting the tag).
 *
 * Word-boundaried matching is tried first so a short term like "F" doesn't
 * grab the "f" inside an unrelated word like "force"; if that finds nothing
 * (e.g. the term is itself only part of a larger token), it falls back to a
 * plain substring match.
 */
function wrapHighlights(escapedText, highlights = []) {
  const ranges = [];
  for (const term of highlights) {
    if (!term) continue;
    const escapedTerm = escapeRegExp(escapeHtml(term));
    const boundaried = new RegExp(`\\b${escapedTerm}\\b`, "i");
    const loose = new RegExp(escapedTerm, "i");
    const match = boundaried.exec(escapedText) || loose.exec(escapedText);
    if (!match) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (ranges.some((r) => start < r.end && end > r.start)) continue; // overlaps an already-claimed span
    ranges.push({ start, end });
  }
  if (!ranges.length) return escapedText;

  ranges.sort((a, b) => a.start - b.start);
  let result = "";
  let cursor = 0;
  for (const { start, end } of ranges) {
    result += escapedText.slice(cursor, start);
    result += `<span class="highlight font-bold">${escapedText.slice(start, end)}</span>`;
    cursor = end;
  }
  result += escapedText.slice(cursor);
  return result;
}

/**
 * Full pipeline for a free-text field: detect+wrap bare LaTeX, protect all
 * math (old and newly-wrapped) from HTML-escaping and from the highlight
 * pass below, escape the rest, optionally wrap highlight terms, then
 * restore the math (still escaped, since the browser un-escapes entities
 * before KaTeX ever sees the text node).
 */
function renderMathAwareText(text, highlights = []) {
  if (!text) return "";
  const latexWrapped = wrapUnescapedLatex(text);
  const { stripped, placeholders } = protectExistingMath(latexWrapped);
  const escaped = wrapHighlights(escapeHtml(stripped), highlights);
  return restoreMath(escaped, placeholders, escapeHtml);
}

function renderFormula(formula) {
  if (!formula) return "";
  // Gemini occasionally wraps the formula in its own $ / $$ delimiters;
  // strip them so we don't emit nested/malformed KaTeX delimiters.
  const clean = formula.trim().replace(/^\${1,2}|\${1,2}$/g, "");
  return `
    <div class="my-4 text-center">
      <span class="text-xl md:text-2xl px-6 py-2 bg-yellow-100/80 border-2 border-yellow-300 rounded-lg inline-block shadow-md">
        $$${clean}$$
      </span>
    </div>`;
}

function renderTable(table) {
  if (!table || !table.headers?.length) return "";
  const headerRow = table.headers.map((h) => `<th class="p-2 border-r border-slate-300 last:border-r-0">${renderMathAwareText(h)}</th>`).join("");
  const bodyRows = table.rows
    .map(
      (row) =>
        `<tr class="border-b border-slate-200 last:border-b-0">${row
          .map((cell) => `<td class="p-2 border-r border-slate-300 last:border-r-0 font-bold">${renderMathAwareText(cell)}</td>`)
          .join("")}</tr>`
    )
    .join("");
  return `
    <div class="max-w-md mx-auto my-6 border-2 border-slate-400 bg-white/70 rounded-lg p-2 shadow-sm">
      <table class="w-full text-center">
        <thead><tr class="border-b-2 border-slate-400 text-rose-700 font-bold">${headerRow}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;
}

function renderCallout(callout) {
  if (!callout) return "";
  const style = CALLOUT_STYLE[callout.type] || CALLOUT_STYLE.Important;
  return `
    <div class="mt-4 p-3 ${style.bg} rounded border-l-4 ${style.border} text-sm md:text-base">
      <span class="callout-badge ${style.badge} text-white inline-block mb-1">${style.label}</span>
      <p>${renderMathAwareText(callout.text)}</p>
    </div>`;
}

/**
 * Small handwritten-style margin note next to a section's heading, e.g.
 * "📍 12:34" or "📍 Video 2 · 12:34–18:02" for a multi-video batch - a
 * pushpin rather than a clock face since this reads as "here's where in
 * the source video this came from", not a duration/countdown. Absent
 * entirely whenever timestampStart wasn't set (see timestampMatcher.js -
 * no match confident enough, or the video's transcript had no segment
 * timing to begin with, e.g. the Whisper fallback) - no placeholder shown,
 * the section just renders exactly as it did before this feature existed.
 */
function renderTimestamp(section) {
  if (!section.timestampStart) return "";
  const label = section.timestampRange || section.timestampStart;
  const videoPrefix = section.timestampVideo ? `${escapeHtml(section.timestampVideo)} · ` : "";
  return `<span class="timestamp-tag">📍 ${videoPrefix}${escapeHtml(label)}</span>`;
}

function renderSection(section) {
  const bullets = (section.bullets || [])
    .map((b) => `<li>${renderMathAwareText(b, section.highlights)}</li>`)
    .join("");

  return `
    <div class="mb-8">
      <h2 class="marker-heading text-2xl md:text-3xl mb-2">${renderMathAwareText(section.subheading)}${renderTimestamp(section)}</h2>
      <div class="line-align space-y-3">
        <ul class="list-disc pl-6 space-y-1">${bullets}</ul>
        ${renderFormula(section.formula)}
        ${renderTable(section.table)}
        ${renderCallout(section.callout)}
      </div>
    </div>`;
}

function renderSpiralBinding() {
  return `<div class="spiral-binding">${'<div class="spiral-ring"></div>'.repeat(12)}</div>`;
}

function renderPage(page, index, subject) {
  const pageNum = index + 1;
  const icon = DOODLE_ICONS[index % DOODLE_ICONS.length];

  return `
    <div id="page-${pageNum}" class="notebook-page notebook-paper paper-ruled px-8 md:px-14 py-12 overflow-hidden shadow-2xl relative">
      <div class="margin-line"></div>
      <div class="scan-artifact-noise"></div>
      <div class="shadow-vignette"></div>
      ${renderSpiralBinding()}
      <div class="absolute right-8 top-6 flex items-center gap-3">
        <span class="doodle text-sm font-bold text-rose-500">Page ${pageNum}</span>
        <svg viewBox="0 0 24 24" class="w-5 h-5 doodle text-rose-500 fill-none stroke-current" stroke-width="1.5">${icon}</svg>
      </div>
      <div class="relative z-20 pl-4 md:pl-10 handwritten text-lg">
        ${pageNum === 1 && subject ? `<p class="text-xs uppercase tracking-widest text-rose-500 font-bold mb-2">${escapeHtml(subject)}</p>` : ""}
        ${page.sections.map(renderSection).join("\n")}
      </div>
    </div>`;
}

/**
 * `styleId` selects a preset from STYLE_PRESETS above (falls back to
 * `classic` for an unknown/missing id - the same fallback whether the
 * field was never sent at all, pre-dating this feature, or a client sent
 * something invalid; both degrade to today's output rather than erroring).
 * Every color in the stylesheet below now reads from `theme` instead of a
 * literal hex/rgba value - a CSS variable swap, not a second template.
 */
export function renderNotesHtml(notes, { styleId } = {}) {
  const theme = STYLE_PRESETS[styleId] || STYLE_PRESETS[DEFAULT_STYLE_ID];
  const pagesHtml = notes.pages.map((page, i) => renderPage(page, i, notes.subject)).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(notes.title)} — Topper's Scanned Revision Notes</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Caveat:wght@400;700&family=Kalam:wght@300;400;700&family=Permanent+Marker&family=Architects+Daughter&family=Reenie+Beanie&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/contrib/auto-render.min.js"></script>
  <style>${TAILWIND_CSS}</style>
  <style>
    :root {
      --blue-ink: ${theme.inkColor};
      --red-marker: ${theme.markerColor};
      --paper-bg: ${theme.paperBg};
      --highlight-rgb: ${theme.highlightRgb};
      --doodle-color: ${theme.doodleColor};
      --doodle-opacity: ${theme.doodleOpacity};
      --badge-color: ${theme.badgeColor};
      --katex-color: ${theme.katexColor};
    }
    body { background-color: var(--paper-bg); }
    .handwritten { font-family: 'Kalam', cursive; font-weight: 400; color: var(--blue-ink); line-height: 1.7; }
    .marker-heading { font-family: 'Caveat', cursive; font-weight: 700; color: var(--red-marker); letter-spacing: -0.5px; transform: rotate(-0.5deg); display: inline-block; }
    .marker-title { font-family: 'Permanent Marker', cursive; color: var(--red-marker); transform: rotate(-1.5deg); }
    .notebook-paper { background-color: var(--paper-bg); position: relative; box-shadow: 0 10px 30px rgba(0,0,0,0.15); border-radius: 4px; min-height: 1050px; }
    .paper-ruled { background-image: linear-gradient(#e2e8f0 1px, transparent 1px); background-size: 100% 32px; }
    .margin-line { position: absolute; top: 0; bottom: 0; left: 65px; width: 2px; background-color: rgba(239,68,68,0.4); z-index: 10; }
    .spiral-binding { position: absolute; left: -20px; top: 40px; bottom: 40px; display: flex; flex-direction: column; justify-content: space-around; z-index: 50; height: 90%; }
    .spiral-ring { width: 45px; height: 18px; background: linear-gradient(90deg, #94a3b8 0%, #cbd5e1 30%, #f1f5f9 60%, #64748b 100%); border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); margin-bottom: 25px; transform: rotate(-4deg); }
    .highlight { background: linear-gradient(104deg, rgba(var(--highlight-rgb),0.8) 0.9%, rgba(var(--highlight-rgb),0.95) 2.4%, rgba(var(--highlight-rgb),0.7) 5.8%, rgba(var(--highlight-rgb),0.3) 93%, rgba(var(--highlight-rgb),0.85) 96%, rgba(var(--highlight-rgb),0.5) 98%); border-radius: 4px 15px 4px 12px; padding: 0 4px; }
    .callout-badge { font-family: 'Permanent Marker', cursive; font-size: 0.7rem; letter-spacing: 0.5px; padding: 4px 8px; border-radius: 4px; transform: rotate(-2deg); box-shadow: 2px 2px 5px rgba(0,0,0,0.15); }
    .scan-artifact-noise { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; opacity: 0.12; mix-blend-mode: multiply; background-image: url("${NOISE_TEXTURE_DATA_URI}"); background-repeat: repeat; background-size: 200px 200px; z-index: 40; }
    .shadow-vignette { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; box-shadow: inset 0 0 80px rgba(0,0,0,0.1); z-index: 42; border-radius: 4px; }
    .doodle { color: var(--doodle-color); opacity: var(--doodle-opacity); transform: rotate(-5deg); }
    .timestamp-tag { font-family: 'Reenie Beanie', cursive; font-size: 1.35rem; color: var(--doodle-color); opacity: var(--doodle-opacity); margin-left: 12px; white-space: nowrap; display: inline-block; transform: rotate(-3deg); vertical-align: middle; }
    .katex { font-size: 1.05em !important; color: var(--katex-color); }
    .subject-badge { background-color: var(--badge-color); }
    .notebook-page { break-after: page; }
    .notebook-page:last-child { break-after: auto; }
    @media print {
      body { background: white; }
      .notebook-page { box-shadow: none !important; margin: 0; }
    }
  </style>
</head>
<body class="py-8 px-2 md:px-4 text-slate-800">
  <div id="notebook-container" class="max-w-4xl mx-auto space-y-12 relative">
    <div class="text-center mb-6">
      <div class="subject-badge inline-block text-slate-900 text-xs font-bold uppercase py-1 px-2 rotate-[-8deg] shadow-md mb-2">
        ${notes.subject ? escapeHtml(notes.subject) : "Topper Notes"} 📚
      </div>
      <h1 class="marker-title text-4xl md:text-5xl tracking-wide">${escapeHtml(notes.title)}</h1>
    </div>
    ${pagesHtml}
  </div>
  <script>
    document.addEventListener("DOMContentLoaded", function () {
      renderMathInElement(document.getElementById("notebook-container"), {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
      });
    });
  </script>
</body>
</html>`;
}
