import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Avatar, STATUS_LABEL, USER, party } from "./ui";
import type { AgentId, Message, Party, Snapshot } from "./types";

/** Toạ độ trong khung 1000 × 780 (khớp viewBox của SVG). Phần dưới hàng dev để chừa chỗ cho các cung Min ↔ client. */
const VB_H = 780;
const POS: Record<Party, { x: number; y: number }> = {
  user: { x: 500, y: 40 },
  vu: { x: 500, y: 150 },
  lucas: { x: 500, y: 290 },
  pual: { x: 160, y: 285 },
  james: { x: 160, y: 445 },
  min: { x: 125, y: 615 },
  rio: { x: 375, y: 615 },
  paul: { x: 625, y: 615 },
  mouse: { x: 875, y: 615 },
};

/**
 * Các đường cố định của luồng làm việc. Hai chiều của một cặp tự cong về hai phía.
 * Lucas ↔ từng dev là các tia giao việc song song (không nhãn cho đỡ rối); những bàn giao
 * khác (James → dev, Vũ → dev báo lỗi kiểm) hiện đường tạm khi có gói tin chạy qua.
 */
type Edge = { from: Party; to: Party; label: string; /** Cung vòng xuống dưới (cho các nút cùng hàng), độ sâu điểm điều khiển. */ dip?: number };

const EDGES: Edge[] = [
  { from: "user", to: "vu", label: "giao task" },
  { from: "vu", to: "user", label: "báo cáo" },
  { from: "vu", to: "lucas", label: "phân tích" },
  { from: "lucas", to: "vu", label: "PASS" },
  { from: "lucas", to: "pual", label: "brief" },
  { from: "pual", to: "james", label: "thiết kế" },
  { from: "james", to: "pual", label: "cần sửa" },
  ...(["min", "rio", "paul", "mouse"] as const).flatMap((d) => [
    { from: "lucas" as Party, to: d as Party, label: d === "min" ? "giao việc song song" : "" },
    { from: d as Party, to: "lucas" as Party, label: "" },
  ]),
  // Min làm việc TRỰC TIẾP với từng client: gửi hợp đồng API đã chốt, nhận kết quả đối chiếu.
  ...(["rio", "paul", "mouse"] as const).flatMap((c, i) => [
    { from: "min" as Party, to: c as Party, label: "", dip: 140 + i * 45 },
    { from: c as Party, to: "min" as Party, label: c === "mouse" ? "Min ⇄ client: hợp đồng API · đối chiếu" : "", dip: 162 + i * 45 },
  ]),
];

const BEND = 34;

function geom(from: Party, to: Party) {
  const p = POS[from];
  const q = POS[to];
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const dip = EDGES.find((e) => e.from === from && e.to === to)?.dip;
  if (dip) {
    // cung vòng xuống dưới hàng dev: không cắt qua các nút nằm giữa
    const c = { x: (p.x + q.x) / 2, y: Math.max(p.y, q.y) + dip };
    const mid = { x: 0.25 * p.x + 0.5 * c.x + 0.25 * q.x, y: 0.25 * p.y + 0.5 * c.y + 0.25 * q.y };
    return { d: `M${p.x},${p.y} Q${c.x},${c.y} ${q.x},${q.y}`, mid, angle: (Math.atan2(dy, dx) * 180) / Math.PI, nx: 0, ny: 1 };
  }
  const len = Math.hypot(dx, dy) || 1;
  // pháp tuyến đổi chiều theo hướng đi, nên A→B và B→A cong về hai phía khác nhau
  const nx = -dy / len;
  const ny = dx / len;
  const c = { x: (p.x + q.x) / 2 + nx * BEND, y: (p.y + q.y) / 2 + ny * BEND };
  const mid = { x: 0.25 * p.x + 0.5 * c.x + 0.25 * q.x, y: 0.25 * p.y + 0.5 * c.y + 0.25 * q.y };
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return { d: `M${p.x},${p.y} Q${c.x},${c.y} ${q.x},${q.y}`, mid, angle, nx, ny };
}

type Packet = { id: number; from: Party; to: Party; color: string };

export function Graph({ snap, selected, onSelect }: { snap: Snapshot; selected: AgentId | null; onSelect: (id: AgentId | null) => void }) {
  const [packets, setPackets] = useState<Packet[]>([]);
  const [pinged, setPinged] = useState<Record<string, number>>({});
  const seen = useRef<number>(snap.messages.at(-1)?.id ?? 0);

  // Tin nhắn mới tới qua socket → bắn một gói chạy dọc đường nối, tới nơi thì nút nhận loé lên.
  useEffect(() => {
    const fresh = snap.messages.filter((m) => m.id > seen.current);
    if (!fresh.length) return;
    seen.current = fresh.at(-1)!.id;
    setPackets((ps) => [...ps, ...fresh.map((m) => ({ id: m.id, from: m.from, to: m.to, color: party(snap, m.from).color }))]);
    for (const m of fresh) {
      window.setTimeout(() => setPinged((p) => ({ ...p, [m.to]: Date.now() })), 1300);
      window.setTimeout(() => setPackets((ps) => ps.filter((x) => x.id !== m.id)), 1700);
    }
  }, [snap.messages, snap]);

  // Đường "đang nóng": người gửi gần nhất → agent đang làm việc.
  const hot = useMemo(() => {
    const set = new Set<string>();
    for (const id of Object.keys(snap.agents) as AgentId[]) {
      if (snap.agents[id].status !== "working") continue;
      const last = findLast(snap.messages, (m) => m.to === id);
      if (last) set.add(`${last.from}>${id}`);
    }
    return set;
  }, [snap.agents, snap.messages]);

  const extra = packets.filter((p) => !EDGES.some((e) => e.from === p.from && e.to === p.to));
  const parties: Party[] = ["user", "vu", "lucas", "pual", "james", "min", "rio", "paul", "mouse"];

  return (
    <div className="graph-wrap">
      <div className="graph">
        <svg viewBox={`0 0 1000 ${VB_H}`} preserveAspectRatio="none" className="edges">
          <defs>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3.5" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {EDGES.map((e) => {
            const g = geom(e.from, e.to);
            const key = `${e.from}>${e.to}`;
            const isHot = hot.has(key);
            const color = party(snap, e.from).color;
            return (
              <g key={key} className={`edge ${isHot ? "hot" : ""}`} style={{ ["--c" as string]: color }}>
                <path d={g.d} className="edge-base" />
                {isHot && <path d={g.d} className="edge-flow" filter="url(#glow)" />}
                <g transform={`translate(${g.mid.x},${g.mid.y}) rotate(${g.angle})`}>
                  <path d="M-5,-5 L4,0 L-5,5" className="chev" />
                </g>
                <text x={g.mid.x + g.nx * 16} y={g.mid.y + g.ny * 16 + 4} className="edge-label" textAnchor="middle">
                  {e.label}
                </text>
              </g>
            );
          })}
          {extra.map((p) => (
            <path key={`x${p.id}`} d={geom(p.from, p.to).d} className="edge-base temp" />
          ))}
          {[...hot]
            .filter((k) => !EDGES.some((e) => `${e.from}>${e.to}` === k))
            .map((k) => {
              const [from, to] = k.split(">") as [Party, Party];
              const d = geom(from, to).d;
              return (
                <g key={`h${k}`} className="edge hot" style={{ ["--c" as string]: party(snap, from).color }}>
                  <path d={d} className="edge-base temp" />
                  <path d={d} className="edge-flow" filter="url(#glow)" />
                </g>
              );
            })}
          {packets.map((p) => (
            <PacketDot key={p.id} d={geom(p.from, p.to).d} color={p.color} />
          ))}
        </svg>

        {parties.map((id) => {
          const pos = POS[id];
          const style = { left: `${pos.x / 10}%`, top: `${(pos.y / VB_H) * 100}%` };
          const ping = pinged[id] && Date.now() - pinged[id] < 900;
          if (id === "user") {
            return (
              <div key={id} className={`node user ${ping ? "ping" : ""}`} style={style}>
                <Avatar a={USER} size={30} />
                <b>Anh</b>
              </div>
            );
          }
          const a = snap.agents[id];
          return (
            <button
              key={id}
              className={`node ${a.status} ${selected === id ? "sel" : ""} ${ping ? "ping" : ""}`}
              style={{ ...style, ["--c" as string]: a.color }}
              onClick={() => onSelect(selected === id ? null : id)}
            >
              <div className="node-head">
                <Avatar a={a} size={32} />
                <div className="node-name">
                  <b>{a.name}</b>
                  <small>{a.role}</small>
                </div>
              </div>
              <div className="node-act">
                <span className={`pill ${a.status}`}>{STATUS_LABEL[a.status]}</span>
                <span className="act-text">{a.activity || (a.status === "idle" ? "Đang chờ việc" : "")}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const FLIGHT_MS = 1300;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Chấm sáng chạy dọc đường cong, tự tính vị trí mỗi khung hình (SMIL animateMotion không nội suy ổn định). */
function PacketDot({ d, color }: { d: string; color: string }) {
  const track = useRef<SVGPathElement>(null);
  const dot = useRef<SVGGElement>(null);
  useLayoutEffect(() => {
    const path = track.current!;
    const len = path.getTotalLength();
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / FLIGHT_MS);
      const pt = path.getPointAtLength(len * ease(t));
      dot.current?.setAttribute("transform", `translate(${pt.x},${pt.y})`);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    tick(start);
    return () => cancelAnimationFrame(raf);
  }, [d]);
  return (
    <g>
      <path ref={track} d={d} fill="none" stroke="none" />
      <g ref={dot} className="packet" filter="url(#glow)">
        <circle r="16" fill={color} opacity="0.18" />
        <circle r="7" fill={color} />
        <circle r="3" fill="#fff" />
      </g>
    </g>
  );
}

function findLast<T>(arr: T[], fn: (x: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return arr[i];
  return undefined;
}

export type { Message };
