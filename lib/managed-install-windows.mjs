import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const RECEIPT_SCHEMA = 1;

class InvalidReceiptError extends Error {}

function info(message) {
  process.stdout.write(`INFO: ${message}\n`);
}

function envValue(runtimeEnv, name, fallback = "") {
  const key = Object.keys(runtimeEnv).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? runtimeEnv[key] : fallback;
}

async function pathType(path) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return "symlink-or-junction";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
}

function requireSafeAbsoluteDirectory(path, label) {
  if (!path || !isAbsolute(path) || resolve(path) === sep) {
    throw new Error(`${label} must be an absolute, non-root directory`);
  }
  const supplied = resolve(path);
  const stat = lstatSync(supplied);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink or junction: ${supplied}`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${supplied}`);
  return realpathSync(supplied);
}

function resolveLayout(context) {
  const home = requireSafeAbsoluteDirectory(
    context.homeDir ?? process.env.USERPROFILE,
    "USERPROFILE",
  );
  const localAppData = requireSafeAbsoluteDirectory(
    context.localAppData ?? process.env.LOCALAPPDATA,
    "LOCALAPPDATA",
  );
  const targetDir = join(home, "bin");
  const stateDir = join(localAppData, "pi-profile-manager");
  const artifacts = [
    {
      name: "runtime",
      sourcePath: context.windowsPayloadPath,
      targetPath: join(targetDir, "pi-profile-manager.mjs"),
    },
    {
      name: "launcher",
      sourcePath: context.windowsLauncherPath,
      targetPath: join(targetDir, "pi-profile-manager.cmd"),
    },
  ];
  return {
    home,
    localAppData,
    targetDir,
    stateDir,
    receiptPath: join(stateDir, "receipt-windows.json"),
    backupDir: join(stateDir, "backups"),
    lockPath: join(stateDir, "install-windows.lock"),
    artifacts,
  };
}

function assertWithin(root, path) {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`unsafe path outside managed root: ${path}`);
  }
}

async function assertNoReparseParents(root, path) {
  assertWithin(root, path);
  const parts = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const type = await pathType(current);
    if (type === "absent") return;
    if (type === "symlink-or-junction") {
      throw new Error(`refusing symlink or junction in managed path: ${current}`);
    }
    if (current !== path && type !== "directory") {
      throw new Error(`managed parent is not a directory: ${current}`);
    }
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function uniqueSuffix() {
  return `${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}`;
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
  await assertNoReparseParents(layout.localAppData, layout.stateDir);
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
    receipt.platform !== "win32" ||
    receipt.package !== context.packageName ||
    typeof receipt.version !== "string" ||
    !Array.isArray(receipt.artifacts) ||
    receipt.artifacts.length !== layout.artifacts.length
  ) {
    throw new InvalidReceiptError(`invalid Windows ownership receipt: ${layout.receiptPath}`);
  }
  for (const expected of layout.artifacts) {
    const artifact = receipt.artifacts.find((entry) => entry.name === expected.name);
    if (
      !artifact ||
      artifact.targetPath !== expected.targetPath ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    ) {
      throw new InvalidReceiptError(`invalid Windows artifact receipt: ${expected.name}`);
    }
  }
}

async function readReceipt(context, layout) {
  const type = await pathType(layout.receiptPath);
  if (type === "absent") return null;
  if (type !== "file") throw new Error(`ownership receipt is not a regular file: ${layout.receiptPath}`);
  try {
    const receipt = JSON.parse(await readFile(layout.receiptPath, "utf8"));
    validateReceipt(receipt, context, layout);
    return receipt;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new InvalidReceiptError(`cannot parse Windows ownership receipt: ${error.message}`);
    }
    throw error;
  }
}

async function inspect(context, layout = resolveLayout(context)) {
  for (const artifact of layout.artifacts) {
    await assertNoReparseParents(layout.home, artifact.targetPath);
  }
  await assertNoReparseParents(layout.localAppData, layout.receiptPath);

  let receipt;
  try {
    receipt = await readReceipt(context, layout);
  } catch (error) {
    if (error instanceof InvalidReceiptError) {
      return { kind: "foreign", layout, receipt: null, reason: error.message };
    }
    throw error;
  }

  const targetTypes = await Promise.all(layout.artifacts.map((entry) => pathType(entry.targetPath)));
  if (targetTypes.every((type) => type === "absent") && !receipt) {
    return { kind: "absent", layout, receipt: null };
  }
  if (!receipt) {
    return { kind: "foreign", layout, receipt: null, reason: "ownership receipt is missing" };
  }
  if (targetTypes.some((type) => type !== "file")) {
    return {
      kind: "foreign",
      layout,
      receipt,
      reason: `managed artifacts are incomplete or non-files: ${targetTypes.join(",")}`,
    };
  }

  const hashes = new Map();
  for (const artifact of layout.artifacts) hashes.set(artifact.name, await sha256(artifact.targetPath));
  for (const artifact of receipt.artifacts) {
    if (hashes.get(artifact.name) !== artifact.sha256) {
      return {
        kind: "drifted",
        layout,
        receipt,
        hashes,
        reason: `${artifact.name} checksum does not match ownership receipt`,
      };
    }
  }
  return { kind: "managed", layout, receipt, hashes };
}

async function sourceArtifacts(context, layout) {
  const result = [];
  for (const artifact of layout.artifacts) {
    if ((await pathType(artifact.sourcePath)) !== "file") {
      throw new Error(`package payload is missing: ${artifact.sourcePath}`);
    }
    result.push({ ...artifact, sha256: await sha256(artifact.sourcePath) });
  }
  return result;
}

function makeReceipt(context, artifacts) {
  return {
    schema: RECEIPT_SCHEMA,
    platform: "win32",
    package: context.packageName,
    version: context.packageVersion,
    artifacts: artifacts.map(({ name, targetPath, sha256: digest }) => ({
      name,
      targetPath,
      sha256: digest,
    })),
    installedAt: new Date().toISOString(),
  };
}

async function stageFile(path, content) {
  const staged = `${path}.new-${uniqueSuffix()}`;
  await writeFile(staged, content, { flag: "wx" });
  return staged;
}

async function replaceFiles(replacements) {
  const completed = [];
  try {
    for (const replacement of replacements) {
      const displaced = `${replacement.targetPath}.old-${uniqueSuffix()}`;
      const existed = (await pathType(replacement.targetPath)) === "file";
      if (existed) await rename(replacement.targetPath, displaced);
      try {
        await rename(replacement.stagedPath, replacement.targetPath);
      } catch (error) {
        if (existed) await rename(displaced, replacement.targetPath);
        throw error;
      }
      completed.push({ ...replacement, displaced: existed ? displaced : null });
    }
    return completed;
  } catch (error) {
    for (const item of completed.reverse()) {
      await rm(item.targetPath, { force: true });
      if (item.displaced) await rename(item.displaced, item.targetPath);
    }
    for (const item of replacements) await rm(item.stagedPath, { force: true });
    throw error;
  }
}

async function finalizeReplacements(completed) {
  for (const item of completed) {
    if (item.displaced) {
      try {
        await rm(item.displaced, { force: true });
      } catch (error) {
        info(`cleanup deferred for replaced artifact ${item.displaced}: ${error.message}`);
      }
    }
  }
}

async function rollbackReplacements(completed) {
  for (const item of completed.reverse()) {
    await rm(item.targetPath, { force: true });
    if (item.displaced) await rename(item.displaced, item.targetPath);
  }
}

export async function installWindowsManager(context) {
  const layout = resolveLayout(context);
  return withMutationLock(layout, async () => {
    const state = await inspect(context, layout);
    const sources = await sourceArtifacts(context, layout);
    if (state.kind === "foreign" || state.kind === "drifted") {
      throw new Error(`refusing to replace ${state.kind} Windows target: ${state.reason}`);
    }
    if (
      state.kind === "managed" &&
      state.receipt.version === context.packageVersion &&
      sources.every((source) => state.hashes.get(source.name) === source.sha256)
    ) {
      info(`already installed: ${layout.targetDir} (${context.packageVersion})`);
      return;
    }

    await assertNoReparseParents(layout.home, layout.targetDir);
    await assertNoReparseParents(layout.localAppData, layout.backupDir);
    await mkdir(layout.targetDir, { recursive: true });
    await mkdir(layout.backupDir, { recursive: true });

    if (state.kind === "managed") {
      const backupRoot = join(layout.backupDir, `${state.receipt.version}-${uniqueSuffix()}`);
      await mkdir(backupRoot);
      for (const artifact of layout.artifacts) {
        await copyFile(artifact.targetPath, join(backupRoot, basename(artifact.targetPath)));
      }
      await copyFile(layout.receiptPath, join(backupRoot, "receipt-windows.json"));
      info(`backup created: ${backupRoot}`);
    }

    const replacements = [];
    for (const source of sources) {
      replacements.push({
        targetPath: source.targetPath,
        stagedPath: await stageFile(source.targetPath, await readFile(source.sourcePath)),
      });
    }
    const receiptContent = `${JSON.stringify(makeReceipt(context, sources), null, 2)}\n`;
    replacements.push({
      targetPath: layout.receiptPath,
      stagedPath: await stageFile(layout.receiptPath, receiptContent),
    });

    let completed = [];
    try {
      completed = await replaceFiles(replacements);
      if (process.env.PI_PROFILE_MANAGER_TEST_FAIL_AFTER_REPLACE === "1") {
        throw new Error("simulated failure after Windows payload replacement");
      }
    } catch (error) {
      if (completed.length > 0) await rollbackReplacements(completed);
      throw new Error(`Windows install failed and previous state was restored: ${error.message}`);
    }
    await finalizeReplacements(completed);

    info(`installed: ${layout.targetDir} (${context.packageVersion})`);
    const pathEntries = envValue(process.env, "PATH").split(";").map((entry) => entry.toLowerCase());
    if (!pathEntries.includes(layout.targetDir.toLowerCase())) {
      info(`add to user PATH and open a new terminal: ${layout.targetDir}`);
    }
  });
}

export async function windowsManagerStatus(context) {
  const layout = resolveLayout(context);
  const state = await inspect(context, layout);
  if (state.kind === "absent") {
    info("status: absent");
    return { status: "absent", exitCode: 1 };
  }
  if (state.kind === "foreign") {
    info(`status: foreign (${state.reason})`);
    return { status: "foreign", exitCode: 3 };
  }
  if (state.kind === "drifted") {
    info(`status: managed-drifted (${state.reason})`);
    return { status: "managed-drifted", exitCode: 2 };
  }
  const sources = await sourceArtifacts(context, layout);
  const current =
    state.receipt.version === context.packageVersion &&
    sources.every((source) => state.hashes.get(source.name) === source.sha256);
  const status = current ? "managed-current" : "managed-version-different";
  info(`status: ${status} (installed ${state.receipt.version}, package ${context.packageVersion})`);
  return { status, exitCode: 0 };
}

export async function uninstallWindowsManager(context) {
  const layout = resolveLayout(context);
  return withMutationLock(layout, async () => {
    const state = await inspect(context, layout);
    if (state.kind === "absent") {
      info("already uninstalled");
      return;
    }
    if (state.kind !== "managed") {
      throw new Error(`refusing to uninstall ${state.kind} Windows target: ${state.reason}`);
    }

    const staged = [];
    try {
      for (const targetPath of [...layout.artifacts.map((entry) => entry.targetPath), layout.receiptPath]) {
        const stagedPath = join(layout.stateDir, `.uninstall-${basename(targetPath)}-${uniqueSuffix()}`);
        await rename(targetPath, stagedPath);
        staged.push({ targetPath, stagedPath });
      }
      if (process.env.PI_PROFILE_MANAGER_TEST_FAIL_DURING_UNINSTALL === "1") {
        throw new Error("simulated failure during Windows uninstall");
      }
    } catch (error) {
      for (const item of staged.reverse()) await rename(item.stagedPath, item.targetPath);
      throw new Error(`Windows uninstall failed and managed files were restored: ${error.message}`);
    }
    for (const item of staged) await rm(item.stagedPath, { force: true });
    info(`uninstalled: ${layout.targetDir}`);
    info(`profile state and backups were preserved under ${layout.home}`);
  });
}
