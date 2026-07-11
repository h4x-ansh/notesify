#!/usr/bin/env node
/**
 * Wraps `next build` for the mobile/Capacitor target. Replaces the old
 * `dotenv -e .env.mobile -- next build` script, which turned out not to be
 * reliable protection against `.env.local`: Next's own env loader
 * independently discovers and loads `.env.local` regardless of what
 * dotenv-cli already injected into process.env, and depending on the
 * installed Next.js/dotenv-cli versions' precedence behavior, `.env.local`
 * can win - silently baking the local Electron dev backend URL
 * (`http://localhost:4500`) into a build meant for a real device talking
 * to the hosted Render backend. The build itself reports success either
 * way - nothing about the output looks wrong until the app is actually
 * installed on a device and can't reach anything.
 *
 * Fix, in two layers rather than trusting either alone:
 *
 * 1. `.env.local` is renamed out of the way (not deleted - restored in a
 *    `finally`, even if the build throws) before the build runs, so
 *    Next's own env loader can't find it at all - this removes the
 *    ambiguity about precedence entirely instead of depending on getting
 *    it right. `.env.mobile`'s values are parsed directly (via the
 *    `dotenv` package) and passed straight into the spawned `next build`
 *    process's env, so there's no second CLI layer's own precedence rules
 *    to reason about either.
 * 2. After a successful build, the static output is grepped for a literal
 *    `http://localhost` - a build-time assertion, not just trust in step
 *    1's mechanism. Fails loudly (non-zero exit, lists the offending
 *    files) if found, so a future regression (a Next.js upgrade changing
 *    env-loading behavior again, a new hardcoded localhost reference added
 *    somewhere) can't silently slip through the way the original bug did.
 */
import { existsSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.join(__dirname, "..");
const envLocalPath = path.join(frontendRoot, ".env.local");
const envLocalBackupPath = path.join(frontendRoot, ".env.local.mobile-build-backup");
const envMobilePath = path.join(frontendRoot, ".env.mobile");
const outDir = path.join(frontendRoot, "out");

function log(...args) {
  console.log("[build:mobile]", ...args);
}

if (!existsSync(envMobilePath)) {
  console.error(`[build:mobile] ${envMobilePath} not found - can't build the mobile target without it.`);
  process.exit(1);
}

// Moving .env.local aside (rather than trying to out-clever Next's env
// precedence) is what makes this deterministic across Next.js versions -
// if it existed before this script ran, it's guaranteed to exist again
// after, success or failure.
const envLocalExisted = existsSync(envLocalPath);
if (envLocalExisted) {
  if (existsSync(envLocalBackupPath)) {
    console.error(
      `[build:mobile] ${envLocalBackupPath} already exists - a previous run may have crashed before restoring .env.local. Resolve manually before re-running (rename it back to .env.local if that's the real one).`
    );
    process.exit(1);
  }
  log(".env.local found - temporarily moving it aside so Next's own env loader can't pick it up over .env.mobile.");
  renameSync(envLocalPath, envLocalBackupPath);
}

let buildExitCode = 0;
try {
  const mobileEnv = parseDotenv(readFileSync(envMobilePath, "utf8"));
  log("Building with .env.mobile values:", Object.keys(mobileEnv).join(", "));

  const nextBin = path.join(frontendRoot, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
  // shell: true - required on Windows to execute a .cmd shim at all
  // (spawnSync fails with EINVAL against a .cmd file otherwise); harmless
  // on other platforms where the plain binary is exec'd directly either
  // way. Quoting the binary path is required once shell:true is set on
  // Windows - cmd.exe otherwise splits on the space in this project's own
  // directory name ("...\Anuneet Kumar\...") and tries to run "C:\Users\Anuneet"
  // as the command.
  const result = spawnSync(process.platform === "win32" ? `"${nextBin}"` : nextBin, ["build"], {
    cwd: frontendRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...mobileEnv },
  });
  buildExitCode = result.status ?? 1;
} finally {
  if (envLocalExisted) {
    renameSync(envLocalBackupPath, envLocalPath);
    log(".env.local restored.");
  }
}

if (buildExitCode !== 0) {
  process.exit(buildExitCode);
}

// Build-time assertion: fail loudly if the static output still contains
// the local dev backend URL, regardless of how it might have gotten
// there - a hard guarantee independent of the mechanism above.
log("Verifying no localhost URL leaked into the mobile build output...");

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

if (!existsSync(outDir)) {
  console.error(`[build:mobile] Build reported success but ${outDir} doesn't exist - can't verify output.`);
  process.exit(1);
}

const offenders = [];
for (const file of walk(outDir)) {
  if (!/\.(js|html|json)$/.test(file)) continue;
  const content = readFileSync(file, "utf8");
  if (content.includes("http://localhost")) offenders.push(path.relative(frontendRoot, file));
}

if (offenders.length > 0) {
  console.error(
    "[build:mobile] FAILED assertion: the mobile build output contains 'http://localhost' - .env.local leaked into this build despite being moved aside. Offending files:"
  );
  for (const f of offenders) console.error("  -", f);
  process.exit(1);
}

log("OK - mobile build output points at the configured NEXT_PUBLIC_API_BASE_URL, not localhost.");
