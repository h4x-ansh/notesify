import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";
import express from "express";
import { fetchCaptionsOnly } from "../src/transcript.js";

/**
 * Packages the whole app (Express backend + static frontend export) as one
 * standalone process tree, spawned entirely by Electron - no dev servers,
 * no dependency on the end user having Node.js installed separately.
 *
 * The backend is spawned via Electron's own executable running as plain
 * Node (ELECTRON_RUN_AS_NODE=1) rather than assuming a system `node` binary
 * exists on the target machine. The frontend is a static export (see
 * frontend/next.config.mjs) served by a plain express.static server run
 * in-process here - not loaded via win.loadFile(), because Next's static
 * export uses root-absolute asset paths (/_next/static/...) that don't
 * resolve under file://.
 *
 * A "fetch-transcript" IPC handler (see preload.cjs +
 * frontend/lib/transcript.ts) lets the renderer fetch YouTube captions
 * through the main process instead of the spawned backend - reuses
 * src/transcript.js's fetchCaptionsOnly() as-is, same module the backend
 * itself imports.
 *
 * PDF export needs a real Chromium to drive (see src/pdfExport.js). Rather
 * than bundling Puppeteer's own ~350MB download (roughly doubling install
 * size on top of Electron's own bundled Chromium), the packaged app looks
 * for an already-installed system Chromium-based browser (Chrome, Edge,
 * Brave, Chromium, Opera, or Vivaldi, in that preference order - see
 * findSystemChromium()) and points Puppeteer at whichever it finds first.
 * Edge ships as a mandatory OS component on Windows 10/11, so this is a safe
 * bet in practice even before the other fallbacks - and if truly none are
 * present, generation fails with a clear error surfaced through the normal
 * job-error UI rather than crashing anything.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;

// Packaged Electron apps are Windows-subsystem executables - there's no
// console to print to even when launched from a terminal. Everything
// startup-related goes to a log file so failures are diagnosable from a
// cold double-click launch, not just from `npm run electron`.
const logDir = app.getPath("userData");
mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, "main.log");
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  try {
    appendFileSync(logPath, line);
  } catch {
    // logging must never itself crash startup
  }
}

process.on("uncaughtException", (err) => log("UNCAUGHT EXCEPTION:", err.stack || String(err)));
process.on("unhandledRejection", (err) => log("UNHANDLED REJECTION:", err?.stack || String(err)));

log("=== app starting ===", "isPackaged:", String(isPackaged));

const BACKEND_PORT = 4500;
const FRONTEND_PORT = 3000;

// app.getAppPath() resolves correctly in both dev (project root) and
// packaged builds, whether or not asar packing is used (asar is disabled
// here - see electron-builder config - specifically so a plain file path
// like this can be handed straight to child_process.spawn without any
// asar-transparency concerns). extraResources (the frontend build, the
// bundled Chromium, .env) are NOT part of the app bundle and always land
// directly under resourcesPath regardless of the asar setting.
const projectRoot = app.getAppPath();
const backendEntry = path.join(projectRoot, "server.js");
const frontendOutDir = isPackaged
  ? path.join(process.resourcesPath, "frontend", "out")
  : path.join(__dirname, "..", "frontend", "out");
const envFilePath = isPackaged ? path.join(process.resourcesPath, ".env") : path.join(__dirname, "..", ".env");

/**
 * First existing system Chromium-based browser install, checked in
 * preference order: Chrome -> Edge -> Brave -> Chromium -> Opera -> Vivaldi.
 * Chrome/Edge come first since they're the most common and best-tested with
 * Puppeteer; the rest are fallbacks for machines that have neither.
 */
function findSystemChromium() {
  const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env["LOCALAPPDATA"] || "";

  const candidates = [
    // Chrome
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    // Edge
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    // Brave
    path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    path.join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    path.join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    // Chromium
    path.join(programFiles, "Chromium", "Application", "chrome.exe"),
    path.join(programFilesX86, "Chromium", "Application", "chrome.exe"),
    // Opera
    path.join(localAppData, "Programs", "Opera", "opera.exe"),
    // Vivaldi
    path.join(localAppData, "Vivaldi", "Application", "vivaldi.exe"),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

// Only override in the packaged app - dev mode keeps using Puppeteer's own
// default resolution (the global ~/.cache/puppeteer install), which is what
// every other dev-mode test in this project has actually run against.
const systemChromiumPath = isPackaged ? findSystemChromium() : null;

log("projectRoot:", projectRoot);
log("backendEntry:", backendEntry, "exists:", String(existsSync(backendEntry)));
log("frontendOutDir:", frontendOutDir, "exists:", String(existsSync(frontendOutDir)));
log("envFilePath:", envFilePath, "exists:", String(existsSync(envFilePath)));
log("systemChromiumPath:", String(systemChromiumPath));

if (existsSync(envFilePath)) {
  const result = dotenv.config({ path: envFilePath });
  log("dotenv loaded:", result.error ? `ERROR: ${result.error}` : "ok");
}

// Lets the renderer fetch YouTube captions without going through the
// spawned backend at all - see frontend/lib/transcript.ts's
// window.notesifyBridge usage and electron/preload.cjs. Reuses
// fetchCaptionsOnly() as-is (captions attempt only, no yt-dlp/Whisper -
// that stays part of the backend's job pipeline, unchanged) since the main
// process is plain Node, same as the spawned server.js, just running here
// instead. This never actually had Render's IP-blocking problem (it's
// always been the user's own local IP), but is wired up the same way as
// the mobile build for one consistent client-side-first architecture.
ipcMain.handle("fetch-transcript", async (_event, youtubeUrl) => {
  try {
    return await fetchCaptionsOnly(youtubeUrl);
  } catch (err) {
    log("[fetch-transcript IPC] failed:", err?.message || String(err));
    return null;
  }
});

// Local settings persistence (default language/style/quality tier - see
// frontend/lib/settings.ts and electron/preload.cjs's matching bridge
// methods) - a flat JSON file under the same userData directory main.log
// already lives in, read/written whole rather than per-key (this only
// ever holds one small object, not worth a real key-value store). Kept
// entirely in the main process rather than handing the renderer direct
// filesystem access, same reasoning as fetch-transcript above.
const settingsFilePath = path.join(logDir, "settings.json");

function readSettingsFile() {
  try {
    return JSON.parse(readFileSync(settingsFilePath, "utf8"));
  } catch {
    return {};
  }
}

function writeSettingsFile(data) {
  try {
    writeFileSync(settingsFilePath, JSON.stringify(data), "utf8");
  } catch (err) {
    log("[set-setting IPC] failed to write settings.json:", err?.message || String(err));
  }
}

ipcMain.handle("get-setting", (_event, key) => {
  const data = readSettingsFile();
  return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
});

ipcMain.handle("set-setting", (_event, key, value) => {
  const data = readSettingsFile();
  data[key] = value;
  writeSettingsFile(data);
});

// Durable on-device PDF storage (see frontend/lib/pdfStore.ts) - Electron's
// equivalent of the mobile build's @capacitor/filesystem Directory.Data
// writes, since a renderer with contextIsolation:true/nodeIntegration:false
// has no fs access of its own. Lives under userData (same parent dir as
// main.log/settings.json above), not the backend's own JOBS_OUTPUT_DIR -
// that dir holds the backend's working copy keyed to its own in-memory job
// store, which doesn't survive a backend restart; this is a separate,
// intentionally-durable copy the renderer owns the lifecycle of.
const pdfsDir = path.join(logDir, "pdfs");
mkdirSync(pdfsDir, { recursive: true });

function safePdfFilename(jobId, filename) {
  // jobId is a server-generated UUID (never user input); filename comes
  // from the backend's own Content-Disposition header, built from the
  // notes title with non-word characters already stripped (see
  // server.js's /download route) - stripped again here regardless, since
  // this is what actually becomes a filesystem path.
  const cleanName = String(filename).replace(/[^\w\- .]+/g, "").trim() || "notes.pdf";
  return `${jobId}-${cleanName}`;
}

ipcMain.handle("save-pdf", (_event, jobId, filename, base64) => {
  try {
    const filePath = path.join(pdfsDir, safePdfFilename(jobId, filename));
    writeFileSync(filePath, Buffer.from(base64, "base64"));
    return { path: filePath };
  } catch (err) {
    log("[save-pdf IPC] failed:", err?.message || String(err));
    return null;
  }
});

ipcMain.handle("read-pdf", (_event, filePath) => {
  try {
    const data = readFileSync(filePath);
    return { data: data.toString("base64") };
  } catch (err) {
    log("[read-pdf IPC] failed:", err?.message || String(err));
    return null;
  }
});

// Desktop has no native share-sheet - revealing the file in Explorer/Finder
// is the closest honest equivalent (see lib/pdfStore.ts's sharePersistedPdf).
ipcMain.handle("reveal-file", (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

let backendProcess = null;

function startBackend() {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(BACKEND_PORT),
    JOBS_OUTPUT_DIR: path.join(app.getPath("userData"), "jobs"),
  };

  // Point Puppeteer at the detected system Chrome/Edge instead of its own
  // default resolution (the global ~/.cache/puppeteer cache), which won't
  // exist on a machine this app was never `npm install`-ed on. Puppeteer
  // reads this env var directly in launch(), no code changes needed in
  // pdfExport.js. If neither browser was found, this stays unset and
  // Puppeteer's own launch() throws a clear "browser not found" error,
  // which the pipeline surfaces through the normal job-error UI.
  if (systemChromiumPath) {
    env.PUPPETEER_EXECUTABLE_PATH = systemChromiumPath;
  }

  log("spawning backend:", process.execPath, backendEntry);
  backendProcess = spawn(process.execPath, [backendEntry], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  backendProcess.stdout.on("data", (d) => log("[backend stdout]", d.toString().trim()));
  backendProcess.stderr.on("data", (d) => log("[backend stderr]", d.toString().trim()));

  backendProcess.on("error", (err) => log("[backend spawn error]", err.stack || String(err)));
  backendProcess.on("exit", (code, signal) => {
    log(`[backend] exited code=${code} signal=${signal}`);
    backendProcess = null;
  });
}

function startFrontendServer() {
  return new Promise((resolve, reject) => {
    const staticApp = express();
    staticApp.use(express.static(frontendOutDir));
    const server = staticApp.listen(FRONTEND_PORT, () => {
      log(`frontend static server listening on ${FRONTEND_PORT}`);
      resolve(server);
    });
    server.on("error", (err) => {
      log("frontend static server error:", err.stack || String(err));
      reject(err);
    });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => log("did-fail-load:", String(code), desc, url));
  win.loadURL(`http://localhost:${FRONTEND_PORT}`);
  log("window created, loading frontend");
}

app.whenReady().then(async () => {
  log("app ready");
  try {
    startBackend();
    await startFrontendServer();
    createWindow();
  } catch (err) {
    log("STARTUP FAILURE:", err.stack || String(err));
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
});
