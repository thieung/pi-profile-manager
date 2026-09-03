import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tableSeparator =
  /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m;

const files = {
  en: {
    name: "README.md",
    headings: ["Requirements", "Install", "Profiles", "Safety", "Development"],
    safetyHeading: "## Safety",
    safetyMarkers: [
      "Never reads or copies provider credentials",
      "Never mutates the system through npm lifecycle scripts",
      "checksum has drifted",
      "Creates a backup before an upgrade and rolls back",
      "never runs an installer or performs a network mutation",
      "same user",
      "Uninstall does not remove profiles, credentials, or backups",
    ],
  },
  vi: {
    name: "README.vi.md",
    headings: ["Điều kiện", "Cài đặt", "Profiles", "An toàn", "Development"],
    safetyHeading: "## An toàn",
    safetyMarkers: [
      "Không đọc hoặc copy provider credentials",
      "Không tự chạy mutation qua npm lifecycle scripts",
      "drift khỏi checksum",
      "Upgrade tạo backup và rollback",
      "không chạy installer hoặc network mutation",
      "cùng quyền user",
      "không xóa profiles, credentials hay backups",
    ],
  },
};

function load(name) {
  return fs.readFileSync(path.join(root, name), "utf8").replace(/\r\n/g, "\n");
}

function headings(text) {
  return text.split("\n").flatMap((line) => {
    const match = /^## (.+)$/.exec(line);
    return match ? [match[1]] : [];
  });
}

function splitAdvanced(text, name) {
  const start = text.search(/<details(?:\s[^>]*)?>/i);
  const end = text.search(/<\/details>/i);
  assert.notEqual(start, -1, `${name} missing <details>`);
  assert.notEqual(end, -1, `${name} missing </details>`);
  assert.ok(start < end, `${name} details tags are ordered`);
  const openTag = text.slice(start, text.indexOf(">", start) + 1);
  assert.equal(/\sopen(?:[=>\s]|$)/i.test(openTag), false, `${name} details must stay collapsed`);
  return {
    visible: text.slice(0, start),
    advanced: text.slice(start, end),
  };
}

function safetySection(text, heading, name) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `${name} missing ${heading}`);
  const after = text.slice(start + heading.length);
  const next = after.search(/\n## |\n<details[\s>]/);
  return after.slice(0, next === -1 ? undefined : next);
}

for (const spec of Object.values(files)) {
  test(`${spec.name} stays a short first-install README`, () => {
    const text = load(spec.name);
    const lines = text.split("\n");
    const lineCount = text.endsWith("\n") ? lines.length - 1 : lines.length;
    assert.ok(lineCount <= 180, `${spec.name} has ${lineCount} lines`);
    assert.equal(tableSeparator.test(text), false, `${spec.name} must not contain markdown tables`);

    const { visible, advanced } = splitAdvanced(text, spec.name);
    assert.match(visible, /\[English\]\(README\.md\)/);
    assert.match(visible, /\[Tiếng Việt\]\(README\.vi\.md\)/);
    assert.match(visible, /https:\/\/github\.com\/badlogic\/pi-mono/);
    assert.match(visible, /https:\/\/agentkit\.best\/\?ref=OMG49S8R/);
    assert.equal(/raspberry\s*pi/i.test(text), false);
    for (const profile of ["pi-dev", "pi-ak", "pi-omp"]) {
      assert.ok(text.includes(profile), `${spec.name} missing ${profile}`);
    }

    for (const token of [
      "ppm-bootstrap install",
      "pi-profile-manager bootstrap",
      "pi-profile-manager doctor",
      "pi-profile-manager install pi-dev",
    ]) {
      assert.ok(visible.includes(token), `${spec.name} visible path missing ${token}`);
    }
    for (const token of [
      "pi-profile-manager add",
      "pi-profile-manager install pi-ak",
      "pi-profile-manager install pi-omp",
      "pi-profile-manager verify all",
      "pi-profile-manager profiles list --json",
      "ppm-bootstrap status",
      "ppm-bootstrap uninstall",
    ]) {
      assert.ok(advanced.includes(token), `${spec.name} Advanced missing ${token}`);
    }

    const tokenMatches = text.match(/--broker-token\s+(\S+)/g) ?? [];
    assert.ok(tokenMatches.length > 0, `${spec.name} missing --broker-token example`);
    for (const match of tokenMatches) {
      assert.equal(match, '--broker-token "$OMP_AUTH_BROKER_TOKEN"');
    }
    assert.ok(advanced.includes('--broker-token "$OMP_AUTH_BROKER_TOKEN"'));

    const safety = safetySection(visible, spec.safetyHeading, spec.name);
    for (const marker of spec.safetyMarkers) {
      assert.ok(safety.includes(marker), `${spec.name} Safety missing ${marker}`);
    }
    assert.equal(text.includes("Native Windows contract"), false);
    assert.equal(text.includes("Windows native support contract"), false);
    assert.deepEqual(headings(text), spec.headings);
  });
}
