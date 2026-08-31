# Pi Profile Manager

[English](README.md) | [Tiếng Việt](README.vi.md)

Set up and maintain three isolated profiles for [Pi](https://github.com/badlogic/pi-mono), [Oh My Pi](https://github.com/can1357/oh-my-pi), and [AgentKit](https://agentkit.best/?ref=OMG49S8R):

```text
pi-dev  = upstream Pi + selected extensions
pi-ak   = upstream Pi + selected extensions + AgentKit
pi-omp  = Oh My Pi + AgentKit
```

Each profile gets its own runtime configuration, skills, extensions, and sessions. The `pi-dev`/`pi-ak` CLI wrappers isolate Pi skill discovery for interactive sessions when profile skills or `$PWD/.pi` exists: they disable Pi auto-discovery and load profile skills first, then `$PWD/.pi/skills` when present. If neither profile skills nor project `.pi` exists, the wrapper falls back to plain Pi discovery. Pi lifecycle commands (`install`, `remove`, `uninstall`, `update`, `list`, `config`, `auth`) always pass through unchanged. Embedded hosts that do not execute the wrapper, including Orca sessions, are not covered by this CLI isolation.

Profile isolation does not provide a process sandbox or isolate repositories, credentials, ports, containers, or other OS-level resources.

## Requirements

- Node.js 22 or later
- npm
- Bash on macOS and Linux
- PowerShell or Command Prompt on native Windows

[Mise](https://mise.jdx.dev/) is a runtime dependency. The manager can install Mise when it is missing. AgentKit is required only for the `pi-ak` and `pi-omp` profiles.

## Supported OS

| Environment | Status | Notes |
|---|---|---|
| macOS Apple Silicon | Verified | Automated tests, a local tarball smoke test, and a registry smoke test passed. |
| macOS Intel | Target support | Uses the same Unix/Bash contract; no native smoke test has been run on Intel hardware. |
| Linux x64/arm64 | Target support | The Bash/Linux code path is implemented; Linux CI and clean-machine smoke tests are still pending. |
| Windows through WSL2 | Unverified | The Linux workflow may work inside WSL2, but it is not currently claimed as supported. |
| Native Windows 10/11 x64 | CI-tested | Node payload, `.cmd` wrappers, and package gates passed on `windows-latest`; a provider-backed native smoke test is still pending. |
| Native Windows ARM64 | Unsupported | There is not enough CI or runtime evidence for the complete profile workflow. |

`Target support` means the implementation was designed for that platform, not that it has been fully tested across every distribution or architecture.

### Native Windows contract

The Windows implementation uses a dedicated adapter:

- Manager launcher/runtime: `%USERPROFILE%\bin\pi-profile-manager.{cmd,mjs}`
- Receipt, lock, and backups: `%LOCALAPPDATA%\pi-profile-manager`
- Pi profiles: `%USERPROFILE%\.pi\profiles\{pi-dev,pi-ak}`
- OMP profile: `%USERPROFILE%\.omp\profiles\pi-omp\agent`
- Mise configs: `%USERPROFILE%\.config\mise\config.<profile>.toml`
- Mise bootstrap: exact WinGet package `jdx.mise`; it never runs `mise.run`
- Foreign or drifted manager artifacts fail closed; symlinks and junctions inside managed paths are rejected
- Profile configs and wrappers are updated only when they contain the managed marker; user-owned files are rejected

Pi, OMP, and AgentKit all provide Windows implementations upstream, but AgentKit still classifies its Pi/OMP adapters as spikes. Windows support is therefore `CI-tested`, not verified end to end with real Pi, OMP, AgentKit, and provider authentication.

## Install the manager

### macOS and Linux

```bash
npx --yes --package @thieung/pi-profile-manager@latest ppm-bootstrap install
export PATH="$HOME/.local/bin:$PATH"
pi-profile-manager bootstrap --dry-run
pi-profile-manager bootstrap
pi-profile-manager doctor
```

### Windows PowerShell

```powershell
npx --yes --package @thieung/pi-profile-manager@latest ppm-bootstrap install
$env:Path = "$HOME\bin;$env:Path"
pi-profile-manager bootstrap --dry-run
pi-profile-manager bootstrap
pi-profile-manager doctor
```

Open a new terminal after adding `%USERPROFILE%\bin` to your user `PATH`. The package does not modify your PowerShell profile or machine/user `PATH`.

The npm package has no `postinstall` script. Only the explicit `install` command writes the manager executable and its ownership receipt:

- macOS/Linux executable: `~/.local/bin/pi-profile-manager`
- macOS/Linux receipt: `~/.local/share/pi-profile-manager/receipt.json`
- Windows executable: `%USERPROFILE%\bin\pi-profile-manager.{cmd,mjs}`
- Windows receipt: `%LOCALAPPDATA%\pi-profile-manager\receipt.json`

Using `@latest` resolves the version currently assigned to npm's `latest` dist-tag. Pin a concrete version when you need reproducible installation or rollback.

## Bootstrap Mise

If `doctor` reports that Mise is missing:

```bash
pi-profile-manager bootstrap --dry-run
pi-profile-manager bootstrap
pi-profile-manager doctor
```

On macOS/Linux, `bootstrap` downloads the official installer from `https://mise.run` to a temporary file. It installs into a staging directory on the same filesystem, verifies the staged binary with `--version`, and then atomically renames it to `~/.local/bin/mise`. A failed download, installation, or verification leaves the final target absent and removes staging files.

The command does not pipe a network response directly into a shell, use `sudo`, edit shell startup files, or install Node.js, npm, or AgentKit. On Windows, it runs the exact package command `winget install --id jdx.mise --exact` and verifies `mise --version`. If Mise is already available, `bootstrap` is an idempotent no-op.

## Install profiles

Preview each mutation before applying it:

```bash
pi-profile-manager install pi-dev --dry-run
pi-profile-manager install pi-dev

pi-profile-manager install pi-ak --dry-run
pi-profile-manager install pi-ak

pi-profile-manager install pi-omp --dry-run
pi-profile-manager install pi-omp

pi-profile-manager verify all
```

## Discover installed profiles

Tools can consume a read-only inventory without scanning the home directory or guessing profile paths:

```bash
pi-profile-manager profiles list --json
```

The command returns only profiles evidenced by Pi Profile Manager's fixed config or wrapper paths. JSON on stdout follows schema version `1`; diagnostics go to stderr. It exits `0` for an empty inventory and for profiles reported as unhealthy, and non-zero only when it cannot produce a trustworthy inventory or the invocation is invalid. `agentkitEnabled` requires valid AgentKit lifecycle evidence, `managed` verifies manager ownership, and `healthy` additionally verifies the profile root, generated artifacts, and runtime environment. The command never repairs profiles or reads credentials.

## Update

Update the manager to the npm `latest` dist-tag:

```bash
npx --yes --package @thieung/pi-profile-manager@latest ppm-bootstrap install
```

Update the Pi or OMP runtime:

```bash
pi-profile-manager update pi
pi-profile-manager update omp
# or update both
pi-profile-manager update all
```

Pin a runtime version:

```bash
pi-profile-manager update pi --version 0.84.3
pi-profile-manager update omp --version 18.0.4
```

Pin a manager version for reproduction or rollback:

```bash
npx --yes --package @thieung/pi-profile-manager@1.2.4 ppm-bootstrap install
```

## Status and uninstall

```bash
npx --yes --package @thieung/pi-profile-manager@latest ppm-bootstrap status
npx --yes --package @thieung/pi-profile-manager@latest ppm-bootstrap uninstall
```

Uninstall removes only manager artifacts whose ownership can be verified. Profiles, Mise configuration, wrappers, credentials, and backups remain untouched.

## Safety contract

- Never reads or copies provider credentials.
- Never mutates the system through npm lifecycle scripts.
- Never overwrites an executable without a valid ownership receipt.
- Never overwrites an executable whose checksum has drifted from its receipt.
- Creates a backup before an upgrade and rolls back if replacement fails.
- Payload `--dry-run` never runs an installer or performs a network mutation.
- Version 1 assumes that the current user is the only actor modifying managed paths during command execution; it does not protect against a concurrent directory-swap attack from another process running as the same user.

## Development

```bash
npm test
npm pack --dry-run
```

Released under the [MIT License](LICENSE).
