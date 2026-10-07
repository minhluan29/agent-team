import { useEffect, useRef, useState } from "react";
import { api } from "./store";
import type { Account, Project } from "./types";

function useClickOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

/** Nút chọn dự án + thêm dự án mới. */
export function ProjectSwitcher({ projects, activeId, busy }: { projects: Project[]; activeId: string; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const ref = useClickOutside(open, () => setOpen(false));
  const active = projects.find((p) => p.id === activeId);

  return (
    <div className="pop-wrap" ref={ref}>
      <button className="project-btn" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} title={active?.workspace}>
        <span className="project-dot" />
        <span className="project-name">{active?.name ?? "Chọn dự án"}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="popover" role="listbox">
          <div className="pop-title">Dự án</div>
          {projects.map((p) => (
            <button
              key={p.id}
              role="option"
              aria-selected={p.id === activeId}
              className={`pop-item ${p.id === activeId ? "sel" : ""}`}
              onClick={async () => {
                await api(`/api/projects/${p.id}/activate`, {});
                setOpen(false);
              }}
            >
              <b>{p.name}</b>
              <small>
                {p.workspace.replace(/^\/Users\/[^/]+/, "~")}
                {p.jiraKey ? ` · Jira ${p.jiraKey}` : ""}
              </small>
            </button>
          ))}
          {busy && <div className="pop-note">Đội đang chạy task — đổi dự án chỉ đổi phần hiển thị, task đang chạy vẫn làm đúng dự án của nó.</div>}
          <button
            className="pop-add"
            onClick={() => {
              setAdding(true);
              setOpen(false);
            }}
          >
            ＋ Thêm dự án
          </button>
        </div>
      )}
      {adding && <AddProject onClose={() => setAdding(false)} />}
    </div>
  );
}

const CODE_VIBE = "/Users/minhluan/Documents/code_vibe";

async function pick(prompt: string, defaultPath?: string): Promise<{ path: string; name: string } | null> {
  const r = await api("/api/pick-folder", { prompt, defaultPath });
  return r.cancelled ? null : r;
}

/** Thêm dự án: chọn thư mục có sẵn (tên = tên thư mục) hoặc tạo thư mục dự án mới. */
function AddProject({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [folder, setFolder] = useState("");
  const [parent, setParent] = useState(CODE_VIBE);
  const [name, setName] = useState("");
  const [jiraKey, setJiraKey] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"" | "picking" | "saving">("");

  const choose = async (forParent: boolean) => {
    setErr("");
    setBusy("picking");
    try {
      const r = await pick(forParent ? "Chọn thư mục sẽ chứa dự án mới" : "Chọn thư mục dự án", forParent ? parent : folder || CODE_VIBE);
      if (!r) return;
      if (forParent) setParent(r.path);
      else {
        setFolder(r.path);
        setName(r.name); // tên dự án = tên thư mục (vẫn sửa được)
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const submit = async () => {
    setBusy("saving");
    setErr("");
    try {
      if (mode === "existing") await api("/api/projects", { workspace: folder, name, jiraKey });
      else await api("/api/projects", { create: true, parent, name, jiraKey });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const short = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
  const ready = mode === "existing" ? !!folder : !!name.trim();

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal small" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Thêm dự án">
        <header>
          <b>Thêm dự án</b>
          <button onClick={onClose} aria-label="Đóng">
            ✕
          </button>
        </header>
        <div className="form">
          <div className="seg" role="tablist">
            <button role="tab" aria-selected={mode === "existing"} className={mode === "existing" ? "sel" : ""} onClick={() => setMode("existing")}>
              Thư mục có sẵn
            </button>
            <button role="tab" aria-selected={mode === "new"} className={mode === "new" ? "sel" : ""} onClick={() => setMode("new")}>
              Tạo dự án mới
            </button>
          </div>

          {mode === "existing" ? (
            <>
              <div className="field">
                <span className="field-label">Thư mục dự án</span>
                <div className="picker">
                  <span className={`picker-path ${folder ? "" : "empty"}`}>{folder ? short(folder) : "Chưa chọn thư mục"}</span>
                  <button className="ghost" onClick={() => choose(false)} disabled={!!busy}>
                    {busy === "picking" ? "Đang mở Finder…" : "Chọn thư mục…"}
                  </button>
                </div>
                <small>Repo git (hoặc chứa các repo git ở thư mục con). Chưa có git thì em khởi tạo.</small>
              </div>
              <label>
                Tên dự án <span className="opt">(mặc định = tên thư mục)</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Chọn thư mục để lấy tên" />
              </label>
            </>
          ) : (
            <>
              <label>
                Tên dự án <span className="opt">(cũng là tên thư mục)</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="vd snake-game" autoFocus />
              </label>
              <div className="field">
                <span className="field-label">Tạo bên trong</span>
                <div className="picker">
                  <span className="picker-path">{short(parent)}</span>
                  <button className="ghost" onClick={() => choose(true)} disabled={!!busy}>
                    {busy === "picking" ? "Đang mở Finder…" : "Đổi thư mục…"}
                  </button>
                </div>
                <small>
                  Sẽ tạo <code>{short(parent)}/{name.trim() || "…"}</code> và khởi tạo git (nhánh main, chưa có remote — đội commit tại chỗ, không push / MR).
                </small>
              </div>
            </>
          )}

          <label>
            Mã project Jira <span className="opt">(tuỳ chọn)</span>
            <input value={jiraKey} onChange={(e) => setJiraKey(e.target.value.toUpperCase())} placeholder="vd NM — bỏ trống nếu không dùng Jira" />
          </label>
          {busy === "picking" && <div className="pop-note">Hộp thoại Finder đã mở — nếu không thấy, kiểm tra phía sau cửa sổ trình duyệt.</div>}
          {err && <div className="err">{err}</div>}
          <div className="form-actions">
            <button className="ghost" onClick={onClose}>
              Huỷ
            </button>
            <button className="primary" onClick={submit} disabled={!!busy || !ready}>
              {busy === "saving" ? "Đang tạo…" : mode === "existing" ? "Thêm dự án" : "Tạo dự án"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const PLAN: Record<string, string> = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise" };

/** Tài khoản Claude đang kết nối + nút kết nối / đổi tài khoản. */
export function AccountChip({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(open, () => setOpen(false));
  const login = () => api("/api/account/login", {});

  if (!account?.loggedIn) {
    return (
      <button className="connect-btn" onClick={login} disabled={account?.loggingIn}>
        {account?.loggingIn ? "Đang mở trình duyệt…" : "Kết nối Claude"}
      </button>
    );
  }
  const name = account.email ?? "Claude";
  return (
    <div className="pop-wrap" ref={ref}>
      <button className="account-chip" onClick={() => setOpen(!open)} title={name}>
        <span className="acc-avatar">{name[0]?.toUpperCase()}</span>
        <span className="acc-text">
          <b>{name}</b>
          <small>Claude {PLAN[account.subscriptionType ?? ""] ?? account.subscriptionType ?? ""} · đã kết nối</small>
        </span>
      </button>
      {open && (
        <div className="popover right">
          <div className="pop-title">Tài khoản Claude</div>
          <dl className="info-list">
            <dt>Email</dt>
            <dd>{account.email}</dd>
            <dt>Tổ chức</dt>
            <dd>{account.orgName ?? "—"}</dd>
            <dt>Gói</dt>
            <dd>{PLAN[account.subscriptionType ?? ""] ?? account.subscriptionType ?? "—"}</dd>
          </dl>
          <p className="pop-note">Mọi agent chạy bằng tài khoản này. Đổi tài khoản sẽ mở trình duyệt để đăng nhập lại.</p>
          <button className="pop-add" onClick={login} disabled={account.loggingIn}>
            {account.loggingIn ? "Đang chờ đăng nhập trên trình duyệt…" : "Đổi tài khoản / đăng nhập lại"}
          </button>
        </div>
      )}
    </div>
  );
}
