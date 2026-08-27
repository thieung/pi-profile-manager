# Pi Profile Manager

Public bootstrap package cho ba profile độc lập:

```text
pi-dev  = Pi upstream + selected extensions
pi-ak   = Pi upstream + selected extensions + AgentKit
pi-omp  = Oh My Pi + AgentKit
```

Package nhắm tới macOS/Linux và yêu cầu Node.js 22+, npm, Bash và Mise. AgentKit
chỉ bắt buộc khi cài `pi-ak` hoặc `pi-omp`.

## Supported OS

| Môi trường | Trạng thái | Ghi chú |
|---|---|---|
| macOS Apple Silicon | Đã kiểm chứng | Automated tests, local tarball và registry smoke đã pass. |
| macOS Intel | Target support | Cùng Unix/Bash contract; chưa có native smoke trên máy Intel. |
| Linux x64/arm64 | Target support | Code path hỗ trợ Bash/Linux; chưa có Linux CI hoặc clean-machine smoke. |
| Windows qua WSL2 | Chưa kiểm chứng | Có thể dùng Linux workflow bên trong WSL, nhưng chưa được claim support. |
| Windows native | Không hỗ trợ | Bash payload, Unix paths, executable mode và wrapper hiện không tương thích native. |

`Target support` nghĩa là implementation được thiết kế cho platform đó nhưng
chưa đạt cùng evidence level với macOS Apple Silicon. Không nên hiểu là đã được
test đầy đủ trên mọi distribution hoặc architecture.

### Muốn hỗ trợ Windows native cần gì?

Windows native cần một adapter riêng, không chỉ thêm một câu lệnh cài Mise:

- Thay Bash payload hoặc bổ sung PowerShell/Node implementation tương đương.
- Dùng Windows paths cho manager state, profile roots và Mise config thay vì
  `~/.local`, `~/.pi`, `~/.omp` theo Unix semantics.
- Tạo `.cmd`/PowerShell launchers thay cho POSIX shell wrappers và `chmod 0755`.
- Cài Mise qua Scoop hoặc winget; `mise.run` là installer cho macOS/Linux.
- Kiểm chứng atomic replace, symlink/junction, file locking và rollback theo
  Windows filesystem semantics.
- Thêm Windows CI cho install, update, verify, uninstall và path-with-spaces.
- Fact-check Pi, OMP và AgentKit target support trên Windows trước khi claim cả
  ba profiles hoạt động end-to-end.

Cho tới khi adapter và test matrix này tồn tại, hướng dẫn chính thức chỉ nên
dùng macOS/Linux; Windows user có thể thử WSL2 ở trạng thái experimental.

## Cài Manager

```bash
npx --yes @thieung/pi-profile-manager@1.1.0 install
export PATH="$HOME/.local/bin:$PATH"
pi-profile-manager bootstrap --dry-run
pi-profile-manager bootstrap
pi-profile-manager doctor
```

Package không có `postinstall`. Chỉ explicit command `install` mới ghi
`~/.local/bin/pi-profile-manager` và ownership receipt tại
`~/.local/share/pi-profile-manager/receipt.json`.

## Bootstrap Mise

Nếu `doctor` báo thiếu Mise:

```bash
pi-profile-manager bootstrap --dry-run
pi-profile-manager bootstrap
pi-profile-manager doctor
```

`bootstrap` tải official installer từ `https://mise.run` vào temporary file,
sau đó cài `~/.local/bin/mise` và verify version. Command không pipe network
response trực tiếp vào shell, không dùng `sudo`, không sửa shell rc và không tự
cài Node.js/npm hoặc AgentKit. Nếu Mise đã có, command là idempotent no-op.

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
npx --yes @thieung/pi-profile-manager@1.1.0 install
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
npx --yes @thieung/pi-profile-manager@1.1.0 status
npx --yes @thieung/pi-profile-manager@1.1.0 uninstall
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
