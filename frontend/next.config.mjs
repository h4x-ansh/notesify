import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The backend (../package-lock.json) and this frontend both have their
  // own lockfile; without this Next guesses the workspace root and warns.
  turbopack: {
    root: __dirname,
  },
  // Packaged as a static site: Electron spawns a plain static file server
  // for this output (see electron/main.js) rather than running Next's own
  // server inside the built app. That means no rewrites()/API routes/SSR
  // are available at runtime - this app doesn't use any of those (it's a
  // single client component that talks to the Express API over fetch), so
  // static export is a clean fit. The backend now needs CORS enabled
  // (added in server.js) since there's no proxy to dodge it with anymore.
  output: "export",
};

export default nextConfig;
