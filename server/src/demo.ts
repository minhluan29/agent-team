import type { AgentId } from "./agents.js";
import { currentProject } from "./projects.js";
import { log, putTask, say, updateAgent, type Party, type Step, type Task } from "./state.js";

/**
 * Mô phỏng một task chạy hết chuỗi với đội mới — có đoạn song song (Min làm BE trong lúc
 * Pual/James thiết kế; Paul và Rio code cùng lúc). Không gọi Claude, không tốn tiền,
 * không đụng repo/Jira.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let running = false;

type Beat = { agent: AgentId; label: string; tools: string[]; to: Party | Party[]; text: string; file?: string; verdict?: string };

async function play(task: Task, b: Beat) {
  const step: Step = { id: `${task.steps.length}`, agent: b.agent, label: b.label, status: "running", startedAt: Date.now() };
  task.steps.push(step);
  putTask(task);
  updateAgent(b.agent, { status: "working", activity: "Khởi động…", taskId: task.id });
  for (const t of b.tools) {
    await sleep(900);
    log(b.agent, task.id, "tool", t);
    updateAgent(b.agent, { activity: t });
  }
  await sleep(600);
  Object.assign(step, { status: "done", endedAt: Date.now(), verdict: b.verdict });
  putTask(task);
  updateAgent(b.agent, { status: "idle", activity: "" });
  for (const to of Array.isArray(b.to) ? b.to : [b.to]) say(b.agent, to, b.text, { taskId: task.id, file: b.file });
  await sleep(1200);
}

const D = ".claude/tasks/DEMO-1";

export async function runDemo() {
  if (running) return;
  running = true;
  const task: Task = { id: `demo${Date.now().toString(36)}`, projectId: currentProject().id, input: "Mô phỏng: chia sẻ bài viết kèm thống kê lượt chia sẻ", status: "running", steps: [], createdAt: Date.now() };
  putTask(task);
  say("user", "vu", "Giao task mô phỏng DEMO-1 giúp anh", { taskId: task.id });
  await sleep(1200);
  try {
    Object.assign(task, { key: "DEMO-1", summary: "Chia sẻ bài viết + đếm lượt chia sẻ", branch: "feat/DEMO-1-chia-se-bai-viet" });
    await play(task, { agent: "vu", label: "Chuẩn bị (Jira + git)", tools: ["Jira · đọc DEMO-1", "$ git app-be: pull dev → feat/DEMO-1-chia-se-bai-viet", "$ git app-ui: pull dev-ios → feat/DEMO-1-chia-se-bai-viet"], to: [], text: "" });
    await play(task, { agent: "vu", label: "Phân tích task", tools: [`Đọc ${D}/00-ticket.md`, `Ghi ${D}/00-vu-analysis.md`], to: "lucas", file: "00-vu-analysis.md", text: "Người dùng muốn chia sẻ bài viết ra ngoài app và người đăng thấy được bài mình được chia sẻ bao nhiêu lần. Ảnh hưởng **Backend** (đếm lượt) và **Mobile** (nút + số đếm). Web để đợt sau." });
    await play(task, { agent: "lucas", label: "Phân tích & chia việc", tools: [`Đọc ${D}/00-vu-analysis.md`, 'Tìm "PostActions"', "Đọc app-be/apps/api/src/post/post.controller.ts", `Ghi ${D}/01-lucas-plan.md`], to: ["min", "pual"], file: "01-lucas-plan.md", verdict: "Cỡ L · Min + Paul", text: "Cỡ **L**. Hợp đồng API: `POST /posts/:id/share` → `{ data: { shareCount }, code }`. **Min** làm BE ngay; **Pual** thiết kế nút + số đếm, xong thì **Paul** làm mobile theo spec." });

    // Song song: Min (chốt hợp đồng → BE) ‖ Pual → James (thiết kế)
    await Promise.all([
      (async () => {
        await play(task, { agent: "min", label: "Chốt hợp đồng API", tools: [`Đọc ${D}/02-api-contract.md`, "Đọc app-be/apps/api/src/post/dto/post.dto.ts", 'Tìm "SHARE_POST_SUCCESS" trong libs/translator', `Ghi ${D}/02-api-contract.md`], to: "paul", file: "02-api-contract.md", text: "Đã chốt hợp đồng: `POST /posts/:id/share` → `{ data: { postId: string, shareCount: number }, code: \"SHARE_POST_SUCCESS\" }`; lỗi `404 POST_NOT_FOUND`, `403 POST_PRIVATE`. Field camelCase, `shareCount` không null." });
        await play(task, { agent: "min", label: "Code", tools: ["Đọc app-be/apps/api/src/post/post.service.ts", "Sửa app-be/apps/api/src/post/post.service.ts", "Sửa app-be/apps/api/src/post/post.controller.ts", "$ npx jest post.service", `Ghi ${D}/04-min-impl.md`], to: "lucas", file: "04-min-impl.md", text: "BE xong: `POST /posts/:id/share` tăng `share_count` (cột mới nullable, DDL ghi trong báo cáo). Đúng hợp đồng, không thay đổi. Test xanh." });
      })(),
      (async () => {
        await play(task, { agent: "pual", label: "Thiết kế", tools: ["pencil · open_document", "pencil · batch_design", `Ghi ${D}/02-pual-design.md`], to: "james", file: "02-pual-design.md", text: "Nút chia sẻ 24pt cạnh bình luận, số đếm nhỏ bên phải; có trạng thái bài riêng tư." });
        await play(task, { agent: "james", label: "Duyệt UI/UX (vòng 1)", tools: [`Đọc ${D}/02-pual-design.md`, `Ghi ${D}/03-james-review.md`], to: "paul", file: "03-james-review.md", verdict: "APPROVED", text: '**APPROVED**. Spec cuối ở mục "Thiết kế chốt cho dev".' });
      })(),
    ]);
    await Promise.all([
      play(task, { agent: "vu", label: "Kiểm tự động · Min", tools: ["$ tsc · eslint · jest — app-be"], to: [], text: "", verdict: "Đạt" }),
      play(task, { agent: "paul", label: "Code", tools: ["Đọc app-ui/src/components/Feed/PostActions.tsx", "Sửa app-ui/src/components/Feed/PostActions.tsx", "Sửa app-ui/src/apis/post.ts", `Ghi ${D}/04-paul-impl.md`], to: "lucas", file: "04-paul-impl.md", text: "Mobile xong: nút chia sẻ + số đếm, gọi đúng hợp đồng API của Min. Chưa chạy máy thật." }),
    ]);
    say("min", "paul", "Anh xong Backend rồi, đúng hợp đồng đã chốt. Em đối chiếu client với code BE thật giúp anh nhé.", { taskId: task.id, file: "04-min-impl.md" });
    await sleep(1400);
    await play(task, { agent: "paul", label: "Đối chiếu API với Min", tools: ["$ git -C app-be diff dev", "Đọc app-be/apps/api/src/post/post.controller.ts", `Sửa ${D}/04-paul-impl.md`], to: "min", file: "04-paul-impl.md", text: "Đã đối chiếu với code BE của anh Min: path, field `postId` / `shareCount`, mã lỗi `POST_PRIVATE` đều khớp. Không phải sửa gì." });
    await play(task, { agent: "vu", label: "Kiểm tự động · Paul", tools: ["$ tsc · eslint · jest — app-ui"], to: [], text: "", verdict: "Đạt" });
    await play(task, { agent: "lucas", label: "Duyệt kỹ thuật (vòng 1)", tools: ["$ git diff dev...HEAD (app-be)", "$ git diff dev-ios...HEAD (app-ui)", `Ghi ${D}/05-lucas-review.md`], to: "vu", file: "05-lucas-review.md", verdict: "PASS", text: "**PASS**. Client và server khớp hợp đồng, diff gọn." });
    await play(task, { agent: "vu", label: "Push & tạo MR", tools: ["$ git app-be: commit + push", "gitlab · tạo MR app-be → dev", "$ git app-ui: commit + push", "gitlab · tạo MR app-ui → dev-ios", "Jira · comment + chuyển Preview DEMO-1"], to: "user", text: "Xong **DEMO-1** (mô phỏng, cỡ L · Min + Paul): 2 MR (app-be, app-ui), Jira đã sang Preview. Phần chưa kiểm: chạy trên máy thật." });
    task.status = "done";
  } finally {
    putTask(task);
    running = false;
  }
}
