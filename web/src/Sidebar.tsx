import { useEffect, useRef, useState } from "react";
import { api } from "./store";
import type { Project } from "./types";
import { ACCENTS, THEMES, type Settings } from "./settings";

export type Section = "project" | "theme" | "effects" | "about";

const NAV: { id: Section; icon: string; label: string }[] = [
  { id: "project", icon: "▤", label: "Dự án" },
  { id: "theme", icon: "◐", label: "Màu sắc" },
  { id: "effects", icon: "✦", label: "Hiệu ứng" },
  { id: "about", icon: "ⓘ", label: "Thông tin" },
];

export function Sidebar({
  open,
  onClose,
  settings,
  update,
  workspace,
  project,
  section,
  setSection,
}: {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  update: (p: Partial<Settings>) => void;
  workspace: string;
  project: Project | undefined;
  section: Section;
  setSection: (s: Section) => void;
}) {

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Cài đặt">
        <header className="drawer-head">
          <b>Cài đặt</b>
          <button onClick={onClose} aria-label="Đóng">
            ✕
          </button>
        </header>

        <nav className="drawer-nav">
          {NAV.map((n) => (
            <button key={n.id} className={section === n.id ? "sel" : ""} onClick={() => setSection(n.id)}>
              <i>{n.icon}</i>
              {n.label}
            </button>
          ))}
        </nav>

        <div className="drawer-body">
          {section === "project" && project && <ProjectSettings key={project.id} project={project} />}

          {section === "theme" && (
            <>
              <section>
                <h3>Giao diện</h3>
                <p className="desc">Chọn bộ màu tổng thể cho bảng điều khiển.</p>
                <div className="theme-grid">
                  {THEMES.map((t) => (
                    <button key={t.id} className={`theme-card ${settings.theme === t.id ? "sel" : ""}`} onClick={() => update({ theme: t.id })} aria-pressed={settings.theme === t.id}>
                      <div className={`prev ${t.id}`}>
                        <div className="bar" />
                        <div className="row">
                          <div className="box" />
                          <div className="box" />
                        </div>
                        <div className="dotx" />
                      </div>
                      <div className="meta">
                        <b>{t.name}</b>
                        <small>{t.note}</small>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
              <section>
                <h3>Màu nhấn</h3>
                <p className="desc">Màu của nút chính, thanh tiến độ, tab đang chọn và tin nhắn của anh.</p>
                <div className="swatches">
                  {ACCENTS.map((a) => {
                    const [c1, c2] = a.colors[settings.theme];
                    return (
                      <button
                        key={a.id}
                        className={`swatch ${settings.accent === a.id ? "sel" : ""}`}
                        onClick={() => update({ accent: a.id })}
                        title={a.name}
                        aria-label={a.name}
                        aria-pressed={settings.accent === a.id}
                      >
                        <span style={{ background: settings.theme === "galaxy" ? `linear-gradient(135deg, ${c1}, ${c2})` : c1 }} />
                      </button>
                    );
                  })}
                </div>
                <div className="swatch-label">{ACCENTS.find((a) => a.id === settings.accent)?.name}</div>
              </section>
            </>
          )}

          {section === "effects" && (
            <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <h3>Hiệu ứng</h3>
              <div className="toggle-row">
                <div>
                  <b>Nền sao động</b>
                  <small>{settings.theme === "galaxy" ? "Sao trôi, sao băng, tinh vân" : "Chỉ có ở giao diện Galaxy"}</small>
                </div>
                <button
                  className={`switch ${settings.stars ? "on" : ""}`}
                  disabled={settings.theme !== "galaxy"}
                  onClick={() => update({ stars: !settings.stars })}
                  role="switch"
                  aria-checked={settings.stars}
                  aria-label="Nền sao động"
                />
              </div>
              <div className="toggle-row">
                <div>
                  <b>Chuyển động</b>
                  <small>Nhịp sáng, vệt chạy trên đường nối, gói tin bàn giao</small>
                </div>
                <button className={`switch ${settings.motion ? "on" : ""}`} onClick={() => update({ motion: !settings.motion })} role="switch" aria-checked={settings.motion} aria-label="Chuyển động" />
              </div>
            </section>
          )}

          {section === "about" && (
            <section>
              <h3>Thông tin</h3>
              <dl className="info-list">
                <dt>Workspace</dt>
                <dd>{workspace}</dd>
                <dt>Server</dt>
                <dd>{location.host}</dd>
                <dt>Agent</dt>
                <dd>~/Documents/code_vibe/agent-team/agents/*.md</dd>
                <dt>Bàn giao</dt>
                <dd>{workspace}/.claude/tasks/</dd>
              </dl>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}

const DEV_NAME: Record<string, string> = { min: "Min · Backend", rio: "Rio · Frontend", paul: "Paul · Mobile", mouse: "Mouse · Game" };

/** Thông tin + ghi chú riêng của dự án. Ghi chú tự lưu, và được đưa vào ngữ cảnh của mọi agent. */
function ProjectSettings({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);
  const [jira, setJira] = useState(project.jiraKey ?? "");
  const [notes, setNotes] = useState(project.notes);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<number | undefined>(undefined);

  const save = async (patch: Partial<Project>) => {
    setSaved("saving");
    await api(`/api/projects/${project.id}`, patch, "PUT");
    setSaved("saved");
  };
  const onNotes = (v: string) => {
    setNotes(v);
    setSaved("saving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save({ notes: v }), 700);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <>
      <section>
        <h3>Dự án</h3>
        <div className="form tight">
          <label>
            Tên
            <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== project.name && save({ name })} />
          </label>
          <label>
            Mã Jira <span className="opt">(bỏ trống = không dùng Jira)</span>
            <input value={jira} onChange={(e) => setJira(e.target.value.toUpperCase())} onBlur={() => jira !== (project.jiraKey ?? "") && save({ jiraKey: jira })} />
          </label>
        </div>
        <dl className="info-list" style={{ marginTop: 12 }}>
          <dt>Workspace</dt>
          <dd>{project.workspace}</dd>
          {Object.entries(project.repos).map(([r, c]) => (
            <FragmentRow key={r} k={r === "." ? "Repo" : r} v={`${c.base}${c.project ? ` · ${c.project}` : ""}`} />
          ))}
          {Object.entries(project.devRepo).map(([d, r]) => (
            <FragmentRow key={d} k={DEV_NAME[d] ?? d} v={r ?? "—"} />
          ))}
        </dl>
      </section>
      <section>
        <h3>Ghi chú dự án</h3>
        <p className="desc">Quy ước, lưu ý, việc cần nhớ của riêng dự án này. Mọi agent đọc ghi chú này mỗi khi làm cho dự án.</p>
        <textarea className="notes" value={notes} onChange={(e) => onNotes(e.target.value)} placeholder={"vd:\n- Nhánh gốc FE là dev-ios\n- Không chạy migration, field mới luôn nullable\n- Reviewer MR: Rin"} />
        <div className="save-state">{saved === "saving" ? "Đang lưu…" : saved === "saved" ? "Đã lưu ✓" : ""}</div>
      </section>
      <section>
        <button
          className="danger"
          onClick={async () => {
            if (!window.confirm(`Gỡ "${project.name}" khỏi danh sách dự án? File trên máy giữ nguyên.`)) return;
            try {
              await api(`/api/projects/${project.id}`, undefined, "DELETE");
            } catch (e) {
              window.alert((e as Error).message);
            }
          }}
        >
          Gỡ dự án khỏi danh sách
        </button>
      </section>
    </>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
