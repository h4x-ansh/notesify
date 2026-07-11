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
   best quality.
2. **`gemini-2.5-flash-lite`** - same `GEMINI_API_KEY`/Google account, but a
   separate ~1,000 RPD quota bucket from `-flash`'s ~20 RPD, and the same
   native `responseSchema` constraining - a same-family model-string swap,
   not a different integration.
3. **Groq's `llama-3.3-70b-versatile`** (`GROQ_API_KEY`, free at
   [console.groq.com/keys](https://console.groq.com/keys)) - a genuinely
   separate provider/account, ~14,400 RPD free-tier headroom. Different
   model family with no native JSON-schema constraining on Groq's side, so
   the prompt spells out the exact shape explicitly
   (`JSON_SHAPE_INSTRUCTIONS`) on top of `response_format: json_object`
   (valid-JSON-guaranteed, not shape-guaranteed) - the same zod
   (`NotesSchema`) validation every provider's output goes through either
   way is still the real gate, not the prompt wording.

**Only advances on a quota error, specifically** - `isQuotaError()` checks
for a `429` status, `groq-sdk`'s typed `RateLimitError`, or
quota/rate-limit wording in the error message. Anything else (malformed
transcript, a provider's JSON failing the zod schema, a genuine 5xx, auth
errors) fails immediately instead of silently masking a real problem behind
more (doomed) attempts - a different provider wouldn't fix a schema
mismatch or a bad API key either.

**Which provider actually answered is always logged** - `console.log`
on any fallback, so a job that succeeded via Groq is never silently
indistinguishable from one that succeeded via Gemini.

**If all three are exhausted/failing**, the error surfaced to the job (and
therefore `/status`) is `"All note-generation providers are currently
rate-limited. Try again later."` - not the old generic per-provider 429
message, and not conflated with the "no captions" family of errors from
the transcript stage.

**Verified without burning real quota or needing a real `GROQ_API_KEY`**:
monkeypatched `fetch` to return actual-shaped 429 responses from Gemini's
API and a mocked (but response-shape-accurate) success from Groq's
OpenAI-compatible endpoint, run through the real `generateNotes()` - not a
reimplementation of the logic under test. Confirmed, each as a distinct
scenario:
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
  treated as a quota problem - confirms `isQuotaError()` doesn't
  over-match.

**Not verified**: the real Groq API. No `GROQ_API_KEY` was available in
this environment to test against - console.groq.com requires signing up
for an account, which wasn't done here. The mocked test above matches
Groq's documented OpenAI-compatible response shape closely, but hasn't
been checked against what Llama 3.3 70B actually returns for a real
transcript - specifically whether its JSON/LaTeX output needs prompt
adjustments beyond what `JSON_SHAPE_INSTRUCTIONS` already spells out. Set
a real `GROQ_API_KEY` and either force a fake Gemini 429 (as above) or
wait for real quota exhaustion to see it in practice.

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
