import { runCommand } from "./run-command.mjs";

for (const file of [
  "bin/pi-profile-manager.mjs",
  "lib/managed-install.mjs",
  "lib/managed-install-windows.mjs",
  "payload/pi-profile-manager-windows.mjs",
  "scripts/check.mjs",
  "scripts/run-command.mjs",
  "scripts/run-tests.mjs",
  "scripts/test-payload.mjs",
  "test/managed-install.test.mjs",
  "test/managed-install-windows.test.mjs",
  "test/windows-payload.test.mjs",
]) {
  runCommand(process.execPath, ["--check", file]);
}

if (process.platform !== "win32") {
  runCommand("bash", ["-n", "payload/pi-profile-manager", "test/pi-profile-manager.test.sh", "scripts/check-payload-sync.sh"]);
}
