#!/usr/bin/env node

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

After install:
  pi-profile-manager doctor
  pi-profile-manager install <pi-dev|pi-ak|pi-omp|all> [--dry-run]
  pi-profile-manager update <pi|omp|all> [--version <exact>] [--dry-run]
  pi-profile-manager profiles list --json
  pi-profile-manager verify [pi-dev|pi-ak|pi-omp|all]
`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (rest.length > 0) {
    throw new Error(`bootstrap command does not accept extra arguments: ${rest.join(" ")}`);
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
    default:
      usage();
      throw new Error(`unknown bootstrap command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 1;
});
