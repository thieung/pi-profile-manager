import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import {
  chmod,
  copyFile,
  open,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const RECEIPT_SCHEMA = 1;
const EXECUTABLE_NAME = "pi-profile-manager";

class InvalidReceiptError extends Error {}

function info(message) {
  process.stdout.write(`INFO: ${message}\n`);
}

async function pathType(path) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
}

function resolveLayout(home = process.env.HOME) {
  if (!home || !isAbsolute(home) || resolve(home) === sep) {
    throw new Error("HOME must be an absolute, non-root directory");
  }

  const suppliedHome = resolve(home);
  const homeStat = lstatSync(suppliedHome);
  if (homeStat.isSymbolicLink()) {
    throw new Error(`HOME must not be a symlink: ${suppliedHome}`);
  }
  if (!homeStat.isDirectory()) {
    throw new Error(`HOME must be a directory: ${suppliedHome}`);
  }
  const resolvedHome = realpathSync(suppliedHome);
  const targetPath = join(resolvedHome, ".local/bin", EXECUTABLE_NAME);
  const stateDir = join(resolvedHome, ".local/share/pi-profile-manager");
  return {
    home: resolvedHome,
    targetDir: dirname(targetPath),
    targetPath,
    stateDir,
    receiptPath: join(stateDir, "receipt.json"),
    backupDir: join(stateDir, "backups"),
    lockPath: join(stateDir, "install.lock"),
  };
}

function assertWithinHome(layout, path) {
  const rel = relative(layout.home, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`unsafe path outside HOME: ${path}`);
  }
}

async function assertNoSymlinkParents(layout, path) {
  assertWithinHome(layout, path);
  const rel = relative(layout.home, path);
  const parts = rel.split(sep).filter(Boolean);
  let current = layout.home;

  for (const part of parts) {
    current = join(current, part);
    const type = await pathType(current);
    if (type === "absent") return;
    if (type === "symlink") {
      throw new Error(`refusing symlink in managed path: ${current}`);
    }
    if (current !== path && type !== "directory") {
      throw new Error(`managed parent is not a directory: ${current}`);
    }
  }
}

async function sha256(path) {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

function uniqueSuffix() {
  return `${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}`;
}

async function atomicWrite(path, content, mode) {
  const tempPath = `${path}.tmp-${uniqueSuffix()}`;
  await writeFile(tempPath, content, { flag: "wx", mode });
  try {
    await chmod(tempPath, mode);
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function openMutationLock(layout) {
  try {
    return await open(layout.lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`another pi-profile-manager mutation is already running: ${layout.lockPath}`);
    }
    throw error;
  }
}

async function withMutationLock(layout, operation) {
  await assertNoSymlinkParents(layout, layout.stateDir);
  await mkdir(layout.stateDir, { recursive: true, mode: 0o700 });

  const lock = await openMutationLock(layout);

  try {
    await lock.writeFile(`${process.pid}\n`);
    return await operation();
  } finally {
    await lock.close();
    await rm(layout.lockPath, { force: true });
  }
}

function validateReceipt(receipt, context, layout) {
  if (
    !receipt ||
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.package !== context.packageName ||
    receipt.targetPath !== layout.targetPath ||
    typeof receipt.version !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256)
  ) {
    throw new InvalidReceiptError(`invalid ownership receipt: ${layout.receiptPath}`);
  }
}

async function readReceipt(context, layout) {
  const type = await pathType(layout.receiptPath);
  if (type === "absent") return null;
  if (type !== "file") {
    throw new Error(`ownership receipt is not a regular file: ${layout.receiptPath}`);
  }

  let receipt;
  try {
    receipt = JSON.parse(await readFile(layout.receiptPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new InvalidReceiptError(`cannot parse ownership receipt: ${error.message}`);
    }
    throw error;
  }
  validateReceipt(receipt, context, layout);
  return receipt;
}

async function inspect(context) {
  const layout = resolveLayout();
  await assertNoSymlinkParents(layout, layout.targetPath);
  await assertNoSymlinkParents(layout, layout.receiptPath);
  const targetType = await pathType(layout.targetPath);
  let receipt;
  try {
    receipt = await readReceipt(context, layout);
  } catch (error) {
    if (error instanceof InvalidReceiptError) {
      return {
        kind: "foreign",
        layout,
        receipt: null,
        reason: error.message,
      };
    }
    throw error;
  }

  if (targetType === "absent" && !receipt) {
    return { kind: "absent", layout, receipt: null };
  }
  if (targetType !== "file") {
    return { kind: "foreign", layout, receipt, reason: `target is ${targetType}` };
  }
  if (!receipt) {
    return { kind: "foreign", layout, receipt: null, reason: "ownership receipt is missing" };
  }

  const currentSha256 = await sha256(layout.targetPath);
  if (currentSha256 !== receipt.sha256) {
    return {
      kind: "drifted",
      layout,
      receipt,
      currentSha256,
      reason: "target checksum does not match ownership receipt",
    };
  }
  return { kind: "managed", layout, receipt, currentSha256 };
}

function makeReceipt(context, layout, payloadSha256) {
  return {
    schema: RECEIPT_SCHEMA,
    package: context.packageName,
    version: context.packageVersion,
    targetPath: layout.targetPath,
    sha256: payloadSha256,
    installedAt: new Date().toISOString(),
  };
}

async function restorePrevious(layout, backupPath, oldReceiptContent) {
  if (backupPath) {
    await atomicWrite(layout.targetPath, await readFile(backupPath), 0o755);
  } else {
    await rm(layout.targetPath, { force: true });
  }

  if (oldReceiptContent === null) {
    await rm(layout.receiptPath, { force: true });
  } else {
    await atomicWrite(layout.receiptPath, oldReceiptContent, 0o600);
  }
}

export async function installManager(context) {
  const layout = resolveLayout();
  return withMutationLock(layout, () => installManagerUnlocked(context));
}

async function installManagerUnlocked(context) {
  const state = await inspect(context);
  const { layout } = state;
  const payloadType = await pathType(context.payloadPath);
  if (payloadType !== "file") {
    throw new Error(`package payload is missing: ${context.payloadPath}`);
  }
  const payloadSha256 = await sha256(context.payloadPath);

  if (state.kind === "foreign" || state.kind === "drifted") {
    throw new Error(`refusing to replace ${state.kind} target: ${state.reason}`);
  }
  if (
    state.kind === "managed" &&
    state.currentSha256 === payloadSha256 &&
    state.receipt.version === context.packageVersion
  ) {
    info(`already installed: ${layout.targetPath} (${context.packageVersion})`);
    return;
  }

  await assertNoSymlinkParents(layout, layout.targetDir);
  await assertNoSymlinkParents(layout, layout.stateDir);
  await mkdir(layout.targetDir, { recursive: true, mode: 0o755 });
  await mkdir(layout.backupDir, { recursive: true, mode: 0o700 });

  let backupPath = null;
  let oldReceiptContent = null;
  if (state.kind === "managed") {
    backupPath = join(
      layout.backupDir,
      `${EXECUTABLE_NAME}-${state.receipt.version}-${uniqueSuffix()}`,
    );
    await copyFile(layout.targetPath, backupPath);
    await chmod(backupPath, 0o700);
    oldReceiptContent = await readFile(layout.receiptPath);
    info(`backup created: ${backupPath}`);
  }

  try {
    await atomicWrite(layout.targetPath, await readFile(context.payloadPath), 0o755);
    if (process.env.PI_PROFILE_MANAGER_TEST_FAIL_AFTER_REPLACE === "1") {
      throw new Error("simulated failure after payload replacement");
    }
    const receipt = makeReceipt(context, layout, payloadSha256);
    await atomicWrite(layout.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
  } catch (error) {
    await restorePrevious(layout, backupPath, oldReceiptContent);
    throw new Error(`install failed and previous state was restored: ${error.message}`);
  }

  info(`installed: ${layout.targetPath} (${context.packageVersion})`);
  if (!process.env.PATH?.split(":").includes(layout.targetDir)) {
    info(`add to PATH: export PATH="${layout.targetDir}:$PATH"`);
  }
}

export async function managerStatus(context) {
  const state = await inspect(context);
  switch (state.kind) {
    case "absent":
      info("status: absent");
      return { status: "absent", exitCode: 1 };
    case "foreign":
      info(`status: foreign (${state.reason})`);
      return { status: "foreign", exitCode: 3 };
    case "drifted":
      info(`status: managed-drifted (${state.reason})`);
      return { status: "managed-drifted", exitCode: 2 };
    case "managed": {
      const payloadSha256 = await sha256(context.payloadPath);
      const current =
        state.receipt.version === context.packageVersion &&
        state.currentSha256 === payloadSha256;
      const status = current ? "managed-current" : "managed-version-different";
      info(`status: ${status} (installed ${state.receipt.version}, package ${context.packageVersion})`);
      return { status, exitCode: 0 };
    }
  }
}

export async function uninstallManager(context) {
  const layout = resolveLayout();
  return withMutationLock(layout, () => uninstallManagerUnlocked(context));
}

async function uninstallManagerUnlocked(context) {
  const state = await inspect(context);
  const { layout } = state;
  if (state.kind === "absent") {
    info("already uninstalled");
    return;
  }
  if (state.kind !== "managed") {
    throw new Error(`refusing to uninstall ${state.kind} target: ${state.reason}`);
  }

  const suffix = uniqueSuffix();
  const stagedTarget = join(layout.stateDir, `.uninstall-target-${suffix}`);
  const stagedReceipt = join(layout.stateDir, `.uninstall-receipt-${suffix}`);
  await rename(layout.targetPath, stagedTarget);
  try {
    if (process.env.PI_PROFILE_MANAGER_TEST_FAIL_DURING_UNINSTALL === "1") {
      throw new Error("simulated failure during uninstall");
    }
    await rename(layout.receiptPath, stagedReceipt);
  } catch (error) {
    await rename(stagedTarget, layout.targetPath);
    throw new Error(`uninstall failed and target was restored: ${error.message}`);
  }

  await rm(stagedReceipt, { force: true });
  await rm(stagedTarget, { force: true });
  info(`uninstalled: ${layout.targetPath}`);
  info(`profile state and backups were preserved under ${layout.home}`);
}
