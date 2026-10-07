import { useEffect, useMemo, useRef, useState } from "react";
import { Graph } from "./Graph";
import { AccountChip, ProjectSwitcher } from "./ProjectBar";
import { useSettings } from "./settings";
import { Sidebar, type Section } from "./Sidebar";
import { Starfield } from "./Starfield";
import { UsageMeter } from "./UsageMeter";
import { api, useTeam } from "./store";
import { AGENT_ORDER, type AgentId, type LogEntry, type Message, type Snapshot, type Task } from "./types";
import { Avatar, DocsModal, TASK_LABEL, dur, isGood, md, party, time } from "./ui";

type Tab = "graph" | "chat";
type Docs = { task: Task; file?: string } | null;

export default function App() {
  // eslint-disable-next-line prefer-const
  let { snap, online } = useTeam();
  const [tab, setTab] = useState<Tab>("graph");
  const [docs, setDocs] = useState<Docs>(null);
  const [selected, setSelected] = useState<AgentId | null>(null);
  const [seen, setSeen] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [section, setSection] = useState<Section>("project");
  const [pick, setPick] = useState<string | null>(null);
  // Ô chat đóng/mở được; nhớ lựa chọn theo trình duyệt.
  const [chatOpen, setChatOpenRaw] = useState(() => {
    try {
      return localStorage.getItem("chatOpen") !== "0";
    } catch {
      return true;
    }
  });
  const setChatOpen = (v: boolean) => {
    setChatOpenRaw(v);
    try {
      localStorage.setItem("chatOpen", v ? "1" : "0");
    } catch {
      /* trình duyệt chặn lưu thì thôi */
    }
  };
  const { settings, update } = useSettings();
  const showStars = settings.theme === "galaxy" && settings.stars;
  const lastId = snap?.messages.at(-1)?.id ?? 0;
  useEffect(() => {
    if (tab === "chat") setSeen(lastId);
  }, [tab, lastId]);

  if (!snap)
    return (
      <>
        {showStars && <Starfield />}
        <div className="boot">
          <span className="boot-ring" />
          {online ? "ĐANG TẢI…" : "ĐANG KẾT NỐI SERVER…"}
        </div>
      </>
    );

  // Chỉ hiện task / tin nhắn / log của dự án đang chọn (dữ liệu cũ không gắn dự án thuộc Nhà Mình).
  const pid = snap.activeProjectId;
  const mine = (x: { projectId?: string }) => (x.projectId ?? "nha-minh") === pid;
  const raw = snap;
  snap = { ...raw, tasks: raw.tasks.filter(mine), messages: raw.messages.filter(mine), logs: raw.logs.filter(mine) };
  const project = snap.projects?.find((p) => p.id === pid);
  const busyElsewhere = raw.tasks.some((t) => t.status === "running" && !mine(t));
  const total = AGENT_ORDER.reduce((n, id) => n + snap.agents[id].costUsd, 0);
  const unread = snap.messages.filter((m) => m.id > seen && m.from !== "user" && m.to !== "user").length;
  const working = AGENT_ORDER.filter((id) => snap.agents[id].status === "working").length;
  const task = snap.tasks.find((t) => t.id === pick) ?? snap.tasks.find((t) => t.status === "running") ?? snap.tasks[0];
  const jira = !!project?.jiraKey;

  return (
    <>
    {showStars && <Starfield />}
    <div className="app">
      <header className="top">
        <button
          className="menu-btn"
          onClick={() => {
            setSection("project");
            setMenuOpen(true);
          }}
          aria-label="Mở cài đặt"
          title="Cài đặt"
        >
          <span />
        </button>
        <div className="brand">
          <span className="logo" aria-hidden>
            <i />
          </span>
          <div>
            <b>AGENT//TEAM</b>
            <small>{working ? `${working} agent đang chạy` : "đội đang rảnh"}{busyElsewhere ? " · có task ở dự án khác" : ""}</small>
          </div>
        </div>
        {snap.projects && <ProjectSwitcher projects={snap.projects} activeId={pid} busy={raw.tasks.some((t) => t.status === "running")} />}
        <button
          className="icon-btn notes-btn"
          onClick={() => {
            setSection("project");
            setMenuOpen(true);
          }}
          title="Ghi chú dự án"
          aria-label="Ghi chú dự án"
        >
          ✎{project?.notes.trim() ? <i className="notes-dot" /> : null}
        </button>
        <nav className="main-tabs">
          <button className={tab === "graph" ? "sel" : ""} onClick={() => setTab("graph")}>
            <span className="tab-ico">◉</span> Sơ đồ làm việc
          </button>
          <button className={tab === "chat" ? "sel" : ""} onClick={() => setTab("chat")}>
            <span className="tab-ico">⌁</span> Trao đổi giữa agent {unread > 0 && <span className="count">{unread}</span>}
          </button>
        </nav>
        <div className="spacer" />
        <UsageMeter usage={snap.usage} />
        <div className="hud-stat" title="Tổng chi phí ước tính (theo giá API) của các lượt agent">
          <span>COST</span>
          <b>${total.toFixed(2)}</b>
        </div>
        <button className="ghost" onClick={() => api("/api/demo", {})} title="Giả lập một task chạy hết chuỗi — không gọi Claude, không tốn tiền">
          ▶ Mô phỏng
        </button>
        {snap.account && <AccountChip account={snap.account} />}
        <div className={`dot ${online ? "on" : ""}`} title={online ? "Realtime đang kết nối" : "Mất kết nối"} />
      </header>

      {tab === "graph" ? (
        <main className={`graph-page${chatOpen ? "" : " chat-closed"}`}>
          <section className="graph-col">
            <TaskBar snap={snap} task={task} jira={jira} onDocs={(t) => setDocs({ task: t })} />
            <Graph
              snap={snap}
              selected={selected}
              onSelect={(id) => {
                setSelected(id);
                if (id) setChatOpen(true); // bấm nút agent thì mở khung để xem log
              }}
            />
          </section>
          {/* luôn render để đóng/mở có hiệu ứng trượt; lúc đóng thì ẩn khỏi tab/trình đọc màn hình */}
          <aside className={`side${chatOpen ? "" : " closed"}`} aria-hidden={!chatOpen}>
            <div className="side-col">
              <SessionBar snap={snap} task={task} onPick={setPick} onClose={() => setChatOpen(false)} />
              {selected ? <AgentPanel snap={snap} id={selected} onBack={() => setSelected(null)} /> : <CoordinatorPanel snap={snap} jira={jira} onDocs={setDocs} />}
            </div>
          </aside>
          <button className={`chat-tab${chatOpen ? "" : " show"}`} onClick={() => setChatOpen(true)} tabIndex={chatOpen ? -1 : 0} aria-label="Mở ô chat với Vũ">
            <span className="chat-tab-ico" aria-hidden>
              ⇤
            </span>
            <span className="chat-tab-text">Chat với Vũ</span>
          </button>
        </main>
      ) : (
        <Conversation snap={snap} onDocs={setDocs} />
      )}

      {docs && <DocsModal task={docs.task} initial={docs.file} onClose={() => setDocs(null)} />}
    </div>
    <Sidebar
      open={menuOpen}
      onClose={() => setMenuOpen(false)}
      settings={settings}
      update={update}
      workspace={project?.workspace ?? snap.workspace}
      project={project}
      section={section}
      setSection={setSection}
    />
    </>
  );
}

/* ---------------- Tab 1: thanh task + panel bên phải ---------------- */

/** Chọn task (session) — nằm ngay trên ô chat, kèm nút thu gọn khung chat. */
function SessionBar({ snap, task, onPick, onClose }: { snap: Snapshot; task?: Task; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <div className="session-bar">
      <button className="icon-btn" onClick={onClose} title="Thu gọn ô chat" aria-label="Thu gọn ô chat">
        ⇥
      </button>
      {task ? (
        <select value={task.id} onChange={(e) => onPick(e.target.value)} aria-label="Chọn task">
          {snap.tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.key ?? "Task mới"} · {TASK_LABEL[t.status]}
            </option>
          ))}
        </select>
      ) : (
        <span className="session-empty">Chưa có task</span>
      )}
    </div>
  );
}

function TaskBar({ snap, task, jira, onDocs }: { snap: Snapshot; task?: Task; jira: boolean; onDocs: (t: Task) => void }) {
  if (!task) return <div className="taskbar empty-bar">Chưa có task. Nhắn {jira ? "link Jira hoặc " : ""}mô tả việc cần làm cho Vũ (PM) ở ô chat để bắt đầu.</div>;
  return (
    <div className="taskbar">
      <div className="tb-head">
        <b className="tb-key">{task.key ?? "Task mới"}</b>
        <span className="tb-sum">{task.summary || task.input}</span>
        <span className={`pill ${task.status}`}>{TASK_LABEL[task.status]}</span>
        {task.key && <button onClick={() => onDocs(task)}>Tài liệu</button>}
        {task.mrUrl && (
          <a href={task.mrUrl} target="_blank" rel="noreferrer">
            MR ↗
          </a>
        )}
        {(task.status === "running" || task.status === "queued") && (
          <button className="danger" onClick={() => api(`/api/tasks/${task.id}/stop`, {})}>
            Dừng
          </button>
        )}
      </div>
      <ol className="chips">
        {task.steps.map((s) => (
          <li key={s.id} className={s.status} style={{ ["--c" as string]: snap.agents[s.agent].color }}>
            <b>{snap.agents[s.agent].name}</b> {s.label}
            {s.verdict && <em className={isGood(s.verdict) ? "ok" : "warn"}>{s.verdict}</em>}
            <small>{dur(s.startedAt, s.endedAt)}</small>
          </li>
        ))}
      </ol>
      {task.error && <div className="err">{task.error}</div>}
    </div>
  );
}

function useStickyScroll(dep: unknown) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = box.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  return { ref: box, onScroll };
}

function CoordinatorPanel({ snap, jira, onDocs }: { snap: Snapshot; jira: boolean; onDocs: (d: Docs) => void }) {
  const msgs = snap.messages.filter((m) => m.from === "user" || m.to === "user");
  const scroll = useStickyScroll(msgs.length);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const c = snap.agents.vu;

  // Chặn gửi lặp: bộ gõ tiếng Việt có thể bắn 2 phím Enter liền nhau cho một lần nhấn.
  const sending = useRef(false);
  const send = async () => {
    const message = text.trim();
    if (!message || sending.current) return;
    sending.current = true;
    setText(""); // xoá ngay, khỏi để lần Enter thứ hai đọc lại nội dung cũ
    try {
      await api("/api/coordinator", { message });
      setErr("");
    } catch (e) {
      setText(message); // gửi lỗi thì trả lại chữ cho anh sửa / gửi lại
      setErr((e as Error).message);
    } finally {
      sending.current = false;
    }
  };

  return (
    <div className="panel">
      <header className="panel-head">
        <Avatar a={c} size={30} />
        <div>
          <b>Vũ · PM</b>
          <small>{c.status === "working" ? c.activity || "Đang xử lý…" : "Nhắn để giao task hoặc hỏi tiến độ"}</small>
        </div>
      </header>
      <div className="panel-body" {...scroll}>
        {msgs.length === 0 && <div className="empty">{jira ? "Dán link Jira hoặc mô tả" : "Mô tả"} việc cần làm để giao cho cả đội, hoặc hỏi "Rio đang làm gì?".</div>}
        {msgs.map((m) => (
          <div key={m.id} className={`dm ${m.from === "user" ? "mine" : ""}`}>
            <div className="bubble md" dangerouslySetInnerHTML={md(m.text)} />
            <div className="dm-meta">
              {time(m.ts)}
              {m.file && <FileChip m={m} snap={snap} onDocs={onDocs} />}
            </div>
          </div>
        ))}
        {c.status === "working" && msgs.at(-1)?.from === "user" && (
          <div className="dm">
            <div className="bubble typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>
      <div className="composer">
        <textarea
          value={text}
          placeholder={jira ? "Nhắn Vũ… (dán link Jira hoặc mô tả task)" : "Nhắn Vũ… (mô tả task cần làm)"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter lúc bộ gõ (Telex/VNI) còn đang ghép chữ chỉ để chốt chữ, không phải lệnh gửi.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="primary" onClick={() => void send()} disabled={!text.trim()}>
          Gửi
        </button>
      </div>
      {err && <div className="err pad">{err}</div>}
    </div>
  );
}

function AgentPanel({ snap, id, onBack }: { snap: Snapshot; id: AgentId; onBack: () => void }) {
  const a = snap.agents[id];
  const logs = useMemo(() => snap.logs.filter((l) => l.agent === id && l.kind !== "prompt").slice(-300), [snap.logs, id]);
  const scroll = useStickyScroll(logs.length);
  return (
    <div className="panel">
      <header className="panel-head">
        <button className="back" onClick={onBack} aria-label="Quay lại khung chat với Vũ">
          ←
        </button>
        <Avatar a={a} size={30} />
        <div>
          <b>{a.name}</b>
          <small>
            {a.role} · ${a.costUsd.toFixed(2)}
          </small>
        </div>
        {a.status === "working" && (
          <button className="danger sm" onClick={() => api(`/api/agents/${id}/stop`, {})}>
            Dừng
          </button>
        )}
      </header>
      <div className="panel-body log" {...scroll}>
        {logs.length === 0 && <div className="empty">{a.name} chưa làm gì.</div>}
        {logs.map((l) => (
          <LogLine key={l.id} l={l} />
        ))}
      </div>
      <div className="hint">Các agent làm việc độc lập; muốn giao việc thì nhắn Vũ (PM).</div>
    </div>
  );
}

function LogLine({ l }: { l: LogEntry }) {
  if (l.kind === "tool") return <div className="tool-line">{l.text}</div>;
  if (l.kind === "text") return <div className="log-text md" dangerouslySetInnerHTML={md(l.text)} />;
  return <div className={`chip-line ${l.kind}`}>{l.text}</div>;
}

/* ---------------- Tab 2: các agent trao đổi với nhau ---------------- */

function Conversation({ snap, onDocs }: { snap: Snapshot; onDocs: (d: Docs) => void }) {
  const [taskId, setTaskId] = useState<string | "all">("all");
  const [withUser, setWithUser] = useState(true);
  const msgs = snap.messages.filter((m) => (taskId === "all" || m.taskId === taskId) && (withUser || (m.from !== "user" && m.to !== "user")));
  const scroll = useStickyScroll(msgs.length + taskId);
  const typing = AGENT_ORDER.filter((id) => snap.agents[id].status === "working");

  return (
    <main className="conv-page">
      <aside className="conv-tasks">
        <button className={taskId === "all" ? "sel" : ""} onClick={() => setTaskId("all")}>
          Tất cả
        </button>
        {snap.tasks.map((t) => (
          <button key={t.id} className={taskId === t.id ? "sel" : ""} onClick={() => setTaskId(t.id)}>
            <b>{t.key ?? "Task mới"}</b>
            <small>{t.summary || t.input}</small>
            <span className={`pill ${t.status}`}>{TASK_LABEL[t.status]}</span>
          </button>
        ))}
        <label className="toggle">
          <input type="checkbox" checked={withUser} onChange={(e) => setWithUser(e.target.checked)} /> Hiện tin của anh ↔ Vũ
        </label>
      </aside>

      <section className="thread" {...scroll}>
        {msgs.length === 0 && <div className="empty">Chưa có trao đổi nào. Khi đội làm task, các agent nhắn cho nhau ở đây.</div>}
        {msgs.map((m, i) => {
          const from = party(snap, m.from);
          const to = party(snap, m.to);
          const newTask = taskId === "all" && m.taskId && m.taskId !== msgs[i - 1]?.taskId;
          const task = newTask ? snap.tasks.find((t) => t.id === m.taskId) : null;
          return (
            <div key={m.id}>
              {task && (
                <div className="sep">
                  <span>{task.key ?? "Task"} · {task.summary || task.input}</span>
                </div>
              )}
              <article className="msg" style={{ ["--c" as string]: from.color }}>
                <Avatar a={from} size={34} />
                <div className="msg-body">
                  <div className="msg-head">
                    <b style={{ color: from.color }}>{from.name}</b>
                    <span className="to">
                      → <Avatar a={to} size={18} /> {to.name}
                    </span>
                    <time>{time(m.ts)}</time>
                  </div>
                  <div className="msg-text md" dangerouslySetInnerHTML={md(m.text)} />
                  {m.file && <FileChip m={m} snap={snap} onDocs={onDocs} />}
                </div>
              </article>
            </div>
          );
        })}
        {typing.length > 0 && (
          <div className="typing-row">
            {typing.map((id) => (
              <span key={id} style={{ color: snap.agents[id].color }}>
                <span className="spinner" />
                {snap.agents[id].name} đang làm…
              </span>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function FileChip({ m, snap, onDocs }: { m: Message; snap: Snapshot; onDocs: (d: Docs) => void }) {
  const task = snap.tasks.find((t) => t.id === m.taskId);
  if (!task || !m.file) return null;
  return (
    <button className="file-chip" onClick={() => onDocs({ task, file: m.file })}>
      📄 {m.file}
    </button>
  );
}
