# Pi Profile Manager

[English](README.md) | [Tiếng Việt](README.vi.md)

Package bootstrap công khai cho ba profile độc lập của [Pi](https://github.com/badlogic/pi-mono), [Oh My Pi](https://github.com/can1357/oh-my-pi) và [AgentKit](https://github.com/bestagentkits/agentkit):

```text
pi-dev  = Pi upstream + selected extensions
pi-ak   = Pi upstream + selected extensions + AgentKit
pi-omp  = Oh My Pi + AgentKit
```

Mỗi profile có runtime config, skills, extensions và sessions riêng. Profile isolation không phải process sandbox và không tách repositories, credentials, ports, containers hay các tài nguyên khác ở tầng OS.

## Điều Kiện

- Node.js 22 trở lên
- npm
- Bash trên macOS và Linux
- PowerShell hoặc Command Prompt trên Windows native

[Mise](https://mise.jdx.dev/) là dependency runtime; manager có thể cài Mise nếu máy chưa có. AgentKit chỉ bắt buộc khi cài `pi-ak` hoặc `pi-omp`.

## Supported OS

| Môi trường | Trạng thái | Ghi chú |
|---|---|---|
| macOS Apple Silicon | Đã kiểm chứng | Automated tests, local tarball và registry smoke đã pass. |
| macOS Intel | Target support | Cùng Unix/Bash contract; chưa có native smoke trên máy Intel. |
| Linux x64/arm64 | Target support | Code path hỗ trợ Bash/Linux; chưa có Linux CI hoặc clean-machine smoke. |
| Windows qua WSL2 | Chưa kiểm chứng | Có thể dùng Linux workflow bên trong WSL, nhưng chưa được claim support. |
| Windows 10/11 x64 native | CI-tested | Node payload, `.cmd` wrappers và package gates đã pass trên `windows-latest`; chưa có provider-backed native smoke. |
| Windows ARM64 native | Không hỗ trợ | Chưa có đủ CI/runtime evidence cho full profile workflow. |

`Target support` nghĩa là implementation được thiết kế cho platform đó nhưng chưa đạt cùng evidence level với macOS Apple Silicon. Không nên hiểu là đã được test đầy đủ trên mọi distribution hoặc architecture.

### Windows native support contract

Windows implementation dùng adapter riêng:

- Manager launcher/runtime: `%USERPROFILE%\bin\pi-profile-manager.{cmd,mjs}`
- Receipt, lock và backups: `%LOCALAPPDATA%\pi-profile-manager`
- Pi profiles: `%USERPROFILE%\.pi\profiles\{pi-dev,pi-ak}`
- OMP profile: `%USERPROFILE%\.omp\profiles\pi-omp\agent`
- Mise configs: `%USERPROFILE%\.config\mise\config.<profile>.toml`
- Mise bootstrap: exact WinGet package `jdx.mise`; không chạy `mise.run`
- Foreign/drifted manager artifacts fail-closed; symlink/junction trong managed paths bị từ chối
- Profile config và wrapper chỉ được update khi có managed marker; file user-owned bị từ chối

Pi, OMP và AgentKit đều có Windows implementation upstream, nhưng AgentKit vẫn xếp Pi/OMP adapters ở mức `spike`. Windows hiện đạt mức `CI-tested`; chỉ được claim end-to-end sau native runtime smoke với Pi/OMP/AgentKit thật và provider authentication.

## Cài Manager

### macOS/Linux

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

Mở terminal mới sau khi thêm `%USERPROFILE%\bin` vào user `PATH`. Package không tự sửa PowerShell profile hoặc machine/user `PATH`.

Package không có `postinstall`. Chỉ explicit command `install` mới ghi manager executable và ownership receipt:

- macOS/Linux executable: `~/.local/bin/pi-profile-manager`
- macOS/Linux receipt: `~/.local/share/pi-profile-manager/receipt.json`
- Windows executable: `%USERPROFILE%\bin\pi-profile-manager.{cmd,mjs}`
- Windows receipt: `%LOCALAPPDATA%\pi-profile-manager\receipt.json`

`@latest` resolve version đang được gắn npm dist-tag `latest`. Khi cần reproduce chính xác hoặc rollback, hãy pin version cụ thể.

## Bootstrap Mise

Nếu `doctor` báo thiếu Mise:

```bash
pi-profile-manager bootstrap --dry-run
pi-profile-manager bootstrap
pi-profile-manager doctor
```

Trên macOS/Linux, `bootstrap` tải official installer từ `https://mise.run` vào temporary file. Installer chỉ ghi vào staging directory cùng filesystem; manager chạy `--version` trên binary staging rồi mới atomic rename thành `~/.local/bin/mise`. Nếu download, install hoặc verification lỗi, target cuối vẫn absent và staging được dọn.

Command không pipe network response trực tiếp vào shell, không dùng `sudo`, không sửa shell rc và không tự cài Node.js/npm hoặc AgentKit. Trên Windows, `bootstrap` gọi exact package `winget install --id jdx.mise --exact`, rồi verify `mise --version`. Nếu Mise đã có, command là idempotent no-op trên mọi platform.

## Cài Profiles

Preview từng mutation trước khi apply:

```bash
pi-profile-manager install pi-dev --dry-run
pi-profile-manager install pi-dev

pi-profile-manager install pi-ak --dry-run
pi-profile-manager install pi-ak

pi-profile-manager install pi-omp --dry-run
pi-profile-manager install pi-omp

pi-profile-manager verify all
```

## Update

Update manager theo npm dist-tag `latest`:

```bash
npx --yes --package @thieung/pi-profile-manager@latest ppm-bootstrap install
```

Update Pi hoặc OMP runtime:

```bash
pi-profile-manager update pi
pi-profile-manager update omp
# hoặc update cả hai
pi-profile-manager update all
```

Pin runtime version cụ thể:

```bash
pi-profile-manager update pi --version 0.84.3
pi-profile-manager update omp --version 18.0.4
```

Pin manager version để reproduce hoặc rollback:

```bash
npx --yes --package @thieung/pi-profile-manager@1.2.2 ppm-bootstrap install
```

## Status Và Uninstall

```bash
npx --yes --package @thieung/pi-profile-manager@latest ppm-bootstrap status
npx --yes --package @thieung/pi-profile-manager@latest ppm-bootstrap uninstall
```

Uninstall chỉ xóa manager artifacts có thể xác minh ownership. Profiles, Mise config, wrappers, credentials và backups được giữ nguyên.

## Safety Contract

- Không đọc hoặc copy provider credentials.
- Không tự chạy mutation qua npm lifecycle scripts.
- Không overwrite executable không có receipt hợp lệ.
- Không overwrite executable đã drift khỏi checksum trong receipt.
- Upgrade tạo backup và rollback nếu replacement thất bại.
- `--dry-run` của payload không chạy installer hoặc network mutation.
- V1 giả định user đang chạy tool là actor duy nhất sửa managed paths trong lúc command thực thi; tool không chống directory-swap đồng thời từ process khác có cùng quyền user.

## Development

```bash
npm test
npm pack --dry-run
```

Source được phát hành theo [MIT License](LICENSE).
