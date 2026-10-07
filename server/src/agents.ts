import fs from "node:fs";
import path from "node:path";
import { AGENTS_DIR } from "./config.js";

export type AgentId = "vu" | "lucas" | "pual" | "james" | "min" | "rio" | "paul" | "mouse";

/** Dev làm code — chạy song song, mỗi người một repo. */
export const DEVS = ["min", "rio", "paul", "mouse"] as const;
export type DevId = (typeof DEVS)[number];

export type AgentSpec = {
  id: AgentId;
  name: string;
  role: string;
  color: string;
  /** Lời dặn riêng của agent, nối vào system prompt preset của Claude Code. */
  prompt: string;
  /** Danh sách tool được phép. null = không giới hạn (điều phối). */
  tools: string[] | null;
};

const meta: Record<AgentId, Pick<AgentSpec, "name" | "role" | "color">> = {
  vu: { name: "Vũ", role: "PM · Product Manager", color: "#a5b4fc" },
  lucas: { name: "Lucas", role: "Product Leader", color: "#4f9dff" },
  pual: { name: "Pual", role: "Thiết kế giao diện", color: "#ff5fa2" },
  james: { name: "James", role: "Duyệt UI/UX", color: "#ffb547" },
  min: { name: "Min", role: "Senior Backend", color: "#fb923c" },
  rio: { name: "Rio", role: "Senior Frontend", color: "#22d3ee" },
  paul: { name: "Paul", role: "Senior Mobile", color: "#3ddc97" },
  mouse: { name: "Mouse", role: "Senior Game Dev", color: "#c084fc" },
};

export const AGENT_ORDER: AgentId[] = ["vu", "lucas", "pual", "james", "min", "rio", "paul", "mouse"];

function parse(file: string) {
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { front: {} as Record<string, string>, body: raw };
  const front: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) front[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { front, body: m[2].trim() };
}

/** Đọc lại từ đĩa mỗi lần gọi, để sửa file .md là có hiệu lực ngay ở lượt chạy sau. */
export function loadAgent(id: AgentId): AgentSpec {
  const { front, body } = parse(path.join(AGENTS_DIR, `${id}.md`));
  const tools = front.tools ? front.tools.split(",").map((t) => t.trim()).filter(Boolean) : null;
  return { id, ...meta[id], prompt: body, tools };
}

export function agentMeta(id: AgentId) {
  return { id, ...meta[id] };
}
