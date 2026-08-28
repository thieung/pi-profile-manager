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
  grep -F "$needle" "$file" >/dev/null || fail "missing '$needle' in $file"
}

assert_not_contains() {
  local needle="$1"
  local file="$2"
  if grep -F "$needle" "$file" >/dev/null; then
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
esac
FAKE_PI

  cat >"$fake_bin/omp" <<'FAKE_OMP'
#!/usr/bin/env bash
set -euo pipefail
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
  mkdir -p "$AGENTKIT_OMP_HOME/skills" "$HOME/.agentkit/adapters/omp/engineer"
  printf '{"version":1,"kit":"engineer","claims":["skills"]}\n' >"$HOME/.agentkit/adapters/omp/engineer/omp-ownership.json"
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
  use|lock)
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
      pi-omp)
        export OMP_PROFILE="pi-omp"
        export AGENTKIT_OMP_HOME="$HOME/.omp/profiles/pi-omp/agent"
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
  printf 'ok: AgentKit uses explicit Pi and OMP targets\n'
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
test_profiles_inventory_drift_is_unhealthy
test_profiles_inventory_foreign_is_unhealthy
test_pi_dev_install_and_idempotency
test_changed_managed_file_is_backed_up
test_agentkit_targets
test_wrong_root_stops_extensions
test_exact_updates
test_wrong_root_stops_updates
test_update_requires_installed_profile
test_update_dry_run_has_no_tool_invocation
test_omp_update_guards
test_verify_all
test_missing_dependency
printf 'PASS: pi-profile-manager isolated tests\n'
