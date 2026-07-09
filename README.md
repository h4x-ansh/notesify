# Notesify — YouTube Lecture → Handwritten Topper's Notes

A CLI that takes a YouTube lecture link and produces an exam-ready PDF styled
like a topper's handwritten notebook: spiral binding, ruled paper, blue-ink
body text, red-marker headings, yellow-highlighter spans, hand-drawn callout
boxes, and margin doodles.

```
node generate-notes.js "<youtube-url>" --output notes.pdf
```

Or as a local API (first step toward an Electron-packaged desktop app — see
[API](#local-api) below):

```
npm run serve
curl -X POST http://localhost:4500/generate -H "Content-Type: application/json" \
  -d '{"youtubeUrl":"<youtube-url>"}'
```

## The problem

I was already doing this by hand for my own exam prep: copy a lecture link,
pull the transcript, prompt an LLM for detailed notes, prompt a second LLM
(Gemini, using its Canvas tool) to turn those notes into an aesthetic
handwritten-style page, then export to PDF. It worked, but it was five manual
steps and two different chat UIs per video. This automates all of it into one
command.

## Architecture

```
YouTube URL
   │
   ▼
[1] transcript.js     — captions via youtube-transcript, falls back to
   │                     yt-dlp + Whisper if no captions exist
   ▼
[2] notesGenerator.js — Gemini API, schema-constrained JSON output,
   │                     transcript → structured JSON (title, pages,
   │                     sections, bullets, highlights, formulas, tables,
   │                     callouts)
   ▼
[3] template.js        — JSON → the handwritten-notebook HTML (Tailwind +
   │                     Kalam/Caveat/Permanent Marker fonts + KaTeX)
   ▼
[4] pdfExport.js       — Puppeteer renders the HTML headlessly and prints
   │                     it to a paginated PDF
   ▼
notes.pdf
```

Each step is a plain function with a narrow input/output contract, so any
stage can be swapped or tested in isolation (e.g. the template can be fed a
hand-written JSON fixture without touching YouTube or Gemini at all).

`src/pipeline.js` is the single place that sequences steps 1-4 and reports
progress via an `onUpdate` callback after each stage transition. Both
`generate-notes.js` (CLI) and `server.js` (API) call this same function
directly — neither duplicates the sequencing, and the CLI doesn't go through
HTTP to use it.

## Local API

`node server.js` (or `npm run serve`) starts an Express server on
`localhost:4500` wrapping the same pipeline. It's local-only by design (no
auth) — the first step toward packaging this as an Electron desktop app.
The `frontend/` directory (Next.js, TypeScript) is the second step: a
single-page UI that talks to this server — see `frontend/README.md` for how
it's wired up (notably, a rewrite proxy instead of CORS, since the two dev
servers run on different ports).

Since the full pipeline takes 30-60s+ (transcript fetch, a Gemini call, then
a Puppeteer render/print), `/generate` doesn't block on it — it kicks off
the pipeline in the background against an in-memory job store (`src/jobStore.js`,
a `Map<jobId, jobState>` — no database, doesn't need to survive a restart)
and returns a `jobId` immediately. Poll `/status` for progress.

| Endpoint | Behavior |
|---|---|
| `POST /generate` `{ youtubeUrl }` | Starts the pipeline async, returns `202 { jobId }` |
| `GET /status/:jobId` | `{ stage, progress, error, ...meta }` — `meta` picks up fields like `transcriptSource`, `notesTitle`, `pageCount` as each stage finishes |
| `GET /download/:jobId` | Streams the PDF once `stage === "done"`; `409` if not ready yet |
| `GET /debug/jobs` / `GET /debug/jobs/:jobId` | Full job state including per-stage `timings` (`setContent`/`fontsAndSettle`/`print`/`total`) — same numbers the CLI prints to console, just per-jobId here |
| `GET /health` | Liveness check |

`stage` moves through `queued → extracting_transcript → generating_notes →
rendering_pdf → done`, or `error` at any point — a failure at, say, the
Gemini step (bad video, rate limit, missing captions with no Whisper
fallback configured) is caught inside `runPipeline`, recorded as
`{ stage: "error", error: message }`, and never crashes the server.

## Key design decisions

**Structured JSON instead of prose, enforced via schema-constrained
output.** The original manual workflow used two free-form prose prompts
chained together — notes as markdown, then "restyle this as handwritten
notes." Chaining prose through two LLM calls compounds drift: the second
model has to *re-parse* the first model's formatting, and nothing stops it
from paraphrasing, dropping a formula, or inventing a section. Instead,
Gemini is called once with `generationConfig.responseSchema` set to a schema
that mirrors the final page/section structure directly, so the model's raw
output is already shaped JSON rather than prose to be re-interpreted. There
is no free-form note-writing step to lose fidelity in — the model fills the
same structure the template renders, and `zod` validates the response before
it ever reaches the renderer.

**The original "Gemini Canvas" step was never image generation.** The
handwritten look (photorealistic ink, scan noise, doodles) came from Canvas
emitting an interactive HTML/CSS artifact — Tailwind, handwriting Google
Fonts, and hand-drawn CSS shapes — that got screenshotted or printed. That
meant the entire "handwritten" step could become deterministic templating
instead of a second model call: cheaper, faster, and the output is a real
DOM you can grep, diff, or restyle, not an opaque image. (Gemini is now also
what generates the *notes content* in step 2 — a separate, later decision,
unrelated to Canvas.)

**Highlighting is a targeted string match, not a model decision at render
time.** Gemini names *which* terms in each section deserve a highlighter
mark (`highlights: [...]`) during the structured JSON pass. The template
then does a plain first-match substring wrap. This keeps the rendering step
free of any LLM call — it's pure string/HTML generation — so pagination and
styling stay fast and fully deterministic.

**Page breaks are CSS, not image stitching.** Each `.notebook-page` gets
`break-after: page`; Puppeteer's `page.pdf()` respects that natively. This
was simpler and produces sharper text than rendering each page to a PNG and
recombining with a PDF library, at the cost of being harder to preview
page-by-page outside a PDF viewer.

**Transcript fallback degrades loudly, not silently.** Most lecture videos
on YouTube have captions, so `youtube-transcript` handles the common case
with no API cost. When captions are missing, the fallback needs `yt-dlp` on
`PATH` and an `OPENAI_API_KEY` for Whisper — and if either is missing, it
fails with a specific, actionable error rather than silently producing empty
notes.

## Performance

The template originally loaded Tailwind's CDN script (which JIT-compiles
utility classes live, in-browser, on every page load — a dev-only tool, not
meant for repeated production use) and painted a live `feTurbulence` SVG
filter for the scanned-paper grain on every one of the 5+ full-page-height
notebook pages. Measured on a real 5-page notes.json through the full
Puppeteer render → PDF pipeline (3-run average):

| stage | before | after | change |
|---|---|---|---|
| `setContent` (page load) | 1688ms | 1255ms | −26% |
| fonts/settle | 561ms | 687ms | ~flat |
| `page.pdf()` print | 10665ms | 3078ms | **−71%** |
| **total** | **12914ms** | **5020ms** | **−61%** |

Fixes, in order of impact:

- **Static noise texture.** The `feTurbulence` filter was being recomputed
  by the browser's rendering engine on every paint of every page — the
  dominant cost, confirmed by print time dropping 71%. `scripts/generate-noise-texture.mjs`
  rasterizes it once into a small tileable PNG (checked into
  `src/templates/noiseTexture.js` as a base64 data URI); the template now
  just tiles that image with the same `opacity`/`mix-blend-mode`, so it's a
  cheap image paint instead of a per-pixel filter computation, repeated once
  per page, every render.
- **Statically compiled Tailwind.** `npm run build:css` (also wired to
  `postinstall`) compiles `src/templates/tailwind-input.css` through the
  Tailwind CLI into a minified `src/templates/styles.css`, scanning
  `template.js` for used classes. `template.js` reads that file once at
  module load and inlines it directly into the generated HTML's `<style>`
  tag — no CDN script, no live JIT compile per render.
- **Scoped KaTeX auto-render.** `renderMathInElement` now targets
  `#notebook-container` instead of `document.body`, a minor tightening of
  what it walks.

Google Fonts and the KaTeX CSS/JS bundle are still CDN-loaded — vendoring
those would shave more off `setContent`, but wasn't part of this pass.
Re-run the benchmark with `node scripts/benchmark.mjs [runs]` (needs a
`output/notes.json` from a prior real run) to reproduce these numbers.

## Known tradeoffs / what I'd harden next

- **Google Fonts + KaTeX are still CDN-loaded.** Only Tailwind and the noise
  texture were converted to static assets in this pass (see Performance
  above). Self-hosting the four handwriting fonts and the KaTeX bundle would
  remove the remaining network dependency and further cut `setContent` time.
- **No retry/backoff on the Gemini call.** A transient API error currently
  just fails the whole run (surfaces as `stage: "error"` via the API, or a
  non-zero exit from the CLI) rather than retrying. Worth wrapping in a
  small retry for production use — Gemini's free tier does occasionally
  return transient 503s.
- **Highlight matching prefers word boundaries, falls back to substring.**
  Each term is matched with `\bterm\b` first so a short highlight like "F"
  doesn't grab the "f" inside "force"; if that finds nothing, it falls back
  to a plain substring match rather than silently dropping the highlight.
  All terms are matched against the pristine original text and the output
  built in one pass — no term's injected `<span>` can be re-matched by a
  later term (an earlier version of this had exactly that bug: a bare "F"
  term matching the "f" inside a previous match's own `font-bold` class
  name, corrupting the HTML).
- **In-memory job store, no persistence.** `src/jobStore.js` is a `Map` -
  fine for the Electron app's locally-spawned backend, but now that the same
  `server.js` is also deployed hosted (see [Hosted API (Render)](#hosted-api-render)),
  a free-tier spin-down or redeploy silently drops every in-flight job with
  no way for a client to recover it beyond resubmitting. Needs a real queue
  (or at least a persisted job record) before anything depends on jobs
  surviving a restart.
- **No auth on the hosted API.** `server.js`'s original "not internet-facing"
  assumption (see [Local API](#local-api)) is no longer true now that it's
  deployed on Render with a public URL - anyone with the link can call
  `/generate` and consume the shared `GEMINI_API_KEY` quota (the exact 429
  the desktop app hit during testing is one bad actor away from being
  trivial to trigger deliberately). Fine while the URL is unlisted during
  mobile-app development; needs at least a shared-secret header or per-client
  API key before sharing the URL more broadly.

## Setup

```bash
npm install
cp .env.example .env   # fill in GEMINI_API_KEY
node generate-notes.js "https://www.youtube.com/watch?v=..." -o notes.pdf
```

Optional flags: `--keep-html` and `--keep-json` write out the intermediate
HTML/JSON alongside the PDF, useful for debugging the template or the notes
schema without re-calling Gemini.

The audio-transcription fallback (only triggered when a video has no
captions) additionally needs `yt-dlp` on `PATH` and `OPENAI_API_KEY` set.

`npm install` runs `build:css` automatically. If you add/remove Tailwind
classes in `template.js`, re-run `npm run build:css` manually to refresh
`src/templates/styles.css` before generating notes.

## Desktop app (Electron)

`electron/main.js` packages the Express backend and the frontend into one
standalone process tree - no `next dev`, no manually-started `node
server.js`, nothing external. On `app.whenReady()`:

1. **Backend**: spawned via `child_process.spawn(process.execPath, [...])`
   with `ELECTRON_RUN_AS_NODE=1` - i.e. Electron's own bundled binary
   running as plain Node, not a system `node` install (which a real
   standalone install can't assume exists on the target machine).
2. **Frontend**: `frontend/next.config.mjs` builds a static export
   (`output: "export"`) rather than running Next's own server inside the
   packaged app. It's served by a plain `express.static` server started
   in-process in `electron/main.js` - **not** `win.loadFile()` pointed at
   `out/index.html`, because Next's static export uses root-absolute asset
   paths (`/_next/static/...`) that don't resolve under `file://`; verified
   this empirically before committing to the static-server approach.
3. **Window**: `win.loadURL('http://localhost:3000')` - itself served by
   a process Electron spawned, not a dev server.

Since the frontend static server and the backend are on different ports
(different origins to a browser), `server.js` now has a permissive CORS
middleware - both only ever run on localhost under Electron's control, so
this doesn't expose anything a `localhost`-bound service doesn't already.

**PDF rendering browser: system Chrome/Edge, not a bundled copy.**
Puppeteer's own Chromium download (`~/.cache/puppeteer`, ~350MB) works fine
for dev, but bundling it into the installer would roughly double the app's
size on top of Electron's own bundled Chromium - two full copies of the
same browser engine for one app. Instead, `electron/main.js` (`findSystemChromium`)
checks the usual Chrome/Edge install locations and points
`PUPPETEER_EXECUTABLE_PATH` at whichever it finds - Puppeteer's `launch()`
respects that env var natively, no changes needed in `pdfExport.js`. Edge
ships as a mandatory OS component on Windows 10/11, so this is a safe bet
in practice; if truly neither is installed, PDF generation fails with a
clear error surfaced through the normal job-error UI rather than crashing.
This dropped the portable exe from ~190MB to ~92MB.

**Build and verify:**

```bash
npm run electron:pack   # fast: unpacked build at dist/win-unpacked/Notesify.exe
npm run electron:dist   # slower: single portable "Notesify 0.1.0.exe" at dist/
```

Both verified end to end from a cold double-click (all dev servers/terminals
closed, `ELECTRON_RUN_AS_NODE` unset, ports free beforehand): the window
opens, the full URL → transcript → notes → PDF pipeline runs (rendered via
system Chrome, confirmed via `main.log`'s `systemChromiumPath` entry), and
the PDF lands in `<userData>/jobs`. The portable build's single exe is a
self-extracting NSIS wrapper - it takes a few seconds to extract to a temp
dir on first launch before the window/servers come up, which is normal,
not a hang.

Both run `build:frontend` first automatically. Verifying this actually
works standalone means closing every dev server/terminal and launching the
built `.exe` cold - `electron/main.js` logs its own startup (resolved
paths, whether each expected file actually exists, backend stdout/stderr)
to `<userData>/main.log` since a packaged Electron app is a Windows-
subsystem executable with no attached console, even launched from a
terminal.

**Gotcha worth knowing:** if you're testing from a terminal that itself has
`ELECTRON_RUN_AS_NODE=1` set in its environment (this can happen inside
Electron-based tools/IDEs), `electron.exe` - and the packaged app's own
`.exe` - will silently run as plain Node instead of launching the actual
Electron app, failing fast with no window and no error dialog. Unset it
before testing:
```bash
env -u ELECTRON_RUN_AS_NODE npm run electron:pack
```
A real double-click from Explorer/taskbar never has this problem - it's
purely a hazard of testing from a shell that inherited it.

**Known tradeoffs specific to the packaged build:**
- **`.env` (including the real `GEMINI_API_KEY`) ships inside `extraResources`.**
  Pragmatic for verifying this works standalone on the same machine; wrong
  for actually distributing this to other people, since it'd hand out a
  personal API key. A real distribution needs an in-app "enter your API
  key" flow (stored via `app.getPath("userData")`, not bundled) before
  shipping to anyone else.
- **`asar: false`.** Chosen deliberately so `server.js` can be spawned as a
  plain file on disk with zero asar-transparency edge cases - electron-builder
  warns this is "not recommended," which is true for a typical packaged
  app trying to minimize size/protect source, but not a concern for a
  single-user local tool that already ships its full source either way.
- **`JOBS_OUTPUT_DIR` points at `app.getPath("userData")`**, not next to
  `server.js` - a real install directory (e.g. under `Program Files`) is
  often not writable without elevation.
- **PDF generation depends on system Chrome/Edge being installed.** Not
  bundling Puppeteer's own Chromium (see above) halved the install size but
  means `findSystemChromium()` has to actually find something at runtime.
  Extremely likely on Windows (Edge is mandatory), but not guaranteed on a
  locked-down or stripped install - worth bundling a fallback copy if this
  ever needs to run on machines that can't be assumed to have either.

## Hosted API (Render)

The same `server.js` is also deployed as a standalone hosted service via
`Dockerfile` + `render.yaml` - this is what a future mobile app talks to
over the network, since it can't spawn Puppeteer locally the way the
Electron app does. **This is a separate deployment; it doesn't affect or
depend on the Electron app, which keeps using its own locally-spawned
backend.**

**Why Render, not Railway:** checked both against 2026 pricing before
choosing. Railway removed its free tier in 2023/2024 - it's now a $5 trial
credit then a $1/month minimum just to keep a service alive. Render still
has a genuine free tier (750 instance-hours/month, 512MB RAM, Docker
support), at the cost of spinning down after ~15 min idle.

**Docker, not Render's native Node buildpack:** Puppeteer needs a real
Chromium binary plus the OS-level libraries it links against (NSS, font
rendering, etc.) - a buildpack that just runs `npm install` has no way to
provide those. `Dockerfile` installs the Debian `chromium` package instead
(pulls in its full dependency tree via `apt` automatically, rather than
hand-listing ~15 individual `.so` libs for Puppeteer's own Chromium
download) and points `PUPPETEER_EXECUTABLE_PATH` at it - the same
system-browser approach `findSystemChromium()` uses for the desktop app,
just via `apt` instead of probing Windows install paths.

`src/templates/styles.css` (compiled Tailwind output, committed to git -
see [Performance](#performance)) is copied in pre-built; the Docker build
does **not** run `npm run build:css`, since that needs the `tailwindcss`
CLI, a devDependency, which a production `npm ci --omit=dev` never
installs. First version of this Dockerfile ran a plain `npm ci` and hit
exactly that: `postinstall` firing `build:css` with no `tailwindcss`
binary present, failing the build before it ever got to `COPY server.js`.
Fixed with `npm ci --omit=dev --ignore-scripts`.

**Environment variables** (`GEMINI_API_KEY`, `GEMINI_MODEL`,
`OPENAI_API_KEY`) are set through Render's dashboard, not committed -
`render.yaml` marks the secrets `sync: false` so Render prompts for them on
first deploy instead of reading them from this repo.

**Verified for real**, not just "the build didn't error": `POST /generate`
against the live URL with a real short video, polled `GET /status/:jobId`
to `"stage":"done"`, then `GET /download/:jobId` - confirmed a genuine
`application/pdf`-typed, 2-page PDF, not just a 200 with an empty body.

**Cold-start / spin-down behavior actually observed, not assumed:**
- The free-tier instance spins down after idle and takes on the order of
  30-60s to come back on the first request after a gap - expected, matches
  Render's documented behavior.
- More surprising: even on a freshly-deployed, already-warm instance,
  roughly 1 in 5 requests to `/health` came back `404 Not Found` with an
  `x-render-routing: no-server` header - a response from Render's edge
  proxy, not from Express (no `x-powered-by: Express` on those responses).
  This wasn't a one-time deploy-settling blip; it recurred across a 30s
  sampling window well after the service reported "live." A client talking
  to this API - the future mobile app included - needs to retry on 404/5xx
  rather than treating a single failed request as authoritative.
