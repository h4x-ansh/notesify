# Notesify frontend

Single-page Next.js (TypeScript, App Router) UI for the notes pipeline,
built as a static export (`output: "export"` in `next.config.mjs`) with no
Next server at runtime. Two different shells wrap this same codebase:

- **Electron** (`../electron/main.js`) — talks to a backend it spawns
  itself, locally, on `http://localhost:4500`.
- **Capacitor/Android** (`android/`, this directory's `capacitor.config.ts`)
  — talks to the hosted Render backend over the internet, with an
  `X-API-Secret` header on every request.

`lib/api.ts` is the one place both configs are read from - which target
you're building picks which config applies (see below), and neither build
affects the other.

## Run (dev, against a local backend)

```bash
npm install
cp .env.local.example .env.local   # only needed if the backend isn't on the default port
npm run dev
```

Start the backend separately first (`node ../server.js` from the project
root, or `npm run serve` there) — the UI shows a "waiting for the local
server" state and auto-retries if it isn't up yet.

## CORS, not a rewrite proxy

This used to proxy `/api/*` through Next's own server to dodge CORS. That
stopped being viable once the app became a static export with no server at
runtime (needed so Electron can serve it via a plain `express.static`, and
so the Android build can ship it as static assets in the APK) - there's no
Next server left to do the proxying. `server.js` has permissive CORS
instead (`Access-Control-Allow-Origin: *`); `lib/api.ts` calls the backend's
absolute URL directly.

## Structure

- `lib/api.ts` — typed fetch wrappers (`generateNotes`, `getStatus`,
  `fetchPdf`, `checkHealth`) matching `server.js`'s response shapes exactly.
  `API_BASE_URL` and `API_SHARED_SECRET` are read from `NEXT_PUBLIC_*` env
  vars baked in at `next build` time (a static export can't read env vars
  at runtime). `fetchPdf` does an authenticated `fetch` + `Blob` rather than
  a plain link, since `X-API-Secret` can't ride on an `<a href>`/`<iframe
  src>` the way it can on a real fetch call. `fetchWithRetry` transparently
  retries the specific `404` + `x-render-routing: no-server` signature
  Render's edge proxy occasionally returns even on a healthy instance (see
  the root README's "Cold-start / spin-down behavior actually observed").
- `components/NotesApp.tsx` — the whole flow as one state machine:
  `checking-server → server-unreachable ⇄ input → progress → done | error`.
  Copy adapts based on `IS_HOSTED_BACKEND` (derived from whether
  `API_BASE_URL` is localhost) - "waking up the server" instead of
  "waiting for the local server" when it's actually Render cold-starting.
- `components/NotesApp.module.css` — the dark theme, plus a `max-width:
  480px` mobile breakpoint (larger tap targets/padding) since the
  Capacitor/Android build renders this at phone width, not the desktop
  width it was originally designed for.

## Building for Electron (local backend)

```bash
npm run build
```

No special env vars - defaults to `http://localhost:4500`, no auth header
(matches `server.js`'s `requireApiSecret` being a no-op when
`API_SHARED_SECRET` is unset). See `../electron/main.js` and the root
README's "Desktop app (Electron)" section.

## Building for Android (hosted backend)

```bash
cp .env.mobile.example .env.mobile   # fill in NEXT_PUBLIC_API_SHARED_SECRET
npm run build:mobile                 # next build, loading .env.mobile
npx cap sync android                 # copy the static export into android/
npm run cap:open                     # opens the project in Android Studio
```

From Android Studio: `Build → Build Bundle(s) / APK(s) → Build APK(s)`, or
`Run` to install straight onto a connected device/emulator. The debug APK
lands under `android/app/build/outputs/apk/debug/`.

**What's been verified vs. not**: the web layer (static build → real fetch
calls with the auth header → status polling with retry → authenticated PDF
blob download) has been driven end-to-end against the live Render backend
via a headless browser serving the exact build output that ships in the
APK - see the root README's Capacitor/Android section for the actual
run log. What has **not** been verified is the native Android shell itself
(WebView behavior, APK install, on-device touch/rendering) - this
development environment has no Android SDK/emulator. That step needs to
happen on a machine with Android Studio installed.

**Known limitation - baked-in shared secret**: `NEXT_PUBLIC_API_SHARED_SECRET`
gets compiled into the APK's JS bundle in plain text. Anyone who unzips the
APK and greps the bundle can read it. Acceptable for a single-owner app
talking to its own backend (matches the auth model documented in the root
README); would need real per-user auth before distributing this APK to
other people.
