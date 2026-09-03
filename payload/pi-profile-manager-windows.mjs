#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readSync,
  readdirSync,
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

function exactManagedFirstLine(content) {
  return String(content).replaceAll("\r\n", "\n").split("\n")[0] === `# ${MANAGED_MARKER}`;
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
export class PromptCancelledError extends Error {
  constructor() {
    super("prompt cancelled");
    this.code = "ECANCELLED";
  }
}

function defaultPrompt(outputStream, inputStream = process.stdin) {
  return function (question) {
    outputStream.write(question);
    const buf = Buffer.alloc(1024);
    let line = "";
    while (true) {
      let bytesRead = 0;
      try {
        bytesRead = inputStream.readSync ? inputStream.readSync(0, buf, 0, 1, null) : readSync(0, buf, 0, 1, null);
      } catch {
        break;
      }
      if (bytesRead === 0) break;
      const ch = buf.toString("utf8", 0, bytesRead);
      if (ch === "\n") break;
      if (ch === "\r") continue;
      line += ch;
    }
    return line.trim();
  };
}

export function promptSecretReader(inputStream, outputStream) {
  return function (question) {
    outputStream.write(question);
    if (!inputStream.isTTY) {
      return defaultPrompt(outputStream, inputStream)("");
    }
    inputStream.setRawMode(true);
    const rawBytes = [];
    const buf = Buffer.alloc(16);
    try {
      while (true) {
        let bytesRead = 0;
        try {
          bytesRead = inputStream.readSync ? inputStream.readSync(0, buf, 0, 1, null) : readSync(0, buf, 0, 1, null);
        } catch {
          break;
        }
        if (bytesRead === 0) break;
        const charCode = buf[0];
        if (charCode === 3) {
          throw new PromptCancelledError();
        }
        if (charCode === 13 || charCode === 10) {
          outputStream.write("\n");
          break;
        }
        if (charCode === 127 || charCode === 8) {
          while (rawBytes.length > 0) {
            const popped = rawBytes.pop();
            if ((popped & 0xc0) !== 0x80) break;
          }
        } else if (charCode >= 32) {
          for (let i = 0; i < bytesRead; i += 1) rawBytes.push(buf[i]);
        }
      }
    } finally {
      inputStream.setRawMode(false);
    }
    return Buffer.from(rawBytes).toString("utf8");
  };
}

function defaultPromptSecret(outputStream) {
  return promptSecretReader(process.stdin, outputStream);
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
  const prompt = options.prompt ?? defaultPrompt(output);
  const promptSecret = options.promptSecret ?? defaultPromptSecret(output);
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
    output.write(`Usage:\n  ${PROGRAM_NAME} bootstrap [--dry-run]\n  ${PROGRAM_NAME} doctor\n  ${PROGRAM_NAME} install <pi-dev|pi-ak|pi-omp|all> [--dry-run]\n  ${PROGRAM_NAME} add [name] [--auth <broker|local>] [--broker-url <url>] [--broker-token <token>] [--with-agentkit|--no-agentkit] [--dry-run]\n  ${PROGRAM_NAME} update <pi|omp|all> [--version <exact>] [--dry-run]\n  ${PROGRAM_NAME} profiles list --json\n  ${PROGRAM_NAME} verify [pi-dev|pi-ak|pi-omp|<custom>|all]\n`);
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

  function lstatPresent(path) {
    try {
      return lstatSync(path);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  function assertRegularFile(path) {
    const stat = lstatPresent(path);
    if (!stat) return null;
    if (!stat.isFile()) throw new Error(`managed target is not a regular file: ${path}`);
    return stat;
  }

  function assertManagedFileWritable(path, content) {
    assertSafeManagedPath(home, path);
    if (!assertRegularFile(path)) return;
    const existing = readFileSync(path, "utf8");
    if (existing !== content && !hasManagedMarker(existing)) {
      throw new Error(`refusing to overwrite user-owned file without managed marker: ${path}`);
    }
  }

  function assertManagedMarkerFileWritable(path) {
    assertSafeManagedPath(home, path);
    if (!assertRegularFile(path)) return;
    if (!exactManagedFirstLine(readFileSync(path, "utf8"))) {
      throw new Error(`refusing to overwrite user-owned file without managed marker: ${path}`);
    }
  }

  function assertTargetWritable(path) {
    assertSafeManagedPath(home, path);
    const stat = lstatPresent(path);
    if (stat) {
      if (!stat.isFile()) throw new Error(`managed target is not a regular file: ${path}`);
      try {
        accessSync(path, constants.W_OK);
      } catch {
        throw new Error(`managed target is not writable: ${path}`);
      }
    }
    let dir = dirname(path);
    while (!lstatPresent(dir)) {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const dirStat = lstatPresent(dir);
    if (!dirStat || !dirStat.isDirectory()) {
      throw new Error(`managed destination is not writable: ${dir}`);
    }
    try {
      accessSync(dir, constants.W_OK | constants.X_OK);
    } catch {
      throw new Error(`managed destination is not writable: ${dir}`);
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

  function hasAkSkills(root) {
    const skillsRoot = join(root, "skills");
    try {
      return readdirSync(skillsRoot, { withFileTypes: true }).some((entry) =>
        entry.isDirectory() && entry.name.startsWith("ak-") && existsSync(join(skillsRoot, entry.name, "SKILL.md")),
      );
    } catch (error) {
      if (error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  function isUnderRoot(path, root) {
    const rel = relative(resolve(root), resolve(path));
    return rel === "" || (!isAbsolute(rel) && !rel.startsWith("..") && rel !== ".." && !rel.startsWith(`..${sep}`));
  }

  function collectStrings(value, output = []) {
    if (typeof value === "string") output.push(value);
    else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, output));
    else if (value && typeof value === "object") Object.values(value).forEach((entry) => collectStrings(entry, output));
    return output;
  }

  function isOmpPathClaim(text) {
    const normalized = String(text).replaceAll("\\", "/");
    return isAbsolute(text) || normalized.includes("/.omp/") || normalized.includes(":/.omp/");
  }

  function hasWrongOmpClaims(value) {
    if (!value) return false;
    const profilesRoot = join(home, ".omp", "profiles");
    const defaultRoot = join(home, ".omp", "agent");
    for (const text of collectStrings(value)) {
      if (!isOmpPathClaim(text)) continue;
      if (isUnderRoot(text, defaultRoot) || !isUnderRoot(text, profilesRoot)) return true;
    }
    return false;
  }

  function hasTargetProfileClaim(value, root) {
    if (!value) return false;
    for (const text of collectStrings(value)) {
      if (isOmpPathClaim(text) && isUnderRoot(text, root)) return true;
    }
    return false;
  }

  function validOwnership(value) {
    return Boolean(value && value.version === 1 && value.kit === "engineer" && Array.isArray(value.claims));
  }

  function validNativePaths(value) {
    return Boolean(value && Array.isArray(value.skills));
  }

  function ompClaimsStayInProfile(root, profile = "pi-omp") {
    const ownership = readJsonObject(
      join(home, ".agentkit", "adapters", "omp", "engineer", "omp-ownership.json"),
      profile,
      "ownership",
    );
    const nativePaths = readJsonObject(
      join(home, ".agentkit", "adapters", "omp", "engineer", ".agentkit", "native-skill-paths.json"),
      profile,
      "native skill paths",
    );
    if (!validOwnership(ownership) || !validNativePaths(nativePaths)) return false;
    if (hasWrongOmpClaims(ownership) || hasWrongOmpClaims(nativePaths)) return false;
    return hasTargetProfileClaim(ownership.claims, root) && hasTargetProfileClaim(nativePaths.skills, root);
  }

  function ompAgentKitEnabled(profile = "pi-omp") {
    const root = ompRoot(profile);
    return hasAkSkills(root) && ompClaimsStayInProfile(root, profile);
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

  function ompRuntimeHealthy(profile = "pi-omp") {
    try {
      const script = [
        "const e=process['env'];",
        "process.stdout.write(JSON.stringify({root:e.AGENTKIT_OMP_HOME||'',pi:e.PI_CODING_AGENT_DIR||null}))",
      ].join("");
      const profileRoot = ompRoot(profile);
      const values = JSON.parse(captureCommand("mise", ["-E", profile, "exec", "--", "node", "-e", script]));
      if (resolve(values.root || "").toLowerCase() !== resolve(profileRoot).toLowerCase() || values.pi !== null) {
        return false;
      }
      const runtimeRoot = captureCommand("mise", ["-E", profile, "exec", "--", "omp", "config", "path"]);
      return resolve(runtimeRoot).toLowerCase() === resolve(profileRoot).toLowerCase();
    } catch {
      warnProfile(profile, "runtime environment did not resolve");
      return false;
    }
  }

  function ompRoot(profile = "pi-omp") {
    return join(home, ".omp", "profiles", profile, "agent");
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

  function ompConfig(profile = "pi-omp") {
    const profileRoot = ompRoot(profile);
    return [
      `# ${MANAGED_MARKER}`,
      "[env]",
      `OMP_PROFILE = "${profile}"`,
      `AGENTKIT_OMP_HOME = ${tomlString(profileRoot)}`,
      "PI_PROFILE = false",
      "PI_CODING_AGENT_DIR = false",
      "PI_CODING_AGENT_SESSION_DIR = false",
      "",
    ].join("\n");
  }

  function piSessionRouterScript() {
    return [
      "const { spawnSync } = require('node:child_process');",
      "const { existsSync, readdirSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "const marker = process.argv.indexOf('--');",
      "const args = marker >= 0 ? process.argv.slice(marker + 1) : process.argv.slice(1);",
      "const root = process.env.PI_CODING_AGENT_DIR || '';",
      "const profileSkills = join(root, 'skills');",
      "const projectPi = join(process.cwd(), '.pi');",
      "let hasProfileSkill = false;",
      "try {",
      "  hasProfileSkill = readdirSync(profileSkills, { withFileTypes: true }).some((entry) => entry.isDirectory() && existsSync(join(profileSkills, entry.name, 'SKILL.md')));",
      "} catch (error) {",
      "  if (!error || error.code !== 'ENOENT') throw error;",
      "}",
      "const finalArgs = (existsSync(projectPi) || hasProfileSkill)",
      "  ? ['--no-skills', '--skill', profileSkills, ...(existsSync(join(projectPi, 'skills')) ? ['--skill', join(projectPi, 'skills')] : []), ...args]",
      "  : args;",
      "const result = spawnSync('pi', finalArgs, { stdio: 'inherit', shell: false });",
      "if (result.error) { console.error(result.error.message); process.exit(1); }",
      "process.exit(result.status ?? 1);",
    ].join(" ");
  }

  function wrapper(profile, executable) {
    if (executable !== "pi") {
      return `@echo off\r\n@rem ${MANAGED_MARKER}\r\nmise -E ${profile} exec -- ${executable} %*\r\nexit /b %ERRORLEVEL%\r\n`;
    }
    const router = quoteCmdArgument(piSessionRouterScript());
    return [
      "@echo off",
      `@rem ${MANAGED_MARKER}`,
      "set __ppm_cmd=%~1",
      "if \"%__ppm_cmd%\"==\"install\" goto ppm_passthrough",
      "if \"%__ppm_cmd%\"==\"remove\" goto ppm_passthrough",
      "if \"%__ppm_cmd%\"==\"uninstall\" goto ppm_passthrough",
      "if \"%__ppm_cmd%\"==\"update\" goto ppm_passthrough",
      "if \"%__ppm_cmd%\"==\"list\" goto ppm_passthrough",
      "if \"%__ppm_cmd%\"==\"config\" goto ppm_passthrough",
      "if \"%__ppm_cmd%\"==\"auth\" goto ppm_passthrough",
      `mise -E ${profile} exec -- node -e ${router} -- %*`,
      "exit /b %ERRORLEVEL%",
      ":ppm_passthrough",
      `mise -E ${profile} exec -- pi %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
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

  function ensureOmpProfile(profile = "pi-omp") {
    const configPath = join(miseConfigDir, `config.${profile}.toml`);
    const wrapperPath = join(binDir, `${profile}.cmd`);
    const configContent = ompConfig(profile);
    const wrapperContent = wrapper(profile, "omp");
    assertManagedFileWritable(configPath, configContent);
    assertManagedFileWritable(wrapperPath, wrapperContent);
    const profileRoot = ompRoot(profile);
    if (!dryRun) {
      assertSafeManagedPath(home, profileRoot);
      mkdirSync(profileRoot, { recursive: true });
      mkdirSync(miseConfigDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
    } else {
      info(`would create profile directories: ${profileRoot}`);
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

  function assertOmpProfileRoot(profile = "pi-omp") {
    const expected = ompRoot(profile);
    if (dryRun) {
      info(`would assert ${profile} root: ${expected}`);
      return;
    }
    const script = "process.stdout.write(JSON.stringify({root:process.env.AGENTKIT_OMP_HOME||'',pi:process.env.PI_CODING_AGENT_DIR||null}))";
    const values = JSON.parse(captureCommand("mise", ["-E", profile, "exec", "--", "node", "-e", script]));
    if (resolve(values.root).toLowerCase() !== resolve(expected).toLowerCase()) {
      throw new Error(`${profile} resolved root '${values.root}'; expected '${expected}'`);
    }
    if (values.pi !== null) throw new Error(`${profile} unexpectedly inherits PI_CODING_AGENT_DIR='${values.pi}'`);
    info(`${profile} root verified: ${values.root}`);
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

  function installOmpBinary(version, profile = "pi-omp") {
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
      info(`OMP installed: ${captureCommand("mise", ["-E", profile, "exec", "--", "omp", "--version"])}`);
    }
  }

  function installPiExtensions(profile) {
    assertPiProfileRoot(profile);
    for (const extension of PI_EXTENSIONS) {
      runCommand("mise", ["-E", profile, "exec", "--", "pi", "install", extension]);
    }
  }

  function firstOmpAkSkill(profile = "pi-omp") {
    const skillsRoot = join(ompRoot(profile), "skills");
    try {
      for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
        const skill = join(skillsRoot, entry.name, "SKILL.md");
        if (entry.isDirectory() && entry.name.startsWith("ak-") && existsSync(skill)) return skill;
      }
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    return null;
  }

  function firstWrongOmpClaim(profile = "pi-omp") {
    const ownership = readJsonObject(join(home, ".agentkit", "adapters", "omp", "engineer", "omp-ownership.json"), profile, "ownership");
    const nativePaths = readJsonObject(join(home, ".agentkit", "adapters", "omp", "engineer", ".agentkit", "native-skill-paths.json"), profile, "native skill paths");
    for (const value of [ownership, nativePaths]) {
      for (const text of collectStrings(value)) {
        if (!isOmpPathClaim(text)) continue;
        if (isUnderRoot(text, join(home, ".omp", "agent")) || !isUnderRoot(text, join(home, ".omp", "profiles"))) {
          return text;
        }
      }
    }
    return null;
  }

  function assertOmpAgentKitInstalled(profile = "pi-omp") {
    const skill = firstOmpAkSkill(profile);
    const profileRoot = ompRoot(profile);
    const ownership = readJsonObject(join(home, ".agentkit", "adapters", "omp", "engineer", "omp-ownership.json"), profile, "ownership");
    const nativePaths = readJsonObject(join(home, ".agentkit", "adapters", "omp", "engineer", ".agentkit", "native-skill-paths.json"), profile, "native skill paths");
    const wrongClaim = firstWrongOmpClaim(profile);
    const missingTarget = !hasTargetProfileClaim(ownership && ownership.claims, profileRoot) ||
      !hasTargetProfileClaim(nativePaths && nativePaths.skills, profileRoot);
    if (skill && !wrongClaim && validOwnership(ownership) && validNativePaths(nativePaths) && !missingTarget) {
      return skill;
    }
    const defaultSkills = join(home, ".omp", "agent", "skills");
    const found = skill || (existsSync(defaultSkills) ? defaultSkills : "none");
    throw new Error([
      `${profile} AgentKit skills were not installed into the named OMP profile.`,
      `AGENTKIT_OMP_HOME=${profileRoot}`,
      `actual skills root found=${found}`,
      `wrong default destination=${defaultSkills}`,
      wrongClaim ? `out-of-profile claim=${wrongClaim}` : null,
      !validOwnership(ownership) ? (ownership ? "malformed AgentKit ownership metadata" : "missing AgentKit ownership metadata") : null,
      !validNativePaths(nativePaths) ? (nativePaths ? "malformed AgentKit native skill paths" : "missing AgentKit native skill paths") : null,
      !wrongClaim && missingTarget ? "missing in-profile AgentKit claim" : null,
      `repair: re-run pi-profile-manager install ${profile}`,
    ].filter(Boolean).join(" "));
  }

  function installAgentKit(profile, target) {
    requireCommand("ak");
    if (target === "pi") assertPiProfileRoot(profile);
    else assertOmpProfileRoot(profile);
    runCommand("mise", [
      "-E", profile, "exec", "--", "ak", "kit", "init", "engineer",
      "--target", target, "--global", "--channel", "beta", "--yes", "--no-interactive",
    ]);
    if (target === "omp") {
      const profileRoot = ompRoot(profile);
      if (dryRun) {
        info(`would assert AgentKit skills under: ${join(profileRoot, "skills", "ak-*", "SKILL.md")}`);
        info(`would reject default OMP AgentKit destination: ${join(home, ".omp", "agent", "skills")}`);
      } else {
        info(`${profile} AgentKit skill verified: ${assertOmpAgentKitInstalled(profile)}`);
      }
    }
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

  function ompInventoryProfile(profile = "pi-omp") {
    const config = readProfileFile(join(miseConfigDir, `config.${profile}.toml`));
    const wrapperFile = readProfileFile(join(binDir, `${profile}.cmd`));
    if (!config.exists && !wrapperFile.exists) return null;
    const profileRoot = ompRoot(profile);
    const markerPath = join(profileRoot, ".manager-profile");
    let markerOk = profile === "pi-omp";
    if (!markerOk) {
      try {
        const marker = readProfileFile(markerPath);
        markerOk = marker.exists && marker.regular && exactManagedFirstLine(marker.content);
      } catch {
        markerOk = false;
      }
    }
    const managed = config.regular && wrapperFile.regular &&
      hasManagedMarker(config.content) && hasManagedMarker(wrapperFile.content) && markerOk;
    if (!managed) warnProfile(profile, "managed evidence is incomplete or foreign");
    const contentMatches = matchesManagedContent(config.content, ompConfig(profile)) &&
      matchesManagedContent(wrapperFile.content, wrapper(profile, "omp"));
    if (managed && !contentMatches) warnProfile(profile, "managed artifacts are drifted");
    return {
      id: profile,
      runtime: "omp",
      agentDir: resolve(profileRoot),
      sessionDir: null,
      agentkitEnabled: ompAgentKitEnabled(profile),
      managed,
      healthy: managed && contentMatches && isDirectory(profileRoot) && ompRuntimeHealthy(profile),
    };
  }

  function listProfilesJson() {
    const defaultProfiles = ["pi-dev", "pi-ak", "pi-omp"];
    const discovered = new Set(defaultProfiles);
    const ompProfilesDir = join(home, ".omp", "profiles");
    if (isDirectory(ompProfilesDir)) {
      let entries = [];
      try {
        entries = readdirSync(ompProfilesDir, { withFileTypes: true });
      } catch {}
      for (const entry of entries) {
        try {
          if (!entry.isDirectory()) continue;
          const id = entry.name;
          if (defaultProfiles.includes(id)) continue;
          const markerPath = join(ompProfilesDir, id, "agent", ".manager-profile");
          const marker = readProfileFile(markerPath);
          if (marker.exists && marker.regular && exactManagedFirstLine(marker.content)) {
            discovered.add(id);
          }
        } catch {}
      }
    }
    const profilesList = [];
    const orderedProfiles = [
      ...defaultProfiles,
      ...Array.from(discovered).filter((id) => !defaultProfiles.includes(id)).sort(),
    ];
    for (const id of orderedProfiles) {
      if (id === "pi-dev" || id === "pi-ak") {
        profilesList.push(piInventoryProfile(id));
      } else {
        profilesList.push(ompInventoryProfile(id));
      }
    }
    const profiles = profilesList.filter(Boolean);
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

  function verifyOmpProfile(profile = "pi-omp") {
    const config = join(miseConfigDir, `config.${profile}.toml`);
    const wrapperPath = join(binDir, `${profile}.cmd`);
    assertManagedFileOwned(config, `${profile} verify`);
    assertManagedFileOwned(wrapperPath, `${profile} verify`);
    assertOmpProfileRoot(profile);
    const profileRoot = ompRoot(profile);
    const runtimeRoot = captureCommand("mise", ["-E", profile, "exec", "--", "omp", "config", "path"]);
    if (resolve(runtimeRoot).toLowerCase() !== resolve(profileRoot).toLowerCase()) {
      throw new Error(`${profile} config path '${runtimeRoot}'; expected '${profileRoot}'`);
    }
    const skillsRoot = join(profileRoot, "skills");
    const marker = join(profileRoot, ".agentkit-profile");
    if (profile === "pi-omp" || existsSync(marker)) {
      assertOmpAgentKitInstalled(profile);
    } else if (existsSync(skillsRoot)) {
      try {
        const hasSkills = readdirSync(skillsRoot, { withFileTypes: true }).some(
          (e) => e.isDirectory() && e.name.startsWith("ak-") && existsSync(join(skillsRoot, e.name, "SKILL.md")),
        );
        if (hasSkills) assertOmpAgentKitInstalled(profile);
      } catch {}
    }
    info(`${profile} verification passed`);
  }

  function verifyTarget(target) {
    requireCommand("mise");
    if (["pi-dev", "all"].includes(target)) verifyPiProfile("pi-dev");
    if (["pi-ak", "all"].includes(target)) verifyPiProfile("pi-ak");
    if (["pi-omp", "all"].includes(target)) verifyOmpProfile("pi-omp");
    if (["pi-dev", "pi-ak", "pi-omp", "all"].includes(target)) return;

    validateProfileName(target);
    const config = join(miseConfigDir, `config.${target}.toml`);
    const wrapperPath = join(binDir, `${target}.cmd`);
    if (existsSync(config) || existsSync(wrapperPath)) {
      if (existsSync(config)) {
        const content = readFileSync(config, "utf8");
        if (content.includes("OMP_PROFILE =")) {
          verifyOmpProfile(target);
          return;
        }
        if (content.includes('PI_CODING_AGENT_DIR = "')) {
          verifyPiProfile(target);
          return;
        }
      }
      verifyOmpProfile(target);
      return;
    }
    throw new Error(`unknown verify target: ${target}`);
  }

  function validateEnvValue(label, value) {
    if (value.includes("\r") || value.includes("\n")) {
      throw new Error(`${label} cannot contain newline or carriage return`);
    }
  }

  function brokerEnvContent(url, token) {
    return [
      `# ${MANAGED_MARKER}`,
      `OMP_AUTH_BROKER_URL=${url}`,
      `OMP_AUTH_BROKER_TOKEN=${token}`,
      "",
    ].join("\n");
  }

  function writeBrokerEnv(profile, url, token) {
    validateEnvValue("OMP_AUTH_BROKER_URL", url);
    validateEnvValue("OMP_AUTH_BROKER_TOKEN", token);
    const profileRoot = ompRoot(profile);
    const envPath = join(profileRoot, ".env");
    assertSafeManagedPath(home, envPath);

    if (assertRegularFile(envPath)) {
      const existing = readFileSync(envPath, "utf8");
      if (!hasManagedMarker(existing)) {
        throw new Error(`refusing to overwrite user-owned file without managed marker: ${envPath}`);
      }
    }

    if (dryRun) {
      info(`would write: ${envPath} (token redacted)`);
      return;
    }

    mkdirSync(profileRoot, { recursive: true });
    const staged = `${envPath}.tmp-${uniqueSuffix()}`;
    try {
      writeFileSync(staged, brokerEnvContent(url, token), { mode: 0o600, flag: "wx" });
      renameSync(staged, envPath);
    } finally {
      if (existsSync(staged)) rmSync(staged, { force: true });
    }
    info(`wrote: ${envPath}`);
  }

  function validateProfileName(name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error(`invalid profile name: ${name}`);
    const lower = name.toLowerCase();
    const reserved = [
      "all", "pi", "omp", "doctor", "update", "install", "verify", "bootstrap", "add", "list", "profiles", "profile", "help",
      "pi-dev", "pi-ak", "pi-omp",
      "con", "prn", "aux", "nul",
      "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
      "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    if (reserved.includes(lower)) {
      throw new Error(`reserved profile name: ${name}`);
    }
  }

  function cmdAdd(args) {
    let profileName = "";
    let authType = "";
    let brokerUrl = "";
    let brokerToken = "";
    let withAgentkit = null;
    let interactive = false;

    let index = 0;
    while (index < args.length) {
      const arg = args[index];
      if (arg === "--auth") {
        if (index + 1 >= args.length) throw new Error("--auth requires a value (broker or local)");
        authType = args[index + 1];
        index += 2;
      } else if (arg === "--broker-url") {
        if (index + 1 >= args.length) throw new Error("--broker-url requires a value");
        brokerUrl = args[index + 1];
        index += 2;
      } else if (arg === "--broker-token") {
        if (index + 1 >= args.length) throw new Error("--broker-token requires a value");
        brokerToken = args[index + 1];
        index += 2;
      } else if (arg === "--with-agentkit") {
        withAgentkit = true;
        index++;
      } else if (arg === "--no-agentkit") {
        withAgentkit = false;
        index++;
      } else if (arg === "--dry-run") {
        dryRun = true;
        index++;
      } else if (["-h", "--help"].includes(arg)) {
        usage();
        return;
      } else if (arg.startsWith("-")) {
        throw new Error(`unknown option: ${arg}`);
      } else {
        if (!profileName) {
          profileName = arg;
          index++;
        } else {
          throw new Error(`unexpected argument: ${arg}`);
        }
      }
    }

    if (!profileName) {
      interactive = true;
      profileName = prompt("Profile name: ");
    }
    if (!profileName) throw new Error("add requires a profile name");
    validateProfileName(profileName);

    if (!authType) {
      interactive = true;
      output.write("Select authentication mode:\n");
      output.write("  1) OMP Auth Broker (OMP_AUTH_BROKER_URL + OMP_AUTH_BROKER_TOKEN)\n");
      output.write("  2) Local (standalone credentials / agent.db)\n");
      const choice = prompt("Choice [1-2]: ");
      if (["1", "broker", "omp auth broker", "auth broker"].includes(choice.toLowerCase())) {
        authType = "broker";
      } else if (["2", "local"].includes(choice.toLowerCase())) {
        authType = "local";
      } else {
        throw new Error(`invalid authentication choice: ${choice}`);
      }
    }

    if (!["broker", "local"].includes(authType.toLowerCase())) {
      throw new Error(`invalid auth type: ${authType} (expected 'broker' or 'local')`);
    }
    authType = authType.toLowerCase();

    if (authType === "broker") {
      if (!brokerUrl) {
        interactive = true;
        brokerUrl = prompt("Enter OMP_AUTH_BROKER_URL: ");
      }
      if (!brokerUrl) throw new Error("--broker-url is required when using broker authentication");
      validateEnvValue("OMP_AUTH_BROKER_URL", brokerUrl);

      if (!brokerToken) {
        interactive = true;
        brokerToken = promptSecret("Enter OMP_AUTH_BROKER_TOKEN: ");
      }
      if (!brokerToken) throw new Error("--broker-token is required when using broker authentication");
      validateEnvValue("OMP_AUTH_BROKER_TOKEN", brokerToken);
    }

    if (withAgentkit === null) {
      if (interactive) {
        const akChoice = prompt("Install AgentKit into this profile? [y/N]: ");
        withAgentkit = ["y", "yes"].includes(akChoice.toLowerCase());
      } else {
        withAgentkit = false;
      }
    }

    requireCommand("mise");
    if (withAgentkit) requireCommand("ak");

    const configPath = join(miseConfigDir, `config.${profileName}.toml`);
    const wrapperPath = join(binDir, `${profileName}.cmd`);
    const profileRoot = ompRoot(profileName);
    const envPath = join(profileRoot, ".env");
    const markerPath = join(profileRoot, ".manager-profile");
    const akMarkerPath = join(profileRoot, ".agentkit-profile");

    assertManagedFileWritable(configPath, ompConfig(profileName));
    assertManagedFileWritable(wrapperPath, wrapper(profileName, "omp"));

    const envStat = lstatPresent(envPath);
    if (envStat) {
      if (!envStat.isFile()) throw new Error(`managed target is not a regular file: ${envPath}`);
      const existing = readFileSync(envPath, "utf8");
      if (!hasManagedMarker(existing) && !exactManagedFirstLine(existing)) {
        if (authType === "broker") {
          throw new Error(`refusing to overwrite user-owned file without managed marker: ${envPath}`);
        } else {
          throw new Error(`refusing to remove user-owned file without managed marker: ${envPath}`);
        }
      }
    }

    assertManagedMarkerFileWritable(markerPath);
    if (withAgentkit) assertManagedMarkerFileWritable(akMarkerPath);
    assertTargetWritable(configPath);
    assertTargetWritable(wrapperPath);
    assertTargetWritable(markerPath);
    if (authType === "broker" || envStat) assertTargetWritable(envPath);
    if (withAgentkit) assertTargetWritable(akMarkerPath);

    ensureOmpProfile(profileName);
    assertOmpProfileRoot(profileName);
    if (!dryRun) {
      writeManagedFile(markerPath, `# ${MANAGED_MARKER}\n`);
    }

    if (authType === "broker") {
      writeBrokerEnv(profileName, brokerUrl, brokerToken);
    } else if (envStat) {
      if (dryRun) {
        info(`would remove broker env: ${envPath}`);
      } else {
        rmSync(envPath, { force: true });
        info(`removed broker env: ${envPath}`);
      }
    }

    if (dryRun) {
      info(`would verify or install OMP runtime for ${profileName}`);
      if (withAgentkit) {
        info(`would install AgentKit for ${profileName}`);
        writeManagedFile(akMarkerPath, `# ${MANAGED_MARKER}\n`);
      }
    } else {
      if (runner.exists("omp")) {
        try {
          info(`OMP verified: ${captureCommand("mise", ["-E", profileName, "exec", "--", "omp", "--version"])}`);
        } catch {
          throw new Error(`failed to verify existing OMP in ${profileName}: omp --version failed`);
        }
      } else {
        installOmpBinary("latest", profileName);
      }
      if (withAgentkit) {
        installAgentKit(profileName, "omp");
        writeManagedFile(akMarkerPath, `# ${MANAGED_MARKER}\n`);
      }
    }

    info(`profile ready: ${profileName} (${authType})`);
    info(`run: ${profileName}`);
    if (authType === "broker") {
      info(`verify connection: ${profileName} auth-broker status`);
    }
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
    } else if (command === "add") {
      cmdAdd(args);
    } else if (["profiles", "profile"].includes(command)) {
      const target = args.shift();
      if (target === "list") {
        if (args.length !== 1 || args[0] !== "--json") throw new Error(`${command} list requires --json`);
        listProfilesJson();
      } else if (target === "add") {
        cmdAdd(args);
      } else {
        throw new Error(`${command} requires: list --json or add`);
      }
    } else if (command === "list") {
      if (args.length !== 1 || args[0] !== "--json") throw new Error("list requires --json");
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
    if (error.code === "ECANCELLED") {
      process.exitCode = 130;
    } else {
      process.stderr.write(`ERROR: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
