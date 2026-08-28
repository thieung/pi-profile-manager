#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const PROGRAM_NAME = "pi-profile-manager";
const MANAGED_MARKER = "managed by pi-profile-manager";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const OMP_TOOL = "github:can1357/oh-my-pi";
const PI_EXTENSIONS = [
  "npm:statusline-pi@1.2.1",
  "npm:advisor-pi@1.0.3",
  "npm:grok-pi@1.2.0",
  "npm:model-debugger@1.0.2",
  "npm:@tintinweb/pi-subagents@0.18.0",
];

function uniqueSuffix() {
  return `${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}`;
}

function quoteCommand(parts) {
  return parts.map((part) => (/^[A-Za-z0-9_@+=:,./\\-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}

function quoteCmdArgument(value) {
  return `"${String(value).replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

export function buildCmdInvocation(executable, args) {
  return `call ${[executable, ...args].map(quoteCmdArgument).join(" ")}`;
}

function envValue(runtimeEnv, name, fallback = "") {
  const key = Object.keys(runtimeEnv).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? runtimeEnv[key] : fallback;
}

function hasManagedMarker(content) {
  const normalized = content.replaceAll("\r\n", "\n").toLowerCase();
  return normalized.startsWith(`# ${MANAGED_MARKER}\n`) ||
    normalized.startsWith(`@echo off\n@rem ${MANAGED_MARKER}\n`);
}

function defaultRunner(runtimeEnv) {
  const extensions = process.platform === "win32"
    ? envValue(runtimeEnv, "PATHEXT", ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];

  function find(command) {
    if (isAbsolute(command) && existsSync(command)) return command;
    const pathEntries = envValue(runtimeEnv, "PATH").split(delimiter).filter(Boolean);
    for (const directory of pathEntries) {
      for (const extension of extensions) {
        const candidate = join(directory, `${command}${extname(command) ? "" : extension.toLowerCase()}`);
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      }
    }
    if (process.platform === "win32" && command.toLowerCase() === "mise") {
      for (const candidate of [
        join(envValue(runtimeEnv, "LOCALAPPDATA"), "Microsoft", "WinGet", "Links", "mise.exe"),
        join(envValue(runtimeEnv, "USERPROFILE"), "scoop", "shims", "mise.exe"),
      ]) {
        if (candidate && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      }
    }
    return null;
  }

  function execute(command, args, options = {}) {
    const executable = find(command);
    if (!executable) throw new Error(`missing required command: ${command}`);
    let file = executable;
    let finalArgs = args;
    let windowsVerbatimArguments = false;
    if (process.platform === "win32" && [".cmd", ".bat"].includes(extname(executable).toLowerCase())) {
      file = envValue(runtimeEnv, "ComSpec", "cmd.exe");
      finalArgs = ["/d", "/s", "/c", buildCmdInvocation(executable, args)];
      windowsVerbatimArguments = true;
    }
    const result = spawnSync(file, finalArgs, {
      encoding: "utf8",
      env: options.env ?? runtimeEnv,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsVerbatimArguments,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = options.capture ? (result.stderr || result.stdout || "").trim() : "";
      throw new Error(`${command} exited ${result.status}${detail ? `: ${detail}` : ""}`);
    }
    return options.capture ? (result.stdout ?? "").trim() : "";
  }

  return {
    exists: (command) => find(command) !== null,
    run: (command, args, env) => execute(command, args, { env }),
    capture: (command, args, env) => execute(command, args, { capture: true, env }),
    find,
  };
}

function assertSafeManagedPath(root, path) {
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedRoot, resolve(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`unsafe managed path: ${path}`);
  }
  let current = resolvedRoot;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) return;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink or junction in managed path: ${current}`);
    if (current !== resolve(path) && !stat.isDirectory()) {
      throw new Error(`managed parent is not a directory: ${current}`);
    }
  }
}

export function createWindowsProfileManager(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.arch ?? process.arch;
  if (platform === "win32" && architecture !== "x64") {
    throw new Error(`unsupported Windows architecture: ${architecture}; only x64 is supported`);
  }
  const home = resolve(options.home ?? env.USERPROFILE ?? "");
  if (!home || !isAbsolute(home) || home === sep || !existsSync(home) || !lstatSync(home).isDirectory()) {
    throw new Error("USERPROFILE must be an existing absolute, non-root directory");
  }
  if (lstatSync(home).isSymbolicLink()) throw new Error(`USERPROFILE must not be a symlink or junction: ${home}`);
  const runner = options.runner ?? defaultRunner(env);
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  let dryRun = false;
  let requestedVersion = "latest";

  const binDir = join(home, "bin");
  const miseConfigDir = join(home, ".config", "mise");
  const piProfilesDir = join(home, ".pi", "profiles");
  const ompProfileRoot = join(home, ".omp", "profiles", "pi-omp", "agent");

  function info(message) {
    output.write(`INFO: ${message}\n`);
  }

  function warn(message) {
    errorOutput.write(`WARN: ${message}\n`);
  }

  function usage() {
    output.write(`Usage:\n  ${PROGRAM_NAME} bootstrap [--dry-run]\n  ${PROGRAM_NAME} doctor\n  ${PROGRAM_NAME} install <pi-dev|pi-ak|pi-omp|all> [--dry-run]\n  ${PROGRAM_NAME} update <pi|omp|all> [--version <exact>] [--dry-run]\n  ${PROGRAM_NAME} profiles list --json\n  ${PROGRAM_NAME} verify [pi-dev|pi-ak|pi-omp|all]\n`);
  }

  function requireCommand(command) {
    if (!runner.exists(command)) throw new Error(`missing required command: ${command}`);
  }

  function validateVersion(version) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) throw new Error(`invalid version: ${version}`);
  }

  function printCommand(command, args) {
    output.write(`RUN: ${quoteCommand([command, ...args])}\n`);
  }

  function runCommand(command, args, childEnv = env) {
    printCommand(command, args);
    if (!dryRun) runner.run(command, args, childEnv);
  }

  function captureCommand(command, args, childEnv = env) {
    if (dryRun) throw new Error("internal error: capture attempted during dry-run");
    return runner.capture(command, args, childEnv);
  }

  function writeManagedFile(path, content) {
    assertSafeManagedPath(home, path);
    if (existsSync(path)) {
      if (!lstatSync(path).isFile()) throw new Error(`managed target is not a regular file: ${path}`);
      const existing = readFileSync(path, "utf8");
      if (existing === content) {
        info(`unchanged: ${path}`);
        return;
      }
      if (!hasManagedMarker(existing)) {
        throw new Error(`refusing to overwrite user-owned file without managed marker: ${path}`);
      }
      const backup = `${path}.bak.${uniqueSuffix()}`;
      if (dryRun) info(`would back up: ${path} -> ${backup}`);
      else {
        copyFileSync(path, backup);
        info(`backed up: ${path} -> ${backup}`);
      }
    }
    if (dryRun) {
      info(`would write: ${path}`);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    const staged = `${path}.tmp-${uniqueSuffix()}`;
    writeFileSync(staged, content, { flag: "wx" });
    const displaced = `${path}.old-${uniqueSuffix()}`;
    const existed = existsSync(path);
    if (existed) renameSync(path, displaced);
    try {
      renameSync(staged, path);
      if (existed) rmSync(displaced, { force: true });
    } catch (error) {
      rmSync(staged, { force: true });
      if (existed && existsSync(displaced)) renameSync(displaced, path);
      throw error;
    }
    info(`wrote: ${path}`);
  }

  function assertManagedFileWritable(path, content) {
    assertSafeManagedPath(home, path);
    if (!existsSync(path)) return;
    if (!lstatSync(path).isFile()) throw new Error(`managed target is not a regular file: ${path}`);
    const existing = readFileSync(path, "utf8");
    if (existing !== content && !hasManagedMarker(existing)) {
      throw new Error(`refusing to overwrite user-owned file without managed marker: ${path}`);
    }
  }

  function assertManagedFileOwned(path, label) {
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`${label} requires managed file: ${path}`);
    if (!hasManagedMarker(readFileSync(path, "utf8"))) {
      throw new Error(`${label} refuses user-owned file without managed marker: ${path}`);
    }
  }

  function warnProfile(profile, message) {
    warn(`${profile} ${message}`);
  }

  function readProfileFile(path) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) return { exists: true, regular: false, content: "" };
      return { exists: true, regular: true, content: readFileSync(path, "utf8") };
    } catch (error) {
      if (error?.code === "ENOENT") return { exists: false, regular: false, content: "" };
      throw error;
    }
  }

  function isDirectory(path) {
    try {
      return lstatSync(path).isDirectory();
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  function readJsonObject(path, profile, label) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isFile()) {
      warnProfile(profile, `AgentKit ${label} is not a regular file`);
      return null;
    }
    const content = readFileSync(path, "utf8");
    try {
      const value = JSON.parse(content);
      if (!value || Array.isArray(value) || typeof value !== "object") {
        warnProfile(profile, `AgentKit ${label} is not a JSON object`);
        return null;
      }
      return value;
    } catch {
      warnProfile(profile, `AgentKit ${label} is invalid`);
      return null;
    }
  }

  function piAgentKitEnabled(profile) {
    const manifest = readJsonObject(
      join(piRoot(profile), "extensions", "agentkit-hooks-engineer", ".agentkit", "install-manifest.json"),
      profile,
      "manifest",
    );
    return Boolean(manifest && manifest.version === 1 && manifest.kit === "engineer" && Array.isArray(manifest.files));
  }

  function ompAgentKitEnabled() {
    const ownership = readJsonObject(
      join(home, ".agentkit", "adapters", "omp", "engineer", "omp-ownership.json"),
      "pi-omp",
      "ownership",
    );
    return Boolean(ownership && ownership.version === 1 && ownership.kit === "engineer" && Array.isArray(ownership.claims));
  }

  function piRuntimeHealthy(profile) {
    try {
      const script = [
        "const e=process['env'];",
        "process.stdout.write(JSON.stringify({root:e.PI_CODING_AGENT_DIR||'',session:e.PI_CODING_AGENT_SESSION_DIR||''}))",
      ].join("");
      const values = JSON.parse(captureCommand("mise", ["-E", profile, "exec", "--", "node", "-e", script]));
      return resolve(values.root || "").toLowerCase() === resolve(piRoot(profile)).toLowerCase() &&
        resolve(values.session || "").toLowerCase() === resolve(join(piRoot(profile), "sessions")).toLowerCase();
    } catch {
      warnProfile(profile, "runtime environment did not resolve");
      return false;
    }
  }

  function ompRuntimeHealthy() {
    try {
      const script = [
        "const e=process['env'];",
        "process.stdout.write(JSON.stringify({root:e.AGENTKIT_OMP_HOME||'',pi:e.PI_CODING_AGENT_DIR||null}))",
      ].join("");
      const values = JSON.parse(captureCommand("mise", ["-E", "pi-omp", "exec", "--", "node", "-e", script]));
      if (resolve(values.root || "").toLowerCase() !== resolve(ompProfileRoot).toLowerCase() || values.pi !== null) {
        return false;
      }
      const runtimeRoot = captureCommand("mise", ["-E", "pi-omp", "exec", "--", "omp", "config", "path"]);
      return resolve(runtimeRoot).toLowerCase() === resolve(ompProfileRoot).toLowerCase();
    } catch {
      warnProfile("pi-omp", "runtime environment did not resolve");
      return false;
    }
  }

  function piRoot(profile) {
    return join(piProfilesDir, profile);
  }

  function tomlString(value) {
    return JSON.stringify(value);
  }

  function piConfig(profile) {
    return [
      `# ${MANAGED_MARKER}`,
      "[env]",
      `PI_CODING_AGENT_DIR = ${tomlString(piRoot(profile))}`,
      `PI_CODING_AGENT_SESSION_DIR = ${tomlString(join(piRoot(profile), "sessions"))}`,
      "OMP_PROFILE = false",
      "PI_PROFILE = false",
      "",
    ].join("\n");
  }

  function ompConfig() {
    return [
      `# ${MANAGED_MARKER}`,
      "[env]",
      'OMP_PROFILE = "pi-omp"',
      `AGENTKIT_OMP_HOME = ${tomlString(ompProfileRoot)}`,
      "PI_PROFILE = false",
      "PI_CODING_AGENT_DIR = false",
      "PI_CODING_AGENT_SESSION_DIR = false",
      "",
    ].join("\n");
  }

  function wrapper(profile, executable) {
    return `@echo off\r\n@rem ${MANAGED_MARKER}\r\nmise -E ${profile} exec -- ${executable} %*\r\nexit /b %ERRORLEVEL%\r\n`;
  }

  function matchesManagedContent(actual, canonical) {
    const newline = canonical.endsWith("\r\n") ? "\r\n" : "\n";
    return actual === canonical || actual === `${canonical}${newline}`;
  }

  function ensurePiProfile(profile) {
    const configPath = join(miseConfigDir, `config.${profile}.toml`);
    const wrapperPath = join(binDir, `${profile}.cmd`);
    const configContent = piConfig(profile);
    const wrapperContent = wrapper(profile, "pi");
    assertManagedFileWritable(configPath, configContent);
    assertManagedFileWritable(wrapperPath, wrapperContent);
    if (!dryRun) {
      assertSafeManagedPath(home, piRoot(profile));
      mkdirSync(join(piRoot(profile), "sessions"), { recursive: true });
      mkdirSync(miseConfigDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
    } else {
      info(`would create profile directories: ${piRoot(profile)}`);
    }
    writeManagedFile(configPath, configContent);
    writeManagedFile(wrapperPath, wrapperContent);
  }

  function ensureOmpProfile() {
    const configPath = join(miseConfigDir, "config.pi-omp.toml");
    const wrapperPath = join(binDir, "pi-omp.cmd");
    const configContent = ompConfig();
    const wrapperContent = wrapper("pi-omp", "omp");
    assertManagedFileWritable(configPath, configContent);
    assertManagedFileWritable(wrapperPath, wrapperContent);
    if (!dryRun) {
      assertSafeManagedPath(home, ompProfileRoot);
      mkdirSync(ompProfileRoot, { recursive: true });
      mkdirSync(miseConfigDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
    } else {
      info(`would create profile directories: ${ompProfileRoot}`);
    }
    writeManagedFile(configPath, configContent);
    writeManagedFile(wrapperPath, wrapperContent);
  }

  function preflightManagedProfileFiles(target) {
    const artifacts = [];
    if (["pi-dev", "all"].includes(target)) {
      artifacts.push(
        [join(miseConfigDir, "config.pi-dev.toml"), piConfig("pi-dev")],
        [join(binDir, "pi-dev.cmd"), wrapper("pi-dev", "pi")],
      );
    }
    if (["pi-ak", "all"].includes(target)) {
      artifacts.push(
        [join(miseConfigDir, "config.pi-ak.toml"), piConfig("pi-ak")],
        [join(binDir, "pi-ak.cmd"), wrapper("pi-ak", "pi")],
      );
    }
    if (["pi-omp", "all"].includes(target)) {
      artifacts.push(
        [join(miseConfigDir, "config.pi-omp.toml"), ompConfig()],
        [join(binDir, "pi-omp.cmd"), wrapper("pi-omp", "omp")],
      );
    }
    for (const [path, content] of artifacts) assertManagedFileWritable(path, content);
  }

  function assertPiProfileRoot(profile) {
    const expected = piRoot(profile);
    if (dryRun) {
      info(`would assert ${profile} root: ${expected}`);
      return;
    }
    const script = "process.stdout.write(process.env.PI_CODING_AGENT_DIR || '')";
    const actual = captureCommand("mise", ["-E", profile, "exec", "--", "node", "-e", script]);
    if (resolve(actual).toLowerCase() !== resolve(expected).toLowerCase()) {
      throw new Error(`${profile} resolved root '${actual}'; expected '${expected}'`);
    }
    const forbidden = join(home, ".pi", "agent");
    if (resolve(actual).toLowerCase() === resolve(forbidden).toLowerCase()) {
      throw new Error(`${profile} resolved to forbidden default root: ${actual}`);
    }
    info(`${profile} root verified: ${actual}`);
  }

  function assertOmpProfileRoot() {
    if (dryRun) {
      info(`would assert pi-omp root: ${ompProfileRoot}`);
      return;
    }
    const script = "process.stdout.write(JSON.stringify({root:process.env.AGENTKIT_OMP_HOME||'',pi:process.env.PI_CODING_AGENT_DIR||null}))";
    const values = JSON.parse(captureCommand("mise", ["-E", "pi-omp", "exec", "--", "node", "-e", script]));
    if (resolve(values.root).toLowerCase() !== resolve(ompProfileRoot).toLowerCase()) {
      throw new Error(`pi-omp resolved root '${values.root}'; expected '${ompProfileRoot}'`);
    }
    if (values.pi !== null) throw new Error(`pi-omp unexpectedly inherits PI_CODING_AGENT_DIR='${values.pi}'`);
    info(`pi-omp root verified: ${values.root}`);
  }

  function bootstrapMise() {
    if (runner.exists("mise")) {
      info(`mise already available: ${runner.find?.("mise") ?? "PATH"}`);
      if (dryRun) info("would verify existing Mise: mise --version");
      else info(`mise version: ${captureCommand("mise", ["--version"])}`);
      return;
    }
    if (dryRun) {
      info("would install Mise with winget package: jdx.mise");
      info("would verify: mise --version");
      return;
    }
    requireCommand("winget");
    runCommand("winget", [
      "install",
      "--id",
      "jdx.mise",
      "--exact",
      "--source",
      "winget",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ]);
    if (!runner.exists("mise")) {
      throw new Error("winget completed but mise is not available; open a new terminal and rerun doctor");
    }
    info(`mise installed: ${runner.find?.("mise") ?? "PATH"}`);
    info(`mise version: ${captureCommand("mise", ["--version"])}`);
  }

  function installPiBinary(version) {
    requireCommand("npm");
    validateVersion(version);
    runCommand("npm", ["install", "-g", "--ignore-scripts", `${PI_PACKAGE}@${version}`]);
    if (!dryRun) info(`Pi installed: ${captureCommand("pi", ["--version"])}`);
  }

  function resolveOmpVersion(version) {
    if (dryRun && version === "latest") return "latest";
    return version === "latest" ? captureCommand("mise", ["latest", OMP_TOOL]) : version;
  }

  function installOmpBinary(version) {
    requireCommand("mise");
    validateVersion(version);
    const resolved = resolveOmpVersion(version);
    validateVersion(resolved);
    info(dryRun && version === "latest"
      ? "OMP target version: latest (not resolved during dry-run)"
      : `OMP target version: ${resolved}`);
    runCommand("mise", ["use", "-g", "--pin", `${OMP_TOOL}@${resolved}`], { ...env, MISE_LOCKED: "0" });
    runCommand("mise", ["lock", "-g", OMP_TOOL]);
    if (!dryRun) {
      info(`OMP installed: ${captureCommand("mise", ["-E", "pi-omp", "exec", "--", "omp", "--version"])}`);
    }
  }

  function installPiExtensions(profile) {
    assertPiProfileRoot(profile);
    for (const extension of PI_EXTENSIONS) {
      runCommand("mise", ["-E", profile, "exec", "--", "pi", "install", extension]);
    }
  }

  function installAgentKit(profile, target) {
    requireCommand("ak");
    if (target === "pi") assertPiProfileRoot(profile);
    else assertOmpProfileRoot();
    runCommand("mise", [
      "-E", profile, "exec", "--", "ak", "kit", "init", "engineer",
      "--target", target, "--global", "--channel", "beta", "--yes", "--no-interactive",
    ]);
  }

  function preflightInstall(target) {
    requireCommand("mise");
    if (["pi-dev", "pi-ak", "all"].includes(target)) requireCommand("npm");
    if (["pi-ak", "pi-omp", "all"].includes(target)) requireCommand("ak");
    if (!["pi-dev", "pi-ak", "pi-omp", "all"].includes(target)) throw new Error(`unknown install target: ${target}`);
  }

  function prepareInstall(target) {
    preflightManagedProfileFiles(target);
    if (["pi-dev", "all"].includes(target)) ensurePiProfile("pi-dev");
    if (["pi-ak", "all"].includes(target)) ensurePiProfile("pi-ak");
    if (["pi-omp", "all"].includes(target)) ensureOmpProfile();
    if (["pi-dev", "all"].includes(target)) assertPiProfileRoot("pi-dev");
    if (["pi-ak", "all"].includes(target)) assertPiProfileRoot("pi-ak");
    if (["pi-omp", "all"].includes(target)) assertOmpProfileRoot();
  }

  function installTarget(target) {
    preflightInstall(target);
    prepareInstall(target);
    if (["pi-dev", "pi-ak", "all"].includes(target)) installPiBinary("latest");
    if (["pi-dev", "all"].includes(target)) installPiExtensions("pi-dev");
    if (["pi-ak", "all"].includes(target)) {
      installPiExtensions("pi-ak");
      installAgentKit("pi-ak", "pi");
    }
    if (["pi-omp", "all"].includes(target)) {
      installOmpBinary("latest");
      installAgentKit("pi-omp", "omp");
    }
    info(`install complete: ${target}`);
    info(`next: ${PROGRAM_NAME} verify ${target}`);
  }

  function piInventoryProfile(profile) {
    const agentDir = piRoot(profile);
    const sessionDir = join(agentDir, "sessions");
    const config = readProfileFile(join(miseConfigDir, `config.${profile}.toml`));
    const wrapperPath = join(binDir, `${profile}.cmd`);
    const wrapperFile = readProfileFile(wrapperPath);
    if (!config.exists && !wrapperFile.exists) return null;
    const managed = config.regular && wrapperFile.regular &&
      hasManagedMarker(config.content) && hasManagedMarker(wrapperFile.content);
    if (!managed) warnProfile(profile, "managed evidence is incomplete or foreign");
    const contentMatches = matchesManagedContent(config.content, piConfig(profile)) &&
      matchesManagedContent(wrapperFile.content, wrapper(profile, "pi"));
    if (managed && !contentMatches) warnProfile(profile, "managed artifacts are drifted");
    const healthy = managed && contentMatches && isDirectory(agentDir) && isDirectory(sessionDir) && piRuntimeHealthy(profile);
    return {
      id: profile,
      runtime: "pi",
      agentDir: resolve(agentDir),
      sessionDir: resolve(sessionDir),
      agentkitEnabled: piAgentKitEnabled(profile),
      managed,
      healthy,
    };
  }

  function ompInventoryProfile() {
    const config = readProfileFile(join(miseConfigDir, "config.pi-omp.toml"));
    const wrapperFile = readProfileFile(join(binDir, "pi-omp.cmd"));
    if (!config.exists && !wrapperFile.exists) return null;
    const managed = config.regular && wrapperFile.regular &&
      hasManagedMarker(config.content) && hasManagedMarker(wrapperFile.content);
    if (!managed) warnProfile("pi-omp", "managed evidence is incomplete or foreign");
    const contentMatches = matchesManagedContent(config.content, ompConfig()) &&
      matchesManagedContent(wrapperFile.content, wrapper("pi-omp", "omp"));
    if (managed && !contentMatches) warnProfile("pi-omp", "managed artifacts are drifted");
    return {
      id: "pi-omp",
      runtime: "omp",
      agentDir: resolve(ompProfileRoot),
      sessionDir: null,
      agentkitEnabled: ompAgentKitEnabled(),
      managed,
      healthy: managed && contentMatches && isDirectory(ompProfileRoot) && ompRuntimeHealthy(),
    };
  }

  function listProfilesJson() {
    const profiles = [
      piInventoryProfile("pi-dev"),
      piInventoryProfile("pi-ak"),
      ompInventoryProfile(),
    ].filter(Boolean);
    output.write(`${JSON.stringify({ schemaVersion: 1, profiles })}\n`);
  }

  function installedPiProfiles() {
    const profiles = [];
    for (const profile of ["pi-dev", "pi-ak"]) {
      const config = join(miseConfigDir, `config.${profile}.toml`);
      const wrapperPath = join(binDir, `${profile}.cmd`);
      if (existsSync(config) || existsSync(wrapperPath)) {
        assertManagedFileOwned(config, `${profile} update`);
        assertManagedFileOwned(wrapperPath, `${profile} update`);
        assertPiProfileRoot(profile);
        profiles.push(profile);
      }
    }
    if (profiles.length === 0) throw new Error("no managed Pi profile found; run install pi-dev or install pi-ak first");
    return profiles;
  }

  function assertInstalledOmpProfile() {
    const config = join(miseConfigDir, "config.pi-omp.toml");
    const wrapperPath = join(binDir, "pi-omp.cmd");
    assertManagedFileOwned(config, "pi-omp update");
    assertManagedFileOwned(wrapperPath, "pi-omp update");
    assertOmpProfileRoot();
  }

  function updateTarget(target) {
    if (target === "pi") {
      installedPiProfiles();
      installPiBinary(requestedVersion);
      return;
    }
    if (target === "omp") {
      assertInstalledOmpProfile();
      installOmpBinary(requestedVersion);
      return;
    }
    if (target === "all") {
      if (requestedVersion !== "latest") throw new Error("--version cannot be combined with update all");
      installedPiProfiles();
      assertInstalledOmpProfile();
      installPiBinary("latest");
      installOmpBinary("latest");
      return;
    }
    throw new Error(`unknown update target: ${target}`);
  }

  function verifyPiProfile(profile) {
    const config = join(miseConfigDir, `config.${profile}.toml`);
    const wrapperPath = join(binDir, `${profile}.cmd`);
    assertManagedFileOwned(config, `${profile} verify`);
    assertManagedFileOwned(wrapperPath, `${profile} verify`);
    assertPiProfileRoot(profile);
    const packages = captureCommand("mise", ["-E", profile, "exec", "--", "pi", "list"]);
    for (const extension of PI_EXTENSIONS) {
      if (!packages.includes(extension)) throw new Error(`${profile} missing extension: ${extension}`);
    }
    const packageRoot = join(piRoot(profile), "npm", "node_modules").toLowerCase();
    if (!packages.toLowerCase().includes(packageRoot)) {
      throw new Error(`${profile} package list does not point to its profile root`);
    }
    if (profile === "pi-ak") {
      const manifest = join(piRoot(profile), "extensions", "agentkit-hooks-engineer", ".agentkit", "install-manifest.json");
      if (!existsSync(manifest)) throw new Error("pi-ak missing AgentKit install manifest");
    }
    info(`${profile} verification passed`);
  }

  function verifyOmpProfile() {
    const config = join(miseConfigDir, "config.pi-omp.toml");
    const wrapperPath = join(binDir, "pi-omp.cmd");
    assertManagedFileOwned(config, "pi-omp verify");
    assertManagedFileOwned(wrapperPath, "pi-omp verify");
    assertOmpProfileRoot();
    const runtimeRoot = captureCommand("mise", ["-E", "pi-omp", "exec", "--", "omp", "config", "path"]);
    if (resolve(runtimeRoot).toLowerCase() !== resolve(ompProfileRoot).toLowerCase()) {
      throw new Error(`pi-omp config path '${runtimeRoot}'; expected '${ompProfileRoot}'`);
    }
    const ownership = join(home, ".agentkit", "adapters", "omp", "engineer", "omp-ownership.json");
    if (!existsSync(ownership)) throw new Error("pi-omp missing AgentKit ownership index");
    info("pi-omp verification passed");
  }

  function verifyTarget(target) {
    requireCommand("mise");
    if (["pi-dev", "all"].includes(target)) verifyPiProfile("pi-dev");
    if (["pi-ak", "all"].includes(target)) verifyPiProfile("pi-ak");
    if (["pi-omp", "all"].includes(target)) verifyOmpProfile();
    if (!["pi-dev", "pi-ak", "pi-omp", "all"].includes(target)) throw new Error(`unknown verify target: ${target}`);
  }

  function doctor() {
    let failures = 0;
    for (const command of ["mise", "npm"]) {
      if (runner.exists(command)) info(`${command}: ${runner.find?.(command) ?? "PATH"}`);
      else {
        warn(`missing prerequisite: ${command}`);
        failures += 1;
      }
    }
    for (const command of ["pi", "omp", "ak"]) {
      if (runner.exists(command)) info(`${command}: ${runner.find?.(command) ?? "PATH"}`);
      else warn(`optional until its profile is installed: ${command}`);
    }
    const pathEntries = envValue(env, "PATH").split(delimiter).filter(Boolean).map((entry) => resolve(entry).toLowerCase());
    if (pathEntries.includes(resolve(binDir).toLowerCase())) info(`wrapper PATH configured: ${binDir}`);
    else warn(`${binDir} is not currently in PATH`);
    if (failures > 0) throw new Error(`doctor found ${failures} missing prerequisite(s)`);
    info("doctor passed");
  }

  function parseOptions(args) {
    const remaining = [...args];
    while (remaining.length > 0) {
      const option = remaining.shift();
      if (option === "--dry-run") dryRun = true;
      else if (option === "--version") {
        if (remaining.length === 0) throw new Error("--version requires a value");
        requestedVersion = remaining.shift();
        validateVersion(requestedVersion);
      } else if (["-h", "--help"].includes(option)) {
        usage();
        return "help";
      } else throw new Error(`unknown option: ${option}`);
    }
    return "ok";
  }

  function main(argv) {
    dryRun = false;
    requestedVersion = "latest";
    const args = [...argv];
    const command = args.shift();
    if (!command) {
      usage();
      throw new Error("command is required");
    }
    if (command === "bootstrap") {
      if (parseOptions(args) === "help") return;
      if (requestedVersion !== "latest") throw new Error("bootstrap does not accept --version");
      bootstrapMise();
    } else if (command === "doctor") {
      if (args.length > 0) throw new Error("doctor does not accept arguments");
      doctor();
    } else if (command === "install") {
      const target = args.shift();
      if (!target) throw new Error("install requires a profile or all");
      if (parseOptions(args) === "help") return;
      if (requestedVersion !== "latest") throw new Error("--version is supported only by update");
      installTarget(target);
    } else if (command === "update") {
      const target = args.shift();
      if (!target) throw new Error("update requires pi, omp, or all");
      if (parseOptions(args) === "help") return;
      updateTarget(target);
    } else if (command === "profiles") {
      const target = args.shift();
      if (target !== "list") throw new Error("profiles requires: list --json");
      if (args.length !== 1 || args[0] !== "--json") throw new Error("profiles list requires --json");
      listProfilesJson();
    } else if (command === "verify") {
      if (args.length > 1) throw new Error("verify accepts at most one target");
      verifyTarget(args[0] ?? "all");
    } else if (["help", "-h", "--help"].includes(command)) usage();
    else {
      usage();
      throw new Error(`unknown command: ${command}`);
    }
  }

  return { main, paths: { binDir, miseConfigDir, piProfilesDir, ompProfileRoot } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    createWindowsProfileManager().main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}
