# Notesify frontend

Single-page Next.js (TypeScript, App Router) UI for the notes pipeline. Talks
to the Express API in `../server.js` — this directory is frontend-only, it
doesn't touch any backend code.

## Run

```bash
npm install
cp .env.local.example .env.local   # only needed if the backend isn't on the default port
npm run dev
```

Start the backend separately first (`node ../server.js` from the project
root, or `npm run serve` there) — the UI shows a "waiting for the local
server" state and auto-retries if it isn't up yet.

## Why a rewrite proxy

The Express API runs on a different port (`4500`) than the Next dev/prod
server (`3000`), which the browser treats as a different origin. `server.js`
is intentionally not being modified to add CORS headers (out of scope for
this piece), so instead `next.config.mjs` proxies `/api/*` to the backend
server-side (`NOTESIFY_BACKEND_URL`, default `http://localhost:4500`). The
browser only ever calls same-origin `/api/*` (see `lib/api.ts`); Next's own
Node server forwards those to Express node-to-node, which isn't subject to
CORS at all. This also means the actual backend URL never needs to be
exposed to client-side code.

## Structure

- `lib/api.ts` — typed fetch wrappers (`generateNotes`, `getStatus`,
  `downloadUrl`, `checkHealth`) matching `server.js`'s response shapes
  exactly, plus a loose client-side YouTube URL sanity check.
- `components/NotesApp.tsx` — the whole flow as one state machine:
  `checking-server → server-unreachable ⇄ input → progress → done | error`.
  Polls `GET /api/status/:jobId` every 2s while generating; a few
  consecutive failed polls (not a job-level error, an actual dropped
  connection) drops back to the unreachable state rather than a hard error.
- `components/NotesApp.module.css` — the dark theme. Accent color and the
  warm off-white text intentionally echo the highlighter-yellow and
  notebook-cream from the actual generated PDFs, so the tool's own UI and
  its output share a visual thread.
