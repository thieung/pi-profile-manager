# Pi Profile Manager

Public bootstrap package cho ba profile độc lập:

```text
pi-dev  = Pi upstream + selected extensions
pi-ak   = Pi upstream + selected extensions + AgentKit
pi-omp  = Oh My Pi + AgentKit
```

Package hỗ trợ macOS/Linux và yêu cầu Node.js 22+, npm, Mise. AgentKit chỉ bắt
buộc khi cài `pi-ak` hoặc `pi-omp`.

## Cài Manager

```bash
npx --yes @thieung/pi-profile-manager@1.0.0 install
export PATH="$HOME/.local/bin:$PATH"
pi-profile-manager doctor
```

Package không có `postinstall`. Chỉ explicit command `install` mới ghi
`~/.local/bin/pi-profile-manager` và ownership receipt tại
`~/.local/share/pi-profile-manager/receipt.json`.

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
npx --yes @thieung/pi-profile-manager@1.0.0 install
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
npx --yes @thieung/pi-profile-manager@1.0.0 status
npx --yes @thieung/pi-profile-manager@1.0.0 uninstall
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
