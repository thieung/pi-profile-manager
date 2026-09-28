#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  installManager,
  managerStatus,
  uninstallManager,
} from "../lib/managed-install.mjs";
import {
  installWindowsManager,
  uninstallWindowsManager,
  windowsManagerStatus,
} from "../lib/managed-install-windows.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);
const context = {
  packageName: packageMetadata.name,
  packageVersion: packageMetadata.version,
  payloadPath: resolve(packageRoot, "payload/pi-profile-manager"),
  windowsPayloadPath: resolve(packageRoot, "payload/pi-profile-manager-windows.mjs"),
  windowsLauncherPath: resolve(packageRoot, "payload/pi-profile-manager.cmd"),
};
const windows = process.platform === "win32";

function usage() {
  process.stdout.write(`Pi Profile Manager bootstrap ${packageMetadata.version}

Usage:
  npx --yes --package ${packageMetadata.name}@${packageMetadata.version} ppm-bootstrap install
  npx --yes --package ${packageMetadata.name}@${packageMetadata.version} ppm-bootstrap status
  npx --yes --package ${packageMetadata.name}@${packageMetadata.version} ppm-bootstrap uninstall

Run any manager command without installing:
  npx --yes --package ${packageMetadata.name}@${packageMetadata.version} pi-profile-manager add <name> --auth local --with-agentkit

After install:
  pi-profile-manager doctor
  pi-profile-manager install <pi-dev|pi-ak|pi-omp|all> [--dry-run]
  pi-profile-manager add [name] [--auth <broker|local>] [--broker-url <url>] [--broker-token <token>] [--with-agentkit|--no-agentkit] [--dry-run]
  pi-profile-manager update <pi|omp|all> [--version <exact>] [--dry-run]
  pi-profile-manager profiles list --json
  pi-profile-manager verify [pi-dev|pi-ak|pi-omp|<custom>|all]
`);
}

const bootstrapCommands = new Set(["install", "status", "uninstall", "--version", "-v", "help", "--help", "-h"]);

// Bootstrap commands take no arguments, so any other invocation (including
// `install <profile>`) is a manager command and runs the packaged payload.
function runPayload(args) {
  const [file, argv] = windows
    ? [process.execPath, [context.windowsPayloadPath, ...args]]
    : ["bash", [context.payloadPath, ...args]];
  const result = spawnSync(file, argv, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}

async function main() {
  const args = process.argv.slice(2);
  const [command, ...rest] = args;
  if (command !== undefined && (!bootstrapCommands.has(command) || rest.length > 0)) {
    runPayload(args);
    return;
  }

  switch (command) {
    case "install":
      if (windows && process.arch !== "x64") {
        throw new Error(`unsupported Windows architecture: ${process.arch}; only x64 is supported`);
      }
      await (windows ? installWindowsManager(context) : installManager(context));
      return;
    case "status": {
      const result = await (windows ? windowsManagerStatus(context) : managerStatus(context));
      process.exitCode = result.exitCode;
      return;
    }
    case "uninstall":
      await (windows ? uninstallWindowsManager(context) : uninstallManager(context));
      return;
    case "--version":
    case "-v":
      process.stdout.write(`${packageMetadata.version}\n`);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      usage();
      return;
  }
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 1;
});
