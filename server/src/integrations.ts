import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { currentProject } from "./projects.js";

/**
 * Việc cố định (git, Jira, GitLab) chạy thẳng bằng code thay vì nhờ agent: vài giây thay vì
 * vài phút, và không tốn token. Credential lấy từ cấu hình MCP sẵn có của workspace trong
 * ~/.claude.json, nên không phải khai báo lại ở đâu.
 */

type Env = Record<string, string>;

function mcpEnv(name: string): Env {
  const file = path.join(os.homedir(), ".claude.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const ws = currentProject().workspace;
  // ưu tiên cấu hình của chính workspace; không có thì mượn của dự án khác / cấu hình chung
  const env =
    d.projects?.[ws]?.mcpServers?.[name]?.env ??
    d.mcpServers?.[name]?.env ??
    Object.values<any>(d.projects ?? {}).find((p) => p?.mcpServers?.[name]?.env)?.mcpServers[name].env;
  if (!env) throw new Error(`Không thấy cấu hình MCP "${name}" trong ~/.claude.json`);
  return env;
}

// ---------------- Jira ----------------

export async function jira<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const env = mcpEnv("atlassian-jira");
  const auth = Buffer.from(`${env.ATLASSIAN_USER_EMAIL}:${env.ATLASSIAN_API_TOKEN}`).toString("base64");
  const res = await fetch(`https://${env.ATLASSIAN_SITE_NAME}.atlassian.net${p}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jira ${method} ${p}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (res.status === 204 ? null : res.json()) as T;
}

/** ADF (định dạng mô tả của Jira) → markdown đủ đọc cho agent. */
export function adfToMd(node: any, depth = 0): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  const kids = (sep = "") => (node.content ?? []).map((c: any) => adfToMd(c, depth)).join(sep);
  switch (node.type) {
    case "doc":
      return kids("\n\n");
    case "paragraph":
      return kids();
    case "text": {
      let t = node.text ?? "";
      for (const m of node.marks ?? []) {
        if (m.type === "code") t = `\`${t}\``;
        else if (m.type === "strong") t = `**${t}**`;
        else if (m.type === "link") t = `[${t}](${m.attrs?.href})`;
      }
      return t;
    }
    case "hardBreak":
      return "\n";
    case "heading":
      return `${"#".repeat(node.attrs?.level ?? 2)} ${kids()}`;
    case "bulletList":
      return (node.content ?? []).map((li: any) => `${"  ".repeat(depth)}- ${adfToMd(li, depth + 1).trim()}`).join("\n");
    case "orderedList":
      return (node.content ?? []).map((li: any, i: number) => `${"  ".repeat(depth)}${i + 1}. ${adfToMd(li, depth + 1).trim()}`).join("\n");
    case "taskList":
      return (node.content ?? []).map((li: any) => `${"  ".repeat(depth)}- [${li.attrs?.state === "DONE" ? "x" : " "}] ${adfToMd(li, depth + 1).trim()}`).join("\n");
    case "listItem":
    case "taskItem":
      return kids("\n");
    case "codeBlock":
      return "```\n" + kids() + "\n```";
    case "rule":
      return "---";
    case "table":
      return (node.content ?? []).map((row: any) => "| " + (row.content ?? []).map((c: any) => adfToMd(c, depth).replace(/\n/g, " ")).join(" | ") + " |").join("\n");
    case "mention":
      return `@${node.attrs?.text ?? ""}`;
    case "emoji":
      return node.attrs?.text ?? node.attrs?.shortName ?? "";
    default:
      return kids(node.content?.length > 1 ? "\n" : "");
  }
}

/** Văn bản thường (đoạn cách nhau dòng trống, dòng "- " là gạch đầu dòng) → ADF để comment Jira. */
export function textToAdf(text: string) {
  const content: any[] = [];
  for (const block of text.trim().split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const h = lines[0].match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      content.push({ type: "heading", attrs: { level: h[1].length }, content: inline(h[2]) });
      lines.shift();
      if (!lines.length) continue;
    }
    if (lines.every((l) => /^\s*[-*] /.test(l))) {
      content.push({
        type: "bulletList",
        content: lines.map((l) => ({ type: "listItem", content: [{ type: "paragraph", content: inline(l.replace(/^\s*[-*] /, "")) }] })),
      });
    } else {
      content.push({ type: "paragraph", content: lines.flatMap((l, i) => (i ? [{ type: "hardBreak" }, ...inline(l)] : inline(l))) });
    }
  }
  return { type: "doc", version: 1, content };
}

function inline(s: string) {
  // tách link để Jira hiện thành link bấm được
  const out: any[] = [];
  for (const part of s.split(/(https?:\/\/\S+)/)) {
    if (!part) continue;
    out.push(/^https?:\/\//.test(part) ? { type: "text", text: part, marks: [{ type: "link", attrs: { href: part } }] } : { type: "text", text: part });
  }
  return out.length ? out : [{ type: "text", text: " " }];
}

/** Tạo ticket Task trong project Jira, trả về mã (vd NM-695). */
export async function createJiraTask(projectKey: string, summary: string, description: string, labels: string[]) {
  const res = await jira<{ key: string }>("POST", "/rest/api/3/issue", {
    fields: {
      project: { key: projectKey },
      issuetype: { id: "10015" }, // Task
      summary,
      description: textToAdf(description),
      labels,
    },
  });
  return res.key;
}

export async function jiraTransition(key: string, match: RegExp) {
  const { transitions } = await jira<{ transitions: { id: string; name: string; to: { name: string } }[] }>("GET", `/rest/api/3/issue/${key}/transitions`);
  const t = transitions.find((x) => match.test(x.name) || match.test(x.to?.name ?? ""));
  if (!t) return null;
  await jira("POST", `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
  return t.to?.name ?? t.name;
}

// ---------------- GitLab ----------------

export async function gitlab<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const env = mcpEnv("gitlab");
  const base = (env.GITLAB_API_URL || "https://gitlab.com/api/v4").replace(/\/$/, "");
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "PRIVATE-TOKEN": env.GITLAB_PERSONAL_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitLab ${method} ${p}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (res.status === 204 ? null : res.json()) as Promise<T>;
}

// ---------------- git / shell ----------------

const pexec = promisify(execFile);

export async function sh(cmd: string, args: string[], cwd: string, timeoutMs = 10 * 60_000) {
  try {
    const { stdout } = await pexec(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e: any) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    const err = new Error(out || e.message) as Error & { output?: string; code?: number };
    err.output = out;
    err.code = e.code;
    throw err;
  }
}

export const git = (repo: string, ...args: string[]) => sh("git", ["-C", repoPath(repo), ...args], repoPath(repo));

/** Tên repo trong dự án (thư mục con của workspace, hoặc "." nếu workspace chính là repo). */
export type Repo = string;
export function repoCfg(repo: Repo) {
  const c = currentProject().repos[repo];
  if (!c) throw new Error(`Dự án ${currentProject().name} không có repo "${repo}"`);
  return c;
}

export function repoPath(repo: string) {
  return path.join(currentProject().workspace, repo);
}

/** Bẩn = có thay đổi thật chưa commit; con trỏ submodule lệch thì bỏ qua. */
export async function dirtyFiles(repo: Repo) {
  const out = await git(repo, "status", "--porcelain", "--ignore-submodules=all");
  return out.split("\n").filter(Boolean);
}

export async function prepareBranch(repo: Repo, branch: string) {
  const { base } = repoCfg(repo);
  // remote mới tạo (GitHub trống) chưa có nhánh gốc thì coi như repo chỉ có trên máy
  const hasRemote = !!base && !!(await git(repo, "remote")).trim() && !!(await git(repo, "ls-remote", "--heads", "origin", base).catch(() => "")).trim();
  const hasCommit = await git(repo, "rev-parse", "--verify", "HEAD").then(
    () => true,
    () => false,
  );
  if (hasRemote) {
    await git(repo, "fetch", "origin", base);
    await git(repo, "checkout", base);
    await git(repo, "pull", "--ff-only", "origin", base);
  } else if (hasCommit && base) {
    // repo chỉ có trên máy: đứng từ nhánh gốc nếu có
    await git(repo, "checkout", base).catch(() => {});
  }
  // repo chưa có commit nào: checkout -b chỉ đổi tên nhánh sắp tạo, vẫn ổn
  const exists = (await git(repo, "branch", "--list", branch)).trim();
  if (exists) await git(repo, "checkout", branch);
  else await git(repo, "checkout", "-b", branch);
}

/** File đổi so với nhánh gốc, gồm cả phần chưa commit và file mới. */
export async function changedFiles(repo: Repo) {
  const { base } = repoCfg(repo);
  // repo mới chưa có commit / chưa có nhánh gốc: chỉ tính phần chưa commit
  const committed = (await git(repo, "diff", "--name-only", `${base}...HEAD`).catch(() => "")).split("\n");
  const pending = (await git(repo, "status", "--porcelain", "--ignore-submodules=all", "-uall"))
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).split(" -> ").pop()!);
  return [...new Set([...committed, ...pending].filter(Boolean))].filter((f) => !repoCfg(repo).exclude.some((x) => f === x || f.startsWith(x + "/")));
}

export function slugify(s: string, max = 6) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, max)
    .join("-");
}
