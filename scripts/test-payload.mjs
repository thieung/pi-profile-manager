import { copyFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./run-command.mjs";

if (process.platform === "win32") {
  const root = mkdtempSync(join(tmpdir(), "ppm windows cmd smoke "));
  const home = join(root, "User Home");
  const localAppData = join(root, "Local AppData");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync("payload/pi-profile-manager-windows.mjs", join(bin, "pi-profile-manager.mjs"));
  copyFileSync("payload/pi-profile-manager.cmd", join(bin, "pi-profile-manager.cmd"));
  const previousUserProfile = process.env.USERPROFILE;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.USERPROFILE = home;
  process.env.LOCALAPPDATA = localAppData;
  try {
    runCommand(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${join(bin, "pi-profile-manager.cmd")}" --help`]);
    runCommand(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${join(bin, "pi-profile-manager.cmd")}" bootstrap --dry-run`]);
  } finally {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  }
  process.stdout.write("PASS: Windows cmd payload smoke\n");
} else {
  runCommand("bash", ["test/pi-profile-manager.test.sh"]);
  runCommand("bash", ["scripts/check-payload-sync.sh"]);
}
