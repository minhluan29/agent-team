// Giữ khớp với server/src/state.ts
export type AgentId = "vu" | "lucas" | "pual" | "james" | "min" | "rio" | "paul" | "mouse";

export type AgentState = {
  id: AgentId;
  name: string;
  role: string;
  color: string;
  status: "idle" | "working" | "error";
  activity: string;
  taskId: string | null;
  sessionId: string | null;
  costUsd: number;
};

export type LogEntry = {
  id: number;
  projectId?: string;
  ts: number;
  agent: AgentId;
  taskId: string | null;
  kind: "prompt" | "text" | "tool" | "result" | "error" | "system";
  text: string;
};

export type Step = {
  id: string;
  agent: AgentId;
  label: string;
  status: "running" | "done" | "failed";
  verdict?: string;
  startedAt: number;
  endedAt?: number;
};

export type Task = {
  id: string;
  projectId?: string;
  input: string;
  key?: string;
  summary?: string;
  branch?: string;
  mrUrl?: string;
  status: "queued" | "running" | "done" | "failed" | "stopped";
  error?: string;
  steps: Step[];
  createdAt: number;
};

export type Party = AgentId | "user";

export type Message = {
  id: number;
  projectId?: string;
  ts: number;
  taskId: string | null;
  from: Party;
  to: Party;
  text: string;
  file?: string;
};

export type UsageWindow = { utilization: number; resetsAt: number };
export type Usage = { windows: Record<string, UsageWindow>; status: string; updatedAt: number };

export type DevId = "min" | "rio" | "paul" | "mouse";
export type Project = {
  id: string;
  name: string;
  workspace: string;
  jiraKey?: string;
  repos: Record<string, { base: string; project: string; exclude: string[] }>;
  devRepo: Partial<Record<DevId, string>>;
  notes: string;
  createdAt: number;
};
export type Account = { loggedIn: boolean; email?: string; orgName?: string; subscriptionType?: string; authMethod?: string; loggingIn?: boolean };

export type Snapshot = {
  agents: Record<AgentId, AgentState>;
  tasks: Task[];
  logs: LogEntry[];
  messages: Message[];
  usage: Usage | null;
  workspace: string;
  projects: Project[];
  activeProjectId: string;
  account: Account;
};

export const AGENT_ORDER: AgentId[] = ["vu", "lucas", "pual", "james", "min", "rio", "paul", "mouse"];
