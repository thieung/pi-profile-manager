import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installManager,
  managerStatus,
  uninstallManager,
} from "../lib/managed-install.mjs";

async function fixture(version = "1.0.0", content = "#!/bin/sh\nprintf 'v1\\n'\n") {
  const root = await mkdtemp(join(tmpdir(), "pi-profile-manager-node-test-"));
  const homePath = join(root, "home");
  const payloadPath = join(root, `payload-${version}`);
  await mkdir(homePath, { recursive: true });
  const home = await realpath(homePath);
  await writeFile(payloadPath, content, { mode: 0o755 });
  return {
    root,
    home,
    context: {
      packageName: "@thieung/pi-profile-manager",
      packageVersion: version,
      payloadPath,
    },
    targetPath: join(home, ".local/bin/pi-profile-manager"),
    receiptPath: join(home, ".local/share/pi-profile-manager/receipt.json"),
    backupDir: join(home, ".local/share/pi-profile-manager/backups"),
  };
}

async function withHome(home, operation) {
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = "/usr/bin:/bin";
  try {
    return await operation();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    delete process.env.PI_PROFILE_MANAGER_TEST_FAIL_AFTER_REPLACE;
    delete process.env.PI_PROFILE_MANAGER_TEST_FAIL_DURING_UNINSTALL;
  }
}

test("first install writes executable and ownership receipt", async () => {
  const fx = await fixture();
  await withHome(fx.home, async () => {
    await installManager(fx.context);
    assert.equal(await readFile(fx.targetPath, "utf8"), "#!/bin/sh\nprintf 'v1\\n'\n");
    assert.equal((await lstat(fx.targetPath)).mode & 0o777, 0o755);
    assert.equal((await lstat(fx.receiptPath)).mode & 0o777, 0o600);
    const receipt = JSON.parse(await readFile(fx.receiptPath, "utf8"));
    assert.equal(receipt.package, fx.context.packageName);
    assert.equal(receipt.version, "1.0.0");
    assert.equal(receipt.targetPath, fx.targetPath);
    assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await managerStatus(fx.context), {
      status: "managed-current",
      exitCode: 0,
    });
  });
});

test("same version install is idempotent", async () => {
  const fx = await fixture();
  await withHome(fx.home, async () => {
    await installManager(fx.context);
    const receiptBefore = await readFile(fx.receiptPath, "utf8");
    await installManager(fx.context);
    assert.equal(await readFile(fx.receiptPath, "utf8"), receiptBefore);
    assert.deepEqual(await readdir(fx.backupDir), []);
  });
});

test("upgrade backs up the owned payload", async () => {
  const fx = await fixture();
  await withHome(fx.home, async () => {
    await installManager(fx.context);
    const nextPayload = join(fx.root, "payload-1.1.0");
    await writeFile(nextPayload, "#!/bin/sh\nprintf 'v2\\n'\n", { mode: 0o755 });
    const next = { ...fx.context, packageVersion: "1.1.0", payloadPath: nextPayload };
    await installManager(next);
    assert.equal(await readFile(fx.targetPath, "utf8"), "#!/bin/sh\nprintf 'v2\\n'\n");
    const backups = await readdir(fx.backupDir);
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^pi-profile-manager-1\.0\.0-/);
    assert.equal(await readFile(join(fx.backupDir, backups[0]), "utf8"), "#!/bin/sh\nprintf 'v1\\n'\n");
  });
});

test("foreign target fails closed", async () => {
  const fx = await fixture();
  await mkdir(join(fx.home, ".local/bin"), { recursive: true });
  await writeFile(fx.targetPath, "user-owned\n");
  await withHome(fx.home, async () => {
    await assert.rejects(() => installManager(fx.context), /refusing to replace foreign target/);
    assert.equal(await readFile(fx.targetPath, "utf8"), "user-owned\n");
  });
});

test("drifted managed target cannot be replaced or uninstalled", async () => {
  const fx = await fixture();
  await withHome(fx.home, async () => {
    await installManager(fx.context);
    await writeFile(fx.targetPath, "modified-after-install\n");
    assert.deepEqual(await managerStatus(fx.context), {
      status: "managed-drifted",
      exitCode: 2,
    });
    await assert.rejects(() => installManager(fx.context), /refusing to replace drifted target/);
    await assert.rejects(() => uninstallManager(fx.context), /refusing to uninstall drifted target/);
    assert.equal(await readFile(fx.targetPath, "utf8"), "modified-after-install\n");
  });
});

test("failed upgrade rolls target and receipt back", async () => {
  const fx = await fixture();
  await withHome(fx.home, async () => {
    await installManager(fx.context);
    const receiptBefore = await readFile(fx.receiptPath, "utf8");
    const nextPayload = join(fx.root, "payload-1.1.0");
    await writeFile(nextPayload, "#!/bin/sh\nprintf 'broken-upgrade\\n'\n", { mode: 0o755 });
    process.env.PI_PROFILE_MANAGER_TEST_FAIL_AFTER_REPLACE = "1";
    await assert.rejects(
      () => installManager({ ...fx.context, packageVersion: "1.1.0", payloadPath: nextPayload }),
      /previous state was restored/,
    );
    delete process.env.PI_PROFILE_MANAGER_TEST_FAIL_AFTER_REPLACE;
    assert.equal(await readFile(fx.targetPath, "utf8"), "#!/bin/sh\nprintf 'v1\\n'\n");
    assert.equal(await readFile(fx.receiptPath, "utf8"), receiptBefore);
  });
});

test("uninstall removes only owned manager state", async () => {
  const fx = await fixture();
  const profileMarker = join(fx.home, ".pi/profiles/pi-dev/keep-me");
  await mkdir(join(fx.home, ".pi/profiles/pi-dev"), { recursive: true });
  await writeFile(profileMarker, "keep\n");
  await withHome(fx.home, async () => {
    await installManager(fx.context);
    await uninstallManager(fx.context);
    await assert.rejects(() => lstat(fx.targetPath), { code: "ENOENT" });
    await assert.rejects(() => lstat(fx.receiptPath), { code: "ENOENT" });
    assert.equal(await readFile(profileMarker, "utf8"), "keep\n");
    await uninstallManager(fx.context);
  });
});

test("symlink target is refused", async () => {
  const fx = await fixture();
  const foreign = join(fx.root, "foreign");
  await writeFile(foreign, "foreign\n");
  await mkdir(join(fx.home, ".local/bin"), { recursive: true });
  await symlink(foreign, fx.targetPath);
  await withHome(fx.home, async () => {
    await assert.rejects(() => installManager(fx.context), /refusing symlink in managed path/);
    assert.equal(await readFile(foreign, "utf8"), "foreign\n");
  });
});

test("symlink HOME is refused", async () => {
  const fx = await fixture();
  const linkedHome = join(fx.root, "linked-home");
  await symlink(fx.home, linkedHome);
  await withHome(linkedHome, async () => {
    await assert.rejects(() => installManager(fx.context), /HOME must not be a symlink/);
  });
});

test("invalid receipt is classified as foreign", async () => {
  const fx = await fixture();
  await mkdir(join(fx.home, ".local/bin"), { recursive: true });
  await mkdir(join(fx.home, ".local/share/pi-profile-manager"), { recursive: true });
  await writeFile(fx.targetPath, "user-or-unknown\n");
  await writeFile(fx.receiptPath, "{not-json}\n");
  await withHome(fx.home, async () => {
    assert.deepEqual(await managerStatus(fx.context), {
      status: "foreign",
      exitCode: 3,
    });
    await assert.rejects(() => installManager(fx.context), /refusing to replace foreign target/);
  });
});

test("failed uninstall restores the target and receipt", async () => {
  const fx = await fixture();
  await withHome(fx.home, async () => {
    await installManager(fx.context);
    const receiptBefore = await readFile(fx.receiptPath, "utf8");
    process.env.PI_PROFILE_MANAGER_TEST_FAIL_DURING_UNINSTALL = "1";
    await assert.rejects(() => uninstallManager(fx.context), /target was restored/);
    delete process.env.PI_PROFILE_MANAGER_TEST_FAIL_DURING_UNINSTALL;
    assert.equal(await readFile(fx.targetPath, "utf8"), "#!/bin/sh\nprintf 'v1\\n'\n");
    assert.equal(await readFile(fx.receiptPath, "utf8"), receiptBefore);
  });
});

test("active mutation lock fails closed", async () => {
  const fx = await fixture();
  const lockPath = join(fx.home, ".local/share/pi-profile-manager/install.lock");
  await mkdir(join(fx.home, ".local/share/pi-profile-manager"), { recursive: true });
  await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600 });
  await withHome(fx.home, async () => {
    await assert.rejects(
      () => installManager(fx.context),
      /another pi-profile-manager mutation is already running/,
    );
    await assert.rejects(() => lstat(fx.targetPath), { code: "ENOENT" });
    assert.equal(await readFile(lockPath, "utf8"), `${process.pid}\n`);
  });
});

test("package manifest has no npm install lifecycle hooks", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const hook of ["preinstall", "install", "postinstall"]) {
    assert.equal(manifest.scripts?.[hook], undefined);
  }
  assert.deepEqual(manifest.bin, {
    "pi-profile-manager": "bin/pi-profile-manager.mjs",
    "ppm-bootstrap": "bin/pi-profile-manager.mjs",
  });
});
