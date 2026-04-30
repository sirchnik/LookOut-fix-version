/// <reference types="node" />

// @ts-check

import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const liveServer = require("live-server");

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const certDir = path.join(root, ".cert");
const certPath = path.join(certDir, "localhost-cert.pem");
const keyPath = path.join(certDir, "localhost-key.pem");

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 * @returns {Promise<void>}
 */
function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

/** @returns {Promise<void>} */
async function ensureCertificate() {
  if ((await exists(certPath)) && (await exists(keyPath))) {
    return;
  }

  await mkdir(certDir, { recursive: true });

  console.log("Generating trusted local HTTPS certificate with mkcert...");

  try {
    await runCommand("mkcert", ["-install"], { cwd: root });

    await runCommand(
      "mkcert",
      [
        "-cert-file",
        certPath,
        "-key-file",
        keyPath,
        "localhost",
        "127.0.0.1",
        "::1",
      ],
      { cwd: root },
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "mkcert was not found in PATH. Install mkcert, then run pnpm dev again.",
      );
    }
    throw error;
  }
}

/**
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<void>}
 */
async function waitForInitialBuild(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const indexPath = path.join(dist, "index.html");

  while (Date.now() < deadline) {
    if (await exists(indexPath)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    "Timed out waiting for initial build output in dist/. Check build.mjs for errors.",
  );
}

/** @returns {import("node:child_process").ChildProcess} */
function startBuildWatcher() {
  return spawn(process.execPath, [path.join(root, "build.mjs"), "--watch"], {
    cwd: root,
    stdio: "inherit",
  });
}

/** @returns {Promise<void>} */
async function main() {
  await ensureCertificate();

  const buildWatcher = startBuildWatcher();
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    liveServer.shutdown();
    buildWatcher.kill("SIGTERM");
  };

  buildWatcher.once("exit", (code) => {
    if (shuttingDown) {
      return;
    }

    console.error(
      `build.mjs --watch exited unexpectedly with code ${code ?? "unknown"}.`,
    );
    shutdown();
    process.exitCode = typeof code === "number" ? code : 1;
  });

  buildWatcher.once("error", (error) => {
    console.error(error);
    shutdown();
    process.exitCode = 1;
  });

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await waitForInitialBuild();

  const httpsConfig = {
    cert: await readFile(certPath),
    key: await readFile(keyPath),
  };

  liveServer.start({
    host: "localhost",
    port: 8080,
    open: true,
    file: "index.html",
    wait: 100,
    root: dist,
    logLevel: 1,
    https: httpsConfig,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
