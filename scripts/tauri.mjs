#!/usr/bin/env node
// Wrapper around the Tauri CLI that supplies the updater signing key locally.
//
// The Tauri v2 CLI does not read .env files, and the private key must never be
// committed, so builds would otherwise fail with "A public key has been found,
// but no private key". This resolves the key from ~/.tauri (see .gitignore) and
// hands the CLI a path to it. CI sets TAURI_SIGNING_PRIVATE_KEY from a repo
// secret, and an already-set variable always wins.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KEY_PATH =
  process.env.TAURI_SIGNING_KEY_PATH ??
  join(homedir(), ".tauri", "atimo-updater.key");

const env = { ...process.env };

if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  if (existsSync(KEY_PATH)) {
    // The CLI accepts either the key itself or a path to it.
    env.TAURI_SIGNING_PRIVATE_KEY = KEY_PATH;
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
  } else {
    console.warn(
      `[tauri] No updater signing key at ${KEY_PATH}. ` +
        `Commands that bundle the app will fail; run \`bun run tauri signer generate -w "${KEY_PATH}"\` ` +
        `or set TAURI_SIGNING_PRIVATE_KEY yourself.`,
    );
  }
}

// `bun run` puts node_modules/.bin on PATH, but direct `node scripts/tauri.mjs`
// invocations do not, so prefer the local binary when it is there.
const localBin = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);
const bin = existsSync(localBin) ? localBin : "tauri";

const child = spawn(bin, process.argv.slice(2), {
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("error", (error) => {
  console.error(`[tauri] Failed to start the Tauri CLI: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
