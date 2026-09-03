import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";
import test from "node:test";
import {
  PromptCancelledError,
  buildCmdInvocation,
  createWindowsProfileManager,
  promptSecretReader,
} from "../payload/pi-profile-manager-windows.mjs";

const EXTENSIONS = [
  "npm:statusline-pi@1.2.1",
  "npm:advisor-pi@1.0.3",
  "npm:grok-pi@1.2.0",
  "npm:model-debugger@1.0.2",
  "npm:@tintinweb/pi-subagents@0.18.0",
];

test("Windows cmd invocation handles spaces and percent signs", () => {
  assert.equal(
    buildCmdInvocation("C:\\User Home\\pi-profile-manager.cmd", ["--label", "100%"]),
    'call "C:\\User Home\\pi-profile-manager.cmd" "--label" "100%%"',
  );
});

function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `ppm-windows-payload-${name}-`));
  const home = join(root, "User Home");
  mkdirSync(home, { recursive: true });
  const calls = [];
  const commands = new Set(["mise", "npm", "ak"]);
  let wrongPiRoot = false;
  let wrongOmpRoot = false;
  let ompAkDest = "profile";
  let failOmpVersion = false;

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
      if (command === "mise" && args.includes("use") && args.some((a) => a.includes("oh-my-pi"))) commands.add("omp");
      if (command === "mise" && args.includes("ak") && args.includes("init")) {
        const target = args[args.indexOf("--target") + 1];
        if (target === "pi") {
          const profile = args[1];
          const manifest = join(piRoot(profile), "extensions", "agentkit-hooks-engineer", ".agentkit", "install-manifest.json");
          mkdirSync(join(manifest, ".."), { recursive: true });
          writeFileSync(manifest, '{"version":1,"kit":"engineer","files":["AGENTS.md"]}\n');
        } else {
          const profile = args[1];
          const profileRoot = join(home, ".omp", "profiles", profile, "agent");
          const adapterRoot = join(home, ".agentkit", "adapters", "omp", "engineer");
          const skillRoot = ompAkDest === "default" ? join(home, ".omp", "agent", "skills") : join(profileRoot, "skills");
          mkdirSync(join(skillRoot, "ak-cook"), { recursive: true });
          writeFileSync(join(skillRoot, "ak-cook", "SKILL.md"), "---\nname: ak-cook\ndescription: fake AgentKit cook skill\n---\n");
          mkdirSync(join(adapterRoot, ".agentkit"), { recursive: true });
          const ownershipPath = join(adapterRoot, "omp-ownership.json");
          const nativePath = join(adapterRoot, ".agentkit", "native-skill-paths.json");
          const skillFile = join(skillRoot, "ak-cook", "SKILL.md");
          let ownership = { version: 1, kit: "engineer", claims: [] };
          try { ownership = JSON.parse(readFileSync(ownershipPath, "utf8")); } catch {}
          if (!Array.isArray(ownership.claims)) ownership.claims = [];
          if (!ownership.claims.includes(skillRoot)) ownership.claims.push(skillRoot);
          ownership.version = 1;
          ownership.kit = "engineer";
          writeFileSync(ownershipPath, JSON.stringify(ownership));
          let native = { skills: [] };
          try { native = JSON.parse(readFileSync(nativePath, "utf8")); } catch {}
          if (!Array.isArray(native.skills)) native.skills = [];
          if (!native.skills.includes(skillFile)) native.skills.push(skillFile);
          writeFileSync(nativePath, JSON.stringify(native));
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
        const script = args.at(-1);
        if (profile === "pi-omp" || !profile.startsWith("pi-")) {
          const targetRoot = join(home, ".omp", "profiles", profile, "agent");
          return JSON.stringify({
            root: wrongOmpRoot ? join(home, ".omp", "agent") : targetRoot,
            pi: null,
          });
        }
        const root = wrongPiRoot ? join(home, ".pi", "agent") : piRoot(profile);
        return script.includes("JSON.stringify")
          ? JSON.stringify({ root, session: join(piRoot(profile), "sessions") })
          : root;
      }
      if (command === "mise" && args.includes("omp") && args.includes("--version")) {
        if (failOmpVersion) throw new Error("omp --version failed");
        return "omp/18.0.4";
      }
      if (command === "mise" && args.includes("pi") && args.includes("list")) {
        const profile = args[1];
        return [
          ...EXTENSIONS,
          join(piRoot(profile), "npm", "node_modules"),
        ].join("\n");
      }
      if (command === "mise" && args.includes("omp") && args.includes("config")) {
        const profile = args[1];
        return join(home, ".omp", "profiles", profile, "agent");
      }
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
    runner,
    calls,
    commands,
    manager,
    stdout,
    stderr,
    setWrongPiRoot(value) { wrongPiRoot = value; },
    setWrongOmpRoot(value) { wrongOmpRoot = value; },
    setOmpAkDest(value) { ompAkDest = value; },
    setFailOmpVersion(value) { failOmpVersion = value; },
  };
}

function readInventory(fx) {
  fx.stdout.length = 0;
  fx.stderr.length = 0;
  fx.manager.main(["profiles", "list", "--json"]);
  return JSON.parse(fx.stdout.join(""));
}

test("Windows profile inventory returns stable schema for an empty installation", () => {
  const fx = fixture("inventory-empty");
  const inventory = readInventory(fx);
  assert.deepEqual(inventory, { schemaVersion: 1, profiles: [] });
  assert.equal(fx.stderr.join(""), "");
  assert.equal(fx.stdout.join(""), `${JSON.stringify(inventory)}\n`);
});

test("Windows profile inventory reports a healthy pi-dev profile", () => {
  const fx = fixture("inventory-pi-dev");
  fx.manager.main(["install", "pi-dev"]);
  const inventory = readInventory(fx);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.profiles.length, 1);
  assert.deepEqual(inventory.profiles[0], {
    id: "pi-dev",
    runtime: "pi",
    agentDir: join(fx.home, ".pi", "profiles", "pi-dev"),
    sessionDir: join(fx.home, ".pi", "profiles", "pi-dev", "sessions"),
    agentkitEnabled: false,
    managed: true,
    healthy: true,
  });
  assert.ok(isAbsolute(inventory.profiles[0].agentDir));
  assert.ok(inventory.profiles[0].agentDir.includes(sep));
  assert.equal(fx.stderr.join(""), "");
  assert.doesNotMatch(fx.stdout.join(""), /INFO:|WARN:|RUN:/);
});

test("Windows profile inventory detects AgentKit for pi-ak", () => {
  const fx = fixture("inventory-pi-ak");
  fx.manager.main(["install", "pi-ak"]);
  const inventory = readInventory(fx);
  assert.equal(inventory.profiles.length, 1);
  assert.equal(inventory.profiles[0].id, "pi-ak");
  assert.equal(inventory.profiles[0].agentkitEnabled, true);
  assert.equal(inventory.profiles[0].managed, true);
  assert.equal(inventory.profiles[0].healthy, true);
});

test("Windows profile inventory detects AgentKit for pi-omp", () => {
  const fx = fixture("inventory-pi-omp");
  fx.manager.main(["install", "pi-omp"]);
  const inventory = readInventory(fx);
  assert.equal(inventory.profiles.length, 1);
  assert.equal(inventory.profiles[0].id, "pi-omp");
  assert.equal(inventory.profiles[0].runtime, "omp");
  assert.equal(inventory.profiles[0].sessionDir, null);
  assert.equal(inventory.profiles[0].agentkitEnabled, true);
  assert.equal(inventory.profiles[0].managed, true);
  assert.equal(inventory.profiles[0].healthy, true);
});

test("Windows pi-omp AgentKit install fails closed when ak writes default OMP destination", () => {
  const fx = fixture("pi-omp-ak-default-dest");
  fx.setOmpAkDest("default");
  assert.throws(() => fx.manager.main(["install", "pi-omp"]), /not installed into the named OMP profile/);
  assert.equal(existsSync(join(fx.home, ".omp", "agent", "skills", "ak-cook", "SKILL.md")), true);
});

test("Windows pi-omp inventory and verify reject ownership without profile skills", () => {
  const fx = fixture("pi-omp-ak-missing-skills");
  fx.manager.main(["install", "pi-omp"]);
  rmSync(join(fx.home, ".omp", "profiles", "pi-omp", "agent", "skills"), { recursive: true, force: true });
  const inventory = readInventory(fx);
  assert.equal(inventory.profiles[0].agentkitEnabled, false);
  assert.throws(() => fx.manager.main(["verify", "pi-omp"]), /not installed into the named OMP profile/);
});

test("Windows pi-omp inventory and verify reject default OMP native skill claims", () => {
  const fx = fixture("pi-omp-ak-wrong-claim");
  fx.manager.main(["install", "pi-omp"]);
  const nativePaths = join(fx.home, ".agentkit", "adapters", "omp", "engineer", ".agentkit", "native-skill-paths.json");
  writeFileSync(nativePaths, JSON.stringify({ skills: [join(fx.home, ".omp", "agent", "skills", "ak-cook", "SKILL.md")] }));
  const inventory = readInventory(fx);
  assert.equal(inventory.profiles[0].agentkitEnabled, false);
  assert.throws(() => fx.manager.main(["verify", "pi-omp"]), /out-of-profile claim/);
});

test("Windows profile inventory accepts exactly one legacy extra newline", () => {
  const fx = fixture("inventory-legacy-newline");
  fx.manager.main(["install", "all"]);
  const artifacts = [
    join(fx.home, ".config", "mise", "config.pi-dev.toml"),
    join(fx.home, "bin", "pi-dev.cmd"),
    join(fx.home, ".config", "mise", "config.pi-ak.toml"),
    join(fx.home, "bin", "pi-ak.cmd"),
    join(fx.home, ".config", "mise", "config.pi-omp.toml"),
    join(fx.home, "bin", "pi-omp.cmd"),
  ];
  for (const artifact of artifacts) {
    const content = readFileSync(artifact, "utf8");
    writeFileSync(artifact, `${content}${content.endsWith("\r\n") ? "\r\n" : "\n"}`);
  }
  const inventory = readInventory(fx);
  assert.equal(inventory.profiles.length, 3);
  assert.equal(inventory.profiles.every((profile) => profile.managed), true);
  assert.equal(inventory.profiles.every((profile) => profile.healthy), true);
  assert.equal(fx.stderr.join(""), "");
});

test("Windows profile inventory rejects more than one extra newline", () => {
  const fx = fixture("inventory-extra-newlines");
  fx.manager.main(["install", "pi-dev"]);
  const wrapper = join(fx.home, "bin", "pi-dev.cmd");
  writeFileSync(wrapper, `${readFileSync(wrapper, "utf8")}\r\n\r\n`);
  const inventory = readInventory(fx);
  assert.equal(inventory.profiles[0].managed, true);
  assert.equal(inventory.profiles[0].healthy, false);
  assert.match(fx.stderr.join(""), /pi-dev managed artifacts are drifted/);
});

test("Windows profile inventory keeps managed drift visible but unhealthy", () => {
  const fx = fixture("inventory-drift");
  fx.manager.main(["install", "pi-dev"]);
  const config = join(fx.home, ".config", "mise", "config.pi-dev.toml");
  writeFileSync(config, `${readFileSync(config, "utf8")}# drift\n`);
  const inventory = readInventory(fx);
  assert.equal(inventory.profiles[0].managed, true);
  assert.equal(inventory.profiles[0].healthy, false);
  assert.match(fx.stderr.join(""), /pi-dev managed artifacts are drifted/);
  assert.equal(fx.stderr.join("").includes(fx.home), false);
});

test("Windows profile inventory reports foreign fixed artifacts as unmanaged", () => {
  const fx = fixture("inventory-foreign");
  const config = join(fx.home, ".config", "mise", "config.pi-ak.toml");
  const wrapper = join(fx.home, "bin", "pi-ak.cmd");
  mkdirSync(join(config, ".."), { recursive: true });
  mkdirSync(join(wrapper, ".."), { recursive: true });
  writeFileSync(config, "[env]\nPI_CODING_AGENT_DIR = 'foreign'\n");
  writeFileSync(wrapper, "@echo user-owned\r\n");
  const inventory = readInventory(fx);
  assert.equal(inventory.profiles[0].id, "pi-ak");
  assert.equal(inventory.profiles[0].managed, false);
  assert.equal(inventory.profiles[0].healthy, false);
  assert.match(fx.stderr.join(""), /pi-ak managed evidence is incomplete or foreign/);
  assert.equal(fx.stderr.join("").includes(fx.home), false);
});

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
  const piAkWrapper = readFileSync(join(fx.home, "bin", "pi-ak.cmd"), "utf8");
  assert.match(piAkWrapper, /if "%__ppm_cmd%"=="install" goto ppm_passthrough/);
  assert.match(piAkWrapper, /--no-skills/);
  assert.match(piAkWrapper, /'--skill', profileSkills/);
  assert.match(piAkWrapper, /'--skill', join\(projectPi, 'skills'\)/);
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

test("Windows add command supports broker auth and enforces credential security", () => {
  const fx = fixture("add-broker");
  fx.manager.main(["add", "team-broker", "--auth", "broker", "--broker-url", "https://broker.example.com", "--broker-token", "secret-token-xyz", "--no-agentkit", "--dry-run"]);
  assert.equal(fx.stdout.some((line) => line.includes("would write:")), true);
  assert.equal(fx.stdout.some((line) => line.includes("token redacted")), true);
  assert.equal(fx.stdout.some((line) => line.includes("secret-token-xyz")), false);
  assert.equal(existsSync(join(fx.home, ".omp", "profiles", "team-broker", "agent", ".env")), false);
  assert.throws(() => fx.manager.main(["add", "bad.name", "--auth", "local"]), /invalid profile name/);
  assert.throws(() => fx.manager.main(["add", "bad/name", "--auth", "local"]), /invalid profile name/);
  assert.throws(() => fx.manager.main(["add", "bad\\name", "--auth", "local"]), /invalid profile name/);
  assert.throws(() => fx.manager.main(["add", "../traversal", "--auth", "local"]), /invalid profile name/);
  assert.throws(() => fx.manager.main(["add", "doctor", "--auth", "local"]), /reserved profile name/);


  assert.throws(
    () => fx.manager.main(["add", "bad-url", "--auth", "broker", "--broker-url", "https://example.com\nINJECT=1", "--broker-token", "tok", "--no-agentkit"]),
    /cannot contain newline or carriage return/,
  );
  assert.equal(existsSync(join(fx.home, ".config", "mise", "config.bad-url.toml")), false);
  assert.equal(existsSync(join(fx.home, "bin", "bad-url.cmd")), false);

  assert.throws(
    () => fx.manager.main(["add", "bad-tok", "--auth", "broker", "--broker-url", "https://example.com", "--broker-token", "tok\r\nINJECT=1", "--no-agentkit"]),
    /cannot contain newline or carriage return/,
  );

  const userOwnedDir = join(fx.home, ".omp", "profiles", "user-owned", "agent");
  mkdirSync(userOwnedDir, { recursive: true });
  writeFileSync(join(userOwnedDir, ".env"), "UNMANAGED=123\n");
  assert.throws(
    () => fx.manager.main(["add", "user-owned", "--auth", "broker", "--broker-url", "https://example.com", "--broker-token", "tok", "--no-agentkit"]),
    /refusing to overwrite user-owned file without managed marker/,
  );
  assert.equal(readFileSync(join(userOwnedDir, ".env"), "utf8"), "UNMANAGED=123\n");
  const userMarkerDir = join(fx.home, ".omp", "profiles", "user-marker", "agent");
  mkdirSync(userMarkerDir, { recursive: true });
  writeFileSync(join(userMarkerDir, ".manager-profile"), "UNMANAGED=1\n");
  assert.throws(
    () => fx.manager.main(["add", "user-marker", "--auth", "local", "--no-agentkit"]),
    /refusing to overwrite user-owned file without managed marker/,
  );
  assert.equal(existsSync(join(fx.home, ".config", "mise", "config.user-marker.toml")), false);
  assert.equal(existsSync(join(fx.home, "bin", "user-marker.cmd")), false);


  fx.manager.main(["add", "team-broker", "--auth", "broker", "--broker-url", "https://broker.example.com", "--broker-token", "secret-token-xyz", "--no-agentkit"]);
  const envFile = join(fx.home, ".omp", "profiles", "team-broker", "agent", ".env");
  assert.equal(existsSync(envFile), true);
  assert.equal(existsSync(join(fx.home, ".config", "mise", "config.team-broker.toml")), true);
  assert.equal(existsSync(join(fx.home, "bin", "team-broker.cmd")), true);

  const content = readFileSync(envFile, "utf8");
  assert.match(content, /OMP_AUTH_BROKER_URL=https:\/\/broker\.example\.com/);
  assert.match(content, /OMP_AUTH_BROKER_TOKEN=secret-token-xyz/);

  fx.manager.main(["add", "team-broker", "--auth", "broker", "--broker-url", "https://broker.example.com", "--broker-token", "secret-token-new", "--no-agentkit"]);
  const agentFiles = readdirSync(join(fx.home, ".omp", "profiles", "team-broker", "agent"));
  assert.equal(agentFiles.some((f) => f.includes(".bak") || f.includes(".old")), false);

  fx.manager.main(["verify", "team-broker"]);
  assert.equal(fx.stdout.some((line) => line.includes("team-broker verification passed")), true);
  // Unrelated Mise config must not be discovered
  writeFileSync(join(fx.home, ".config", "mise", "config.python.toml"), '[tools]\npython = "3.12"\n');


  const inventory = readInventory(fx);
  assert.equal(inventory.profiles.length, 1);
  assert.equal(inventory.profiles[0].id, "team-broker");
  assert.equal(inventory.profiles[0].runtime, "omp");
  assert.equal(inventory.profiles[0].managed, true);
  assert.equal(inventory.profiles[0].healthy, true);
  assert.equal(inventory.profiles[0].agentkitEnabled, false);
});

test("Windows add command supports local mode and honors unmanaged safety", () => {
  const fx = fixture("add-local");
  fx.manager.main(["add", "team-local", "--auth", "local", "--no-agentkit"]);
  assert.equal(existsSync(join(fx.home, ".config", "mise", "config.team-local.toml")), true);
  assert.equal(existsSync(join(fx.home, "bin", "team-local.cmd")), true);
  assert.equal(existsSync(join(fx.home, ".omp", "profiles", "team-local", "agent")), true);
  assert.equal(existsSync(join(fx.home, ".omp", "profiles", "team-local", "agent", ".env")), false);

  const userLocalDir = join(fx.home, ".omp", "profiles", "user-local", "agent");
  mkdirSync(userLocalDir, { recursive: true });
  writeFileSync(join(userLocalDir, ".env"), "USER_SECRET=999\n");
  assert.throws(
    () => fx.manager.main(["add", "user-local", "--auth", "local", "--no-agentkit"]),
    /refusing to remove user-owned file without managed marker/,
  );
  assert.equal(readFileSync(join(userLocalDir, ".env"), "utf8"), "USER_SECRET=999\n");

  fx.manager.main(["add", "team-switch", "--auth", "broker", "--broker-url", "https://example.com", "--broker-token", "tok", "--no-agentkit"]);
  assert.equal(existsSync(join(fx.home, ".omp", "profiles", "team-switch", "agent", ".env")), true);
  fx.manager.main(["add", "team-switch", "--auth", "local", "--no-agentkit"]);
  assert.equal(existsSync(join(fx.home, ".omp", "profiles", "team-switch", "agent", ".env")), false);
});

test("Windows add command supports AgentKit verification lifecycle", () => {
  const fx = fixture("add-agentkit");
  fx.manager.main(["add", "team-ak", "--auth", "local", "--with-agentkit"]);
  assert.equal(existsSync(join(fx.home, ".omp", "profiles", "team-ak", "agent", ".agentkit-profile")), true);
  assert.equal(existsSync(join(fx.home, ".omp", "profiles", "team-ak", "agent", "skills", "ak-cook", "SKILL.md")), true);

  fx.manager.main(["verify", "team-ak"]);
  assert.equal(fx.stdout.some((line) => line.includes("team-ak verification passed")), true);

  rmSync(join(fx.home, ".omp", "profiles", "team-ak", "agent", "skills"), { recursive: true, force: true });
  assert.throws(
    () => fx.manager.main(["verify", "team-ak"]),
    /AgentKit skills were not installed/,
  );
});

test("Windows interactive wizard prompts for inputs and protects secret from output", () => {
  const promptCalls = [];
  const secretCalls = [];
  const promptAnswers = ["wizard-team", "1", "https://broker.example.com", "y"];
  const secretAnswers = ["super-secret-token-999"];

  const fx = fixture("wizard-broker");
  const interactiveManager = createWindowsProfileManager({
    home: fx.home,
    env: {
      USERPROFILE: fx.home,
      LOCALAPPDATA: join(fx.root, "Local AppData"),
      PATH: [join(fx.home, "bin"), join(fx.root, "fake-bin")].join(delimiter),
    },
    runner: fx.runner,
    output: { write: (val) => fx.stdout.push(val) },
    errorOutput: { write: (val) => fx.stderr.push(val) },
    prompt(q) {
      promptCalls.push(q);
      return promptAnswers.shift();
    },
    promptSecret(q) {
      secretCalls.push(q);
      return secretAnswers.shift();
    },
  });

  interactiveManager.main(["add"]);
  assert.equal(promptCalls.some((q) => q.includes("Profile name:")), true);
  assert.equal(promptCalls.some((q) => q.includes("Choice")), true);
  assert.equal(promptCalls.some((q) => q.includes("OMP_AUTH_BROKER_URL")), true);
  assert.equal(secretCalls.some((q) => q.includes("OMP_AUTH_BROKER_TOKEN")), true);
  assert.equal(promptCalls.some((q) => q.includes("Install AgentKit")), true);

  assert.equal(fx.stdout.some((line) => line.includes("super-secret-token-999")), false);
  assert.equal(fx.stderr.some((line) => line.includes("super-secret-token-999")), false);

  const envFile = join(fx.home, ".omp", "profiles", "wizard-team", "agent", ".env");
  assert.equal(existsSync(envFile), true);
  assert.equal(readFileSync(envFile, "utf8").includes("OMP_AUTH_BROKER_TOKEN=super-secret-token-999"), true);
  assert.equal(existsSync(join(fx.home, ".omp", "profiles", "wizard-team", "agent", ".manager-profile")), true);
  assert.equal(existsSync(join(fx.home, ".omp", "profiles", "wizard-team", "agent", ".agentkit-profile")), true);

  interactiveManager.main(["verify", "wizard-team"]);
  assert.equal(fx.stdout.some((line) => line.includes("wizard-team verification passed")), true);
});

test("Windows add command installs missing OMP binary and validates custom profile", () => {
  const fx = fixture("add-missing-omp");
  assert.equal(fx.commands.has("omp"), false);
  fx.manager.main(["add", "team-fresh", "--auth", "local", "--no-agentkit"]);
  assert.equal(fx.commands.has("omp"), true);
  const versionCapture = fx.calls.find(
    (c) => c.kind === "capture" && c.command === "mise" && c.args.includes("team-fresh") && c.args.includes("--version"),
  );
  assert.ok(versionCapture);
  assert.equal(fx.stdout.some((line) => line.includes("team-fresh")), true);
});

test("Windows writeBrokerEnv leaves no displaced or temporary files on disk", () => {
  const fx = fixture("atomic-secret");
  fx.manager.main(["add", "atomic-team", "--auth", "broker", "--broker-url", "https://example.com", "--broker-token", "tok1", "--no-agentkit"]);
  fx.manager.main(["add", "atomic-team", "--auth", "broker", "--broker-url", "https://example.com", "--broker-token", "tok2", "--no-agentkit"]);
  const agentDir = join(fx.home, ".omp", "profiles", "atomic-team", "agent");
  const files = readdirSync(agentDir);
  assert.equal(files.some((f) => f.includes(".old")), false);
  assert.equal(files.some((f) => f.includes(".tmp")), false);
  assert.equal(files.some((f) => f.includes(".bak")), false);
});

test("Windows secret reader safely restores rawMode on Ctrl+C cancellation", () => {
  let rawModeState = null;
  const mockStdin = {
    isTTY: true,
    setRawMode(val) {
      rawModeState = val;
    },
    readSync(fd, buf) {
      buf[0] = 3; // Ctrl+C
      return 1;
    },
  };
  const reader = promptSecretReader(mockStdin, { write() {} });
  assert.throws(
    () => reader("prompt: "),
    (err) => err instanceof PromptCancelledError && err.code === "ECANCELLED",
  );
  assert.equal(rawModeState, false);
});


test("Windows add review findings: names, claims, preflight, and secrets", () => {
  const fx = fixture("add-review-fixes");
  assert.throws(() => fx.manager.main(["add", "help", "--auth", "local"]), /reserved profile name/);
  assert.throws(() => fx.manager.main(["add", "pi-dev", "--auth", "local"]), /reserved profile name/);
  assert.throws(() => fx.manager.main(["add", "CON", "--auth", "local"]), /reserved profile name/);
  assert.throws(() => fx.manager.main(["verify", "../../etc/passwd"]), /invalid profile name/);

  fx.manager.main(["add", "team-a", "--auth", "local", "--with-agentkit"]);
  fx.manager.main(["add", "team-b", "--auth", "local", "--with-agentkit"]);
  fx.manager.main(["verify", "team-a"]);
  fx.manager.main(["verify", "team-b"]);
  const inventory = readInventory(fx);
  assert.equal(inventory.profiles.find((p) => p.id === "team-a").agentkitEnabled, true);
  assert.equal(inventory.profiles.find((p) => p.id === "team-b").agentkitEnabled, true);

  if (process.platform !== "win32") {
    chmodSync(join(fx.home, ".config", "mise"), 0o555);
    try {
      assert.throws(
        () => fx.manager.main(["add", "ro-cfg", "--auth", "local", "--no-agentkit"]),
        /not writable/,
      );
    } finally {
      chmodSync(join(fx.home, ".config", "mise"), 0o755);
    }
    assert.equal(existsSync(join(fx.home, ".omp", "profiles", "ro-cfg")), false);
  }

  const akDirPath = join(fx.home, ".omp", "profiles", "ak-dir", "agent", ".agentkit-profile");
  mkdirSync(akDirPath, { recursive: true });
  assert.throws(
    () => fx.manager.main(["add", "ak-dir", "--auth", "local", "--with-agentkit"]),
    /managed target is not a regular file/,
  );
  assert.equal(existsSync(join(fx.home, ".config", "mise", "config.ak-dir.toml")), false);

  fx.commands.add("omp");
  fx.setFailOmpVersion(true);
  assert.throws(
    () => fx.manager.main(["add", "stale-omp", "--auth", "local", "--no-agentkit"]),
    /failed to verify existing OMP/,
  );
  fx.setFailOmpVersion(false);

  fx.manager.main(["add", "team-meta", "--auth", "local", "--with-agentkit"]);
  writeFileSync(join(fx.home, ".agentkit", "adapters", "omp", "engineer", "omp-ownership.json"), "{}\n");
  const broken = readInventory(fx);
  assert.equal(broken.profiles.find((p) => p.id === "team-meta").agentkitEnabled, false);
  assert.throws(() => fx.manager.main(["verify", "team-meta"]), /malformed AgentKit ownership metadata/);

  const negatedDir = join(fx.home, ".omp", "profiles", "negated", "agent");
  mkdirSync(negatedDir, { recursive: true });
  writeFileSync(join(negatedDir, ".manager-profile"), "# not managed by pi-profile-manager\n");
  writeFileSync(join(fx.home, ".config", "mise", "config.negated.toml"), '[env]\nOMP_PROFILE = "negated"\n');
  writeFileSync(join(fx.home, "bin", "negated.cmd"), "@echo off\r\n");
  const listed = readInventory(fx);
  assert.equal(listed.profiles.some((p) => p.id === "negated"), false);

  const token = "tökén";
  const bytes = [...Buffer.from(token, "utf8"), 13];
  let index = 0;
  const mockStdin = {
    isTTY: true,
    setRawMode() {},
    readSync(fd, buf) {
      buf[0] = bytes[index++];
      return 1;
    },
  };
  const reader = promptSecretReader(mockStdin, { write() {} });
  assert.equal(reader("prompt: "), token);
});
