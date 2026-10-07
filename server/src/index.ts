import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { AGENT_ORDER, type AgentId } from "./agents.js";
import { getAccount, startLogin } from "./account.js";
import { makeProjectFolder, pickFolder } from "./folders.js";
import { ROOT, config, taskDir } from "./config.js";
import { activeProjectId, createProject, currentProject, listProjects, removeProject, setActive, updateProject, withProject } from "./projects.js";
import { runDemo } from "./demo.js";
import { probeUsage } from "./usage.js";
import { currentTaskId, enqueueTask, stopTask } from "./pipeline.js";
import { isBusy, runAgent, stopAgent } from "./runner.js";
import { addClient, broadcast, say, state, updateAgent } from "./state.js";

const app = express();
app.use(express.json());

app.get("/api/state", async (_req, res) => {
  res.json({ ...state, workspace: currentProject().workspace, projects: listProjects(), activeProjectId: activeProjectId(), account: await getAccount() });
});

// ---------- dự án ----------
app.get("/api/projects", (_req, res) => res.json({ projects: listProjects(), activeProjectId: activeProjectId() }));

/** Hộp thoại chọn thư mục của macOS. */
app.post("/api/pick-folder", async (req, res) => {
  try {
    const picked = await pickFolder(String(req.body?.prompt ?? "Chọn thư mục"), req.body?.defaultPath);
    res.json(picked ? { path: picked, name: picked.split("/").pop() } : { cancelled: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** body: { workspace, name?, jiraKey? } — hoặc { create: true, parent, name, jiraKey? } để tạo thư mục mới. */
app.post("/api/projects", (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const workspace = req.body?.create ? makeProjectFolder(String(req.body?.parent ?? ""), name) : String(req.body?.workspace ?? "");
    const p = createProject({ name, workspace, jiraKey: req.body?.jiraKey });
    setActive(p.id);
    broadcast({ t: "projects", projects: listProjects(), activeProjectId: activeProjectId() });
    res.json(p);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.put("/api/projects/:id", (req, res) => {
  try {
    const p = updateProject(req.params.id, req.body ?? {});
    broadcast({ t: "projects", projects: listProjects(), activeProjectId: activeProjectId() });
    res.json(p);
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

app.delete("/api/projects/:id", (req, res) => {
  if (state.tasks.some((t) => t.projectId === req.params.id && (t.status === "running" || t.status === "queued")))
    return res.status(409).json({ error: "Dự án đang có task chạy" });
  try {
    removeProject(req.params.id);
    broadcast({ t: "projects", projects: listProjects(), activeProjectId: activeProjectId() });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/projects/:id/activate", (req, res) => {
  try {
    setActive(req.params.id);
    broadcast({ t: "projects", projects: listProjects(), activeProjectId: activeProjectId() });
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

// ---------- tài khoản Claude ----------
app.get("/api/account", async (req, res) => res.json(await getAccount(req.query.fresh === "1")));
app.post("/api/account/login", (_req, res) => {
  startLogin();
  res.json({ ok: true });
});

app.post("/api/tasks", (req, res) => {
  const input = String(req.body?.input ?? "").trim();
  if (!input) return res.status(400).json({ error: "Thiếu nội dung task" });
  res.json(enqueueTask(input));
});

app.post("/api/tasks/:id/stop", (req, res) => {
  stopTask(req.params.id);
  res.json({ ok: true });
});

/** Các file bàn giao (00-ticket.md … 05-rio-review.md) của một task. */
app.get("/api/tasks/:id/files", (req, res) => {
  const task = state.tasks.find((t) => t.id === req.params.id);
  if (!task?.key) return res.json([]);
  const dir = withProject(task.projectId, () => taskDir(task.key!));
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((name) => ({ name, content: fs.readFileSync(path.join(dir, name), "utf8") }));
  res.json(files);
});

const JIRA_RE = /^\s*(?:https?:\/\/\S*atlassian\.net\/browse\/[A-Z]+-\d+\S*|[A-Z]{2,}-\d+)\s*$/;

/** Ảnh chụp trạng thái đội để Điều phối trả lời "ai đang làm gì" mà không phải đoán. */
function teamBrief() {
  const agents = AGENT_ORDER.map((id) => {
    const a = state.agents[id];
    return `- ${a.name}: ${a.status === "working" ? `đang làm — ${a.activity}` : a.status === "error" ? "lỗi ở lượt trước" : "rảnh"}`;
  }).join("\n");
  const tasks = state.tasks
    .filter((t) => t.projectId === currentProject().id)
    .slice(0, 5)
    .map((t) => `- [${t.id}] ${t.key ?? "(chưa có key)"} ${t.status}: ${t.summary || t.input.slice(0, 80)} · bước: ${t.steps.map((s) => `${state.agents[s.agent].name}/${s.label}${s.verdict ? `=${s.verdict}` : ""}`).join(" → ") || "chưa bắt đầu"}`)
    .join("\n");
  return `Dự án đang chọn: ${currentProject().name} (${currentProject().workspace})\nAgent:\n${agents}\nTask gần đây của dự án:\n${tasks || "- chưa có"}`;
}

app.post("/api/usage/refresh", async (_req, res) => {
  try {
    await probeUsage();
    res.json(state.usage);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/demo", (_req, res) => {
  void runDemo();
  res.json({ ok: true });
});

/** Ô nhắn duy nhất của anh: luôn gửi tới Vũ (PM). */
let lastUserMsg = { text: "", at: 0 };

app.post("/api/coordinator", (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "Tin nhắn trống" });
  // Lưới an toàn: cùng một tin gửi lại trong 3 giây là bị nhân đôi do bàn phím, không phải anh gửi lần nữa.
  if (message === lastUserMsg.text && Date.now() - lastUserMsg.at < 3000) return res.json({ ok: true, duplicate: true });
  lastUserMsg = { text: message, at: Date.now() };

  // Link/mã Jira thì giao thẳng cho đội, khỏi tốn một lượt hỏi Điều phối — chỉ với dự án dùng Jira.
  if (currentProject().jiraKey && JIRA_RE.test(message)) {
    const task = enqueueTask(message);
    say("user", "vu", message, { taskId: task.id });
    return res.json({ ok: true, taskId: task.id });
  }

  // Ngữ cảnh = vài tin gần nhất giữa anh và Vũ. Không nối tiếp phiên cũ: phiên của Vũ dài ra
  // theo từng task, resume nó khiến một câu trả lời ngắn cũng tốn vài đô.
  const recent = state.messages
    .filter((m) => m.projectId === currentProject().id && ((m.from === "user" && m.to === "vu") || (m.from === "vu" && m.to === "user")))
    .slice(-8)
    .map((m) => `${m.from === "user" ? "Anh" : "Vũ"}: ${m.text.slice(0, 600)}`)
    .join("\n");
  say("user", "vu", message, { taskId: currentTaskId() });
  const prompt = `[Anh nhắn qua bảng điều khiển]
Trò chuyện gần đây:
${recent || "(chưa có)"}

Trạng thái đội lúc này:
${teamBrief()}

Em có thể thao tác hệ thống bằng curl:
- Giao việc mới cho cả đội: curl -s -X POST localhost:${config.port}/api/tasks -H 'Content-Type: application/json' -d '{"input": "<mô tả đầy đủ>"}'
- Dừng task: curl -s -X POST localhost:${config.port}/api/tasks/<id>/stop
Chỉ giao việc khi anh rõ ràng muốn đội làm một việc mới; câu hỏi thì trả lời thôi. Trả lời ngắn gọn, tiếng Việt.

Tin nhắn của anh:
${message}`;
  // Khi trò chuyện, Vũ cần Bash để gọi API giao việc / dừng task.
  const pid = activeProjectId();
  void withProject(pid, () => runAgent("vu", prompt, { tools: ["Read", "Grep", "Glob", "Bash", "mcp__atlassian-jira__jira_get"], effort: "low" })).then((r) => withProject(pid, () => {
    say("vu", "user", r.ok ? r.text : "Em gặp lỗi khi xử lý tin nhắn này — xem log của Vũ.", { taskId: currentTaskId() });
  }));
  res.json({ ok: true });
});

/** Chat trực tiếp / giao việc lẻ cho một agent — nối tiếp session gần nhất của nó. */
app.post("/api/agents/:id/message", (req, res) => {
  const id = req.params.id as AgentId;
  if (!AGENT_ORDER.includes(id)) return res.status(404).json({ error: "Không có agent này" });
  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "Tin nhắn trống" });
  void runAgent(id, message, { resume: req.body?.fresh ? false : true, taskId: state.agents[id].taskId });
  res.json({ ok: true });
});

app.post("/api/agents/:id/stop", (req, res) => {
  stopAgent(req.params.id as AgentId);
  res.json({ ok: true });
});

app.post("/api/agents/:id/reset", (req, res) => {
  const id = req.params.id as AgentId;
  if (isBusy(id)) return res.status(409).json({ error: "Đang bận" });
  updateAgent(id, { sessionId: null, taskId: null, status: "idle", activity: "" });
  res.json({ ok: true });
});

// Bản build của frontend (npm run build) — chạy production chỉ cần một cổng.
const dist = path.join(ROOT, "web", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", addClient);

server.listen(config.port, () => {
  void probeUsage().catch(() => {});
  console.log(`Agent Team server: http://localhost:${config.port}  (dự án: ${currentProject().name} — ${currentProject().workspace})`);
});
