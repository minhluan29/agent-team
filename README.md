# Agent Team

Bảng điều khiển cho đội 4 agent (Rio · Pual · James · Lucas) cùng một Điều phối, chạy bằng Claude Agent SDK trên máy anh.

```
Anh giao task (link Jira / mô tả — không có Jira thì tự tạo ticket NM)
  → [hệ thống] Jira (assign, Start/Due date, In Progress) + pull + cắt nhánh
  → Vũ (PM): phân tích task góc nhìn sản phẩm          (00-vu-analysis.md)
  → Lucas (Product Leader): phân tích tính năng, phân cỡ S/M/L,
     chốt hợp đồng API, chia việc cho dev               (01-lucas-plan.md)
  → SONG SONG:
       Min  (Senior Backend, app-be)   — CHỐT hợp đồng API (02-api-contract.md) → code
       Pual → James (thiết kế, chỉ cỡ L có UI)
       Rio  (Senior Frontend, app-fe) ┐
       Paul (Senior Mobile, app-ui)   ├ chờ thiết kế chốt (nếu có) rồi chạy cùng lúc
       Mouse  (Senior Game Dev, app-ui) ┘
     client code đúng hợp đồng Min đã chốt (tên field, kiểu, mã lỗi, khung { data, code })
     Min xong → từng client ĐỐI CHIẾU code của mình với code BE thật, lệch thì sửa phía client
     mỗi dev xong → [hệ thống] tsc/eslint/jest repo của mình → đỏ thì dev đó tự sửa
  → Lucas duyệt kỹ thuật (bỏ qua với cỡ S) → dev được nêu tên sửa song song
  → Vũ viết commit/MR → [hệ thống] commit, push, MR từng repo, comment Jira, Preview
```

Lucas chỉ giao cho những dev thật sự có việc (`Dev: min, paul` ở đầu plan). Task không có UI hoặc cỡ S/M thì bỏ qua Pual và James.

## Chạy

```bash
cd ~/Documents/code_vibe/agent-team
npm run setup        # lần đầu
npm run dev          # http://localhost:5317  (sửa code là tự nạp lại)
# hoặc
npm start            # build rồi chạy một cổng: http://localhost:4317
```

Không cần API key: SDK dùng đăng nhập Claude Code sẵn có trên máy.

## Dùng

**Tab "Sơ đồ làm việc"**: các agent là nút độc lập, nối bằng đường theo luồng làm việc. Khi một agent bàn giao, một gói tin chạy dọc đường nối (realtime qua WebSocket); đường dẫn tới agent đang làm có vệt chạy theo màu người gửi, nút đang làm phát sáng. Bấm một nút để xem log thao tác của agent đó.

Khung bên phải là ô nhắn **duy nhất**, gửi tới Điều phối:
- Dán link/mã Jira → giao thẳng cho cả đội.
- Câu khác → Điều phối trả lời dựa trên trạng thái đội lúc đó; nếu anh muốn đội làm việc mới hoặc dừng task, nó tự gọi API của app.

**Tab "Trao đổi giữa agent"**: dạng chat, xem các agent nhắn gì cho nhau (Rio → Pual, James → Pual "cần sửa", Rio → Điều phối "PASS"…), lọc theo task, bấm file đính kèm để đọc tài liệu bàn giao.

**▶ Mô phỏng** (góc trên): giả lập một task chạy hết chuỗi, có một vòng sửa — không gọi Claude, không tốn tiền, không đụng repo/Jira. Dùng để xem giao diện hoạt động.

## Dự án

Đội làm được cho nhiều dự án. Nút tên dự án ở thanh trên để chọn / **＋ Thêm dự án** (tên, thư mục workspace, mã Jira tuỳ chọn) — em tự dò repo git, nhánh gốc, đường dẫn GitLab và đoán dev phụ trách theo `package.json` (NestJS → Min, Next/web → Rio, Expo/RN → Paul, game → Mouse). Task, tin nhắn, log lọc theo dự án đang chọn; task đang chạy luôn làm đúng dự án của nó dù anh đổi dự án giữa chừng.

**Ghi chú dự án** (nút ✎ hoặc Cài đặt → Dự án): tự lưu, và được nối vào lời dặn của MỌI agent khi làm cho dự án đó — chỗ ghi quy ước riêng. Dự án không có mã Jira thì bỏ qua toàn bộ bước Jira.

**Tài khoản Claude** (góc phải): email + gói đang kết nối, đọc từ `claude auth status`. Chưa đăng nhập thì có nút **Kết nối Claude**; đổi tài khoản mở trình duyệt qua `claude auth login`.

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `agents/*.md` | Lời dặn + danh sách tool của từng agent. Sửa là có hiệu lực ở lượt chạy sau. `rio/pual/james/lucas.md` được symlink vào `app-nha-xai/.claude/agents/` nên `claude` CLI cũng dùng được. |
| `server/src/pipeline.ts` | Thứ tự chuyển việc, số vòng sửa, cách đọc kết luận APPROVED/PASS. |
| `server/src/demo.ts` | Kịch bản mô phỏng. |
| `server/src/runner.ts` | Chạy một agent qua SDK, phát sự kiện lên giao diện, chặn tool ngoài vai trò. |
| `web/src/` | Giao diện React. |
| `data/state.json` | Lịch sử task, log, phiên của từng agent. Xoá file để làm sạch. |
| `data/projects.json` | Danh sách dự án, repo, dev phụ trách, ghi chú. |
| `server/src/projects.ts` | Quản lý dự án + ngữ cảnh dự án cho từng việc đang chạy. |
| `config.json` | (tuỳ chọn, chép từ `config.example.json`) đổi workspace, cổng, số vòng sửa. |

Các agent chạy với cwd là workspace (`app-nha-xai`), nên dùng chung CLAUDE.md, memory và MCP (atlassian-jira, gitlab, pencil) như khi anh mở `claude` ở đó.
