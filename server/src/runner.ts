import { query, type Options, type PreToolUseHookInput, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { loadAgent, type AgentId } from "./agents.js";
import { currentProject, projectBrief } from "./projects.js";
import { log, setUsage, state, updateAgent } from "./state.js";

export type RunResult = { ok: boolean; text: string; sessionId: string | null };

const running = new Map<AgentId, AbortController>();
/** Mỗi agent chạy tuần tự: việc mới xếp hàng sau việc đang làm thay vì bị từ chối. */
const queues = new Map<AgentId, Promise<unknown>>();

export function isBusy(id: AgentId) {
  return running.has(id);
}

export function stopAgent(id: AgentId) {
  running.get(id)?.abort();
}

/** Một dòng ngắn mô tả tool đang chạy, để hiện lên thẻ agent. */
function describeTool(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const short = (p: string) => p.replace(currentProject().workspace + "/", "");
  switch (name) {
    case "Read":
      return `Đọc ${short(s(input.file_path))}`;
    case "Write":
      return `Ghi ${short(s(input.file_path))}`;
    case "Edit":
      return `Sửa ${short(s(input.file_path))}`;
    case "Bash":
      return `$ ${s(input.description) || s(input.command)}`.slice(0, 200);
    case "Grep":
      return `Tìm "${s(input.pattern)}"`;
    case "Glob":
      return `Liệt kê ${s(input.pattern)}`;
    case "WebFetch":
      return `Mở ${s(input.url)}`;
    default: {
      const m = name.match(/^mcp__(.+?)__(.+)$/);
      if (m) return `${m[1]} · ${m[2]}${input.path ? ` ${s(input.path)}` : ""}`;
      return name;
    }
  }
}

/**
 * Agent chuyên môn chỉ được dùng đúng tool khai trong frontmatter. `tools` thu hẹp bộ tool
 * dựng sẵn; hook PreToolUse chặn nốt phần còn lọt (MCP, hay allow-rule trong settings.json
 * của workspace — chế độ dontAsk một mình không chặn được những thứ đó).
 */
function toolGuard(list: string[]): Partial<Options> {
  const allowed = new Set(list);
  return {
    tools: list.filter((t) => !t.startsWith("mcp__")),
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              const name = (input as PreToolUseHookInput).tool_name;
              if (allowed.has(name)) return {};
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: `Tool ${name} không thuộc vai trò của agent này.`,
                },
              };
            },
          ],
        },
      ],
    },
  };
}

type RunOpts = {
  taskId?: string | null;
  /** Nối tiếp session gần nhất của agent — dùng cho vòng sửa để agent nhớ việc vừa làm. */
  resume?: boolean;
  /** Ghi đè danh sách tool của agent cho lượt này ([] = chỉ viết chữ). */
  tools?: string[];
  effort?: Options["effort"];
  maxTurns?: number;
};

export function runAgent(id: AgentId, prompt: string, opts: RunOpts = {}): Promise<RunResult> {
  const prev = queues.get(id) ?? Promise.resolve();
  if (running.has(id)) log(id, opts.taskId ?? null, "system", "Có việc mới — xếp hàng chờ xong việc hiện tại");
  const next = prev.catch(() => {}).then(() => runNow(id, prompt, opts));
  queues.set(id, next);
  return next;
}

async function runNow(id: AgentId, prompt: string, opts: RunOpts): Promise<RunResult> {
  const spec = loadAgent(id);
  const taskId = opts.taskId ?? null;
  const abort = new AbortController();
  running.set(id, abort);
  updateAgent(id, { status: "working", activity: "Khởi động…", taskId });
  log(id, taskId, "prompt", prompt);

  const resume = opts.resume ? state.agents[id].sessionId ?? undefined : undefined;
  let sessionId: string | null = null;
  let finalText = "";
  let ok = false;

  try {
    const q = query({
      prompt,
      options: {
        cwd: currentProject().workspace,
        abortController: abort,
        resume,
        // Nạp CLAUDE.md, memory và MCP (jira, gitlab, pencil) giống hệt khi anh chạy `claude` trong workspace.
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code", append: `${spec.prompt}\n\n${projectBrief()}` },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        ...((opts.tools ?? spec.tools) && toolGuard(opts.tools ?? spec.tools!)),
        ...(opts.effort && { effort: opts.effort }),
        ...(opts.maxTurns && { maxTurns: opts.maxTurns }),
      },
    });

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === "rate_limit_event") {
        setUsage(msg.rate_limit_info);
      } else if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
        const mcp = msg.mcp_servers.map((s) => `${s.name}:${s.status}`).join(", ");
        log(id, taskId, "system", `model ${msg.model} · MCP: ${mcp || "không có"}`);
      } else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            log(id, taskId, "text", block.text);
            updateAgent(id, { activity: block.text.split("\n")[0].slice(0, 160) });
          } else if (block.type === "tool_use") {
            const line = describeTool(block.name, block.input as Record<string, unknown>);
            log(id, taskId, "tool", line);
            updateAgent(id, { activity: line });
          }
        }
      } else if (msg.type === "result") {
        sessionId = msg.session_id;
        updateAgent(id, { costUsd: state.agents[id].costUsd + (msg.total_cost_usd ?? 0) });
        if (msg.subtype === "success" && !msg.is_error) {
          ok = true;
          finalText = msg.result;
          log(id, taskId, "result", `Xong · ${(msg.duration_ms / 1000).toFixed(0)}s · $${msg.total_cost_usd.toFixed(2)}`);
        } else {
          const err = msg.subtype === "success" ? msg.result : msg.errors.join("\n") || msg.subtype;
          log(id, taskId, "error", err);
        }
      }
    }
  } catch (e) {
    const aborted = abort.signal.aborted;
    log(id, taskId, "error", aborted ? "Đã dừng theo yêu cầu" : String((e as Error).message ?? e));
  } finally {
    running.delete(id);
    updateAgent(id, { status: ok ? "idle" : "error", activity: ok ? "" : "Lỗi — xem log", sessionId: sessionId ?? state.agents[id].sessionId });
  }
  return { ok, text: finalText, sessionId };
}
