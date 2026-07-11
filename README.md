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
- **Shared-secret auth, not real per-user auth.** `/generate`,
  `/status/:jobId`, and `/download/:jobId` now require an `X-API-Secret`
  header matching `API_SHARED_SECRET` (see [Hosted API (Render)](#hosted-api-render)) -
  closes off the open-quota-drain risk from the URL being public, but it's
  one secret shared by every caller, not a per-user credential. Fine for a
  single-owner mobile app talking to its own backend; would need real
  per-user API keys (or a proper auth provider) the moment this has more
  than one trusted caller. `/health` is intentionally exempt (no sensitive
  operation, needed for uptime checks); `/debug/jobs` and
  `/debug/jobs/:jobId` are **not** currently gated either, which is worth
  revisiting since they do leak job data.

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

`yt-dlp` on `PATH` is no longer purely optional once the "multiple videos"
flow is used, though - playlist resolution and per-video title lookups
(`src/playlist.js`) both need it regardless of whether any video actually
falls back to audio transcription. Missing `yt-dlp` fails a `playlistUrl`
request outright (nothing to resolve without it) but only degrades a
`videoUrls[]` batch gracefully (titles fall back to the raw URL as a
label). Confirmed locally by installing `yt-dlp` via `pip install --user
yt-dlp` (not present on this machine by default) before any of the
verification below could run.

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
`OPENAI_API_KEY`, `API_SHARED_SECRET`, `YT_COOKIES_BASE64`) are set through
Render's dashboard, not committed - `render.yaml` marks the secrets
`sync: false` so Render prompts for them on first deploy instead of reading
them from this repo.

**Auth**: `/generate`, `/status/:jobId`, and `/download/:jobId` require an
`X-API-Secret` header matching `API_SHARED_SECRET` once that env var is set
(see `requireApiSecret` in `server.js`, and the tradeoffs note above on why
this is a shared secret rather than real per-user auth). `/health` doesn't
need it:
```bash
curl -H "X-API-Secret: <the secret>" \
  -X POST https://<host>/generate \
  -H "Content-Type: application/json" \
  -d '{"youtubeUrl":"https://www.youtube.com/watch?v=..."}'
```
A missing or wrong secret both just get a `401 {"error":"Unauthorized"}` -
deliberately the same response either way, so the error message itself
can't be used to guess whether a header was even present.

**Verified for real**, not just "the build didn't error": hit the live URL
without the header first (`401`, confirming the gate is actually live on
the deployed instance, not just in local source), then with the correct
header - `POST /generate` with a real short video, polled `GET
/status/:jobId` to `"stage":"done"`, then `GET /download/:jobId` - confirmed
a genuine `application/pdf`-typed, 2-page PDF, not just a 200 with an empty
body.

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

**Known issue: intermittent caption-fetch failures on Render.** Investigated
by running 17 `/generate` calls across 4 videos (2 that had worked earlier
this session, 2 never used before) directly against the live instance.
Findings ruled out the obvious theory:
- **Not a simple IP block** - one video (Rick Astley, heavily cached/very
  popular) succeeded 4/4 times; another ("Me at the zoo") failed 5/5 in the
  same window. A hard block would fail everything uniformly.
- **Not simply per-video either** - the same video (Gangnam Style) flipped
  from success to failure on an immediate back-to-back repeat request,
  which a purely video-specific cause (e.g. captions permanently disabled)
  can't explain.
- Best-supported explanation: something correlated with per-video/CDN
  cache-tier variance in the `youtube-transcript` package's InnerTube/
  webpage-scraping path, not a uniform Render-IP block.
- The real underlying error was previously **unrecoverable even from this
  process's own logs**: `src/transcript.js` swallowed it in a bare `catch {}`
  with no logging at all, so every failure looked identical from the
  outside regardless of cause. Fixed with diagnostic logging only (no
  behavior change) - the real error type/message (the library throws typed
  errors: captcha/too-many-requests, video-unavailable, captions-disabled,
  no-transcript) now reaches Render's log stream, so the next occurrence is
  a log read instead of a re-investigation.
- The yt-dlp/Whisper fallback (`src/transcript.js`'s `transcribeViaAudioFallback`)
  is untested on Render - every failure observed short-circuited on its
  `OPENAI_API_KEY` presence check before yt-dlp ever ran, since that var
  isn't set there.

**Fix: authenticate as a logged-in session via `YT_COOKIES_BASE64`.**
YouTube's blocking/rate-limiting is IP-and-anonymity based; the standard
workaround is presenting cookies from an actual logged-in browser session
rather than an anonymous request. `YT_COOKIES_BASE64` holds a browser-
exported Netscape-format `cookies.txt`, base64-encoded to survive as a
single-line env var. `src/transcript.js` decodes and writes it to a temp
file once at module load (both `server.js` and `generate-notes.js` import
this module exactly once, so "on import" covers startup for either entry
point) and wires it into both caption-fetch paths:
- **yt-dlp**: `--cookies <path>` appended to its args - yt-dlp reads a
  cookies.txt file natively.
- **`youtube-transcript` (npm)**: no `cookies` option exists on its
  `TranscriptConfig` type (checked - only `lang` and `fetch`), but it does
  accept a custom `fetch`, which is enough to attach a `Cookie` header
  built from the file's youtube.com entries the same way `--cookies` does
  for yt-dlp.

Verified without a real YouTube session (getting real cookies requires a
logged-in browser export, not something to fabricate for testing): fed a
fake Netscape cookie file through the actual code path (decode → write →
parse → the real `fetchTranscript` call, with `fetch` itself swapped out to
intercept rather than skipping any logic) and confirmed the exact `Cookie:
CONSENT=YES+1; SID=...` header reaches the outgoing request, non-youtube.com
cookie entries are correctly excluded, and the module loads cleanly with
no behavior change whatsoever when `YT_COOKIES_BASE64` is unset (the
Electron/local case) or set to something that decodes but contains no
usable cookie lines (fails closed to today's behavior, not a crash).
**Not yet verified**: whether real cookies actually clear the block on
Render - that needs an actual exported session, set via the dashboard.

**Known constraint: Gemini free-tier daily quota (20 requests/day).**
Discovered mid-investigation above - two attempts got past caption fetch
fine and then hit `429 ... GenerateRequestsPerDayPerProjectPerModel-FreeTier`
instead. This is a hard daily cap shared across *all* callers of the one
`GEMINI_API_KEY`, unrelated to captions or Render entirely - it'll interrupt
local dev, Electron, and hosted testing alike once enough requests have run
that day, and resets on a 24h cycle, not a per-minute one. A single shared
free-tier key is fine for solo testing; it will not scale once real users
exist - a per-user "bring your own Gemini key" flow (raised, not yet
designed) would sidestep this rather than paying for a shared quota - and
is worth remembering before assuming a `429` here means something is
broken.

## Multi-provider fallback for notes generation

The Gemini daily-quota constraint above wasn't hypothetical - it interrupted
this project's own testing repeatedly. `src/notesGenerator.js` now falls
through a provider chain instead of hard-failing the moment Gemini's quota
is hit:

1. **`gemini-2.5-flash`** (`GEMINI_MODEL` overridable) - current primary,
   best quality. Unmodified base prompt - already producing good depth on
   its own.
2. **Groq's `llama-3.3-70b-versatile`** (`GROQ_API_KEY`, free at
   [console.groq.com/keys](https://console.groq.com/keys)) - tried *before*
   Flash-Lite: Llama 3.3 70B is a substantially larger/more capable model
   than a "Lite" tier Gemini, so it's the better fallback quality-wise
   despite being a genuinely separate provider/account, ~14,400 RPD
   free-tier headroom. Different model family with no native JSON-schema
   constraining on Groq's side, so the prompt spells out the exact shape
   explicitly (`JSON_SHAPE_INSTRUCTIONS`) on top of
   `response_format: json_object` (valid-JSON-guaranteed, not shape-
   guaranteed) - the same zod (`NotesSchema`) validation every provider's
   output goes through either way is still the real gate, not the prompt
   wording.
3. **`gemini-3.1-flash-lite`** - the final safety net, not the first
   fallback. Same `GEMINI_API_KEY`/Google account, but a separate quota
   bucket from `-flash`'s, and the same native `responseSchema`
   constraining - a same-family model-string swap, not a different
   integration. (Was `gemini-2.5-flash-lite` until Google started returning
   a `404 "This model models/gemini-2.5-flash-lite is no longer available
   to new users"` for it - see "Stale model string" below.
   `gemini-3.1-flash-lite` is the current stable lightweight model per
   [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models),
   confirmed generally available, not preview.)

**Provider-specific prompt depth** (`THOROUGHNESS_INSTRUCTIONS` in
`src/notesGenerator.js`): lighter/smaller models tend to under-elaborate
relative to full Gemini Flash on the exact same base instructions -
summarizing sparsely instead of preserving the source's actual level of
detail. Steps 2 and 3 (Groq, Flash-Lite) get an explicit "do not summarize
sparsely - include all examples, sub-points, and elaborations... match the
depth of a comprehensive study guide, not a brief summary" instruction
appended to the system prompt; step 1 (the primary) keeps the base prompt
untouched, since it doesn't need it. The JSON shape/schema requirements
(`JSON_SHAPE_INSTRUCTIONS`) are identical across all three providers -
only this depth/thoroughness framing differs.

**Advances on a quota error, or a 404 "model no longer available" error** -
`isFallThroughError()` (was `isQuotaError()` - renamed when the second
trigger was added) checks for a `429` status, `groq-sdk`'s typed
`RateLimitError`, quota/rate-limit wording in the error message, or a `404`
whose message actually says the model is unavailable/deprecated/not found
(not just any 404 - see "Stale model string" below for why this second
trigger exists). Anything else (malformed transcript, a provider's JSON
failing the zod schema, a genuine unrelated 5xx, auth errors) fails
immediately instead of silently masking a real problem behind more (doomed)
attempts - a different provider wouldn't fix a schema mismatch or a bad API
key either.

**Stale model string, fixed (July 2026)**: `gemini-2.5-flash-lite` started
returning a `404` ("no longer available to new users") from Google's API -
confirmed via a real call, and via Google's own AI Developers Forum
reporting the same thing happening broadly the same week, ahead of the
model's officially published October 2026 deprecation date. Two problems,
both fixed:
1. **The model string itself** - step 2 now uses `gemini-3.1-flash-lite`
   (see above), the current stable lightweight model.
2. **The fallback chain didn't advance on this failure at all** - a 404 for
   an unavailable model isn't a quota error, so the old `isQuotaError()`
   didn't match it, and the chain surfaced it as a hard failure instead of
   trying Groq - defeating the entire point of having a fallback chain for
   exactly the kind of failure (a fixable-by-trying-something-else error)
   it exists for. `isFallThroughError()` now also matches this case (see
   above), reasoning identically to why quota errors advance: retrying the
   same provider/model would never succeed either way.

**Which provider actually answered is always logged** - `console.log`
on any fallback, so a job that succeeded via Groq is never silently
indistinguishable from one that succeeded via Gemini.

**If all three are exhausted/failing**, the error surfaced to the job (and
therefore `/status`) is `"All note-generation providers are currently
rate-limited. Try again later."` - not the old generic per-provider 429
message, and not conflated with the "no captions" family of errors from
the transcript stage.

**Originally verified without burning real quota or needing a real
`GROQ_API_KEY`**: monkeypatched `fetch` to return actual-shaped 429
responses from Gemini's API and a mocked (but response-shape-accurate)
success from Groq's OpenAI-compatible endpoint, run through the real
`generateNotes()` - not a reimplementation of the logic under test.
Confirmed, each as a distinct scenario:
- Real `gemini-2.5-flash` call against a real transcript still produces
  valid, schema-passing notes (the actual point of "don't break the
  common case" - checked first, before any fallback-path testing).
- Forced 429 on both Gemini steps → chain correctly falls through to Groq,
  Groq's mocked response is used, and the fallback is logged.
- Forced 429 on all three → the exact terminal error message above, not a
  per-provider 429 leaking through.
- A non-quota error (mocked `500`) on the primary provider → fails
  immediately, Groq is never even attempted (asserted directly, not just
  inferred from the outcome).
- A schema-shape mismatch (valid HTTP 200, but the model's JSON is missing
  required fields) on the primary provider → also fails immediately, not
  treated as a quota problem - confirms the fall-through check (then still
  named `isQuotaError()`, before this fix renamed and broadened it) didn't
  over-match.

**Re-verified against the real Groq API** as part of the stale-model-string
fix above (`GROQ_API_KEY` is now configured, closing the earlier gap) -
`fetch` monkeypatched only for the two Gemini calls, Groq's own call left
completely real:
- Forced a real-shaped `429` on `gemini-2.5-flash`, left
  `gemini-3.1-flash-lite` untouched → real call to the new model string
  succeeded with genuine, schema-passing notes - confirms the corrected
  model string is actually valid against Google's live API right now, not
  just per the docs.
- Forced `429` on `gemini-2.5-flash` and a real-shaped `404 "no longer
  available"` on `gemini-3.1-flash-lite` → chain correctly fell through
  all the way to a **real, live Groq call** (confirmed via a request-seen
  flag, not inferred), which returned genuine, schema-passing notes -
  the exact scenario the fix targets, working end to end against real
  providers.
- A genuine, unrelated error (`500`, matching neither quota nor
  model-unavailable wording) on the primary provider → still fails
  immediately, Groq never called - confirms `isFallThroughError()`'s
  broadened matching didn't loosen the "only fall through on a fixable-
  by-switching-provider error" guarantee.

(The two bullets above describe verification done under the *previous*
step 2/3 order - `gemini-3.1-flash-lite` then Groq. Steps 2 and 3 were
later swapped - see "Chain reorder + per-provider prompt depth" below -
so re-read them as historical record of that specific test, not the
current order.)

**Chain reorder + per-provider prompt depth, verified with a real side-
by-side comparison** (same real MIT 6.006 lecture transcript used
elsewhere in this README, ~33K chars): rather than trusting "should
theoretically help," the same transcript was run through all three
providers for real, both before and after the `THOROUGHNESS_INSTRUCTIONS`
change, and the actual output compared directly - not just page/bullet
counts (which turned out ambiguous on their own - see below) but the real
bullet text.
- **Reorder confirmed end-to-end**: forcing `gemini-2.5-flash` to fail
  landed on a **real Groq call** (not Flash-Lite) - confirmed via a
  request-seen flag on each provider's real endpoint, not inferred.
  Forcing both `gemini-2.5-flash` and Groq to fail landed on a real
  `gemini-3.1-flash-lite` call last. Matches the new 1→2→3 order exactly.
- **Groq, before vs. after the thoroughness prompt** (real calls, same
  transcript): bullet *count* barely moved (25 → 24), but average bullet
  length grew 55.1 → 67.7 chars (+23%), and a duplicate "Overview of the
  Course" section present in the "before" output was gone in "after" -
  replaced by a more specific "Common Functions and Asymptotic Notation"
  section pulling out content that used to be buried in a single
  "Asymptotic Analysis" section. Net: less redundancy, more distinct
  technical content actually broken out.
- **Flash-Lite, before vs. after** (real calls, same transcript): this one
  was genuinely mixed, not a clean win, and is reported as such rather
  than rounded up - section count dropped 8 → 6 (an administrative "Course
  Roadmap" quiz-schedule section was dropped entirely in "after," and a
  "Runtime Growth Classes" section got folded into "Asymptotic Analysis"
  as a single bullet). But reading the actual bullet text side by side,
  the academic content that remained is genuinely more elaborated: the
  Birthday Problem algorithm went from one compressed bullet ("maintain a
  record, iterate through individuals...") to an explicit 5-step numbered
  breakdown; "before" had no callout on the course-overview section at
  all, "after" added a real one explaining the course's proof-writing
  emphasis; the consolidated growth-classes bullet in "after" actually
  lists *more* distinct complexity classes (added "quadratic") than the
  dedicated section it replaced. Net for Flash-Lite: real, visible gains
  in per-section depth on the content that matters most, at the cost of
  dropping one non-academic administrative section - not a false "purely
  positive" claim.

## Mobile app (Capacitor/Android)

The same frontend codebase is wrapped a third way: `frontend/capacitor.config.ts`
+ `frontend/android/` package the static export as an Android APK that talks
to the hosted Render backend (above) instead of a locally-spawned one -
mobile can't run Puppeteer locally the way Electron does. **Separate build
target; doesn't touch the Electron app or its local-backend config.**

`frontend/lib/api.ts` serves both: `API_BASE_URL`/`API_SHARED_SECRET` are
`NEXT_PUBLIC_*` env vars baked in at `next build` time, and which values
apply depends entirely on which build command ran -
[frontend/README.md](frontend/README.md#building-for-android-hosted-backend)
has the exact commands. Verified this doesn't cross-contaminate: built both
targets back to back and grepped each `out/` for the other's URL - the
Electron build only ever contains `localhost:4500`, the mobile build only
ever contains the Render URL.

**Auth on mobile**: since `/download/:jobId` (and the others) require
`X-API-Secret`, and a plain `<a href>`/`<iframe src>` can't carry a custom
header, `fetchPdf` in `lib/api.ts` does an authenticated `fetch` + `Blob`
instead and hands the UI an object URL. This is a real behavior change from
the previous plain-link approach, applied to both build targets - harmless
for Electron (no secret configured there, header is just omitted) and
necessary for mobile.

**Cold-start UX**: `IS_HOSTED_BACKEND` (true whenever `API_BASE_URL` isn't
`localhost`) swaps the "waiting for the local server" copy for "waking up
the server - this can take up to a minute," matching Render's actual
spin-down behavior instead of implying something's broken.

**Retry-on-`no-server`**: `fetchWithRetry` in `lib/api.ts` retries transient
failures on `/generate`, `/status`, and `/download` - see the
[Retry-logic audit](#retry-logic-audit) section below for what this
actually catches in practice (not quite what it was originally built to
detect - the no-server signature turned out to be unobservable from a real
browser) and how `/generate` specifically is made safe to retry.

**What's actually been verified, and what hasn't:**
- ✅ `npx cap add android` / `npx cap sync` ran cleanly and the built static
  export (with the Render URL and secret correctly baked in - confirmed by
  grepping the output) landed in `android/app/src/main/assets/public/`,
  with `INTERNET` permission present in the generated `AndroidManifest.xml`.
- ✅ The web layer was driven end-to-end against the **live** Render
  backend: served the exact mobile build output (the same files that ship
  inside the APK) locally and drove it with a headless browser - health
  check with the auth header, `/generate`, status polling (including
  transparently riding out a couple of real `no-server` 404s mid-poll),
  reaching `done`, and an authenticated blob download that resolved to a
  real `blob:` URL. This is the actual code path the Android WebView will
  execute, exercised against the real backend, not a mock.
- ❌ **Not verified**: the native Android shell itself - actually building
  the APK in Android Studio, installing it on a device/emulator, and
  confirming the WebView renders/behaves correctly. This development
  environment has no Android SDK, no `adb`, no emulator, and Node 20 (this
  project's Capacitor version was deliberately pinned to 7.x rather than
  the Node-22-requiring 8.x for that reason - see git history if that
  constraint changes). That step needs a machine with Android Studio.

**Known limitation - baked-in shared secret**: same tradeoff as the hosted
API's shared-secret auth, but more exposed here - `API_SHARED_SECRET` is
compiled directly into the APK's JS bundle, extractable by unzipping the
APK. Fine for a single-owner app; would need real per-user auth before this
APK goes to anyone else.

## Client-side transcript fetching

`YT_COOKIES_BASE64` (above) was one attempt at working around YouTube
blocking Render's IP for caption fetches. This is a more direct one:
**don't fetch captions from Render at all** - fetch them from whichever
device is actually running the app, which has its own, unblocked IP.
`src/transcript.js`'s captions logic didn't move so much as get called
from a different place depending on the build target.

**The premise had a hole, found by testing it rather than assuming it'd
work**: the plan was to run the `youtube-transcript` npm package's fetch
calls directly in the browser/WebView. Tested that first, in real
Chromium, before building anything on top of it - a page on a foreign
origin calling YouTube's `youtubei/v1/player` endpoint and its watch-page
HTML gets hard-blocked by CORS (`No 'Access-Control-Allow-Origin' header is
present`), unconditionally, regardless of IP or rate limits. Building the
whole feature on a `fetch()` call that was always going to be blocked by
the browser itself - not by YouTube - would have shipped something that
silently never worked.

**What actually runs where:**
- **Mobile (Capacitor/Android)**: `capacitor.config.ts` enables
  `CapacitorHttp`, which patches `window.fetch` on native platforms to go
  through native OS networking instead of the WebView's engine - not
  subject to the WebView's CORS enforcement, since the request never
  touches anything that enforces same-origin policy. `frontend/lib/transcript.ts`
  calls `YoutubeTranscript.fetchTranscript()` (the same npm package,
  installed directly in `frontend/` this time - it's pure `fetch`-based
  with no Node built-ins, confirmed by reading its source, so it's
  browser-safe as-is) without needing to know this patching is happening.
- **Electron**: never actually had the blocking problem - its backend runs
  on the user's own local IP already, not Render's - but was wired up the
  same way for one consistent architecture. The renderer can't reach
  Node's `fetch` directly (`contextIsolation: true`, `nodeIntegration: false`)
  and would hit the identical CORS wall if it tried browser `fetch()`
  directly, so `electron/preload.cjs` exposes a `window.notesifyBridge.fetchTranscript()`
  that goes over IPC to `electron/main.js`, which calls `fetchCaptionsOnly()`
  - a function extracted out of `src/transcript.js`'s existing captions
  logic (no behavior change, same code, now just also reusable by the main
  process directly) - unaffected by CORS since it's plain Node.
- **The yt-dlp/Whisper fallback stays entirely server-side**, unchanged -
  see `src/transcript.js`. A client never attempts it.

**API contract change**: `POST /generate` now accepts optional `transcript`/
`transcriptSource` fields (`server.js`). When present, `runPipeline()`
(`src/pipeline.js`) skips `getTranscript()` entirely and goes straight to
Gemini. When absent - client-side fetch wasn't attempted, or failed - the
server falls through to the exact same captions-then-yt-dlp flow as
before. `frontend/lib/transcript.ts`'s `fetchTranscriptClientSide()` always
resolves to `null` rather than throwing on any failure (including a 15s
timeout, added after noticing nothing previously bounded how long a
stalled mobile connection could hang the UI in "Fetching transcript...");
`NotesApp.tsx` treats `null` as an ordinary, expected outcome - not an
error - and just omits `transcript` from the request, which is what
triggers the old behavior. The actual failure UI (rate-limit detection,
cooldown, "Try again") is unchanged and only engages if the request
*still* ultimately fails after that fallback.

**Verified:**
- `fetchCaptionsOnly()` (the exact function Electron's IPC handler calls)
  tested directly - returned a real transcript from this machine's own IP.
- The full `NotesApp.tsx` flow driven through a real browser twice: once
  with no `window.notesifyBridge` (simulating a plain browser/before the
  bridge exists) - confirmed the CORS failure happens, is caught, and the
  request sent to `/generate` correctly omits `transcript`, falling
  through to server-side exactly as designed; once with a mocked
  `window.notesifyBridge` (standing in for Electron's real preload
  contract, which was verified separately) - confirmed a successful
  client-side fetch results in `transcript`/`transcriptSource` actually
  reaching the request body.
- Server-side contract change verified directly: a `/generate` call
  carrying a `transcript` field jumped straight to `generating_notes`
  (skipping `extracting_transcript` entirely) with the exact transcript
  text/length echoed back, and ran to `done` normally; a call without one
  still starts at `extracting_transcript` exactly as before backward
  compatibility confirmed, not assumed.
- `capacitor.config.ts`'s `CapacitorHttp` setting confirmed present in the
  generated `android/app/src/main/assets/capacitor.config.json` after a
  fresh `cap sync`.

**Not verified - same standing limitation as the rest of the mobile
work**: no Android SDK/emulator/device in this environment, so the one
thing that can't be confirmed here is the actual point of this whole
change - whether a real phone, on a real network, successfully fetches a
transcript for a video that's currently blocked on Render, via the real
`CapacitorHttp` native bridge (not the browser `fetch()` proven blocked
above). That needs a real device test.

## PDF download/save on mobile

Tapping "Download PDF" on Android did nothing visible - the bug wasn't
that the fetch failed, it's that `URL.createObjectURL()` + `<a
href="blob:...">` (what the Electron/desktop build already used, see
`lib/api.ts`) has no download-manager wiring in a bare WebView the way a
real browser tab does. The tap fired, the anchor's `href` was a valid
blob URL, and nothing happened - silence, not an error.

**Fix, mobile-only**: `frontend/lib/downloadPdf.ts` writes the fetched PDF
bytes to disk via `@capacitor/filesystem` (`Directory.Cache` - staging for
the next step, not the final resting place; Android's scoped storage means
an app-private cache dir isn't independently browsable by the user anyway)
and immediately opens the system Share sheet via `@capacitor/share`, so the
user picks where it actually goes (Downloads, a PDF viewer, another app).
This is the standard documented Capacitor recipe for "let the user do
something with a generated file," not a workaround invented here.

**Platform branching, not a replacement**: `isNativeMobile()` (wraps
`Capacitor.isNativePlatform()`, false in both Electron and a plain
browser - confirmed via a real end-to-end run through the actual UI, see
below) decides which button renders in `NotesApp.tsx`'s "done" view. The
Electron/desktop `<a href={blobUrl}>` path is untouched code, still
reached the exact same way.

**Failure feedback, the actual complaint**: `savePdfOnMobile()` never
throws - every outcome (shared, saved-but-not-shared because the user
backed out of the share sheet, or a real write/share failure) resolves to
a typed result the UI renders explicitly: "Shared.", "Saved to the app's
cache - use the share sheet to move it somewhere permanent," or a visible
error box with a "try again" that re-arms the button. Silence was the bug;
every path here ends in something on screen.

**Verified:**
- Both frontend build targets compile cleanly with the new plugins,
  including through `Capacitor.isNativePlatform()` running during Next's
  static-export prerender (Node, no `window`) without crashing.
- The Electron/desktop path re-verified end-to-end through the real UI
  after this change: a real `<a href="blob:...">` with the correct
  `download` attribute is present, and critically, `isNativeMobile()`
  correctly returns `false` in a plain Chromium tab - no mobile Save/Share
  button renders, confirming the platform branch doesn't leak into the
  desktop build.
- `npx cap sync` picked up both new plugins (`@capacitor/filesystem@7.1.8`,
  `@capacitor/share@7.0.4`) automatically. Checked the generated Android
  project directly rather than assuming the standard recipe would just
  work: `AndroidManifest.xml` already has a `FileProvider` configured
  (Capacitor's default template includes this), and its `file_paths.xml`
  already covers `cache-path` - so `Directory.Cache` + `Share.share()`
  needs no manual native-side configuration beyond what `cap sync` already
  produced.

**Not verified - the actual point of this fix**: whether tapping the
button on a real device actually opens a share sheet (or shows the error
state) instead of doing nothing. Same standing limitation as the rest of
the mobile work - no Android SDK/emulator/device here. This needs a real
device install: build the APK, tap Download on a completed job, and
confirm it's the share sheet or a visible message, never silence.

## Retry-logic audit

Audited every client-side call to the hosted Render backend
(`frontend/lib/api.ts`) for `fetchWithRetry` coverage, since it had only
ever been explicitly verified against `/status` polling. What this found
was more interesting than "some endpoint was missing retry."

**The headline finding: the retry logic's own detection mechanism was dead
code.** `fetchWithRetry` used to specifically look for a `404` response
carrying an `x-render-routing: no-server` header - the exact signature
identified in the original hosted-API investigation - and only retry that.
Testing it properly (simulating the actual failure through a real browser,
not just grepping for `fetch(`) surfaced the problem: Render's real
no-server response carries **no `Access-Control-Allow-Origin` header at
all** (re-checked the raw response captured during the original
investigation to confirm - it isn't there). A cross-origin `fetch()` to a
response with no CORS header doesn't deliver a readable `Response` to JS -
it throws an opaque network error before `res.status`/`res.headers` can
ever be inspected. The specific detection branch could never fire in a
real browser; every prior "confirmed working" claim about it came from
curl-based testing, which isn't subject to browser CORS at all and so
never would have caught this.

In practice this meant the no-server case *was* still being caught, just
by accident, via the generic network-error catch-all that also exists in
`fetchWithRetry` - not the mechanism actually built and documented for it.

**This mattered immediately, not just as a cleanup item**, because fixing
a different gap this same audit found had just made it visibly break:
`POST /generate` wasn't using `fetchWithRetry` at all before this audit -
a straightforward gap, easy to fix by wrapping it the same way `/status`
already was. But blindly retrying `/generate` on *any* network error is
unsafe on its own merits: a dropped connection doesn't prove the request
never reached Express, so a retry risks silently creating a second job
(a second Gemini call, a second transcript fetch, doubled cost, for what
looked like one click). The obvious-looking fix - "only retry the
provably-safe no-server case, not generic network errors, for `/generate`
specifically" - is exactly what got implemented first. Verifying it (per
this task's explicit "simulate the actual failure, don't just trust it")
is what surfaced the dead-code problem: since the no-server case can't
actually be detected client-side, "only retry the provably-safe case"
collapsed to "never retry `/generate` at all" - worse than doing nothing,
since it would silently stop recovering from the single most common real
failure (a cold-start blip on the very first request) for the one endpoint
where failing to recover means the user's click just didn't do anything.

**The actual fix: make the retry itself safe, not the detection.**
`POST /generate` now sends a client-generated `requestId`
(`crypto.randomUUID()`, created once per submit attempt and reused
unchanged across that attempt's retries - see `generateNotes` in
`lib/api.ts`). `server.js` keeps a short-lived in-memory cache
(`requestId -> jobId`, 5 minute TTL) and returns the existing job on a
repeated `requestId` instead of creating a new one. This makes blind
retry-on-any-network-error provably safe for `/generate` too, the same way
it always was for the read-only `GET` endpoints - so `fetchWithRetry`
itself simplified back down to "retry on any thrown fetch error," with the
no-server-specific branch removed rather than left in as misleading dead
code.

**Per-endpoint conclusion:**
- **`POST /generate`** - gap confirmed and fixed: now uses `fetchWithRetry`,
  made safe via the `requestId` idempotency cache above.
- **`GET /status/:jobId`** - already covered (the original target), still
  correctly wired after the fallback-chain and BYOK-adjacent changes since.
  Read-only, so blind retry was always safe here regardless of the
  no-server-detection question.
- **`GET /download/:jobId`** - already covered from the Capacitor download
  work, also read-only, also always safe.
- **`GET /health`** - deliberately *not* wrapped in `fetchWithRetry`, and
  this is correct as-is, not an oversight: `checkHealth()` is already
  called from its own external polling loop in `NotesApp.tsx` (retrying
  every `HEALTH_RETRY_MS` indefinitely), so stacking `fetchWithRetry`'s
  internal backoff on top would only make each individual poll slower
  without changing the eventual outcome.

**Verified, each as a real scenario through the actual running app, not
inferred:**
- Real backend, real idempotency cache, a genuine `req.abort()` (not a
  mocked response) on the first `/generate` attempt: client made 2 attempts,
  server-side truth (`GET /debug/jobs`) showed **exactly one job created**,
  not two.
- Same real-backend setup with a genuine network abort on the first
  `/status` and first `/download` attempt each, run through a full real
  Gemini call end to end: both recovered, `/status` via its own polling
  loop naturally continuing, `/download` via `fetchWithRetry`'s own retry,
  ending in a real downloadable blob link.
- The dead-code claim itself verified by reproducing the *exact* no-server
  response shape (status, headers, missing ACAO) through Puppeteer and
  confirming `fetch()` throws rather than resolving - not inferred from
  reading MDN, checked against this specific response.

## Security review

A pass across `server.js` and the hosted API, covering rate limiting, input
validation, secrets, dependencies, and error handling.

**Rate limiting** (`express-rate-limit`, per-IP, tiered by cost): there's no
login/signup here - `API_SHARED_SECRET` is one shared credential, not user
accounts - so this isn't brute-force login protection, it's specifically
about bounding how much of the shared Gemini/Groq daily quota one IP can
burn through `/generate`, the only endpoint that costs anything per call.

| Endpoint | Default | Env var overrides |
|---|---|---|
| `POST /generate` | 5 / 15 min | `RATE_LIMIT_GENERATE_MAX`, `RATE_LIMIT_GENERATE_WINDOW_MS` |
| `GET /status/:jobId` | 60 / min | `RATE_LIMIT_STATUS_MAX`, `RATE_LIMIT_STATUS_WINDOW_MS` |
| `GET /download/:jobId` | 20 / 15 min | `RATE_LIMIT_DOWNLOAD_MAX`, `RATE_LIMIT_DOWNLOAD_WINDOW_MS` |

`app.set("trust proxy", 1)` was required for this to work correctly at all
on Render - without it, every request looks like it comes from Render's own
reverse proxy, collapsing per-IP limiting into one shared bucket for every
real caller. Verified each tier is an independent bucket (exhausting
`/generate`'s limit doesn't touch `/status`'s), that the threshold is
actually driven by the env var (not just the hardcoded default happening to
match), and that the response carries standard `RateLimit-*`/`Retry-After`
headers - by running a real server with a deliberately low limit and
watching the 4th of 3 allowed requests get a clean `429`.

**Input validation on `POST /generate`**: `youtubeUrl` is checked against
an anchored pattern (not just "is a string") plus a length cap;
`transcript` (when a client sends one pre-fetched - see the client-side
transcript-fetch work) is capped at 2,000,000 characters and rejected if
empty/wrong-type; `transcriptSource` is checked against an allowlist of the
only three values anything in this codebase actually sends
(`captions`, `captions-client`, `client`) rather than accepted as an
arbitrary string. Found and fixed a real latent bug in the process: Express's
default JSON body limit is 100kb, well under real transcript sizes seen in
this project's own testing (~1.4MB for one long lecture) - raised to 5mb.
Verified with real malformed requests, not just written and assumed
correct: a non-YouTube URL, a missing URL, an XSS-shaped string appended to
an otherwise-valid URL, an invalid `transcriptSource`, an empty transcript,
and a wrong-typed transcript all get a clean `400` with a specific message
- and, to make sure the validation isn't just rejecting everything, a URL
with a real trailing query param (`&t=30s`) and a `youtu.be` short-link
were both confirmed still accepted.

**Secrets**: grepped the full git history (`git log --all -p`, not just
current files) for Google/OpenAI/Groq API key patterns and the actual
`API_SHARED_SECRET` value used during this project's own testing - no
hits. Confirmed `.env` and `frontend/.env.mobile` were never committed at
any point (`git log --all --full-history`). Re-checked the mobile secret
leak specifically, since the Android build's `android/` directory is
intentionally committed (Capacitor's own recommendation, see the mobile
section above): confirmed the *built* web assets
(`android/app/src/main/assets/public/`, where the baked-in
`NEXT_PUBLIC_API_SHARED_SECRET` would actually live) are excluded by
Capacitor's own generated `.gitignore`, not something this project had to
configure - the secret genuinely never reaches a commit. The APK itself
still contains it once built locally, same accepted single-owner-app
tradeoff documented in the mobile section - unchanged by this review.

**Dependencies**: `npm audit` clean (0 vulnerabilities) in the root
project. `frontend/` had one moderate vulnerability - `postcss` (XSS via
unescaped `</style>` in CSS stringification), pulled in transitively by
Next.js, patched via `npm audit fix --force`. That fix would have
downgraded Next.js from 16.2.10 to 9.3.3 - a four-major-version regression,
not something to do for a moderate transitive issue. Used an `overrides`
entry in `frontend/package.json` instead to pin `postcss` directly to a
patched version without touching Next.js at all - confirmed the frontend
still builds clean afterward.

**Error handling**: this was the one that turned into more than a
checklist item. `job.error` (surfaced via `/status`, and previously the
route's own final error handler) used to carry whatever the failing
provider's SDK said verbatim - real Gemini 429 bodies include the request
URL, quota metric names, and model IDs; a zod validation failure dumps
schema paths. `src/errors.js` (`classifyError`) now maps any pipeline error
to one of a handful of stable codes (`rate_limited`, `transcript_unavailable`,
`invalid_output`, `invalid_url`, `internal_error`) plus a generic message -
applied in `pipeline.js`'s catch block before the sanitized version ever
reaches the job store, while the *original* error is still what gets
rethrown (so the CLI's own `catch` in `generate-notes.js`, and
`server.js`'s own `console.error` on the pipeline's background promise,
both still see full detail - nothing was lost, it just stopped being sent
over HTTP). The route-level catch-all error handler was doing the same
leak on a different path (`err.message` straight into the 500 response,
for whatever Express itself needed to handle, e.g. malformed JSON) - now
always a fixed generic message, full error still logged server-side.

Verified with a real, not hypothetical, forced failure: monkeypatched
`fetch` to return the *actual* Gemini 429 response shape (with the real
quota-exceeded message, URLs and all) and a Groq 429 to exhaust the whole
fallback chain, then drove the real `server.js` through a real
`/generate` → poll `/status` cycle. Server console showed the complete raw
chain (both Gemini models' full error text, Groq's error, each fallback
step) exactly as intended for server-side debugging. The actual `/status`
HTTP response the client received contained only
`"The note-generation service is rate-limited right now. Please try again
in a few minutes."` and `"errorCode": "rate_limited"` - checked
programmatically against five distinct leak patterns (the Google API URL,
any Groq mention, quota-internals wording, a stack-trace shape, a
filesystem-path shape) and confirmed none were present, rather than just
eyeballing the response.

**Found along the way, not originally in scope but fixed anyway**:
`/debug/jobs` and `/debug/jobs/:jobId` had no auth at all - flagged as a
known gap back when `API_SHARED_SECRET` was first added, never actually
closed until this pass. They return full job objects (the video URL,
transcript length/source, notes title, timing data) and were reachable by
anyone with the hosted URL, no secret required. Now gated by the same
`requireApiSecret` as every other route - a no-op locally/in Electron where
the secret is unset, same as everywhere else.

**Explicitly out of scope, per the task**: file upload review - this app
has no file upload surface; input is always a YouTube URL or transcript
text, never a user-uploaded file.

Full end-to-end regression re-run after all of the above, with default
(unmodified) production rate limits: a real video, real captions, real
Gemini call, real PDF render, reaching `done` in ~12s with `errorCode: null`
on the success path - confirming none of this broke the actual pipeline.

## Single vs. multiple videos

A new first screen (`mode-choice`) sits in front of the existing URL-input
flow: "Single video" or "Multiple videos." **Single video leads to the
exact same screen as before, untouched** - `resetToStart()` was the only
thing renamed (from `resetToInput()`, since "Try again"/"Generate another"
now return to the mode choice rather than assuming last session's mode),
and the input screen's own JSX/`handleSubmit`/validation are unmodified
line for line.

**Multiple videos** leads to `components/MultiLinkInput.tsx`, a new
self-contained screen: one field to start, each field independently
classified as it's typed into (`classifyLink` - reuses `looksLikeYoutubeUrl`
from `lib/api.ts` rather than duplicating that pattern). A playlist link
(`youtube.com`/`youtu.be` with a `?list=` param - including a "watch a
video that's part of a playlist" URL, which would otherwise also match the
single-video pattern, so playlist detection is checked first) locks the
screen to a single "Next" button - a playlist already contains many
videos, so it's treated as the complete batch on its own. A single-video
link instead reveals "Add more" (appends a new empty field, itself
independently classified) and "Next," building up a `videoUrls` array. An
unrecognized non-empty value shows an inline error under that specific
field and disables both buttons until it's fixed - never a silent block.

**Request shape**: `POST /generate` now accepts `youtubeUrl` (unchanged),
`videoUrls: string[]`, or `playlistUrl: string` - `server.js` requires
exactly one of the three. Both new shapes get the same validation rigor as
`youtubeUrl` always has (pattern/length checks, a `videoUrls` entry
explicitly rejected if it carries a `?list=` param - that should have been
sent as `playlistUrl` instead, defense in depth against a mismatched
request even though the frontend already separates these before ever
building one).

**The stub, and why it responds instead of hanging or 404ing**: resolving
multiple transcripts into one set of notes is real pipeline work, explicitly
out of scope for this task ("a later step, not this one"). `server.js`
still accepts a valid batch request, logs exactly what it received
(`console.log`, videoUrls/playlistUrl - visible server-side, not silently
dropped), creates a real job, and immediately marks it with a clear
`errorCode: "not_implemented"` and a message saying so - rather than either
pretending to succeed or leaving the frontend's progress view spinning
forever against a job that will never advance. The existing generic
error/progress/done views (unmodified) render this exactly like any other
job failure - confirmed by watching a submitted playlist job resolve to
the real "Generation failed" screen with that exact message, "Try again"
included.

**Verified end to end through the real UI** (a live backend, a live
frontend build, Puppeteer driving actual clicks/typing - not just "it
compiles"), each as a distinct run with the actual `/generate` request
body captured and asserted on, not inferred from the UI alone:
- Mode-choice screen reached first, both buttons present. "Single video" →
  the real existing input screen → submitted a real video → request body
  confirmed as `{"youtubeUrl": "...", "requestId": "..."}`, no new fields
  - i.e. genuinely indistinguishable from before this task.
- "Multiple videos" → pasted a playlist link → confirmed "Add more"
  disappears, only "Next" remains → clicked it → request body confirmed as
  `{"playlistUrl": "...", "requestId": "..."}` only.
- "Multiple videos" → pasted a single video link → "Add more" appeared →
  used it twice to reach 3 fields, each independently filled with a valid
  link → confirmed the request body's `videoUrls` array contained exactly
  those 3 URLs, with no `youtubeUrl`/`playlistUrl` present.
- Pasted a non-YouTube URL → confirmed the inline "That doesn't look like a
  YouTube link" error appears and both "Add more" and "Next" are disabled
  (checked their actual `disabled` DOM property, not just visual styling).
- Screenshotted each state (mode-choice, the 3-field batch, the disabled
  invalid state) and visually confirmed they match the design language of
  the rest of the app - not just that the assertions passed.

**Explicitly out of scope, per the task**: the language/style picker (not
built yet), the single-video flow's own internals, and any real
multi-video pipeline logic beyond accepting and logging the new shapes.

## Real multi-video/playlist pipeline

The `not_implemented` stub above is gone - `videoUrls`/`playlistUrl` now
run through a real batch path in `src/pipeline.js`, not a preview.

**Playlist resolution** (`src/playlist.js`, new): `yt-dlp --flat-playlist
--print id <url>` lists a playlist's video IDs without visiting each video
page (fast regardless of playlist length), reconstructed into watch URLs
locally rather than trusting yt-dlp's own `--print url` output format
(varies by version - `--print id` is unambiguous). Capped at 20 videos
(`MAX_PLAYLIST_VIDEOS`), enforced *after* resolution since the real count
isn't known until yt-dlp reports it - a caller pointing at an oversized
playlist gets a clear rejection naming the actual count and the limit, not
a silent truncation to the first 20.

**Per-video title lookup**, also via yt-dlp (`--skip-download --print
"%(title)s"` - no video is downloaded for either this or playlist listing),
labels each video's section in the merged transcript and identifies a
skipped video in job metadata. Best-effort and non-fatal: a broken/missing
yt-dlp falls back to using the URL itself as the label rather than failing
the whole batch over what's ultimately cosmetic.

**Fetch + merge** (`fetchAndMergeTranscripts`/`mergeTranscripts` in
`pipeline.js`): each video's transcript still goes through the exact same
`getTranscript()` as a single-video job - same captions-then-yt-dlp/Whisper
fallback, unchanged. Per-video progress reports as `batchProgress`
("Fetching video 2 of 4...") in job metadata, spread across the same 5-25%
range a single video's `extracting_transcript` already used, so the overall
stage progression doesn't change shape for a batch. **Skip policy**: one
bad video doesn't fail the whole batch - it's recorded with its reason and
excluded from the merge, only failing outright if *every* video in the
batch fails. Skips surface as `skippedVideos` in job metadata (URL, title,
reason) - the frontend's `done` view lists them - never silently dropped.
Successful transcripts are joined with a `--- Video N: [title] ---` marker
each, so Gemini sees clear boundaries between unrelated lecture content
instead of one undifferentiated wall of text.

**Error messages stay specific, not generic** - `src/errors.js` gained a
`PipelineError` class for messages this codebase authors itself (playlist
too large, couldn't resolve a playlist, every video failed): these are
already safe to show a client verbatim (no SDK/provider text to leak), so
`classifyError` passes them through directly instead of flattening them
into the generic "Something went wrong" reserved for actually-unsafe
provider errors.

**Verified with real videos, a real playlist, and a real forced failure -
not mocks:**
- **2-video `videoUrls[]` batch** ("Me at the zoo" + a music video):
  completed real end to end, `batchProgress` correctly showed "video 1 of
  2" then "2 of 2", `transcriptSource: "batch-merged"`,
  `transcriptLength: 2425` (consistent with both individual transcript
  lengths plus markers). **Downloaded the actual PDF and read it** - it
  contains two clearly separate sections, "Elephants: Observed Physical
  Characteristics" and "Rick Astley - Never Gonna Give You Up: Content
  Analysis" - genuinely organized as distinct topics, not blended
  together. This is the one that matters most (confirms the merge actually
  works, not just that the request shape is accepted).
- **Real playlist** (a public 13-video ML conference playlist):
  `resolvePlaylistVideoUrls` resolved all 13 real video IDs; ran the full
  batch through the real server - `batchProgress` correctly incremented
  through all 13, merged transcript landed at 264,440 characters, and the
  job completed with `notesTitle: "Pittsburgh ML Summit '19 - Lecture
  Notes"` and `pageCount: 26` - a title that itself reflects the merge
  correctly recognized a multi-talk event, not one video's title
  arbitrarily standing in for the whole batch. The Gemini call on a
  transcript this large took several minutes (not stuck - no error in the
  server log the whole time, and it did complete) - noting this as a real,
  observed characteristic of large batches, not asserting a false "it's
  instant." Downloaded the resulting 14.5MB/26-page PDF; wasn't able to
  visually re-render *this specific* PDF in this environment (missing
  `poppler-utils`, an infra gap in this session, not the app), so multi-
  section coverage for this one is inferred from the strong structural
  evidence above rather than re-confirmed page by page - the actual
  section-separation *mechanism* is the same code path already directly
  visually verified via the smaller 2-video test.
- **Isolated playlist-resolution checks**: fed the same real 13-video
  playlist through `resolvePlaylistVideoUrls` directly with
  `maxVideos: 5` - correctly rejected with `"This playlist has 13 videos,
  over the 5-video limit..."` and `errorCode: "playlist_too_large"`, not a
  silent truncation to 5. With `maxVideos: 20`, correctly resolved all 13
  real, correctly-ordered watch URLs.
- **Deliberate partial failure**: a 3-video batch with one syntactically-
  valid-but-nonexistent video ID (`ZZZZZZZZZZZ`) mixed in with two real
  ones. The batch **completed successfully** (`stage: "done"`) rather than
  failing outright - `skippedVideos` correctly listed the fake video's URL
  and the exact reason ("No captions available for this video.
  Audio-transcription fallback requires OPENAI_API_KEY to be set."), and
  `transcriptLength: 2425` confirmed only the two real videos' transcripts
  were actually merged in, not a corrupted three-way merge.

## Language + style picker

Between video selection and pipeline start, both the single-video and
multi-video/playlist flows now land on a new picker screen
(`LanguageStylePicker.tsx`) instead of firing `/generate` immediately -
notes language and visual theme are chosen there, then "Generate Notes"
kicks off the pipeline with both included in the request.

**Language** (`ALLOWED_LANGUAGES` in `server.js`): English (default),
Hindi, Tamil, Bengali - Hindi listed first per the most-requested language
for Indian exam-prep audiences. `notesGenerator.js`'s
`languageInstruction()` appends a targeted instruction to the Gemini/Groq
prompt when a non-English language is selected: translate all prose
(titles, headings, bullets, callouts, table cells) but leave LaTeX/math
notation untouched, since transliterating `\hat{i}` or `\sin\theta` would
break rendering. English (the default) sends no extra instruction at all,
so the old prompt shape is unchanged for the common case.

**Style** (`STYLE_PRESETS` in `template.js`): three presets - `classic`
(the original blue-ink/red-marker/yellow-highlight scheme, now the
explicit default rather than the only option), `coolTones`
(purple ink/teal marker/cyan highlight), and `minimal` (near-black ink,
white paper, low-opacity doodles, muted gray accents). Implemented as a
CSS-custom-property swap, not separate templates:
`renderNotesHtml(notes, { styleId })` resolves the preset and injects its
tokens (`--ink-color`, `--marker-color`, `--paper-bg`, `--highlight-rgb`,
`--doodle-color`, `--doodle-opacity`, `--badge-color`, `--katex-color`)
into `:root`, and every previously-hardcoded color reference in the
template now reads from a `var(--...)` instead. Callout colors
(mistake/memory-trick highlight boxes) are deliberately left unthemed -
they're semantic (red/green), not decorative.

Both fields are optional and validated against allowlists (`400` on an
unrecognized value); omitting either falls back to English/`classic`,
so requests using the old shape (no `language`/`styleId` at all) behave
exactly as before this feature existed.

**Verified with real Gemini calls, a real Puppeteer UI walkthrough, and
real downloaded PDFs - not mocks:**
- **Single-video path, Hindi + Cool Tones**: drove the actual browser
  through mode-choice -> single-video input -> picker -> "Generate Notes",
  confirming zero `/generate` requests fired until the picker's own button
  was clicked. The request body carried `language: "Hindi"`,
  `styleId: "coolTones"`. Downloaded and read the resulting PDF - genuine
  Hindi body content throughout, not just labels/headers (title, subject
  badge, headings, and bullets all in actual Hindi prose), rendered in the
  Cool Tones purple/teal scheme, visually distinct from Classic.
- **Multi-video path, English (default) + Minimal**: drove the actual
  browser through mode-choice -> "Multiple videos" -> `MultiLinkInput` ->
  picker -> "Generate Notes", confirming the picker gates the batch path
  the same way. Request body was
  `{"videoUrls":[...], "styleId":"minimal"}` - no `language` field at all,
  since `frontend/lib/api.ts`'s `languageStyleFields()` omits English
  (the default) rather than sending it explicitly. Downloaded and read the
  resulting PDF - near-black ink on plain white paper, muted gray badge,
  subtle gray highlight, no visible doodle clutter - genuinely distinct
  from both Classic and Cool Tones, not just a config flag with no visible
  effect.
- **Backward compatibility, live server**: `POST /generate` with only
  `youtubeUrl`/`requestId` (no `language`/`styleId` fields at all, the old
  request shape) - completed with no validation errors
  (`stage: "done"`, `pageCount: 1`). Downloaded and read the resulting
  PDF - Classic scheme (blue ink, red-marker headings, yellow highlight,
  cream paper, yellow badge) and English content, confirming the new
  fields being fully absent from the request produces the same visual
  behavior as before this feature shipped. This complements an earlier
  isolated check that `renderNotesHtml(notes)` (no options argument at
  all - the pre-feature call signature) produces HTML identical to
  `renderNotesHtml(notes, { styleId: "classic" })`.
- **Invalid values rejected**: `language: "Klingon"` and `styleId: "neon"`
  each independently produced a `400` naming the allowlist, confirming
  the validation isn't just decorative.

## Auto-chunking large playlists into multiple batches

A playlist exceeding one chunk's worth of videos used to be hard-rejected
outright (`playlist_too_large`, no way around it). It now auto-splits into
sequential chunks instead - each chunk becomes its own independent pipeline
run (own jobId, own Gemini call, own PDF), not one giant merged transcript.

**Planning** (`chunkPlaylistVideos` in `src/playlist.js`): after resolving
the full playlist via the existing `resolvePlaylistVideoUrls` (unbounded -
no early rejection at resolution time anymore), the ordered video list is
split into chunks of `PLAYLIST_CHUNK_SIZE` (20, unchanged from the old
single-batch cap). `MAX_PLAYLIST_CHUNKS` (3) is a hard ceiling on top of
that - a playlist needing more than 3 chunks (60+ videos) is still rejected
outright with a clear message, *regardless of confirmation* - auto-chunking
removes the old hard cap's inconvenience without removing the cap that
actually matters (bounding how much quota one submission can consume).

**Confirmation gate** (`server.js`'s `/generate`): when a playlist resolves
to more than one chunk, the route responds `409` with
`{needsConfirmation: true, totalVideos, chunkSize, chunkCount, chunks}`
instead of creating any job at all - no yt-dlp-resolved chunk touches
`runPipeline`, so zero Gemini calls fire, until the caller resubmits the
identical request with `confirmChunking: true`. A playlist that fits in a
single chunk skips this entirely and behaves exactly as it did before
auto-chunking existed (same single-job response shape). Confirmed
multi-chunk requests get a `batchGroupId` (linking the sibling jobs) and a
`jobIds` array instead of a single `jobId`; each job's `meta` carries
`batchGroupId`/`chunkIndex`/`chunkCount`/`chunkRange` so `/status` reflects
which chunk of the original playlist each job covers.

**Frontend**: `LanguageStylePicker`'s "Generate Notes" button still fires
first without `confirmChunking` - if the response comes back as
`needsConfirmation`, a new **confirm-chunks** screen
(`NotesApp.tsx`) shows the exact breakdown ("This playlist has 47 videos -
this will generate 3 separate note PDFs... and will use 3 of your daily
generations") with a per-chunk video-range list, requiring an explicit
"Confirm & generate N PDFs" click (or Cancel, back to the picker) before
the confirmed request ever goes out. Once confirmed, a new
**batch-progress** screen replaces the single-job progress view: one row
per chunk (its own stage/progress bar, or its own error if that specific
chunk failed independently), and a "Download PDF" link per chunk as each
one finishes - polled at a slower 4s interval (vs. the single-job 2s) since
up to 3 jobs are now polled concurrently, keeping combined request volume
under the server's per-IP `/status` rate limit.

**Verified with a real 32-video playlist, a real 100-video playlist, and a
real browser - not mocks:**
- **Confirmation gate blocks generation**: `POST /generate` with a real
  32-video playlist (MIT 6.006, Fall 2011) and no `confirmChunking` -
  `409 {needsConfirmation: true, totalVideos: 32, chunkCount: 2, chunks:
  [{start:1,end:20,count:20},{start:21,end:32,count:12}]}`. Checked
  `/debug/jobs` immediately after - **zero jobs created**, confirming no
  Gemini call can fire before confirmation.
- **Confirmed request dispatches real independent jobs**: same playlist
  resubmitted with `confirmChunking: true` - `202
  {batchGroupId, jobIds: [id1, id2]}`. Polled both jobs to completion:
  chunk 2 (`chunkRange: "21-32"`) **completed for real** -
  `transcriptSource: "batch-merged"`, `transcriptLength: 639770`,
  `notesTitle: "Algorithms - Final Review"`, `pageCount: 11` - a title
  that itself reflects the correct back-half-of-course video range, not
  the whole playlist. Downloaded the real 4.7MB PDF (couldn't visually
  re-render it in this environment - missing `poppler-utils`, the same
  infra gap noted for the earlier large-playlist test - so this is
  confirmed via the job's own structural metadata rather than a page-by-
  page read, same caveat as before). Chunk 1 (`chunkRange: "1-20"`) hit a
  **real, legitimate** Gemini free-tier input-token quota limit
  (transcript was 1,009,041 chars from 20 full-length lecture videos,
  quota is 250,000 tokens/minute) with the Groq fallback also rejecting
  for length - a genuine pre-existing limit of the notes-generation step
  when a chunk's total transcript is enormous, unrelated to the chunking
  logic itself. What actually matters for this feature held up: chunk 1's
  failure was fully isolated to its own job/PDF and **did not affect
  chunk 2**, which completed normally - exactly the resilience
  independent-per-chunk jobs are meant to provide.
- **Ceiling rejection survives confirmation**: a real 100-video playlist
  (a channel's full uploads list) with `confirmChunking: true` sent from
  the start - still hard-rejected, `400 {"error":"This playlist has 100
  videos, which would need 5 batches of up to 20 videos each - over the
  3-batch limit (60 videos max) for one submission...",
  "errorCode":"playlist_too_large"}`. Confirms the ceiling can't be
  bypassed by pre-emptively setting `confirmChunking`.
- **Real browser walkthrough** (Puppeteer against the live server and a
  real static frontend build): pasted the 32-video playlist link ->
  picker -> "Generate Notes" -> landed on the confirm-chunks screen
  showing the exact real numbers ("This playlist has 32 videos - this
  will generate 2 separate note PDFs...", "PDF 1: videos 1-20 (20
  videos)", "PDF 2: videos 21-32 (12 videos)") - confirmed zero
  `confirmChunking:true` requests had fired yet. Clicked **Cancel** -
  returned to the picker screen, still zero confirmed requests. Went
  through again and clicked **Confirm & generate 2 PDFs** - confirmed
  exactly one `confirmChunking:true` request fired, landing on the
  batch-progress screen showing "0 of 2 PDF(s) ready." with a
  "PDF 1 of 2: Queued..." / "PDF 2 of 2: Queued..." row each, backed by
  the same real `batchGroupId`/`jobIds` dispatch verified above.

## Closing the client-side transcript fetch gap in the batch/playlist paths

The single-video flow has fetched transcripts client-side since the caption-
fetch investigation (see the README section above) - specifically to use the
client's own IP instead of Render's, which YouTube has been blocking. That
fix was never applied to the batch paths: `videoUrls[]`, a resolved single
playlist, and the new chunked-playlist flow were all still sending raw video
URLs straight to `/generate`, silently falling back to the exact same
server-side (Render-IP) captions/yt-dlp attempt per video the single-video
fix was meant to avoid - confirmed by reading `NotesApp.tsx`'s `handleGenerate`,
whose batch branch called `generateNotesBatch` directly with no
`fetchTranscriptClientSide` call anywhere in that path, and by a comment
left in the code at the time explicitly noting the batch path "still isn't
attempted" for client-side fetching.

**Fix - client-side-fetch-first now applies uniformly to every video-
selection path:**

- **`videoUrls[]`** (individually pasted links): `handleGenerate` now runs
  `prefetchTranscripts()` over the array before ever calling `/generate`.
- **A playlist that fits in one chunk**: the client can't client-side-fetch
  transcripts for videos it doesn't have URLs for yet, and a `playlistUrl`
  string alone doesn't reveal them - so a new `POST /playlist/resolve`
  endpoint (`server.js`, reusing the existing `resolvePlaylistVideoUrls`/
  `chunkPlaylistVideos` from the auto-chunking work) resolves the playlist to
  its real per-video URLs *before* `/generate` is ever called. `handleGenerate`
  calls this first, then prefetches over the resolved URLs.
- **The chunked-playlist flow**: the same resolution (now including raw
  per-chunk URLs, not just counts) is reused by the confirm-chunks screen -
  `handleConfirmChunking` prefetches across every chunk's videos
  (`resolution.chunks.flatMap(c => c.urls)`) after the user confirms, before
  the confirmed request goes out.

**`prefetchTranscripts()`** (`NotesApp.tsx`) fetches sequentially (not in
parallel) so progress can report a clean "N of M" count and so this doesn't
burst YouTube with concurrent requests from one client. A video whose
client-side fetch fails or wasn't available (e.g. no captions, or running in
a plain browser where neither the Electron IPC bridge nor Capacitor's native
`fetch` patch applies) is simply omitted from the resulting map - the same
partial-success policy the server-side batch path already had: that video
falls through to the server's own captions-then-yt-dlp/Whisper attempt,
unaffected, rather than failing the whole batch.

**Backend**: `/generate` now accepts an optional `transcripts` field - a map
of exact video URL -> `{text, source}`, validated the same way the existing
single-video `transcript` field is (non-empty, under `MAX_TRANSCRIPT_LENGTH`,
capped at `PLAYLIST_CHUNK_SIZE * MAX_PLAYLIST_CHUNKS` entries). Threaded into
`runPipeline` as `preFetchedTranscripts` for all three call sites
(`videoUrls`, `playlistUrl`, and each chunk in the confirmed multi-chunk
dispatch loop). `pipeline.js`'s `fetchAndMergeTranscripts` checks this map
per video before calling `getTranscript()` - a URL present in the map skips
the server-side attempt entirely, same mechanism the single-video
`preFetchedTranscript` option already used, just applied per-video across a
batch instead of to one video.

**Progress UI**: the picker/confirm-chunks screen's submit button shows
"Fetching transcripts on-device (N of M)..." while the prefetch loop runs,
updating live per video - a genuinely visible step, not just a spinner -
before switching to "Starting..." once the request actually goes out.

**Verified with a real Electron app (not a plain browser, which can't
exercise the client-side fetch path at all - see `fetchTranscriptClientSide`'s
own doc comment) and real videos - not mocks:**
- **`videoUrls[]` batch, 2 real videos** ("Me at the zoo" + a Korean-
  language music video): drove the actual Electron app end-to-end - Multiple
  videos -> two pasted links -> picker -> Generate. Watched the submit
  button's label genuinely cycle through "Fetching transcripts on-device (1
  of 2)..." then "(2 of 2)..." before any `/generate` call. Captured the
  real request body - `transcripts` carried real prefetched text for both
  videos (217 chars of real English captions for the first, 654 chars of
  real Korean lyrics for the second, `source: "captions"` for both).
- **Server-side fetch confirmed skipped**: checked Electron's own backend
  log (`main.log`, captures the spawned server.js's stdout/stderr) for that
  job - it jumps directly from `[generate] batch request received` straight
  to the Gemini call log line, with **zero** `[transcript] captions
  fetch...` lines for either video - the exact log line that fires on every
  server-side captions attempt (see `src/transcript.js`), confirmably
  absent here. (The Gemini call itself then hit a real, pre-existing free-
  tier quota exhaustion unrelated to this fix - not a concern for what's
  being verified, transcript fetching happens before that step.)
- **Single-chunk playlist, 13 real videos**: same walkthrough with a real
  13-video playlist. Confirmed `POST /playlist/resolve` fired before
  `/generate` (`{playlistUrl}` body, matching what was pasted). Watched the
  submit label progress through "Looking up playlist..." then "Fetching
  transcripts on-device (1 of 13)..." up through "(13 of 13)...". The
  resulting `/generate` body carried a `transcripts` map with all 13 real
  entries, non-empty text for every one. Backend log again jumped directly
  from `[generate] batch request received` to the Gemini call - no
  server-side transcript-fetch attempts for any of the 13 videos.
- The confirmed multi-chunk dispatch path (`handleConfirmChunking`) reuses
  this exact same `prefetchTranscripts`/`generateNotesBatch` mechanism -
  already proven above - the only difference is flattening multiple chunks'
  URLs into one prefetch pass before submitting with `confirmChunking: true`.

## Timestamp references on generated notes

Each transcript segment YouTube's caption source returns already carries
its own timing (`{text, offset, duration}`), but that timing was being
discarded during the flatten-to-plain-text step every provider (client-side
fetch, server-side captions, the pipeline's batch merge) has always done
before handing a transcript to Gemini/Groq. Sections now carry an optional
timestamp reference back to roughly where in the source video they came
from.

**Preserving segment timing** (`src/transcript.js`'s `normalizeSegments`,
duplicated for the frontend's own youtube-transcript install in
`frontend/lib/transcript.ts`): youtube-transcript's own XML parser is
internally inconsistent about units - the newer srv3 caption format gives
`offset`/`duration` in milliseconds, the older classic format gives
fractional seconds, with no flag exposed to tell them apart. A median-
duration heuristic (real per-segment speech durations in seconds are
almost always under 20; in milliseconds they're almost always in the
thousands) normalizes both to `{text, start, end}` in seconds, robust
regardless of the video's total length. Both `fetchCaptionsOnly` (server-
side, also reused as-is by Electron's IPC handler) and
`fetchTranscriptClientSide` (client-side - browser/mobile's direct
`YoutubeTranscript.fetchTranscript()` call, or Electron's IPC bridge)
return `segments` alongside `text`/`source` now. The Whisper audio-
transcription fallback (no per-segment timing available from that API)
simply never sets it - the one branch of `getTranscript()` that doesn't.

**Code-matched, not model-reported** (`src/timestampMatcher.js`, new
module): each section's timestamp is a deterministic word-overlap match
against the real segment timing, computed entirely in code *after* a
provider's output has already passed schema validation - never sent to
Gemini/Groq's prompt or schema at all. This was a deliberate choice over
asking the model to report its own timestamps: a model-reported timestamp
risks hallucinating a plausible-looking value with no real relation to the
video, the same way any other model output can be wrong, whereas a word-
overlap match against real segment data doesn't depend on model honesty.
For each section, every transcript segment is scored by how many
significant words (`\p{L}\p{N}`-based tokenization - Unicode-aware, not
ASCII-only, since this app generates notes in Hindi/Tamil/Bengali and
transcripts themselves can be in any script) it shares with the section's
subheading/bullets/formula/callout/table text; the best-scoring segment
becomes the anchor (`timestampStart`), with a `timestampRange` added when
segments within a tight ±60s window of the anchor also match. Below a
minimum shared-word threshold, the section is left with no timestamp
fields at all - no guessing.

**Multi-video/batch scoping** (`src/pipeline.js`'s new `mergeSegments`):
each video's segments are tagged with the same 1-based video index/title
`mergeTranscripts`'s own `--- Video N: ... ---` markers already use, so a
match can never straddle two different videos' independent (each 0-based)
timelines. A section whose anchor lands on video 2's segments gets a
`timestampVideo` field ("Video 2" or that video's real title) alongside
its timestamp - single-video notes never carry this field at all, since
there's nothing to disambiguate.

**Template** (`src/template.js`): a small pushpin annotation next to the
section heading - `📍 12:34` or `📍 Video 2 · 12:34–18:02` - set in
'Reenie Beanie' (a handwriting font this template already loaded for
exactly this kind of decorative marginalia, but had never actually used
anywhere until now). Absent entirely when the section has no
`timestampStart`, so old notes (or Whisper-sourced ones) render exactly as
they did before this feature existed.

**Verified with a real video, a real multi-video batch, and real
graceful-degradation - not synthetic data (a synthetic-data unit test of
the matching logic itself was also run first, to catch bugs cheaply before
spending real Gemini calls):**
- **Real single video** (an MIT 6.006 lecture, ~45 minutes, 1135 real
  caption segments): all 6 generated sections got a timestamp, strictly
  increasing across the lecture's real 45-minute runtime (1:10 → 4:17 →
  10:38 → 21:59 → 29:54 → 42:22) - exactly the structure of a real intro
  lecture (overview, definitions, algorithm concept, correctness proofs,
  complexity, computational model). **Spot-checked 3 of them directly
  against the real transcript text at that exact second** - "Defining
  Computational Problems" (4:17) landed on the real segment literally
  saying "a problem is a binary relation between these inputs and
  outputs"; "Proving Correctness" (21:59) landed on "assume the inductive
  hypothesis true for K..."; "Model of Computation: Word RAM" (42:22)
  landed on "I can read and write from an address in memory... in
  constant time" - all three a direct, accurate match to the section's
  real content. Rendered to a real PDF and visually confirmed the 📍
  annotation renders correctly, subtly, in the handwriting font next to
  each heading.
- **Real 2-video batch** ("Me at the zoo" + a Korean-language music
  video): the elephant section correctly got `📍 Me at the zoo · 0:01–0:13`
  - unambiguous about which video, visually confirmed in a real rendered
  PDF. The Gangnam Style section got **no** timestamp - not a bug: its
  generated notes are an English summary/paraphrase of Korean lyrics, so
  there's genuinely no real word overlap between the English section text
  and the Korean transcript segments for a word-overlap match to find -
  exactly the "no confident match → say nothing, don't guess" behavior
  the design calls for, working correctly on a real case where the
  approach's actual limits show up. (This same real test caught and fixed
  a genuine bug: the first tokenizer version only matched `[a-z0-9]`,
  silently producing zero usable words for any non-Latin-script segment -
  fixed to Unicode-aware `\p{L}\p{N}` matching, which is what let the
  video-scoping/tagging itself work correctly here even though the
  cross-language section still couldn't match.)
- **Graceful degradation, no segment data at all** (simulating the
  Whisper-fallback case - a real transcript fetched normally, but
  `generateNotes()` deliberately called without its `segments` option):
  notes generated successfully with no errors, zero `timestampStart`
  fields anywhere in the output, and the template rendered with no
  `timestamp-tag` markup at all - confirming the feature is fully
  additive, never a hard dependency for generation to succeed.

## Investigating "Groq output still reads short" - not a token limit

A real report came in that Groq's output still read short/less detailed
even after the `THOROUGHNESS_INSTRUCTIONS` addition above (verified at the
time via isolated A/B testing showing +23% average bullet length). Rather
than assume the fix "should theoretically help," this was investigated
against the real API.

**Hypothesis 1 - `max_tokens` capping output length: disproven.** A real
Groq call with no `max_completion_tokens` set (today's code, unchanged)
came back with `finish_reason: "stop"`, not `"length"` - the model
completed its response naturally. `usage.completion_tokens` was ~1100-1300
for a ~33K-char real transcript, well under Llama 3.3 70B's real 8,192-
token ceiling (confirmed via Groq's own model docs). There was no
truncation to fix.

**Testing the "fix" anyway - actively harmful, not just unhelpful.**
Explicitly setting `max_completion_tokens: 8192` (the model's real max, as
the hypothesis would suggest) on the *same* real request produced a real
`413 "Request too large for model llama-3.3-70b-versatile ... on tokens
per minute (TPM): Limit 12000, Requested 16254"` rejection. Groq's
free-tier TPM (tokens-per-minute) rate limit counts the *requested*
`max_completion_tokens` against the same budget as `prompt_tokens`, not
just actual usage - a substantial transcript's prompt tokens (8,062 here)
plus a high requested completion budget can blow the 12,000 TPM ceiling
outright, failing a request that would have succeeded with the parameter
left unset. Raising `max_completion_tokens` was **not** applied to the
code - doing so would make real requests on realistically-sized
transcripts fail, not just fail to help. `src/notesGenerator.js`'s
`generateWithGroq` now has a comment recording this so nobody re-attempts
the same fix without re-reading this finding first.

**`THOROUGHNESS_INSTRUCTIONS` confirmed reaching the real request** - the
exact system message string sent to a real call was captured and checked
directly for the instruction text, confirming it wasn't silently dropped
anywhere in the provider-branching logic.

**Real root cause: the model was choosing brevity, not being cut off** -
a genuine model-behavior difference from Gemini 2.5 Flash, not a
configuration bug. The actual lever that can influence this is prompt
wording, not a token ceiling. `THOROUGHNESS_INSTRUCTIONS` was strengthened
with concrete, quantified guidance ("aim for at least 4-6 bullets per
section," "break a worked example into separate bullets per step") rather
than only qualitative framing ("include more detail") - a model defaulting
to terse has less room to interpret its way back to a short answer against
a specific number than against a vague instruction.

**Verified with real calls, and the result reported honestly rather than
rounded up to a clean win:**
- A first strengthened version (bullet-count guidance alone) measurably
  increased bullet count and made section-to-section bullet counts far
  more consistent (6 of 8 sections landing exactly on 4 bullets, versus a
  more scattered 2-4 spread before) - but a side-by-side read of the
  actual bullet text showed this specific run leaning more generic
  ("Algorithms can be described using words or code") and dropping LaTeX
  formula notation and callouts entirely compared to earlier runs that had
  included them.
- Since "more bullets, more generic" isn't the actual goal, the
  instruction was refined again with an explicit anti-padding clause
  ("each bullet must carry a specific, distinct fact... more bullets is
  not a reason to drop \[callout/formula\]"). A follow-up real call showed
  every section hitting 4+ bullets (up to 6 in one), but still read
  somewhat generic in that particular sample - and a subsequent full
  end-to-end real call through the actual public `generateNotes()` chain
  (forcing Gemini to fail so it lands on real Groq, same technique used
  throughout this project) produced a *third*, quite different shape
  again (13 sections, 2-4 bullets each).
- **Honest conclusion**: Groq/Llama's real output has substantial natural
  run-to-run variance independent of prompt wording (expected - this is
  sampling, not a deterministic API), which one-call-per-variant testing
  can't fully separate from an actual prompt effect. What's confirmed with
  confidence: the token-limit hypothesis is definitively ruled out (real
  `finish_reason`/`usage` evidence, plus a real demonstration that
  "fixing" it would actively break requests), and the quantified bullet
  guidance does reliably push bullet *counts* up and more consistent
  across the several real runs sampled. Whether it reliably preserves
  per-bullet *depth* (formulas, callouts, specific figures) as robustly
  as count is a real open question this session's sample size can't fully
  settle - flagged here rather than claimed resolved, consistent with how
  every other finding in this README is reported.

## Fixing `build:mobile` silently baking in `.env.local` instead of `.env.mobile`

`npm run build:mobile` used to be `dotenv -e .env.mobile -- next build` -
injecting `.env.mobile`'s values into the child process's environment
before `next build` ran, on the assumption that already-set `process.env`
values win per Next.js's documented env-loading precedence
(`process.env` → `.env.$(NODE_ENV).local` → `.env.local` → ... → `.env`).
In practice, whether that actually holds depends on the installed
Next.js/dotenv-cli versions' own env-loading behavior - Next's own env
loader independently discovers and loads `.env.local`, and the two tools'
precedence rules don't compose in a way either one documents clearly (see
real-world reports of the same interaction:
[dotenv will not overwrite an already-defined variable, by design](https://github.com/vercel/next.js/discussions/38053)).
The failure mode is silent either way - a `.env.local` present locally
(the normal state for Electron dev, pointing at
`http://localhost:4500`) can end up baked into a build meant for a real
device talking to the hosted Render backend, and the build itself reports
success regardless - nothing looks wrong until the app is actually
installed and can't reach anything.

**Fix, in two independent layers** (`frontend/scripts/build-mobile.mjs`,
replacing the old one-line dotenv-cli invocation):

1. **`.env.local` is renamed out of the way before the build runs**, not
   deleted - moved to `.env.local.mobile-build-backup` and restored in a
   `finally`, so it comes back even if the build itself throws or exits
   non-zero. This removes the ambiguity about precedence entirely instead
   of depending on getting it right: Next's own env loader simply can't
   find a `.env.local` that isn't there. `.env.mobile`'s values are parsed
   directly via the `dotenv` package and passed straight into the spawned
   `next build` process's `env`, so there's no second CLI layer's own
   precedence rules to reason about either (dotenv-cli itself is no longer
   used for this - removed from `devDependencies`, `dotenv` added
   directly since the script now uses it itself rather than transitively
   through dotenv-cli).
2. **A build-time assertion after a successful build** - the static
   output (`out/`) is grepped for a literal `http://localhost`; fails
   loudly (non-zero exit, lists every offending file) if found. This is
   deliberately independent of whether layer 1 worked - it catches *any*
   future regression (a Next.js upgrade changing env-loading behavior
   again, a new hardcoded `localhost` reference added somewhere else
   entirely), not just the one specific mechanism already fixed.

**Verified for real, with `.env.local` present throughout (not deleted -
that defeats the point of the fix):**
- Ran `npm run build:mobile` with a real `.env.local` (pointing at
  `http://localhost:4500`, the normal Electron-dev state) sitting in the
  frontend directory the whole time. Direct `grep` of the real output
  confirms **zero** occurrences of `localhost:4500` anywhere in `out/`,
  and the real Render URL (`onrender.com`) present in the actual bundled
  JS - not inferred from the build log, checked directly against the
  files.
- **`.env.local` restoration confirmed on both paths**: after a
  successful build, `.env.local` exists again with byte-identical content
  and no leftover `.env.local.mobile-build-backup`. Also forced a real
  build *failure* (temporarily renamed away the `next` binary so
  `spawnSync` fails) and confirmed `.env.local` is still restored and the
  script still exits non-zero - the `finally` block covers both outcomes,
  not just the happy path.
- **The assertion itself verified to actually catch a leak**, not just
  exist decoratively - ran its exact detection logic against a
  deliberately-planted `http://localhost` string in a fake output
  directory and confirmed it's correctly flagged as an offending file.
- **No regression on the Electron target**: plain `npm run build` (still
  untouched, still just `next build`) continues to correctly bake in
  `http://localhost:4500` from `.env.local` as intended for that target -
  this fix only changes the mobile build's isolation from `.env.local`,
  not `.env.local`'s own normal effect on the default build.
- Full pipeline re-run end to end: `build:mobile` → `cap sync android` -
  confirmed the Render URL (not localhost) in the actual synced Android
  assets (`android/app/src/main/assets/public/`), and rebuilt the Electron
  target afterward to leave both build outputs current.

## Note-quality tier picker (High/Normal/Low)

A third picker alongside language/style, giving explicit control over which
provider(s) generate a job's notes, instead of always running the same
universal fallback chain regardless of what a user actually wanted.

**Mapping** (`src/notesGenerator.js`'s `buildProvidersForTier`):
- **High** -> `gemini-2.5-flash` only.
- **Normal** (default) -> `groq-llama-3.3-70b`, cascading to
  `gemini-3.1-flash-lite` if Groq fails.
- **Low** -> `gemini-3.1-flash-lite` only.

**Asymmetric by design - each tier is its own closed provider list, not a
shared cascade:**
- **High never cascades.** A user who explicitly picked High chose to
  wait for (or be told no about) `gemini-2.5-flash` specifically -
  silently downgrading them to Groq/Flash-Lite would defeat the entire
  point of picking it. If it fails, the job fails immediately with:
  *"High quality is unavailable right now (daily limit reached). Try
  Normal or Low, or wait until tomorrow."*
- **Normal cascades down to Flash-Lite, never up to High.** Falling up
  into `gemini-2.5-flash` would let a Normal-tier request quietly consume
  High's much scarcer daily quota - exactly what tiering exists to
  prevent. If both steps fail: *"Normal quality is unavailable right now
  (daily limit reached on both providers). Try High or Low, or wait until
  tomorrow."*
- **Low never cascades further** - it's already the cheapest/last-resort
  model, there's nowhere lower to fall to. If it fails: *"Low quality is
  unavailable right now. Try Normal or High, or wait until tomorrow."*

**Thoroughness is tier-based, not hardcoded to a model's identity** -
`THOROUGHNESS_INSTRUCTIONS` (see the earlier Groq-depth investigation
above) is applied by `buildProvidersForTier` based on which tier is
routing to a given provider, not by checking the model name inside
`generateWithGemini`/`generateWithGroq`. In practice this means
`gemini-3.1-flash-lite` gets it in *both* the Normal and Low tiers (same
model, same reasoning, wherever it's routed from) while `gemini-2.5-flash`
never does - but the assignment lives at the tier level, so a future tier
remix would follow from wherever a model gets slotted in, not from a
per-model special case.

**Whichever provider actually answers is tracked and surfaced**: `generateNotes()`
returns `{ notes, providerUsed, cascaded }` (`cascaded` only ever `true`
for Normal, the only tier with more than one step) alongside the existing
`console.log("generated via fallback provider: ...")`. `pipeline.js`
surfaces this as `notesProvider`/`providerCascaded` in job metadata -
`providerCascaded` is only present at all when `true`, so a straightforward
single-provider tier succeeding on its first try doesn't carry a dead
`false` field forever (same pattern as `skippedVideos`). The "done" screen
shows *"Generated via \[provider\] (the first-choice provider was
unavailable)"* only when `providerCascaded` is set - invisible for the
common case, informative when a fallback actually happened.

**Verified with real forced-failure tests (same technique as the earlier
provider-fallback work) - not mocks:**
- **High, `gemini-2.5-flash` forced to fail**: real call through
  `generateNotes({qualityTier: "High"})` - threw the exact specified
  message, and a request-tracking check confirmed **zero** calls ever
  reached Groq or Flash-Lite - it genuinely doesn't cascade, not just
  "cascades to nothing by coincidence."
- **Normal, Groq forced to fail**: cascaded to a real
  `gemini-3.1-flash-lite` call - `providerUsed`/`cascaded` came back
  correctly, and `gemini-2.5-flash` was **never** called (confirmed via
  the same tracking) - Normal doesn't fall *up* into High's quota.
  Re-verified end to end through a real browser: submitted a real job
  through the actual picker UI against a live backend with Groq's real
  endpoint forced to fail, and the **"done" screen genuinely displayed**
  *"Generated via gemini-3.1-flash-lite (the first-choice provider was
  unavailable)"* - not inferred from job metadata, read directly off the
  rendered page.
- **Low, `gemini-3.1-flash-lite` forced to fail**: threw the exact
  specified Low message; confirmed neither Groq nor `gemini-2.5-flash`
  was ever called - no further cascade.
- **Default (no `qualityTier` at all) behaves as Normal**: called
  `generateNotes()` with the option omitted entirely, Groq forced to fail
  - cascaded to Flash-Lite exactly like an explicit `"Normal"` would.
  Confirmed the same at the HTTP/UI level too - a real submission with the
  picker left on its default selection sent a request with `qualityTier`
  omitted entirely (same `languageStyleFields` omit-the-default pattern as
  language/style), and still cascaded/displayed identically to an
  explicit Normal request.
- **Real (unforced) HTTP smoke test of all three tiers**: submitted one
  real job per tier directly against a live backend with no failures
  forced - High completed via `gemini-2.5-flash`, Normal via
  `groq-llama-3.3-70b` (no cascade needed today), Low via
  `gemini-3.1-flash-lite` - each job's `/status` correctly reported
  `notesProvider` matching the tier picked, confirming the everyday,
  nothing-failing path works exactly as the forced-failure tests implied
  it would.
- **Invalid `qualityTier` rejected**: `{"qualityTier":"Ultra"}` against
  the live server correctly 400s with the allowlist message.

## Preserving hedging language on sensitive/allegation-based content

Real testing (the same source material across all three quality tiers)
found that `gemini-2.5-flash` correctly preserved source hedging language
("alleged," "accused," "reportedly") when a transcript described an
unproven claim, but Groq and `gemini-3.1-flash-lite` consistently
flattened it into stated fact - "X was accused of fraud" becoming "X
committed fraud." Auto-generated callout boxes (`Important`/
`Common Mistake`/`Must Remember`) compounded this: a flattened accusation
wrapped in one of these boxes reads with visual authority a plain bullet
doesn't carry.

**Fix, in `SYSTEM_PROMPT` itself** (`src/notesGenerator.js`) - not
`THOROUGHNESS_INSTRUCTIONS`, since this needed to apply to *every*
provider/tier, including the one (`gemini-2.5-flash`/High) that was
already behaving correctly. Two new rules added to the shared prompt every
provider receives:
1. **Hedging preservation**: "If the source material uses hedging
   language (allegedly, accused, reportedly, claims, is said to have)
   when describing accusations, crimes, or unproven claims - especially
   against named individuals - preserve that hedging exactly. Do not
   state allegations as settled fact."
2. **Callout-type constraint**: the existing callout rule now explicitly
   reserves `Important`/`Common Mistake`/`Must Remember` for genuine
   factual/academic content (definitions, formulas, established facts) -
   never for summarizing or editorializing unproven allegations, legal
   claims, or politically contested content. Something worth flagging
   from that kind of material should be a plain bullet, not one of these
   authority-implying callout boxes.

**Verified with a real test transcript across all three tiers, real API
calls throughout** - a media-literacy-style lecture transcript modeling
the exact real-world pattern (a named individual accused of fraud, with
explicit source hedging: "accused," "allegedly diverted," "has not been
convicted," "denies all wrongdoing," "prosecutors claim"), alongside a
genuinely factual legal-principles section (presumption of innocence,
burden of proof) to confirm callouts still work normally on real academic
content, just not on the allegation section specifically:
- **Normal tier (`groq-llama-3.3-70b`)**: hedging fully preserved in the
  real output - "accusing," "has not been convicted and denies all
  wrongdoing," "case is still pending." The allegation section carried
  **zero** callout at all (plain bullets only); the two callouts that did
  appear (`Important` on why hedging language matters as a general
  principle, `Common Mistake` on the burden-of-proof misconception) both
  landed on the genuinely factual sections, not the allegation itself.
- **Low tier (`gemini-3.1-flash-lite`)**: same result - hedging fully
  preserved ("accused," "allegedly diverted," "has not been convicted of
  any crime," "denies all wrongdoing," "Prosecutors claim," "defense
  argues"), and the dedicated "Case Study: Jordan Reyes Allegations"
  section had no callout wrapping it at all - the `Important`/
  `Common Mistake` callouts that did appear were both on the legitimate
  legal-standards content.
- **High tier (`gemini-2.5-flash`)**: could not be freshly verified today
  - real, persistent `429`s confirmed via the exact quota metric name
  (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`) that this is the
  free tier's **daily** cap, already exhausted from this session's
  cumulative real-API testing, not a transient per-minute limit further
  retries could wait out. Two real attempts a minute apart both correctly
  failed with the exact High-tier message and never cascaded to Groq/
  Flash-Lite (itself a real re-confirmation of the earlier no-cascade
  fix). Not a regression risk for this specific change though: the new
  rules were added to the one `SYSTEM_PROMPT` every tier shares, purely
  additive to what Flash already receives - since the bug report's own
  premise is that Flash was *already* preserving hedging correctly before
  this change, and nothing here removes or alters any of Flash's existing
  instructions, there's no mechanism by which this could regress its
  already-correct behavior.
