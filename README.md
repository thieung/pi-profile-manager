# Pi Profile Manager

[English](README.md) | [Tiếng Việt](README.vi.md)

Set up and maintain three isolated profiles for [Pi](https://github.com/badlogic/pi-mono), [Oh My Pi](https://github.com/can1357/oh-my-pi), and [AgentKit](https://agentkit.best/?ref=OMG49S8R):

```text
pi-dev  = upstream Pi + selected extensions
pi-ak   = upstream Pi + selected extensions + AgentKit
pi-omp  = Oh My Pi + AgentKit
```

Each profile gets its own runtime configuration, skills, extensions, and sessions. Profile isolation is not a process sandbox and does not isolate repositories, credentials, ports, containers, or other OS-level resources.

## Requirements

- Node.js 22 or later
- npm
- Bash on macOS and Linux
- PowerShell on native Windows

[Mise](https://mise.jdx.dev/) is a runtime dependency; `bootstrap` can install it when missing. [AgentKit](https://agentkit.best/?ref=OMG49S8R) (`ak`) is required for `pi-ak`, `pi-omp`, and custom profiles with `--with-agentkit`.

macOS Apple Silicon is verified. macOS Intel and Linux x64/arm64 are target support. Native Windows 10/11 x64 is CI-tested, not end-to-end with real Pi, OMP, AgentKit, and provider authentication. Native Windows ARM64 is unsupported.

## Install

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

Open a new terminal after adding `%USERPROFILE%\bin` to your user `PATH`. The package has no `postinstall` script and does not edit your PowerShell profile.

`@latest` follows npm's `latest` dist-tag. Pin a concrete version for reproducible installs or rollback (Advanced).

## Profiles

```bash
pi-profile-manager install pi-dev --dry-run
pi-profile-manager install pi-dev
```

`pi-ak` and `pi-omp` need `ak` on `PATH`. Custom profiles, verify, and inventory JSON are in Advanced.

## Safety

- Never reads or copies provider credentials.
- Never mutates the system through npm lifecycle scripts.
- Never overwrites an executable without a valid ownership receipt, or one whose checksum has drifted from its receipt.
- Creates a backup before an upgrade and rolls back if replacement fails.
- Payload `--dry-run` never runs an installer or performs a network mutation.
- Does not protect against a concurrent directory-swap from another process running as the same user.
- Uninstall does not remove profiles, credentials, or backups.

## Development

```bash
npm test
npm pack --dry-run
```

Released under the [MIT License](LICENSE).

<details>
<summary>Advanced</summary>

### More profiles

```bash
pi-profile-manager install pi-ak --dry-run
pi-profile-manager install pi-ak
pi-profile-manager install pi-omp --dry-run
pi-profile-manager install pi-omp
pi-profile-manager verify all
```

### Add a custom Oh My Pi profile

Interactive setup is preferred. Tokens typed at the prompt are not placed on argv:

```bash
pi-profile-manager add
pi-profile-manager add my-team
```

Broker flags. Use a trusted `https://` URL. `--broker-token` puts the expanded value in the process argument list.

```bash
pi-profile-manager add my-team \
  --auth broker \
  --broker-url https://broker.example.internal \
  --broker-token "$OMP_AUTH_BROKER_TOKEN" \
  --dry-run
```

Local mode with AgentKit:

```bash
pi-profile-manager add my-local --auth local --with-agentkit
pi-profile-manager verify my-team
```

When broker mode is selected, `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN` are stored in `~/.omp/profiles/<name>/agent/.env` (POSIX `0600`). The manager never creates backup copies containing secrets.

### Inventory

```bash
pi-profile-manager profiles list --json
```

Stdout is schema version 1; diagnostics go to stderr. Exit 0 includes empty and unhealthy inventories. Inspect `managed` and `healthy`; do not treat exit 0 as all profiles healthy. The command never reads credentials or repairs profiles.

### Update, status, uninstall

```bash
npx --yes --package @thieung/pi-profile-manager@latest ppm-bootstrap install
npx --yes --package @thieung/pi-profile-manager@1.2.4 ppm-bootstrap install
npx --yes --package @thieung/pi-profile-manager@latest ppm-bootstrap status
npx --yes --package @thieung/pi-profile-manager@latest ppm-bootstrap uninstall
```

```bash
pi-profile-manager update pi
pi-profile-manager update omp
pi-profile-manager update all
pi-profile-manager update pi --version 0.84.3
pi-profile-manager update omp --version 18.0.4
```

Uninstall removes only manager artifacts whose ownership can be verified.

### Bootstrap provenance

On macOS/Linux, `bootstrap` downloads the official installer from `https://mise.run` and runs it; `mise --version` is not a cryptographic authenticity check. On Windows it runs `winget install --id jdx.mise --exact`. If Mise is already available, `bootstrap` is a no-op.

</details>
