# Pi Profile Manager

[English](README.md) | [Tiếng Việt](README.vi.md)

Cài và duy trì ba profile độc lập cho [Pi](https://github.com/badlogic/pi-mono), [Oh My Pi](https://github.com/can1357/oh-my-pi) và [AgentKit](https://agentkit.best/?ref=OMG49S8R):

```text
pi-dev  = Pi upstream + selected extensions
pi-ak   = Pi upstream + selected extensions + AgentKit
pi-omp  = Oh My Pi + AgentKit
```

Mỗi profile có runtime config, skills, extensions và sessions riêng. Profile isolation không phải process sandbox và không tách repositories, credentials, ports, containers hay tài nguyên khác ở tầng OS.

## Điều kiện

- Node.js 22 trở lên
- npm
- Bash trên macOS và Linux
- PowerShell trên Windows native

[Mise](https://mise.jdx.dev/) là dependency runtime; `bootstrap` có thể cài khi máy chưa có. [AgentKit](https://agentkit.best/?ref=OMG49S8R) (`ak`) chỉ bắt buộc cho `pi-ak` và `pi-omp`.

macOS Apple Silicon đã kiểm chứng. macOS Intel và Linux x64/arm64 là target support. Windows 10/11 x64 native là CI-tested, chưa end-to-end với Pi, OMP, AgentKit và provider authentication thật. Windows ARM64 native không hỗ trợ.

## Cài đặt

### macOS và Linux

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

Mở terminal mới sau khi thêm `%USERPROFILE%\bin` vào user `PATH`. Package không có `postinstall` và không sửa PowerShell profile.

`@latest` theo npm dist-tag `latest`. Pin version cụ thể khi cần reproduce hoặc rollback (Advanced).

## Profiles

```bash
pi-profile-manager install pi-dev --dry-run
pi-profile-manager install pi-dev
```

`pi-ak` và `pi-omp` cần `ak` trên `PATH`. Profile tùy biến, verify và inventory JSON nằm trong Advanced.

## An toàn

- Không đọc hoặc copy provider credentials.
- Không tự chạy mutation qua npm lifecycle scripts.
- Không overwrite executable không có receipt hợp lệ, hoặc đã drift khỏi checksum trong receipt.
- Upgrade tạo backup và rollback nếu replacement thất bại.
- `--dry-run` của payload không chạy installer hoặc network mutation.
- Không chống directory-swap đồng thời từ process khác cùng quyền user.
- Uninstall chỉ xóa manager artifacts đã xác minh ownership; không xóa profiles, credentials hay backups.

## Development

```bash
npm test
npm pack --dry-run
```

Source được phát hành theo [MIT License](LICENSE).

<details>
<summary>Advanced</summary>

### Thêm profiles

```bash
pi-profile-manager install pi-ak --dry-run
pi-profile-manager install pi-ak
pi-profile-manager install pi-omp --dry-run
pi-profile-manager install pi-omp
pi-profile-manager verify all
```

### Thêm profile Oh My Pi tùy biến

Nên dùng interactive setup. Token nhập ở prompt không nằm trên argv:

```bash
pi-profile-manager add
pi-profile-manager add my-team
```

Cờ broker. Dùng URL `https://` đáng tin. `--broker-token` đưa giá trị đã expand vào argv.

```bash
pi-profile-manager add my-team \
  --auth broker \
  --broker-url https://broker.example.internal \
  --broker-token "$OMP_AUTH_BROKER_TOKEN" \
  --dry-run
```

Chế độ local kèm AgentKit:

```bash
pi-profile-manager add my-local --auth local --with-agentkit
pi-profile-manager verify my-team
```

Khi chọn broker, `OMP_AUTH_BROKER_URL` và `OMP_AUTH_BROKER_TOKEN` được lưu vào `~/.omp/profiles/<name>/agent/.env` (POSIX `0600`). Manager không tạo backup chứa secrets.

### Inventory

```bash
pi-profile-manager profiles list --json
```

Stdout là schema version 1; diagnostics ghi stderr. Exit 0 gồm inventory rỗng và profile unhealthy. Phải đọc `managed` và `healthy`; đừng coi exit 0 là mọi profile healthy. Command không đọc credentials và không repair profile.

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

Uninstall chỉ xóa manager artifacts có thể xác minh ownership.

### Nguồn bootstrap

Trên macOS/Linux, `bootstrap` tải official installer từ `https://mise.run` và chạy; `mise --version` không phải kiểm tra authenticity mật mã. Trên Windows gọi `winget install --id jdx.mise --exact`. Nếu Mise đã có, command là no-op.

</details>
