import type { CapacitorConfig } from '@capacitor/cli';

// appId matches electron-builder.config.mjs's appId - same app, same brand,
// two different shells (desktop vs Android) around one frontend codebase.
// webDir points at the static export (see next.config.mjs's output:
// "export") - `npm run build:mobile` (frontend/package.json) must run
// before `npx cap sync` picks this up.
const config: CapacitorConfig = {
  appId: 'com.hisarchives.notesify',
  appName: 'Notesify',
  webDir: 'out'
};

export default config;
