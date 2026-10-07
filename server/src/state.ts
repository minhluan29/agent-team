import fs from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import { AGENT_ORDER, agentMeta, type AgentId } from "./agents.js";
import { DATA_DIR } from "./config.js";
import { currentProject } from "./projects.js";

export type AgentStatus = "idle" | "working" | "error";

export type AgentState = ReturnType<typeof agentMeta> & {
  status: AgentStatus;
  activity: string;
  taskId: string | null;
  /** Session gần nhất — chat với agent sẽ nối tiếp session này để nó nhớ việc vừa làm. */
  sessionId: string | null;
  costUsd: number;
};

export type LogKind = "prompt" | "text" | "tool" | "result" | "error" | "system";

export type LogEntry = {
  id: number;
  projectId?: string;
  ts: number;
  agent: AgentId;
  taskId: string | null;
  kind: LogKind;
  text: string;
};

export type StepStatus = "running" | "done" | "failed";

export type Step = {
  id: string;
  agent: AgentId;
  label: string;
  status: StepStatus;
  verdict?: string;
  startedAt: number;
  endedAt?: number;
};

export type TaskStatus = "queued" | "running" | "done" | "failed" | "stopped";

export type Task = {
  id: string;
  projectId?: string;
  input: string;
  key?: string;
  summary?: string;
  branch?: string;
  /** Cỡ task do Rio phân loại: S / M / L */
  size?: string;
  repos?: string[];
  mrUrl?: string;
  mrUrls?: string[];
  status: TaskStatus;
  error?: string;
  steps: Step[];
  createdAt: number;
};

export type Party = AgentId | "user";

/** Tin nhắn qua lại giữa các agent (và giữa anh với Điều phối) — khác với log thao tác. */
export type Message = {
  id: number;
  projectId?: string;
  ts: number;
  taskId: string | null;
  from: Party;
  to: Party;
  text: string;
  /** File bàn giao đính kèm, vd 01-rio-plan.md */
  file?: string;
};

/** Mức dùng gói Claude của anh (lấy từ rate_limit_event của SDK). utilization: 0..1 */
export type UsageWindow = { utilization: number; resetsAt: number };
export type Usage = {
  windows: Record<string, UsageWindow>;
  status: string;
  updatedAt: number;
};

type Snapshot = { agents: Record<AgentId, AgentState>; tasks: Task[]; logs: LogEntry[]; messages: Message[]; usage: Usage | null };

const FILE = path.join(DATA_DIR, "state.json");
const MAX_LOGS = 3000;

function fresh(): Snapshot {
  const agents = {} as Record<AgentId, AgentState>;
  for (const id of AGENT_ORDER) {
    agents[id] = { ...agentMeta(id), status: "idle", activity: "", taskId: null, sessionId: null, costUsd: 0 };
  }
  return { agents, tasks: [], logs: [], messages: [], usage: null };
}

/**
 * Đội cũ (coordinator / rio kiến trúc / lucas dev) → đội mới (vũ / lucas leader / paul mobile).
 * Chỉ chạy một lần với dữ liệu lưu trước khi đổi cơ cấu.
 */
function migrate(saved: any) {
  // Rin (game dev) đổi tên thành Mouse
  if (saved?.agents?.rin) {
    saved.agents.mouse = { ...saved.agents.rin, id: "mouse" };
    delete saved.agents.rin;
    for (const l of saved.logs ?? []) if (l.agent === "rin") l.agent = "mouse";
    for (const m of saved.messages ?? []) {
      if (m.from === "rin") m.from = "mouse";
      if (m.to === "rin") m.to = "mouse";
    }
    for (const t of saved.tasks ?? []) for (const st of t.steps ?? []) if (st.agent === "rin") st.agent = "mouse";
  }
  if (!saved?.agents || saved.agents.vu) return saved;
  const map: Record<string, string> = { coordinator: "vu", rio: "lucas", lucas: "paul" };
  const re = (id: string) => map[id] ?? id;
  for (const l of saved.logs ?? []) l.agent = re(l.agent);
  for (const m of saved.messages ?? []) {
    m.from = m.from === "user" ? "user" : re(m.from);
    m.to = m.to === "user" ? "user" : re(m.to);
  }
  for (const t of saved.tasks ?? []) for (const s of t.steps ?? []) s.agent = re(s.agent);
  const agents: any = {};
  for (const [id, a] of Object.entries<any>(saved.agents)) agents[re(id)] = { ...a, id: re(id) };
  saved.agents = agents;
  return saved;
}

function load(): Snapshot {
  const base = fresh();
  if (!fs.existsSync(FILE)) return base;
  const saved = migrate(JSON.parse(fs.readFileSync(FILE, "utf8"))) as Snapshot;
  for (const id of AGENT_ORDER) {
    // Server vừa khởi động thì không agent nào còn đang chạy thật.
    if (saved.agents?.[id]) base.agents[id] = { ...saved.agents[id], ...agentMeta(id), status: "idle", activity: "" };
  }
  base.tasks = (saved.tasks ?? []).map((t) =>
    t.status === "running" || t.status === "queued" ? { ...t, status: "stopped", error: "Server khởi động lại giữa chừng" } : t,
  );
  base.logs = saved.logs ?? [];
  base.messages = saved.messages ?? [];
  // dữ liệu từ trước khi có nhiều dự án đều thuộc Nhà Mình
  for (const x of [...base.tasks, ...base.logs, ...base.messages] as { projectId?: string }[]) x.projectId ??= "nha-minh";
  base.usage = saved.usage ?? null;
  return base;
}

export const state = load();
let logSeq = state.logs.at(-1)?.id ?? 0;
let msgSeq = state.messages.at(-1)?.id ?? 0;

const clients = new Set<WebSocket>();
export function addClient(ws: WebSocket) {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
}

export function broadcast(msg: unknown) {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

let saveTimer: NodeJS.Timeout | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state));
  }, 500);
}

export function updateAgent(id: AgentId, patch: Partial<AgentState>) {
  Object.assign(state.agents[id], patch);
  broadcast({ t: "agent", agent: state.agents[id] });
  save();
}

export function log(agent: AgentId, taskId: string | null, kind: LogKind, text: string) {
  const entry: LogEntry = { id: ++logSeq, projectId: currentProject().id, ts: Date.now(), agent, taskId, kind, text };
  state.logs.push(entry);
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
  broadcast({ t: "log", entry });
  save();
}

export function putTask(task: Task) {
  const i = state.tasks.findIndex((t) => t.id === task.id);
  if (i < 0) state.tasks.unshift(task);
  else state.tasks[i] = task;
  broadcast({ t: "task", task });
  save();
}

export function say(from: Party, to: Party, text: string, opts: { taskId?: string | null; file?: string } = {}) {
  const m: Message = { id: ++msgSeq, projectId: currentProject().id, ts: Date.now(), taskId: opts.taskId ?? null, from, to, text: text.trim(), file: opts.file };
  state.messages.push(m);
  if (state.messages.length > 1000) state.messages.splice(0, state.messages.length - 1000);
  broadcast({ t: "msg", m });
  save();
  return m;
}

export function setUsage(info: any) {
  const windows: Record<string, UsageWindow> = { ...(state.usage?.windows ?? {}) };
  // Bản CLI mới gửi đủ các cửa sổ trong unifiedWindows; bản cũ chỉ gửi một cửa sổ.
  for (const [k, w] of Object.entries<any>(info?.unifiedWindows ?? {})) {
    if (typeof w?.utilization === "number") windows[k] = { utilization: w.utilization, resetsAt: w.resetsAt };
  }
  if (info?.rateLimitType && typeof info.utilization === "number") {
    windows[info.rateLimitType] = { utilization: info.utilization, resetsAt: info.resetsAt };
  }
  if (!Object.keys(windows).length) return;
  state.usage = { windows, status: info?.status ?? "allowed", updatedAt: Date.now() };
  broadcast({ t: "usage", usage: state.usage });
  save();
}
