import { useEffect, useState } from "react";
import { api } from "./store";
import type { Usage } from "./types";

const LABEL: Record<string, string> = {
  five_hour: "PHIÊN 5H",
  seven_day: "TUẦN",
  seven_day_opus: "TUẦN · OPUS",
  seven_day_sonnet: "TUẦN · SONNET",
};
const ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];

function left(resetsAt: number) {
  const s = Math.max(0, resetsAt * 1000 - Date.now()) / 1000;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}n ${h}g`;
  if (h) return `${h}g ${String(m).padStart(2, "0")}p`;
  return `${m}p`;
}

/** Mức đã dùng của gói Claude (0–100%) theo từng cửa sổ giới hạn, kèm thời gian còn lại tới lúc reset. */
export function UsageMeter({ usage }: { usage: Usage | null }) {
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = async () => {
    setBusy(true);
    try {
      await api("/api/usage/refresh", {});
    } finally {
      setBusy(false);
    }
  };

  const keys = usage ? ORDER.filter((k) => usage.windows[k]) : [];
  return (
    <div className="usage" title={usage ? `Cập nhật lúc ${new Date(usage.updatedAt).toLocaleTimeString("vi-VN")}` : "Chưa có số liệu"}>
      {keys.length === 0 && <span className="usage-empty">CLAUDE LIMIT · chưa có số liệu</span>}
      {keys.map((k) => {
        const w = usage!.windows[k];
        const pct = Math.round(w.utilization * 100);
        const level = pct >= 90 ? "crit" : pct >= 70 ? "warn" : "ok";
        return (
          <div key={k} className={`meter ${level}`}>
            <div className="meter-top">
              <span>{LABEL[k] ?? k.toUpperCase()}</span>
              <b>{pct}%</b>
            </div>
            <div className="meter-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={LABEL[k] ?? k}>
              <i style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            <div className="meter-sub">reset sau {left(w.resetsAt)}</div>
          </div>
        );
      })}
      <button className={`icon-btn ${busy ? "spin" : ""}`} onClick={refresh} disabled={busy} aria-label="Làm mới mức dùng Claude" title="Làm mới (một lượt Haiku rất nhỏ)">
        ⟳
      </button>
    </div>
  );
}
