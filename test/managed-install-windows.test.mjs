import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installWindowsManager,
  uninstallWindowsManager,
  windowsManagerStatus,
} from "../lib/managed-install-windows.mjs";

async function fixture(version = "1.2.0", runtime = "console.log('v1');\n") {
  const root = await mkdtemp(join(tmpdir(), "ppm-windows-install-test-"));
  const homePath = join(root, "User Home");
  const localAppDataPath = join(root, "Local AppData");
  await mkdir(homePath, { recursive: true });
  await mkdir(localAppDataPath, { recursive: true });
  const home = await realpath(homePath);
  const localAppData = await realpath(localAppDataPath);
  const windowsPayloadPath = join(root, `payload-${version}.mjs`);
  const windowsLauncherPath = join(root, `launcher-${version}.cmd`);
  await writeFile(windowsPayloadPath, runtime);
  await writeFile(windowsLauncherPath, "@echo off\r\nnode payload %*\r\n");
  return {
    root,
    home,
    localAppData,
    context: {
      packageName: "@thieung/pi-profile-manager",
      packageVersion: version,
      homeDir: home,
      localAppData,
      windowsPayloadPath,
      windowsLauncherPath,
    },
    runtimePath: join(home, "bin/pi-profile-manager.mjs"),
    launcherPath: join(home, "bin/pi-profile-manager.cmd"),
    receiptPath: join(localAppData, "pi-profile-manager/receipt-windows.json"),
    backupDir: join(localAppData, "pi-profile-manager/backups"),
  };
}

async function withoutTestFailures(operation) {
  const previousPath = process.env.PATH;
  process.env.PATH = "C:\\Windows\\System32";
  try {
    return await operation();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    delete process.env.PI_PROFILE_MANAGER_TEST_FAIL_AFTER_REPLACE;
    delete process.env.PI_PROFILE_MANAGER_TEST_FAIL_DURING_UNINSTALL;
  }
}

test("Windows install owns runtime and cmd launcher", async () => {
  const fx = await fixture();
  await withoutTestFailures(async () => {
    await installWindowsManager(fx.context);
    assert.equal(await readFile(fx.runtimePath, "utf8"), "console.log('v1');\n");
    assert.match(await readFile(fx.launcherPath, "utf8"), /@echo off/);
    const receipt = JSON.parse(await readFile(fx.receiptPath, "utf8"));
    assert.equal(receipt.platform, "win32");
    assert.equal(receipt.artifacts.length, 2);
    assert.deepEqual(await windowsManagerStatus(fx.context), {
      status: "managed-current",
      exitCode: 0,
    });
  });
});

test("Windows install is idempotent", async () => {
  const fx = await fixture();
  await withoutTestFailures(async () => {
    await installWindowsManager(fx.context);
    const receipt = await readFile(fx.receiptPath, "utf8");
    await installWindowsManager(fx.context);
    assert.equal(await readFile(fx.receiptPath, "utf8"), receipt);
    assert.deepEqual(await readdir(fx.backupDir), []);
  });
});

test("Windows upgrade backs up both artifacts", async () => {
  const fx = await fixture();
  await withoutTestFailures(async () => {
    await installWindowsManager(fx.context);
    const nextRuntime = join(fx.root, "payload-1.3.0.mjs");
    const nextLauncher = join(fx.root, "launcher-1.3.0.cmd");
    await writeFile(nextRuntime, "console.log('v2');\n");
    await writeFile(nextLauncher, "@echo off\r\nnode payload-v2 %*\r\n");
    await installWindowsManager({
      ...fx.context,
      packageVersion: "1.3.0",
      windowsPayloadPath: nextRuntime,
      windowsLauncherPath: nextLauncher,
    });
    assert.equal(await readFile(fx.runtimePath, "utf8"), "console.log('v2');\n");
    const backups = await readdir(fx.backupDir);
    assert.equal(backups.length, 1);
    assert.deepEqual(
      (await readdir(join(fx.backupDir, backups[0]))).sort(),
      ["pi-profile-manager.cmd", "pi-profile-manager.mjs", "receipt-windows.json"],
    );
  });
});

test("Windows foreign and drifted artifacts fail closed", async () => {
  const fx = await fixture();
  await mkdir(join(fx.home, "bin"), { recursive: true });
  await writeFile(fx.launcherPath, "user-owned\n");
  await withoutTestFailures(async () => {
    await assert.rejects(
      () => installWindowsManager(fx.context),
      /refusing to replace foreign Windows target/,
    );
    assert.equal(await readFile(fx.launcherPath, "utf8"), "user-owned\n");
  });

  const clean = await fixture();
  await withoutTestFailures(async () => {
    await installWindowsManager(clean.context);
    await writeFile(clean.runtimePath, "drifted\n");
    assert.deepEqual(await windowsManagerStatus(clean.context), {
      status: "managed-drifted",
      exitCode: 2,
    });
    await assert.rejects(() => uninstallWindowsManager(clean.context), /drifted Windows target/);
  });
});

test("Windows failed upgrade restores runtime launcher and receipt", async () => {
  const fx = await fixture();
  await withoutTestFailures(async () => {
    await installWindowsManager(fx.context);
    const receipt = await readFile(fx.receiptPath, "utf8");
    const nextRuntime = join(fx.root, "broken.mjs");
    const nextLauncher = join(fx.root, "broken.cmd");
    await writeFile(nextRuntime, "broken runtime\n");
    await writeFile(nextLauncher, "broken launcher\n");
    process.env.PI_PROFILE_MANAGER_TEST_FAIL_AFTER_REPLACE = "1";
    await assert.rejects(
      () => installWindowsManager({
        ...fx.context,
        packageVersion: "1.3.0",
        windowsPayloadPath: nextRuntime,
        windowsLauncherPath: nextLauncher,
      }),
      /previous state was restored/,
    );
    delete process.env.PI_PROFILE_MANAGER_TEST_FAIL_AFTER_REPLACE;
    assert.equal(await readFile(fx.runtimePath, "utf8"), "console.log('v1');\n");
    assert.match(await readFile(fx.launcherPath, "utf8"), /node payload/);
    assert.equal(await readFile(fx.receiptPath, "utf8"), receipt);
  });
});

test("Windows uninstall removes only owned manager artifacts", async () => {
  const fx = await fixture();
  const profileMarker = join(fx.home, ".pi/profiles/pi-dev/keep-me");
  await mkdir(join(fx.home, ".pi/profiles/pi-dev"), { recursive: true });
  await writeFile(profileMarker, "keep\n");
  await withoutTestFailures(async () => {
    await installWindowsManager(fx.context);
    await uninstallWindowsManager(fx.context);
    await assert.rejects(() => lstat(fx.runtimePath), { code: "ENOENT" });
    await assert.rejects(() => lstat(fx.launcherPath), { code: "ENOENT" });
    await assert.rejects(() => lstat(fx.receiptPath), { code: "ENOENT" });
    assert.equal(await readFile(profileMarker, "utf8"), "keep\n");
    await uninstallWindowsManager(fx.context);
  });
});

test("Windows failed uninstall restores every managed artifact", async () => {
  const fx = await fixture();
  await withoutTestFailures(async () => {
    await installWindowsManager(fx.context);
    process.env.PI_PROFILE_MANAGER_TEST_FAIL_DURING_UNINSTALL = "1";
    await assert.rejects(() => uninstallWindowsManager(fx.context), /were restored/);
    delete process.env.PI_PROFILE_MANAGER_TEST_FAIL_DURING_UNINSTALL;
    assert.equal(await readFile(fx.runtimePath, "utf8"), "console.log('v1');\n");
    assert.match(await readFile(fx.launcherPath, "utf8"), /@echo off/);
    assert.match(await readFile(fx.receiptPath, "utf8"), /"platform": "win32"/);
  });
});

test("Windows symlink parent is refused", async () => {
  const fx = await fixture();
  const foreign = join(fx.root, "foreign-bin");
  await mkdir(foreign);
  await symlink(foreign, join(fx.home, "bin"), "dir");
  await withoutTestFailures(async () => {
    await assert.rejects(
      () => installWindowsManager(fx.context),
      /refusing symlink or junction in managed path/,
    );
  });
});
