import { useEffect, useReducer, useState } from "react";
import type { Account, AgentState, LogEntry, Message, Project, Snapshot, Task, Usage } from "./types";

type Msg = { t: "agent"; agent: AgentState } | { t: "log"; entry: LogEntry } | { t: "task"; task: Task } | { t: "msg"; m: Message } | { t: "usage"; usage: Usage } | { t: "projects"; projects: Project[]; activeProjectId: string } | { t: "account"; account: Account };

function reduce(s: Snapshot | null, a: { t: "init"; snap: Snapshot } | Msg): Snapshot | null {
  if (a.t === "init") return a.snap;
  if (!s) return s;
  switch (a.t) {
    case "agent":
      return { ...s, agents: { ...s.agents, [a.agent.id]: a.agent } };
    case "log":
      if (s.logs.at(-1)?.id === a.entry.id) return s;
      return { ...s, logs: [...s.logs, a.entry].slice(-3000) };
    case "task": {
      const i = s.tasks.findIndex((t) => t.id === a.task.id);
      const tasks = i < 0 ? [a.task, ...s.tasks] : s.tasks.map((t) => (t.id === a.task.id ? a.task : t));
      return { ...s, tasks };
    }
    case "projects":
      return { ...s, projects: a.projects, activeProjectId: a.activeProjectId };
    case "account":
      return { ...s, account: a.account };
    case "usage":
      return { ...s, usage: a.usage };
    case "msg":
      if (s.messages.some((m) => m.id === a.m.id)) return s;
      return { ...s, messages: [...s.messages, a.m] };
    default:
      return s;
  }
}

/** Lấy snapshot qua REST rồi nghe cập nhật qua WebSocket; tự nối lại khi rớt mạng. */
export function useTeam() {
  const [snap, dispatch] = useReducer(reduce, null);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: number | undefined;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = async () => {
        setOnline(true);
        const snap = (await fetch("/api/state").then((r) => r.json())) as Snapshot;
        dispatch({ t: "init", snap });
      };
      ws.onmessage = (e) => dispatch(JSON.parse(e.data) as Msg);
      ws.onclose = () => {
        setOnline(false);
        if (!closed) retry = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { snap, online };
}

export async function api(path: string, body?: unknown, method?: string) {
  const res = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}
