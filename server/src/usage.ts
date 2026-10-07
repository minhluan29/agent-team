import { query } from "@anthropic-ai/claude-agent-sdk";
import { setUsage } from "./state.js";

let probing: Promise<void> | null = null;

/**
 * Hỏi mức dùng gói Claude bằng một lượt Haiku tí hon (không tool, không nạp
 * settings) — chỉ để nhận rate_limit_event. Lúc đội đang chạy thì không cần:
 * số liệu tự cập nhật theo từng lượt agent.
 */
export function probeUsage() {
  probing ??= (async () => {
    try {
      for await (const m of query({
        prompt: "OK",
        options: { maxTurns: 1, persistSession: false, settingSources: [], tools: [], model: "claude-haiku-4-5" },
      })) {
        if (m.type === "rate_limit_event") setUsage(m.rate_limit_info);
      }
    } finally {
      probing = null;
    }
  })();
  return probing;
}
