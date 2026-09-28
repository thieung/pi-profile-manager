import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const binPath = new URL("../bin/pi-profile-manager.mjs", import.meta.url).pathname;
const posixOnly = { skip: process.platform === "win32" };

async function runBin(args) {
  const home = await mkdtemp(join(tmpdir(), "pi-profile-manager-bin-test-"));
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return { ...result, home };
}

test("bootstrap --version stays on the bootstrap path", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const result = await runBin(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${manifest.version}\n`);
});

test("manager commands pass through to the payload", posixOnly, async () => {
  const result = await runBin(["add", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pi-profile-manager add \[name\]/);
});

test("payload exit status propagates without touching HOME", posixOnly, async () => {
  const result = await runBin(["add", "bad name!", "--auth", "local", "--dry-run"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid profile name: bad name!/);
  assert.deepEqual(await readdir(result.home), []);
});

test("bootstrap command names with arguments run the payload", posixOnly, async () => {
  const result = await runBin(["status", "extra"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command: status/);
});
