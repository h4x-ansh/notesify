import type { CapacitorConfig } from '@capacitor/cli';

// appId matches electron-builder.config.mjs's appId - same app, same brand,
// two different shells (desktop vs Android) around one frontend codebase.
// webDir points at the static export (see next.config.mjs's output:
// "export") - `npm run build:mobile` (frontend/package.json) must run
// before `npx cap sync` picks this up.
const config: CapacitorConfig = {
  appId: 'com.hisarchives.notesify',
  appName: 'Notesify',
  webDir: 'out',
  // Patches window.fetch (native platforms only) to route through native
  // OS networking instead of the WebView's engine - not subject to the
  // WebView's same-origin/CORS enforcement the way a normal fetch() call
  // is. Needed specifically for lib/transcript.ts's client-side YouTube
  // caption fetch: confirmed empirically (real Chromium, foreign origin)
  // that YouTube's endpoints don't send Access-Control-Allow-Origin, so an
  // unpatched fetch from this app's origin would always fail with a CORS
  // error, not just get blocked by YouTube.
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
