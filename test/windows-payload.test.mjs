import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createWindowsProfileManager } from "../payload/pi-profile-manager-windows.mjs";

const EXTENSIONS = [
  "npm:statusline-pi@1.2.1",
  "npm:advisor-pi@1.0.3",
  "npm:grok-pi@1.2.0",
  "npm:model-debugger@1.0.2",
  "npm:@tintinweb/pi-subagents@0.18.0",
];

function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `ppm-windows-payload-${name}-`));
  const home = join(root, "User Home");
  mkdirSync(home, { recursive: true });
  const calls = [];
  const commands = new Set(["mise", "npm", "ak"]);
  let wrongPiRoot = false;
  let wrongOmpRoot = false;

  const piRoot = (profile) => join(home, ".pi", "profiles", profile);
  const ompRoot = join(home, ".omp", "profiles", "pi-omp", "agent");
  const runner = {
    exists(command) {
      return commands.has(command);
    },
    find(command) {
      return commands.has(command) ? join(root, "fake-bin", `${command}.exe`) : null;
    },
    run(command, args, childEnv) {
      calls.push({ kind: "run", command, args: [...args], env: { ...childEnv } });
      if (command === "winget") commands.add("mise");
      if (command === "npm" && args[0] === "install") commands.add("pi");
      if (command === "mise" && args.includes("omp") && args.includes("--version")) commands.add("omp");
      if (command === "mise" && args.includes("ak") && args.includes("init")) {
        const target = args[args.indexOf("--target") + 1];
        if (target === "pi") {
          const profile = args[1];
          const manifest = join(piRoot(profile), "extensions", "agentkit-hooks-engineer", ".agentkit", "install-manifest.json");
          mkdirSync(join(manifest, ".."), { recursive: true });
          writeFileSync(manifest, "{}\n");
        } else {
          const ownership = join(home, ".agentkit", "adapters", "omp", "engineer", "omp-ownership.json");
          mkdirSync(join(ownership, ".."), { recursive: true });
          writeFileSync(ownership, "{}\n");
        }
      }
    },
    capture(command, args, childEnv) {
      calls.push({ kind: "capture", command, args: [...args], env: { ...childEnv } });
      if (command === "mise" && args.length === 1 && args[0] === "--version") return "mise 2026.8.14";
      if (command === "mise" && args[0] === "latest") return "18.0.4";
      if (command === "pi" && args[0] === "--version") return "0.84.3";
      if (command === "mise" && args.includes("node") && args.includes("-e")) {
        const profile = args[1];
        if (profile === "pi-omp") {
          return JSON.stringify({
            root: wrongOmpRoot ? join(home, ".omp", "agent") : ompRoot,
            pi: null,
          });
        }
        return wrongPiRoot ? join(home, ".pi", "agent") : piRoot(profile);
      }
      if (command === "mise" && args.includes("omp") && args.includes("--version")) return "omp/18.0.4";
      if (command === "mise" && args.includes("pi") && args.includes("list")) {
        const profile = args[1];
        return [
          ...EXTENSIONS,
          join(piRoot(profile), "npm", "node_modules"),
        ].join("\n");
      }
      if (command === "mise" && args.includes("omp") && args.includes("config")) return ompRoot;
      throw new Error(`unexpected capture: ${command} ${args.join(" ")}`);
    },
  };

  const stdout = [];
  const stderr = [];
  const manager = createWindowsProfileManager({
    home,
    env: {
      USERPROFILE: home,
      LOCALAPPDATA: join(root, "Local AppData"),
      PATH: [join(home, "bin"), join(root, "fake-bin")].join(delimiter),
    },
    runner,
    output: { write: (value) => stdout.push(value) },
    errorOutput: { write: (value) => stderr.push(value) },
  });
  return {
    root,
    home,
    calls,
    commands,
    manager,
    stdout,
    stderr,
    setWrongPiRoot(value) { wrongPiRoot = value; },
    setWrongOmpRoot(value) { wrongOmpRoot = value; },
  };
}

test("Windows runtime rejects unsupported architecture before mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "ppm-windows-arch-"));
  const home = join(root, "User Home");
  mkdirSync(home, { recursive: true });
  assert.throws(
    () => createWindowsProfileManager({ home, env: { USERPROFILE: home }, platform: "win32", arch: "arm64" }),
    /only x64 is supported/,
  );
});

test("Windows bootstrap dry-run has zero command invocation", () => {
  const fx = fixture("bootstrap-dry-run");
  fx.commands.delete("mise");
  fx.commands.add("winget");
  fx.manager.main(["bootstrap", "--dry-run"]);
  assert.equal(fx.calls.length, 0);
  assert.match(fx.stdout.join(""), /would install Mise with winget package: jdx\.mise/);
});

test("Windows bootstrap uses exact winget package and verifies Mise", () => {
  const fx = fixture("bootstrap-winget");
  fx.commands.delete("mise");
  fx.commands.add("winget");
  fx.manager.main(["bootstrap"]);
  assert.deepEqual(fx.calls[0].args, [
    "install", "--id", "jdx.mise", "--exact", "--source", "winget",
    "--accept-package-agreements", "--accept-source-agreements",
  ]);
  assert.equal(fx.calls.at(-1).kind, "capture");
  assert.deepEqual(fx.calls.at(-1).args, ["--version"]);
});

test("Windows existing Mise is an idempotent no-op", () => {
  const fx = fixture("bootstrap-existing");
  fx.manager.main(["bootstrap"]);
  assert.equal(fx.calls.length, 1);
  assert.deepEqual(fx.calls[0].args, ["--version"]);
  assert.doesNotMatch(fx.stdout.join(""), /winget install/);
});

test("Windows install all creates isolated configs and wrappers", () => {
  const fx = fixture("install-all");
  fx.manager.main(["install", "all"]);
  for (const profile of ["pi-dev", "pi-ak", "pi-omp"]) {
    const config = join(fx.home, ".config", "mise", `config.${profile}.toml`);
    const wrapper = join(fx.home, "bin", `${profile}.cmd`);
    assert.ok(existsSync(config), config);
    assert.ok(existsSync(wrapper), wrapper);
    assert.match(readFileSync(wrapper, "utf8"), new RegExp(`mise -E ${profile} exec --`));
  }
  assert.match(
    readFileSync(join(fx.home, ".config", "mise", "config.pi-dev.toml"), "utf8"),
    /PI_CODING_AGENT_DIR/,
  );
  const extensionCalls = fx.calls.filter((entry) => entry.kind === "run" && entry.args.includes("install") && entry.args.includes("pi"));
  assert.equal(extensionCalls.length, 10);
  assert.ok(fx.calls.some((entry) => entry.args.includes("pi") && entry.args.includes("--target")));
  assert.ok(fx.calls.some((entry) => entry.args.includes("omp") && entry.args.includes("--target")));
});

test("Windows profile install refuses user-owned wrapper and config", () => {
  const fx = fixture("foreign-profile-files");
  const config = join(fx.home, ".config", "mise", "config.pi-dev.toml");
  const wrapper = join(fx.home, "bin", "pi-dev.cmd");
  mkdirSync(join(config, ".."), { recursive: true });
  mkdirSync(join(wrapper, ".."), { recursive: true });
  writeFileSync(config, "[env]\nUSER_SETTING = true\n");
  writeFileSync(wrapper, "@echo user-owned\r\n");
  assert.throws(() => fx.manager.main(["install", "pi-dev"]), /refusing to overwrite user-owned file/);
  assert.equal(readFileSync(config, "utf8"), "[env]\nUSER_SETTING = true\n");
  assert.equal(readFileSync(wrapper, "utf8"), "@echo user-owned\r\n");
});

test("Windows profile preflight leaves config absent when wrapper is user-owned", () => {
  const fx = fixture("foreign-wrapper-only");
  const config = join(fx.home, ".config", "mise", "config.pi-dev.toml");
  const wrapper = join(fx.home, "bin", "pi-dev.cmd");
  mkdirSync(join(wrapper, ".."), { recursive: true });
  writeFileSync(wrapper, "@echo user-owned\r\n");
  assert.throws(() => fx.manager.main(["install", "pi-dev"]), /refusing to overwrite user-owned file/);
  assert.equal(existsSync(config), false);
  assert.equal(readFileSync(wrapper, "utf8"), "@echo user-owned\r\n");
});

test("Windows install all preflights every profile before writing any artifact", () => {
  const fx = fixture("foreign-late-profile");
  const foreignWrapper = join(fx.home, "bin", "pi-omp.cmd");
  mkdirSync(join(foreignWrapper, ".."), { recursive: true });
  writeFileSync(foreignWrapper, "@echo user-owned\r\n");
  assert.throws(() => fx.manager.main(["install", "all"]), /refusing to overwrite user-owned file/);
  assert.equal(existsSync(join(fx.home, ".config", "mise", "config.pi-dev.toml")), false);
  assert.equal(existsSync(join(fx.home, "bin", "pi-dev.cmd")), false);
});

test("Windows doctor accepts canonical Path key", () => {
  const root = mkdtempSync(join(tmpdir(), "ppm-windows-path-key-"));
  const home = join(root, "User Home");
  mkdirSync(home, { recursive: true });
  const bin = join(home, "bin");
  const output = [];
  const runner = {
    exists: (command) => ["mise", "npm"].includes(command),
    find: (command) => join(root, `${command}.exe`),
  };
  const manager = createWindowsProfileManager({
    home,
    env: { USERPROFILE: home, Path: bin },
    runner,
    output: { write: (value) => output.push(value) },
    errorOutput: { write: () => {} },
  });
  manager.main(["doctor"]);
  assert.match(output.join(""), /wrapper PATH configured/);
});

test("Windows wrong Pi root stops before npm and AgentKit mutation", () => {
  const fx = fixture("wrong-pi-root");
  fx.setWrongPiRoot(true);
  assert.throws(() => fx.manager.main(["install", "pi-ak"]), /resolved root/);
  assert.equal(fx.calls.some((entry) => entry.command === "npm"), false);
  assert.equal(fx.calls.some((entry) => entry.args.includes("ak")), false);
});

test("Windows wrong OMP root stops before binary and AgentKit mutation", () => {
  const fx = fixture("wrong-omp-root");
  fx.setWrongOmpRoot(true);
  assert.throws(() => fx.manager.main(["install", "pi-omp"]), /resolved root/);
  assert.equal(fx.calls.some((entry) => entry.args[0] === "use"), false);
  assert.equal(fx.calls.some((entry) => entry.args.includes("ak")), false);
});

test("Windows install and verify all preserve profile ownership", () => {
  const fx = fixture("verify-all");
  fx.manager.main(["install", "all"]);
  fx.calls.length = 0;
  fx.manager.main(["verify", "all"]);
  assert.match(fx.stdout.join(""), /pi-dev verification passed/);
  assert.match(fx.stdout.join(""), /pi-ak verification passed/);
  assert.match(fx.stdout.join(""), /pi-omp verification passed/);
});

test("Windows update refuses profiles that were not installed", () => {
  const fx = fixture("update-guard");
  assert.throws(() => fx.manager.main(["update", "pi", "--version", "0.84.3"]), /no managed Pi profile/);
  assert.equal(fx.calls.some((entry) => entry.command === "npm"), false);
});

test("Windows update refuses user-owned profile files", () => {
  const fx = fixture("update-foreign-profile");
  const config = join(fx.home, ".config", "mise", "config.pi-ak.toml");
  const wrapper = join(fx.home, "bin", "pi-ak.cmd");
  mkdirSync(join(config, ".."), { recursive: true });
  mkdirSync(join(wrapper, ".."), { recursive: true });
  writeFileSync(config, "[env]\nPI_CODING_AGENT_DIR = 'user-owned'\n");
  writeFileSync(wrapper, "@echo user-owned\r\n");
  assert.throws(
    () => fx.manager.main(["update", "pi", "--version", "0.84.3"]),
    /refuses user-owned file without managed marker/,
  );
  assert.equal(fx.calls.some((entry) => entry.command === "npm"), false);
});

test("Windows verify refuses user-owned profile files", () => {
  const fx = fixture("verify-foreign-profile");
  const config = join(fx.home, ".config", "mise", "config.pi-omp.toml");
  const wrapper = join(fx.home, "bin", "pi-omp.cmd");
  mkdirSync(join(config, ".."), { recursive: true });
  mkdirSync(join(wrapper, ".."), { recursive: true });
  writeFileSync(config, "[env]\nOMP_PROFILE = 'user-owned'\n");
  writeFileSync(wrapper, "@echo user-owned\r\n");
  assert.throws(
    () => fx.manager.main(["verify", "pi-omp"]),
    /refuses user-owned file without managed marker/,
  );
  assert.equal(fx.calls.length, 0);
});
