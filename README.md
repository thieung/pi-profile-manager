# Pi Profile Manager

Public bootstrap package cho ba profile độc lập:

```text
pi-dev  = Pi upstream + selected extensions
pi-ak   = Pi upstream + selected extensions + AgentKit
pi-omp  = Oh My Pi + AgentKit
```

Package yêu cầu Node.js 22+ và npm. Unix payload dùng Bash; Windows native dùng
Node.js + `.cmd`. Mise là dependency runtime; AgentKit chỉ bắt buộc khi cài
`pi-ak` hoặc `pi-omp`.

## Supported OS

| Môi trường | Trạng thái | Ghi chú |
|---|---|---|
| macOS Apple Silicon | Đã kiểm chứng | Automated tests, local tarball và registry smoke đã pass. |
| macOS Intel | Target support | Cùng Unix/Bash contract; chưa có native smoke trên máy Intel. |
| Linux x64/arm64 | Target support | Code path hỗ trợ Bash/Linux; chưa có Linux CI hoặc clean-machine smoke. |
| Windows qua WSL2 | Chưa kiểm chứng | Có thể dùng Linux workflow bên trong WSL, nhưng chưa được claim support. |
| Windows 10/11 x64 native | CI-tested | Node payload, `.cmd` wrappers và package gates đã pass trên `windows-latest`; chưa có provider-backed native smoke. |
| Windows ARM64 native | Không hỗ trợ | Chưa có CI/runtime evidence cho full profile workflow. |

`Target support` nghĩa là implementation được thiết kế cho platform đó nhưng
chưa đạt cùng evidence level với macOS Apple Silicon. Không nên hiểu là đã được
test đầy đủ trên mọi distribution hoặc architecture.

### Windows native support contract

Windows implementation dùng adapter riêng:

- Manager launcher/runtime: `%USERPROFILE%\bin\pi-profile-manager.{cmd,mjs}`.
- Receipt, lock và backups: `%LOCALAPPDATA%\pi-profile-manager`.
- Pi profiles: `%USERPROFILE%\.pi\profiles\{pi-dev,pi-ak}`.
- OMP profile: `%USERPROFILE%\.omp\profiles\pi-omp\agent`.
- Mise configs: `%USERPROFILE%\.config\mise\config.<profile>.toml`.
- Mise bootstrap: exact WinGet package `jdx.mise`; không chạy `mise.run`.
- Foreign/drifted manager artifacts fail-closed; symlink/junction trong managed paths bị từ chối.
- Profile config và wrapper chỉ được update khi có managed marker; file user-owned bị từ chối.

Pi, OMP và AgentKit đều có Windows implementation upstream, nhưng AgentKit vẫn
xếp Pi/OMP adapters ở mức `spike`. Windows hiện đạt mức `CI-tested`; chỉ được
claim end-to-end sau native runtime smoke với Pi/OMP/AgentKit thật.

## Cài Manager

### macOS/Linux

```bash
npx --yes --package @thieung/pi-profile-manager@1.2.1 ppm-bootstrap install
export PATH="$HOME/.local/bin:$PATH"
pi-profile-manager bootstrap --dry-run
pi-profile-manager bootstrap
pi-profile-manager doctor
```

Package không có `postinstall`. Chỉ explicit command `install` mới ghi
`~/.local/bin/pi-profile-manager` và ownership receipt tại
`~/.local/share/pi-profile-manager/receipt.json`.

### Windows PowerShell

```powershell
npx --yes --package @thieung/pi-profile-manager@1.2.1 ppm-bootstrap install
$env:Path = "$HOME\bin;$env:Path"
pi-profile-manager bootstrap --dry-run
pi-profile-manager bootstrap
pi-profile-manager doctor
```

Mở terminal mới sau khi thêm `%USERPROFILE%\bin` vào user `PATH`. Package không
tự sửa PowerShell profile hoặc machine/user `PATH`.

## Bootstrap Mise

Nếu `doctor` báo thiếu Mise:

```bash
pi-profile-manager bootstrap --dry-run
pi-profile-manager bootstrap
pi-profile-manager doctor
```

Trên macOS/Linux, `bootstrap` tải official installer từ `https://mise.run` vào temporary file.
Installer chỉ ghi vào staging directory cùng filesystem; manager chạy
`--version` trên binary staging rồi mới atomic rename thành
`~/.local/bin/mise`. Nếu download, install hoặc verification lỗi, target cuối
vẫn absent và staging được dọn. Command không pipe network response trực tiếp
vào shell, không dùng `sudo`, không sửa shell rc và không tự cài Node.js/npm
hoặc AgentKit. Trên Windows, `bootstrap` gọi exact package
`winget install --id jdx.mise --exact`, rồi verify `mise --version`. Nếu Mise
đã có, command là idempotent no-op trên mọi platform.

## Cài Profiles

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

Update manager bằng exact version:

```bash
npx --yes --package @thieung/pi-profile-manager@1.2.1 ppm-bootstrap install
```

Update Pi hoặc OMP binary:

```bash
pi-profile-manager update pi
pi-profile-manager update omp
```

Pin version cụ thể:

```bash
pi-profile-manager update pi --version 0.84.3
pi-profile-manager update omp --version 18.0.4
```

## Status Và Uninstall

```bash
npx --yes --package @thieung/pi-profile-manager@1.2.1 ppm-bootstrap status
npx --yes --package @thieung/pi-profile-manager@1.2.1 ppm-bootstrap uninstall
```

Uninstall chỉ xóa manager và receipt đúng ownership. Profiles, Mise config,
wrappers, credentials và backups được giữ nguyên.

## Safety Contract

- Không đọc hoặc copy provider credentials.
- Không tự chạy qua npm lifecycle scripts.
- Không overwrite executable không có receipt hợp lệ.
- Không overwrite executable đã drift khỏi checksum trong receipt.
- Upgrade tạo backup và rollback nếu replacement thất bại.
- `--dry-run` của payload không chạy installer hoặc network mutation.
- V1 giả định user đang chạy tool là actor duy nhất sửa managed paths trong lúc
  command thực thi; tool không chống directory-swap đồng thời từ process khác
  có cùng quyền user.

## Development

```bash
npm test
npm pack --dry-run
```

Source được phát hành theo giấy phép MIT.
