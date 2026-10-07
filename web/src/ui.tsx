import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useState } from "react";
import { api } from "./store";
import type { AgentState, Party, Snapshot, Task } from "./types";

export const md = (s: string) => ({ __html: DOMPurify.sanitize(marked.parse(s, { async: false }) as string) });
export const time = (ts: number) => new Date(ts).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
export const dur = (a: number, b?: number) => {
  const s = Math.round(((b ?? Date.now()) - a) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
};

export const USER = { id: "user" as const, name: "Anh", role: "Người giao việc", color: "#c4b5fd" };

/** Kết luận "đạt" của một bước — so khớp nguyên từ, vì "CHANGES_REQUIRED" có chứa chữ "UI". */
export const isGood = (v: string) => !/CHANGES_REQUIRED|^Lỗi/.test(v);

export function party(snap: Snapshot, p: Party) {
  return p === "user" ? USER : snap.agents[p];
}

export function Avatar({ a, size = 36 }: { a: { id: string; name: string; color: string }; size?: number }) {
  const letter = a.id === "user" ? "★" : a.name[0];
  return (
    <span className="avatar" style={{ ["--c" as string]: a.color, width: size, height: size, fontSize: size * 0.42 }}>
      {letter}
    </span>
  );
}

export const STATUS_LABEL: Record<AgentState["status"], string> = { idle: "Rảnh", working: "Đang làm", error: "Lỗi" };
export const TASK_LABEL: Record<Task["status"], string> = { queued: "Chờ", running: "Đang chạy", done: "Xong", failed: "Lỗi", stopped: "Đã dừng" };

export function DocsModal({ task, initial, onClose }: { task: Task; initial?: string; onClose: () => void }) {
  const [files, setFiles] = useState<{ name: string; content: string }[] | null>(null);
  const [cur, setCur] = useState(0);
  useEffect(() => {
    api(`/api/tasks/${task.id}/files`).then((f: { name: string; content: string }[]) => {
      setFiles(f);
      const i = initial ? f.findIndex((x) => x.name === initial) : -1;
      setCur(i >= 0 ? i : Math.max(0, f.length - 1));
    });
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [task.id, initial, onClose]);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <b>{task.key} · Tài liệu bàn giao</b>
          <button onClick={onClose} aria-label="Đóng">
            ✕
          </button>
        </header>
        {!files ? (
          <div className="empty">Đang tải…</div>
        ) : files.length === 0 ? (
          <div className="empty">Chưa có file nào.</div>
        ) : (
          <div className="docs">
            <nav>
              {files.map((f, i) => (
                <button key={f.name} className={i === cur ? "sel" : ""} onClick={() => setCur(i)}>
                  {f.name}
                </button>
              ))}
            </nav>
            <article className="md" dangerouslySetInnerHTML={md(files[cur].content)} />
          </div>
        )}
      </div>
    </div>
  );
}
