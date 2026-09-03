#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_ROOT/payload/pi-profile-manager"
NODE_BIN="$(command -v node)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi-profile-manager-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf 'not ok: %s\n' "$1" >&2
  exit 1
}

assert_file() {
  [[ -f "$1" ]] || fail "missing file: $1"
}

assert_not_exists() {
  [[ ! -e "$1" ]] || fail "unexpected path: $1"
}

assert_contains() {
  local needle="$1"
  local file="$2"
  grep -F -- "$needle" "$file" >/dev/null || fail "missing '$needle' in $file"
}

assert_not_contains() {
  local needle="$1"
  local file="$2"
  if grep -F -- "$needle" "$file" >/dev/null; then
    fail "unexpected '$needle' in $file"
  fi
}

make_fake_tools() {
  local fake_bin="$1"
  mkdir -p "$fake_bin"

  cat >"$fake_bin/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm|%s\n' "$*" >>"$CALL_LOG"
if [[ "${1:-}" == "view" ]]; then
  printf '0.84.3\n'
fi
FAKE_NPM

  cat >"$fake_bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl|%s\n' "$*" >>"$CALL_LOG"
output=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--output" ]]; then
    output="$2"
    break
  fi
  shift
done
[[ -n "$output" ]]
if [[ "${FAKE_CURL_FAIL:-0}" == "1" ]]; then
  exit 22
fi
cat >"$output" <<'FAKE_INSTALLER'
#!/bin/sh
set -eu
printf 'mise-installer|%s\n' "$MISE_INSTALL_PATH" >>"$CALL_LOG"
if [ "${FAKE_MISE_INSTALL_PARTIAL_FAIL:-0}" = "1" ]; then
  printf 'partial binary\n' >"$MISE_INSTALL_PATH"
  chmod 0755 "$MISE_INSTALL_PATH"
  exit 1
fi
if [ "${FAKE_MISE_INSTALL_FAIL:-0}" = "1" ]; then
  exit 1
fi
mkdir -p "$(dirname "$MISE_INSTALL_PATH")"
cat >"$MISE_INSTALL_PATH" <<'FAKE_INSTALLED_MISE'
#!/bin/sh
if [ "${1:-}" = "--version" ]; then
  if [ "${FAKE_MISE_VERSION_FAIL:-0}" = "1" ]; then
    exit 1
  fi
  printf 'mise 2026.8.14\n'
fi
FAKE_INSTALLED_MISE
chmod 0755 "$MISE_INSTALL_PATH"
FAKE_INSTALLER
FAKE_CURL

  cat >"$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  --version)
    printf '0.84.3\n'
    ;;
  install)
    printf 'pi|%s|%s\n' "${PI_CODING_AGENT_DIR:-unset}" "$*" >>"$CALL_LOG"
    ;;
  list)
    for extension in \
      'npm:statusline-pi@1.2.1' \
      'npm:advisor-pi@1.0.3' \
      'npm:grok-pi@1.2.0' \
      'npm:model-debugger@1.0.2' \
      'npm:@tintinweb/pi-subagents@0.18.0'; do
      printf '%s %s/npm/node_modules\n' "$extension" "$PI_CODING_AGENT_DIR"
    done
    ;;
  *)
    printf 'pi|%s|%s\n' "${PI_CODING_AGENT_DIR:-unset}" "$*" >>"$CALL_LOG"
    ;;
esac
FAKE_PI

  cat >"$fake_bin/omp" <<'FAKE_OMP'
#!/usr/bin/env bash
if [[ "${FAKE_OMP_VERSION_FAIL:-0}" == "1" ]]; then
  exit 1
fi
case "${1:-}" in
  --version) printf 'omp/18.0.4\n' ;;
  config)
    [[ "${2:-}" == "path" ]]
    printf '%s/.omp/profiles/%s/agent\n' "$HOME" "$OMP_PROFILE"
    ;;
esac
FAKE_OMP

  cat >"$fake_bin/ak" <<'FAKE_AK'
#!/usr/bin/env bash
set -euo pipefail
printf 'ak|%s|%s|%s\n' "${PI_CODING_AGENT_DIR:-unset}" "${AGENTKIT_OMP_HOME:-unset}" "$*" >>"$CALL_LOG"
target=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--target" ]]; then
    target="$2"
    break
  fi
  shift
done
if [[ "$target" == "pi" ]]; then
  mkdir -p "$PI_CODING_AGENT_DIR/extensions/agentkit-hooks-engineer/.agentkit"
  printf '{"version":1,"kit":"engineer","files":["AGENTS.md"]}\n' >"$PI_CODING_AGENT_DIR/extensions/agentkit-hooks-engineer/.agentkit/install-manifest.json"
elif [[ "$target" == "omp" ]]; then
  mkdir -p "$HOME/.agentkit/adapters/omp/engineer/.agentkit"
  skill_root="$AGENTKIT_OMP_HOME/skills"
  if [[ "${FAKE_AK_OMP_DEST:-profile}" == "default" ]]; then
    skill_root="$HOME/.omp/agent/skills"
  fi
  mkdir -p "$skill_root/ak-cook"
  printf '%s\n' '---' 'name: ak-cook' 'description: fake AgentKit cook skill' '---' >"$skill_root/ak-cook/SKILL.md"
  node -e '
const fs = require("node:fs");
const [ownershipPath, nativePath, claim, skill] = process.argv.slice(1);
let ownership = { version: 1, kit: "engineer", claims: [] };
try { ownership = JSON.parse(fs.readFileSync(ownershipPath, "utf8")); } catch {}
if (!Array.isArray(ownership.claims)) ownership.claims = [];
if (!ownership.claims.includes(claim)) ownership.claims.push(claim);
ownership.version = 1;
ownership.kit = "engineer";
fs.writeFileSync(ownershipPath, JSON.stringify(ownership));
let native = { skills: [] };
try { native = JSON.parse(fs.readFileSync(nativePath, "utf8")); } catch {}
if (!Array.isArray(native.skills)) native.skills = [];
if (!native.skills.includes(skill)) native.skills.push(skill);
fs.writeFileSync(nativePath, JSON.stringify(native));
' "$HOME/.agentkit/adapters/omp/engineer/omp-ownership.json" \
    "$HOME/.agentkit/adapters/omp/engineer/.agentkit/native-skill-paths.json" \
    "$skill_root" \
    "$skill_root/ak-cook/SKILL.md"
fi
FAKE_AK

  cat >"$fake_bin/mise" <<'FAKE_MISE'
#!/usr/bin/env bash
set -euo pipefail
printf 'mise|%s\n' "$*" >>"$CALL_LOG"
case "${1:-}" in
  --version)
    printf 'mise 2026.8.14\n'
    exit 0
    ;;
  latest)
    printf '18.0.4\n'
    exit 0
    ;;
  use)
    if [[ "$*" == *"oh-my-pi"* ]]; then
      bindir="$(cd "$(dirname "$0")" && pwd)"
      cat >"$bindir/omp" <<'FAKE_OMP'
#!/usr/bin/env bash
if [[ "${FAKE_OMP_VERSION_FAIL:-0}" == "1" ]]; then
  exit 1
fi
case "${1:-}" in
  --version) printf 'omp/18.0.4\n' ;;
  config)
    [[ "${2:-}" == "path" ]]
    printf '%s/.omp/profiles/%s/agent\n' "$HOME" "$OMP_PROFILE"
    ;;
esac
FAKE_OMP
      chmod 0755 "$bindir/omp"
    fi
    exit 0
    ;;
  lock)
    exit 0
    ;;
  -E)
    profile="$2"
    shift 2
    [[ "${1:-}" == "exec" && "${2:-}" == "--" ]]
    shift 2
    case "$profile" in
      pi-dev|pi-ak)
        export PI_CODING_AGENT_DIR="$HOME/.pi/profiles/$profile"
        export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/profiles/$profile/sessions"
        unset OMP_PROFILE AGENTKIT_OMP_HOME || true
        ;;
      *)
        export OMP_PROFILE="$profile"
        export AGENTKIT_OMP_HOME="$HOME/.omp/profiles/$profile/agent"
        unset PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR || true
        if [[ "${FAKE_MISE_WRONG_OMP_ROOT:-0}" == "1" ]]; then
          export AGENTKIT_OMP_HOME="$HOME/.omp/agent"
        fi
        ;;
    esac
    if [[ "${FAKE_MISE_WRONG_ROOT:-0}" == "1" && "$profile" != "pi-omp" ]]; then
      export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
    fi
    exec "$@"
    ;;
esac
FAKE_MISE

  chmod 0755 "$fake_bin/npm" "$fake_bin/curl" "$fake_bin/pi" "$fake_bin/omp" \
    "$fake_bin/ak" "$fake_bin/mise"
}

new_case() {
  local name="$1"
  CASE_ROOT="$TEST_ROOT/$name"
  HOME="$CASE_ROOT/home"
  FAKE_BIN="$CASE_ROOT/bin"
  CALL_LOG="$CASE_ROOT/calls.log"
  OUTPUT="$CASE_ROOT/output.log"
  ERROR_OUTPUT="$CASE_ROOT/error.log"
  TMPDIR="$CASE_ROOT/tmp"
  export HOME CALL_LOG TMPDIR
  mkdir -p "$HOME" "$FAKE_BIN" "$TMPDIR"
  : >"$CALL_LOG"
  : >"$ERROR_OUTPUT"
  make_fake_tools "$FAKE_BIN"
  ln -s "$NODE_BIN" "$FAKE_BIN/node"
  PATH="$FAKE_BIN:/usr/bin:/bin"
  export PATH
}

run_manager() {
  /bin/bash "$SCRIPT" "$@" >"$OUTPUT" 2>&1
}

run_manager_split() {
  /bin/bash "$SCRIPT" "$@" >"$OUTPUT" 2>"$ERROR_OUTPUT"
}

json_eval() {
  # shellcheck disable=SC2016
  "$NODE_BIN" -e 'const fs = require("node:fs"); const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const value = Function("data", `return (${process.argv[2]})`)(data); process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));' "$OUTPUT" "$1"
}

assert_json_eq() {
  local expected="$1"
  local expression="$2"
  local actual
  actual="$(json_eval "$expression")"
  [[ "$actual" == "$expected" ]] || fail "expected JSON $expression to be '$expected', got '$actual'"
}

test_bootstrap_dry_run_has_no_mutation() {
  new_case bootstrap-dry-run
  rm "$FAKE_BIN/mise"
  run_manager bootstrap --dry-run
  assert_not_exists "$HOME/.local/bin/mise"
  [[ ! -s "$CALL_LOG" ]] || fail "bootstrap dry-run invoked a fake dependency"
  [[ -z "$(find "$TMPDIR" -type f -print -quit)" ]] \
    || fail "bootstrap dry-run created a temporary file"
  assert_contains 'would download official Mise installer: https://mise.run' "$OUTPUT"
  printf 'ok: bootstrap dry-run has no mutation\n'
}

test_bootstrap_existing_mise_is_noop() {
  new_case bootstrap-existing
  run_manager bootstrap
  assert_contains 'mise already available:' "$OUTPUT"
  assert_contains 'mise|--version' "$CALL_LOG"
  assert_not_contains 'curl|' "$CALL_LOG"
  printf 'ok: bootstrap existing Mise is no-op\n'
}

test_bootstrap_existing_off_path_mise_is_noop() {
  new_case bootstrap-existing-off-path
  rm "$FAKE_BIN/mise"
  mkdir -p "$HOME/.local/bin"
  cat >"$HOME/.local/bin/mise" <<'FAKE_OFF_PATH_MISE'
#!/bin/sh
printf 'mise 2026.8.14\n'
FAKE_OFF_PATH_MISE
  chmod 0755 "$HOME/.local/bin/mise"
  run_manager bootstrap
  assert_contains "mise already installed: $HOME/.local/bin/mise" "$OUTPUT"
  assert_not_contains 'curl|' "$CALL_LOG"
  assert_contains 'is not currently in PATH' "$OUTPUT"
  printf 'ok: bootstrap existing off-PATH Mise is no-op\n'
}

test_bootstrap_installs_mise() {
  new_case bootstrap-install
  rm "$FAKE_BIN/mise"
  run_manager bootstrap
  assert_file "$HOME/.local/bin/mise"
  [[ -x "$HOME/.local/bin/mise" ]] || fail "installed Mise is not executable"
  assert_contains 'curl|--proto =https --tlsv1.2 --fail --silent --show-error --location --output' "$CALL_LOG"
  assert_contains "mise-installer|$HOME/.local/bin/.mise-stage." "$CALL_LOG"
  assert_contains 'mise version: mise 2026.8.14' "$OUTPUT"
  [[ -z "$(find "$HOME/.local/bin" -name '.mise-stage.*' -print -quit)" ]] \
    || fail "successful bootstrap left a staged Mise binary"
  [[ -z "$(find "$TMPDIR" -type f -print -quit)" ]] \
    || fail "successful bootstrap left a temporary installer"
  printf 'ok: bootstrap installs and verifies Mise\n'
}

test_bootstrap_download_failure_cleans_up() {
  new_case bootstrap-download-failure
  rm "$FAKE_BIN/mise"
  export FAKE_CURL_FAIL=1
  if run_manager bootstrap; then
    fail "failed Mise download unexpectedly passed"
  fi
  unset FAKE_CURL_FAIL
  assert_not_exists "$HOME/.local/bin/mise"
  assert_contains 'failed to download official Mise installer' "$OUTPUT"
  [[ -z "$(find "$TMPDIR" -type f -print -quit)" ]] \
    || fail "download failure left a temporary installer"
  printf 'ok: bootstrap download failure cleans up\n'
}

test_bootstrap_installer_failure_cleans_up() {
  new_case bootstrap-installer-failure
  rm "$FAKE_BIN/mise"
  export FAKE_MISE_INSTALL_FAIL=1
  if run_manager bootstrap; then
    fail "failed Mise installer unexpectedly passed"
  fi
  unset FAKE_MISE_INSTALL_FAIL
  assert_not_exists "$HOME/.local/bin/mise"
  assert_contains 'official Mise installer failed' "$OUTPUT"
  [[ -z "$(find "$TMPDIR" -type f -print -quit)" ]] \
    || fail "installer failure left a temporary installer"
  printf 'ok: bootstrap installer failure cleans up\n'
}

test_bootstrap_partial_installer_failure_cleans_up() {
  new_case bootstrap-partial-installer-failure
  rm "$FAKE_BIN/mise"
  export FAKE_MISE_INSTALL_PARTIAL_FAIL=1
  if run_manager bootstrap; then
    fail "partially failed Mise installer unexpectedly passed"
  fi
  unset FAKE_MISE_INSTALL_PARTIAL_FAIL
  assert_not_exists "$HOME/.local/bin/mise"
  [[ -z "$(find "$HOME/.local/bin" -name '.mise-stage.*' -print -quit)" ]] \
    || fail "partial installer failure left a staged Mise binary"
  assert_contains 'official Mise installer failed' "$OUTPUT"
  printf 'ok: partial installer failure leaves final target absent\n'
}

test_bootstrap_verification_failure_cleans_up() {
  new_case bootstrap-verification-failure
  rm "$FAKE_BIN/mise"
  export FAKE_MISE_VERSION_FAIL=1
  if run_manager bootstrap; then
    fail "unverifiable staged Mise unexpectedly passed"
  fi
  unset FAKE_MISE_VERSION_FAIL
  assert_not_exists "$HOME/.local/bin/mise"
  [[ -z "$(find "$HOME/.local/bin" -name '.mise-stage.*' -print -quit)" ]] \
    || fail "verification failure left a staged Mise binary"
  assert_contains 'staged Mise binary failed verification' "$OUTPUT"
  printf 'ok: verification failure leaves final target absent\n'
}

test_bootstrap_refuses_non_executable_target() {
  new_case bootstrap-non-executable-target
  rm "$FAKE_BIN/mise"
  mkdir -p "$HOME/.local/bin"
  printf 'user-owned file\n' >"$HOME/.local/bin/mise"
  if run_manager bootstrap; then
    fail "non-executable Mise target unexpectedly replaced"
  fi
  assert_contains 'refusing to replace non-executable Mise path' "$OUTPUT"
  assert_contains 'user-owned file' "$HOME/.local/bin/mise"
  assert_not_contains 'curl|' "$CALL_LOG"
  printf 'ok: bootstrap refuses a non-executable target\n'
}

test_dry_run_has_no_mutation() {
  new_case dry-run
  run_manager install pi-dev --dry-run
  assert_not_exists "$HOME/.config/mise/config.pi-dev.toml"
  [[ ! -s "$CALL_LOG" ]] || fail "dry-run invoked a fake dependency"
  assert_contains 'would write:' "$OUTPUT"
  printf 'ok: dry-run has no mutation\n'
}

test_dry_run_all_has_no_tool_invocation() {
  new_case dry-run-all
  run_manager install all --dry-run
  assert_not_exists "$HOME/.config/mise/config.pi-ak.toml"
  assert_not_exists "$HOME/.config/mise/config.pi-omp.toml"
  [[ ! -s "$CALL_LOG" ]] || fail "dry-run all invoked a fake dependency"
  assert_contains 'OMP target version: latest (not resolved during dry-run)' "$OUTPUT"
  printf 'ok: dry-run all has no tool invocation\n'
}

test_profiles_inventory_empty() {
  new_case profiles-empty
  run_manager_split profiles list --json
  assert_json_eq '1' 'data.schemaVersion'
  assert_json_eq '0' 'data.profiles.length'
  [[ ! -s "$ERROR_OUTPUT" ]] || fail "empty inventory wrote diagnostics"
  printf 'ok: profile inventory returns an empty schema v1 payload\n'
}

test_profiles_inventory_pi_dev() {
  local expected_agent_dir
  local expected_session_dir
  new_case profiles-pi-dev
  run_manager install pi-dev
  expected_agent_dir="$("$NODE_BIN" -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$HOME/.pi/profiles/pi-dev")"
  expected_session_dir="$("$NODE_BIN" -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$HOME/.pi/profiles/pi-dev/sessions")"
  : >"$CALL_LOG"
  run_manager_split profiles list --json
  assert_json_eq '1' 'data.profiles.length'
  assert_json_eq 'pi-dev' 'data.profiles[0].id'
  assert_json_eq 'pi' 'data.profiles[0].runtime'
  assert_json_eq "$expected_agent_dir" 'data.profiles[0].agentDir'
  assert_json_eq "$expected_session_dir" 'data.profiles[0].sessionDir'
  assert_json_eq 'false' 'data.profiles[0].agentkitEnabled'
  assert_json_eq 'true' 'data.profiles[0].managed'
  assert_json_eq 'true' 'data.profiles[0].healthy'
  assert_not_contains 'INFO:' "$OUTPUT"
  assert_not_contains 'WARN:' "$OUTPUT"
  assert_not_contains 'RUN:' "$OUTPUT"
  [[ ! -s "$ERROR_OUTPUT" ]] || fail "healthy pi-dev inventory wrote diagnostics"
  printf 'ok: profile inventory reports installed pi-dev\n'
}

test_profiles_inventory_pi_ak_agentkit() {
  new_case profiles-pi-ak
  run_manager install pi-ak
  run_manager_split profiles list --json
  assert_json_eq '1' 'data.profiles.length'
  assert_json_eq 'pi-ak' 'data.profiles[0].id'
  assert_json_eq 'pi' 'data.profiles[0].runtime'
  assert_json_eq 'true' 'data.profiles[0].agentkitEnabled'
  assert_json_eq 'true' 'data.profiles[0].managed'
  assert_json_eq 'true' 'data.profiles[0].healthy'
  printf 'ok: profile inventory reports pi-ak AgentKit evidence\n'
}

test_profiles_inventory_pi_omp_agentkit() {
  local expected_agent_dir
  new_case profiles-pi-omp
  run_manager install pi-omp
  expected_agent_dir="$("$NODE_BIN" -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$HOME/.omp/profiles/pi-omp/agent")"
  run_manager_split profiles list --json
  assert_json_eq '1' 'data.profiles.length'
  assert_json_eq 'pi-omp' 'data.profiles[0].id'
  assert_json_eq 'omp' 'data.profiles[0].runtime'
  assert_json_eq "$expected_agent_dir" 'data.profiles[0].agentDir'
  assert_json_eq 'null' 'data.profiles[0].sessionDir'
  assert_json_eq 'true' 'data.profiles[0].agentkitEnabled'
  assert_json_eq 'true' 'data.profiles[0].managed'
  assert_json_eq 'true' 'data.profiles[0].healthy'
  printf 'ok: profile inventory reports pi-omp AgentKit evidence\n'
}

test_profiles_inventory_accepts_one_legacy_extra_newline() {
  new_case profiles-legacy-newline
  run_manager install all
  printf '\n' >>"$HOME/.config/mise/config.pi-dev.toml"
  printf '\n' >>"$HOME/.local/bin/pi-dev"
  printf '\n' >>"$HOME/.config/mise/config.pi-ak.toml"
  printf '\n' >>"$HOME/.local/bin/pi-ak"
  printf '\n' >>"$HOME/.config/mise/config.pi-omp.toml"
  printf '\n' >>"$HOME/.local/bin/pi-omp"
  run_manager_split profiles list --json
  assert_json_eq '3' 'data.profiles.length'
  assert_json_eq 'true' 'data.profiles.every((profile) => profile.managed)'
  assert_json_eq 'true' 'data.profiles.every((profile) => profile.healthy)'
  [[ ! -s "$ERROR_OUTPUT" ]] || fail "legacy newline compatibility wrote diagnostics"
  printf 'ok: profile inventory accepts exactly one legacy extra newline\n'
}

test_profiles_inventory_rejects_two_extra_newlines() {
  new_case profiles-extra-newlines
  run_manager install pi-dev
  printf '\n\n' >>"$HOME/.local/bin/pi-dev"
  run_manager_split profiles list --json
  assert_json_eq 'false' 'data.profiles[0].managed'
  assert_json_eq 'false' 'data.profiles[0].healthy'
  assert_contains 'managed evidence is incomplete or drifted' "$ERROR_OUTPUT"
  printf 'ok: profile inventory rejects more than one extra newline\n'
}

test_profiles_inventory_drift_is_unhealthy() {
  new_case profiles-drift
  run_manager install pi-dev
  printf '# drift\n' >>"$HOME/.local/bin/pi-dev"
  run_manager_split profiles list --json
  assert_json_eq '1' 'data.profiles.length'
  assert_json_eq 'pi-dev' 'data.profiles[0].id'
  assert_json_eq 'false' 'data.profiles[0].managed'
  assert_json_eq 'false' 'data.profiles[0].healthy'
  assert_contains 'managed evidence is incomplete or drifted' "$ERROR_OUTPUT"
  assert_not_contains "$HOME" "$ERROR_OUTPUT"
  printf 'ok: profile inventory marks drifted artifacts unhealthy without absolute-path diagnostics\n'
}

test_profiles_inventory_foreign_is_unhealthy() {
  new_case profiles-foreign
  mkdir -p "$HOME/.config/mise" "$HOME/.local/bin"
  printf '[env]\nPI_CODING_AGENT_DIR = "foreign"\n' >"$HOME/.config/mise/config.pi-ak.toml"
  printf '#!/bin/sh\nexit 0\n' >"$HOME/.local/bin/pi-ak"
  chmod 0755 "$HOME/.local/bin/pi-ak"
  run_manager_split profiles list --json
  assert_json_eq '1' 'data.profiles.length'
  assert_json_eq 'pi-ak' 'data.profiles[0].id'
  assert_json_eq 'false' 'data.profiles[0].managed'
  assert_json_eq 'false' 'data.profiles[0].healthy'
  assert_contains 'managed evidence is incomplete or drifted' "$ERROR_OUTPUT"
  assert_not_contains "$HOME" "$ERROR_OUTPUT"
  printf 'ok: profile inventory includes foreign fixed-path artifacts as unmanaged unhealthy\n'
}

test_pi_dev_install_and_idempotency() {
  new_case pi-dev
  run_manager install pi-dev
  assert_file "$HOME/.config/mise/config.pi-dev.toml"
  assert_file "$HOME/.local/bin/pi-dev"
  assert_contains "PI_CODING_AGENT_DIR = \"{{ env.HOME }}/.pi/profiles/pi-dev\"" \
    "$HOME/.config/mise/config.pi-dev.toml"
  [[ "$(grep -c '^pi|.*/pi-dev|' "$CALL_LOG")" -eq 5 ]] \
    || fail "pi-dev did not install exactly five extensions"
  assert_not_contains 'ak|' "$CALL_LOG"
  run_manager install pi-dev
  if find "$HOME/.config/mise" "$HOME/.local/bin" -name '*.bak.*' | grep . >/dev/null; then
    fail "idempotent install created a backup"
  fi
  printf 'ok: pi-dev install is idempotent\n'
}

test_changed_managed_file_is_backed_up() {
  new_case backup
  mkdir -p "$HOME/.config/mise"
  printf '%s\n' 'user-owned content 1' >"$HOME/.config/mise/config.pi-dev.toml"
  run_manager install pi-dev
  printf '%s\n' 'user-owned content 2' >"$HOME/.config/mise/config.pi-dev.toml"
  run_manager install pi-dev
  [[ "$(find "$HOME/.config/mise" -name 'config.pi-dev.toml.bak.*' | wc -l | tr -d ' ')" -eq 2 ]] \
    || fail "same-second backup collision lost a backup"
  assert_contains 'backed up:' "$OUTPUT"
  printf 'ok: changed managed files get unique backups\n'
}

test_agentkit_targets() {
  new_case agentkit
  run_manager install pi-ak
  assert_contains "ak|$HOME/.pi/profiles/pi-ak|unset|kit init engineer --target pi" "$CALL_LOG"
  run_manager install pi-omp
  assert_contains "ak|unset|$HOME/.omp/profiles/pi-omp/agent|kit init engineer --target omp" "$CALL_LOG"
  assert_file "$HOME/.agentkit/adapters/omp/engineer/omp-ownership.json"
  assert_file "$HOME/.omp/profiles/pi-omp/agent/skills/ak-cook/SKILL.md"
  printf 'ok: AgentKit uses explicit Pi and OMP targets\n'
}

test_pi_wrapper_isolates_session_skills() {
  new_case pi-wrapper-session
  run_manager install pi-ak
  mkdir -p "$HOME/.pi/profiles/pi-ak/skills/ak-cook"
  printf '%s\n' '---' 'name: ak-cook' '---' >"$HOME/.pi/profiles/pi-ak/skills/ak-cook/SKILL.md"
  : >"$CALL_LOG"
  "$HOME/.local/bin/pi-ak" --help
  assert_contains "pi|$HOME/.pi/profiles/pi-ak|--no-skills --skill $HOME/.pi/profiles/pi-ak/skills --help" "$CALL_LOG"
  assert_not_contains '.agents/skills' "$CALL_LOG"
  mkdir -p "$CASE_ROOT/work/.pi/skills/project-skill"
  printf '%s\n' '---' 'name: project-skill' '---' >"$CASE_ROOT/work/.pi/skills/project-skill/SKILL.md"
  : >"$CALL_LOG"
  (cd "$CASE_ROOT/work" && "$HOME/.local/bin/pi-ak" chat prompt)
  assert_contains "pi|$HOME/.pi/profiles/pi-ak|--no-skills --skill $HOME/.pi/profiles/pi-ak/skills --skill " "$CALL_LOG"
  assert_contains "pi-wrapper-session/work/.pi/skills chat prompt" "$CALL_LOG"
  printf 'ok: pi wrapper isolates session skill discovery\n'
}

test_pi_wrapper_keeps_lifecycle_pass_through() {
  new_case pi-wrapper-lifecycle
  run_manager install pi-ak
  : >"$CALL_LOG"
  "$HOME/.local/bin/pi-ak" install npm:statusline-pi@1.2.1
  assert_contains "pi|$HOME/.pi/profiles/pi-ak|install npm:statusline-pi@1.2.1" "$CALL_LOG"
  assert_not_contains "pi|$HOME/.pi/profiles/pi-ak|--no-skills" "$CALL_LOG"
  printf 'ok: pi wrapper keeps lifecycle commands pass-through\n'
}

test_pi_wrapper_falls_back_without_pi_sources() {
  new_case pi-wrapper-fallback
  run_manager install pi-dev
  rm -rf "$HOME/.pi/profiles/pi-dev/skills"
  : >"$CALL_LOG"
  "$HOME/.local/bin/pi-dev" --help
  assert_contains "pi|$HOME/.pi/profiles/pi-dev|--help" "$CALL_LOG"
  assert_not_contains "pi|$HOME/.pi/profiles/pi-dev|--no-skills" "$CALL_LOG"
  printf 'ok: pi wrapper falls back when profile and project Pi sources are absent\n'
}

test_pi_wrapper_refuses_user_owned_rewrite() {
  new_case pi-wrapper-user-owned
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\nexit 0\n' >"$HOME/.local/bin/pi-ak"
  chmod 0755 "$HOME/.local/bin/pi-ak"
  if run_manager install pi-ak; then
    fail "user-owned pi-ak wrapper unexpectedly replaced"
  fi
  assert_contains 'refusing to overwrite user-owned wrapper without managed marker' "$OUTPUT"
  assert_contains 'exit 0' "$HOME/.local/bin/pi-ak"
  printf 'ok: pi wrapper refuses user-owned rewrite\n'
}

test_pi_wrapper_refuses_marker_substring_rewrite() {
  new_case pi-wrapper-marker-substring
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\n# not managed by pi-profile-manager\nexit 0\n' >"$HOME/.local/bin/pi-ak"
  chmod 0755 "$HOME/.local/bin/pi-ak"
  if run_manager install pi-ak; then
    fail "marker-substring pi-ak wrapper unexpectedly replaced"
  fi
  assert_contains 'refusing to overwrite user-owned wrapper without managed marker' "$OUTPUT"
  assert_contains 'not managed by pi-profile-manager' "$HOME/.local/bin/pi-ak"
  printf 'ok: pi wrapper refuses marker substring rewrite\n'
}

test_pi_omp_agentkit_fails_when_ak_writes_default_dest() {
  new_case pi-omp-ak-default-dest
  export FAKE_AK_OMP_DEST=default
  if run_manager install pi-omp; then
    fail "pi-omp install unexpectedly passed with default OMP AgentKit destination"
  fi
  unset FAKE_AK_OMP_DEST
  assert_contains 'not installed into the named OMP profile' "$OUTPUT"
  assert_contains 'AGENTKIT_OMP_HOME=' "$OUTPUT"
  assert_contains 'wrong default destination=' "$OUTPUT"
  assert_contains 'repair: re-run pi-profile-manager install pi-omp' "$OUTPUT"
  assert_file "$HOME/.omp/agent/skills/ak-cook/SKILL.md"
  printf 'ok: pi-omp AgentKit fails closed on default destination\n'
}

test_pi_omp_agentkit_missing_profile_skills_disables_inventory_and_verify() {
  new_case pi-omp-ak-missing-skills
  run_manager install pi-omp
  rm -rf "$HOME/.omp/profiles/pi-omp/agent/skills"
  run_manager_split profiles list --json
  assert_json_eq 'false' 'data.profiles[0].agentkitEnabled'
  if run_manager verify pi-omp; then
    fail "pi-omp verify unexpectedly passed without profile-local AgentKit skills"
  fi
  assert_contains 'not installed into the named OMP profile' "$OUTPUT"
  printf 'ok: pi-omp AgentKit missing skills disables inventory and verify\n'
}

test_pi_omp_agentkit_wrong_claim_disables_inventory_and_verify() {
  new_case pi-omp-ak-wrong-claim
  run_manager install pi-omp
  mkdir -p "$HOME/.agentkit/adapters/omp/engineer/.agentkit"
  printf '{"skills":["%s/.omp/agent/skills/ak-cook/SKILL.md"]}\n' "$HOME" >"$HOME/.agentkit/adapters/omp/engineer/.agentkit/native-skill-paths.json"
  run_manager_split profiles list --json
  assert_json_eq 'false' 'data.profiles[0].agentkitEnabled'
  if run_manager verify pi-omp; then
    fail "pi-omp verify unexpectedly passed with default OMP AgentKit claim"
  fi
  assert_contains 'out-of-profile claim' "$OUTPUT"
  printf 'ok: pi-omp AgentKit wrong claims disable inventory and verify\n'
}

test_wrong_root_stops_extensions() {
  new_case wrong-root
  export FAKE_MISE_WRONG_ROOT=1
  if run_manager install pi-dev; then
    fail "wrong root unexpectedly passed"
  fi
  unset FAKE_MISE_WRONG_ROOT
  assert_contains 'resolved root' "$OUTPUT"
  assert_not_contains 'npm|install -g' "$CALL_LOG"
  assert_not_contains 'mise|use -g' "$CALL_LOG"
  assert_not_contains 'pi|' "$CALL_LOG"
  assert_not_contains 'ak|' "$CALL_LOG"
  printf 'ok: wrong root stops binary, package, and AgentKit mutation\n'
}

test_exact_updates() {
  new_case updates
  run_manager install pi-dev
  run_manager install pi-omp
  : >"$CALL_LOG"
  run_manager update pi --version 0.84.3
  assert_contains 'npm|install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.3' "$CALL_LOG"
  assert_not_exists "$HOME/.config/mise/config.pi-ak.toml"
  run_manager update omp --version 18.0.4
  assert_contains 'mise|use -g --pin github:can1357/oh-my-pi@18.0.4' "$CALL_LOG"
  assert_contains 'mise|lock -g github:can1357/oh-my-pi' "$CALL_LOG"
  printf 'ok: exact binary updates\n'
}

test_wrong_root_stops_updates() {
  new_case wrong-root-update
  run_manager install pi-dev
  : >"$CALL_LOG"
  export FAKE_MISE_WRONG_ROOT=1
  if run_manager update pi --version 0.84.3; then
    fail "wrong root unexpectedly allowed pi update"
  fi
  unset FAKE_MISE_WRONG_ROOT
  assert_contains 'resolved root' "$OUTPUT"
  assert_not_contains 'npm|install -g' "$CALL_LOG"
  printf 'ok: wrong root stops binary update\n'
}

test_update_requires_installed_profile() {
  new_case update-without-profile
  if run_manager update pi --version 0.84.3; then
    fail "update without a managed profile unexpectedly passed"
  fi
  assert_contains 'no managed Pi profile found' "$OUTPUT"
  assert_not_contains 'npm|install -g' "$CALL_LOG"
  printf 'ok: update requires an installed managed profile\n'
}

test_update_dry_run_has_no_tool_invocation() {
  new_case update-dry-run
  run_manager install all
  : >"$CALL_LOG"
  run_manager update pi --dry-run
  run_manager update omp --dry-run
  run_manager update all --dry-run
  [[ ! -s "$CALL_LOG" ]] || fail "update dry-run invoked a fake dependency"
  if find "$HOME/.config/mise" "$HOME/.local/bin" -name '*.bak.*' | grep . >/dev/null; then
    fail "update dry-run created a backup"
  fi
  printf 'ok: update dry-run has no tool invocation or file mutation\n'
}

test_omp_update_guards() {
  new_case omp-update-guards
  if run_manager update omp --version 18.0.4; then
    fail "OMP update without pi-omp unexpectedly passed"
  fi
  assert_contains 'pi-omp update requires config' "$OUTPUT"
  assert_not_contains 'mise|use -g' "$CALL_LOG"

  run_manager install pi-omp
  : >"$CALL_LOG"
  export FAKE_MISE_WRONG_OMP_ROOT=1
  if run_manager update omp --version 18.0.4; then
    fail "wrong OMP root unexpectedly allowed update"
  fi
  unset FAKE_MISE_WRONG_OMP_ROOT
  assert_contains 'pi-omp resolved root' "$OUTPUT"
  assert_not_contains 'mise|use -g' "$CALL_LOG"
  printf 'ok: OMP update requires installed profile and correct root\n'
}

test_verify_all() {
  new_case verify
  run_manager install all
  run_manager verify all
  assert_contains 'pi-omp verification passed' "$OUTPUT"
  printf 'ok: verify all\n'
}

test_missing_dependency() {
  new_case missing-dependency
  rm "$FAKE_BIN/npm"
  if run_manager install pi-dev; then
    fail "missing npm unexpectedly passed"
  fi
  assert_contains 'missing required command: npm' "$OUTPUT"
  printf 'ok: missing dependency fails clearly\n'
}
test_add_profile_broker_and_security() {
  new_case add-broker
  run_manager add team-broker --auth broker --broker-url "https://broker.example.com" --broker-token "secret-token-xyz" --no-agentkit --dry-run
  assert_contains 'would write:' "$OUTPUT"
  assert_contains 'token redacted' "$OUTPUT"
  assert_not_contains 'secret-token-xyz' "$OUTPUT"
  assert_not_exists "$HOME/.omp/profiles/team-broker/agent/.env"
  assert_not_exists "$HOME/.config/mise/config.team-broker.toml"
  if run_manager add "bad.name" --auth local --no-agentkit; then
    fail "dot in profile name unexpectedly succeeded"
  fi
  assert_contains 'invalid profile name: bad.name' "$OUTPUT"

  if run_manager add "bad/name" --auth local --no-agentkit; then
    fail "slash in profile name unexpectedly succeeded"
  fi
  assert_contains 'invalid profile name: bad/name' "$OUTPUT"

  if run_manager add "../traversal" --auth local --no-agentkit; then
    fail "traversal in profile name unexpectedly succeeded"
  fi
  assert_contains 'invalid profile name: ../traversal' "$OUTPUT"

  if run_manager add "doctor" --auth local --no-agentkit; then
    fail "reserved profile name unexpectedly succeeded"
  fi
  assert_contains 'reserved profile name: doctor' "$OUTPUT"


  if run_manager add bad-url --auth broker --broker-url $'https://broker.example.com\nINJECT=1' --broker-token "tok" --no-agentkit; then
    fail "newline in broker-url unexpectedly succeeded"
  fi
  assert_contains 'cannot contain newline or carriage return' "$OUTPUT"
  assert_not_exists "$HOME/.config/mise/config.bad-url.toml"
  assert_not_exists "$HOME/.local/bin/bad-url"
  assert_not_exists "$HOME/.omp/profiles/bad-url"

  if run_manager add bad-tok --auth broker --broker-url "https://broker.example.com" --broker-token $'tok\r\nINJECT=1' --no-agentkit; then
    fail "carriage return in broker-token unexpectedly succeeded"
  fi
  assert_contains 'cannot contain newline or carriage return' "$OUTPUT"
  assert_not_exists "$HOME/.config/mise/config.bad-tok.toml"
  assert_not_exists "$HOME/.local/bin/bad-tok"
  assert_not_exists "$HOME/.omp/profiles/bad-tok"

  # Refuse overwriting user-owned .env without managed marker
  mkdir -p "$HOME/.omp/profiles/user-owned/agent"
  printf 'UNMANAGED_SECRET=123\n' >"$HOME/.omp/profiles/user-owned/agent/.env"
  if run_manager add user-owned --auth broker --broker-url "https://broker.example.com" --broker-token "tok" --no-agentkit; then
    fail "overwriting user-owned .env unexpectedly succeeded"
  fi
  assert_contains 'refusing to overwrite user-owned file without managed marker' "$OUTPUT"
  assert_contains 'UNMANAGED_SECRET=123' "$HOME/.omp/profiles/user-owned/agent/.env"
  assert_not_exists "$HOME/.config/mise/config.user-owned.toml"
  assert_not_exists "$HOME/.local/bin/user-owned"
  rm -rf "$HOME/.omp/profiles/user-owned"
  # Refuse overwriting user-owned .manager-profile without managed marker
  mkdir -p "$HOME/.omp/profiles/user-marker/agent"
  printf 'UNMANAGED_MARKER=1\n' >"$HOME/.omp/profiles/user-marker/agent/.manager-profile"
  if run_manager add user-marker --auth local --no-agentkit; then
    fail "overwriting user-owned .manager-profile unexpectedly succeeded"
  fi
  assert_contains 'refusing to overwrite user-owned file without managed marker' "$OUTPUT"
  assert_not_exists "$HOME/.config/mise/config.user-marker.toml"
  assert_not_exists "$HOME/.local/bin/user-marker"
  rm -rf "$HOME/.omp/profiles/user-marker"

  run_manager add team-broker --auth broker --broker-url "https://broker.example.com" --broker-token "secret-token-xyz" --no-agentkit
  local env_file="$HOME/.omp/profiles/team-broker/agent/.env"
  assert_file "$env_file"
  assert_file "$HOME/.config/mise/config.team-broker.toml"
  assert_file "$HOME/.local/bin/team-broker"

  local mode
  mode="$("$NODE_BIN" -e 'process.stdout.write((require("node:fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$env_file")"
  [[ "$mode" == "600" ]] || fail "expected mode 600 for .env, got $mode"

  assert_contains 'OMP_AUTH_BROKER_URL=https://broker.example.com' "$env_file"
  assert_contains 'OMP_AUTH_BROKER_TOKEN=secret-token-xyz' "$env_file"

  run_manager add team-broker --auth broker --broker-url "https://broker.example.com" --broker-token "secret-token-new" --no-agentkit
  local backups
  backups="$(find "$HOME/.omp/profiles/team-broker/agent" -name "*.bak*" -o -name "*.old*")"
  [[ -z "$backups" ]] || fail "unexpected backup file created for secrets: $backups"

  run_manager verify team-broker
  assert_contains 'team-broker verification passed' "$OUTPUT"

  run_manager_split profiles list --json
  assert_json_eq '1' 'data.profiles.length'
  assert_json_eq 'team-broker' 'data.profiles[0].id'
  assert_json_eq 'omp' 'data.profiles[0].runtime'
  assert_json_eq 'true' 'data.profiles[0].managed'
  assert_json_eq 'true' 'data.profiles[0].healthy'
  # Unrelated Mise configs must NOT be discovered as profiles
  printf '[tools]\npython = "3.12"\n' >"$HOME/.config/mise/config.python.toml"
  run_manager_split profiles list --json
  assert_json_eq '1' 'data.profiles.length'
  assert_json_eq 'false' 'data.profiles.some((p) => p.id === "python")'

  assert_json_eq 'false' 'data.profiles[0].agentkitEnabled'

  printf 'ok: add profile broker mode and security\n'
}

test_add_profile_local() {
  new_case add-local
  run_manager add team-local --auth local --no-agentkit
  assert_file "$HOME/.config/mise/config.team-local.toml"
  assert_file "$HOME/.local/bin/team-local"
  [[ -d "$HOME/.omp/profiles/team-local/agent" ]] || fail "missing local profile agent directory"
  assert_not_exists "$HOME/.omp/profiles/team-local/agent/.env"
  # Refuse overwriting user-owned config and ensure no mutation
  mkdir -p "$HOME/.config/mise"
  printf 'user_owned = true\n' >"$HOME/.config/mise/config.user-cfg.toml"
  if run_manager add user-cfg --auth local --no-agentkit; then
    fail "overwriting user-owned config unexpectedly succeeded"
  fi
  assert_contains 'refusing to overwrite user-owned config without managed marker' "$OUTPUT"
  assert_contains 'user_owned = true' "$HOME/.config/mise/config.user-cfg.toml"
  assert_not_exists "$HOME/.local/bin/user-cfg"
  assert_not_exists "$HOME/.omp/profiles/user-cfg"


  run_manager verify team-local
  assert_contains 'team-local verification passed' "$OUTPUT"

  run_manager add team-switch --auth broker --broker-url "https://broker.example.com" --broker-token "tok" --no-agentkit
  # Refuse removing user-owned .env when switching or adding local
  mkdir -p "$HOME/.omp/profiles/user-local/agent"
  printf 'UNMANAGED_SECRET=999\n' >"$HOME/.omp/profiles/user-local/agent/.env"
  if run_manager add user-local --auth local --no-agentkit; then
    fail "removing user-owned .env unexpectedly succeeded"
  fi
  assert_contains 'refusing to remove user-owned file without managed marker' "$OUTPUT"
  assert_contains 'UNMANAGED_SECRET=999' "$HOME/.omp/profiles/user-local/agent/.env"


  # Test custom profile add when omp binary is initially missing
  new_case add-missing-omp
  rm -f "$FAKE_BIN/omp"
  run_manager add team-fresh --auth local --no-agentkit
  assert_file "$FAKE_BIN/omp"
  assert_contains 'mise|use -g --pin github:can1357/oh-my-pi@18.0.4' "$CALL_LOG"
  assert_contains 'mise|-E team-fresh exec -- omp --version' "$CALL_LOG"
  assert_contains 'profile ready: team-fresh (local)' "$OUTPUT"

  # Test add fails if installed OMP version check fails
  rm -f "$FAKE_BIN/omp"
  export FAKE_OMP_VERSION_FAIL=1
  if run_manager add team-fail-omp --auth local --no-agentkit; then
    fail "add unexpectedly succeeded when omp --version fails"
  fi
  unset FAKE_OMP_VERSION_FAIL
  assert_contains 'failed to verify installed OMP in team-fail-omp: omp --version failed' "$OUTPUT"
  printf 'ok: add profile local mode\n'
}

test_add_profile_agentkit_verification() {
  new_case add-agentkit
  run_manager add team-ak --auth local --with-agentkit

  run_manager verify team-ak
  assert_contains 'team-ak verification passed' "$OUTPUT"

  rm -rf "$HOME/.omp/profiles/team-ak/agent/skills"
  if run_manager verify team-ak; then
    fail "verify unexpectedly passed for agentkit-enabled profile without skills"
  fi
  assert_contains 'AgentKit skills were not installed' "$OUTPUT"

  printf 'ok: add profile agentkit verification honors lifecycle intent\n'
}

test_add_review_fixes() {
  new_case add-review-fixes
  if run_manager add help --auth local --no-agentkit; then
    fail "reserved help unexpectedly succeeded"
  fi
  assert_contains 'reserved profile name: help' "$OUTPUT"
  if run_manager add pi-dev --auth local --no-agentkit; then
    fail "reserved pi-dev unexpectedly succeeded"
  fi
  assert_contains 'reserved profile name: pi-dev' "$OUTPUT"
  if run_manager add All --auth local --no-agentkit; then
    fail "case-folded reserved name unexpectedly succeeded"
  fi
  assert_contains 'reserved profile name: All' "$OUTPUT"

  if run_manager verify '../../etc/passwd'; then
    fail "traversal verify target unexpectedly succeeded"
  fi
  assert_contains 'invalid profile name' "$OUTPUT"

  run_manager add team-a --auth local --with-agentkit
  run_manager add team-b --auth local --with-agentkit
  run_manager verify team-a
  run_manager verify team-b
  run_manager_split profiles list --json
  assert_json_eq 'true' 'data.profiles.find((p) => p.id === "team-a").agentkitEnabled'
  assert_json_eq 'true' 'data.profiles.find((p) => p.id === "team-b").agentkitEnabled'

  mkdir -p "$HOME/.config/mise"
  printf '# managed by pi-profile-manager-custom\nuser=1\n' >"$HOME/.config/mise/config.prefix.toml"
  if run_manager add prefix --auth local --no-agentkit; then
    fail "prefix-colliding config unexpectedly overwritten"
  fi
  assert_contains 'refusing to overwrite user-owned config without managed marker' "$OUTPUT"
  assert_contains 'user=1' "$HOME/.config/mise/config.prefix.toml"

  mkdir -p "$HOME/.omp/profiles/negated/agent"
  printf '# not managed by pi-profile-manager\n' >"$HOME/.omp/profiles/negated/agent/.manager-profile"
  printf '[env]\nOMP_PROFILE = "negated"\n' >"$HOME/.config/mise/config.negated.toml"
  printf '#!/bin/sh\nexit 0\n' >"$HOME/.local/bin/negated"
  chmod 0755 "$HOME/.local/bin/negated"
  run_manager_split profiles list --json
  assert_json_eq 'false' 'data.profiles.some((p) => p.id === "negated")'

  mkdir -p "$HOME/.config/mise"
  chmod 555 "$HOME/.config/mise"
  if run_manager add ro-cfg --auth local --no-agentkit; then
    chmod 755 "$HOME/.config/mise"
    fail "add unexpectedly succeeded with unwritable mise config dir"
  fi
  chmod 755 "$HOME/.config/mise"
  assert_contains 'not writable' "$OUTPUT"
  assert_not_exists "$HOME/.omp/profiles/ro-cfg"

  mkdir -p "$HOME/.omp/profiles/ak-link/agent"
  ln -s "$HOME/.omp/profiles/ak-link/missing" "$HOME/.omp/profiles/ak-link/agent/.agentkit-profile"
  if run_manager add ak-link --auth local --with-agentkit; then
    fail "symlink .agentkit-profile unexpectedly accepted"
  fi
  assert_contains 'managed target is not a regular file' "$OUTPUT"
  assert_not_exists "$HOME/.config/mise/config.ak-link.toml"

  export FAKE_OMP_VERSION_FAIL=1
  if run_manager add team-stale-omp --auth local --no-agentkit; then
    fail "existing omp version failure unexpectedly succeeded"
  fi
  unset FAKE_OMP_VERSION_FAIL
  assert_contains 'failed to verify existing OMP in team-stale-omp: omp --version failed' "$OUTPUT"

  run_manager add team-meta --auth local --with-agentkit
  printf '{}\n' >"$HOME/.agentkit/adapters/omp/engineer/omp-ownership.json"
  run_manager_split profiles list --json
  assert_json_eq 'false' 'data.profiles.find((p) => p.id === "team-meta").agentkitEnabled'
  if run_manager verify team-meta; then
    fail "verify unexpectedly passed with malformed ownership"
  fi
  assert_contains 'malformed AgentKit ownership metadata' "$OUTPUT"

  printf 'ok: add review findings\n'
}

test_bootstrap_dry_run_has_no_mutation
test_bootstrap_existing_mise_is_noop
test_bootstrap_existing_off_path_mise_is_noop
test_bootstrap_installs_mise
test_bootstrap_download_failure_cleans_up
test_bootstrap_installer_failure_cleans_up
test_bootstrap_partial_installer_failure_cleans_up
test_bootstrap_verification_failure_cleans_up
test_bootstrap_refuses_non_executable_target
test_dry_run_has_no_mutation
test_dry_run_all_has_no_tool_invocation
test_profiles_inventory_empty
test_profiles_inventory_pi_dev
test_profiles_inventory_pi_ak_agentkit
test_profiles_inventory_pi_omp_agentkit
test_profiles_inventory_accepts_one_legacy_extra_newline
test_profiles_inventory_rejects_two_extra_newlines
test_profiles_inventory_drift_is_unhealthy
test_profiles_inventory_foreign_is_unhealthy
test_pi_dev_install_and_idempotency
test_changed_managed_file_is_backed_up
test_agentkit_targets
test_pi_wrapper_isolates_session_skills
test_pi_wrapper_keeps_lifecycle_pass_through
test_pi_wrapper_falls_back_without_pi_sources
test_pi_wrapper_refuses_user_owned_rewrite
test_pi_wrapper_refuses_marker_substring_rewrite
test_pi_omp_agentkit_fails_when_ak_writes_default_dest
test_pi_omp_agentkit_missing_profile_skills_disables_inventory_and_verify
test_pi_omp_agentkit_wrong_claim_disables_inventory_and_verify
test_wrong_root_stops_extensions
test_exact_updates
test_wrong_root_stops_updates
test_update_requires_installed_profile
test_update_dry_run_has_no_tool_invocation
test_omp_update_guards
test_verify_all
test_missing_dependency
test_add_profile_broker_and_security
test_add_profile_local
test_add_profile_agentkit_verification
test_add_review_fixes
printf 'PASS: pi-profile-manager isolated tests\n'
