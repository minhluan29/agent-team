import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DevId } from "./agents.js";
import { DATA_DIR, setWorkspaceGetter } from "./config.js";

/**
 * Đội agent làm được cho nhiều dự án. Mỗi dự án: workspace (cwd của agent), các repo git,
 * dev nào phụ trách repo nào, mã Jira (tuỳ chọn) và ghi chú riêng — ghi chú được đưa vào
 * ngữ cảnh của mọi agent khi làm cho dự án đó.
 */

export type ProjectRepo = { base: string; project: string; exclude: string[] };
export type Project = {
  id: string;
  name: string;
  workspace: string;
  /** Mã project Jira (vd NM). Bỏ trống = dự án không dùng Jira. */
  jiraKey?: string;
  repos: Record<string, ProjectRepo>;
  devRepo: Partial<Record<DevId, string>>;
  notes: string;
  createdAt: number;
};

type Store = { active: string; projects: Project[] };
const FILE = path.join(DATA_DIR, "projects.json");

/** Dự án gốc — giữ đúng cấu hình đội đã chạy trước khi có tính năng nhiều dự án. */
const NHA_MINH: Project = {
  id: "nha-minh",
  name: "Nhà Mình",
  workspace: "/Users/minhluan/Documents/db-moi/app-nha-xai",
  jiraKey: "NM",
  repos: {
    "app-ui": { base: "dev-ios", project: "nha-minh/app-ui", exclude: [] },
    "app-fe": { base: "dev", project: "nha-minh/app-fe/app-fe", exclude: [] },
    // gitlink submodule trôi theo máy — không bao giờ commit
    "app-be": { base: "dev", project: "nha-minh/app-be", exclude: ["libs", "apps/r2", "apps/redis", "apps/socket"] },
  },
  devRepo: { min: "app-be", rio: "app-fe", paul: "app-ui", mouse: "app-ui" },
  notes: "",
  createdAt: 0,
};

function load(): Store {
  if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, "utf8"));
  return { active: NHA_MINH.id, projects: [NHA_MINH] };
}

const store = load();
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}
save();

export const listProjects = () => store.projects;
export const activeProjectId = () => store.active;
export const getProject = (id: string) => store.projects.find((p) => p.id === id);

// ---- ngữ cảnh dự án cho từng việc đang chạy ----
const als = new AsyncLocalStorage<Project>();

/** Dự án của việc đang chạy (task / lượt chat); ngoài ngữ cảnh thì là dự án đang chọn. */
export function currentProject(): Project {
  return als.getStore() ?? getProject(store.active) ?? store.projects[0];
}

export function withProject<T>(projectId: string | undefined, fn: () => T): T {
  const p = (projectId && getProject(projectId)) || currentProject();
  return als.run(p, fn);
}

export function setActive(id: string) {
  if (!getProject(id)) throw new Error("Không có dự án này");
  store.active = id;
  save();
}

export function updateProject(id: string, patch: Partial<Pick<Project, "name" | "notes" | "jiraKey">>) {
  const p = getProject(id);
  if (!p) throw new Error("Không có dự án này");
  if (patch.name !== undefined) p.name = patch.name.trim() || p.name;
  if (patch.notes !== undefined) p.notes = patch.notes;
  if (patch.jiraKey !== undefined) p.jiraKey = patch.jiraKey.trim().toUpperCase() || undefined;
  save();
  return p;
}

// ---- dò repo khi thêm dự án mới ----
function sh(cwd: string, ...args: string[]) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function describeRepo(dir: string): ProjectRepo {
  const head = sh(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "");
  const base = head || sh(dir, "branch", "--show-current") || "main";
  const url = sh(dir, "remote", "get-url", "origin");
  // git@gitlab.com:nhom/repo.git | https://host/nhom/sub/repo.git | ssh://git@host/nhom/repo.git
  const project = url.replace(/^.*?(?:@[^:/]+[:/]|:\/\/[^/]+\/)/, "").replace(/\.git$/, "");
  return { base, project, exclude: [] };
}

/** Đoán dev phụ trách repo theo package.json. */
function guessDev(dir: string): DevId | null {
  const pkgFile = path.join(dir, "package.json");
  if (!fs.existsSync(pkgFile)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps["@nestjs/core"] || deps.express || deps.fastify || deps.koa) return "min";
  if (deps.expo || deps["react-native"]) return "paul";
  if (deps.phaser || deps.pixi || deps["pixi.js"] || deps.three) return "mouse";
  if (deps.next || deps.vite || deps.react || deps.vue || deps["@angular/core"]) return "rio";
  return null;
}

export function createProject(input: { name: string; workspace: string; jiraKey?: string }): Project {
  const workspace = path.resolve(input.workspace.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error(`Không thấy thư mục ${workspace}`);
  if (store.projects.some((p) => p.workspace === workspace)) throw new Error("Workspace này đã có dự án");

  const repos: Record<string, ProjectRepo> = {};
  const devRepo: Partial<Record<DevId, string>> = {};
  let candidates = fs.existsSync(path.join(workspace, ".git"))
    ? ["."]
    : fs.readdirSync(workspace).filter((d) => !d.startsWith(".") && fs.existsSync(path.join(workspace, d, ".git")));
  // Thư mục chưa có git (vd dự án mới tạo): khởi tạo git ngay tại workspace
  if (!candidates.length) {
    execFileSync("git", ["init", "-q", "-b", "main", workspace]);
    candidates = ["."];
  }
  for (const r of candidates) {
    repos[r] = describeRepo(path.join(workspace, r));
    const dev = guessDev(path.join(workspace, r));
    if (dev && !devRepo[dev]) devRepo[dev] = r;
  }
  // dev chưa có repo riêng thì làm ở repo đầu tiên
  for (const d of ["min", "rio", "paul", "mouse"] as DevId[]) devRepo[d] ??= candidates[0];

  const base = (input.name || path.basename(workspace))
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  let id = base || "du-an";
  for (let i = 2; getProject(id); i++) id = `${base}-${i}`;
  const p: Project = {
    id,
    name: input.name.trim() || path.basename(workspace),
    workspace,
    jiraKey: input.jiraKey?.trim().toUpperCase() || undefined,
    repos,
    devRepo,
    notes: "",
    createdAt: Date.now(),
  };
  store.projects.push(p);
  save();
  return p;
}

/** Phần nối vào lời dặn của mọi agent: dự án đang làm + ghi chú riêng của anh. */
export function projectBrief(p = currentProject()) {
  const repos = Object.entries(p.repos)
    .map(([r, c]) => `- \`${r === "." ? p.workspace : path.join(p.workspace, r)}\` — nhánh gốc \`${c.base}\``)
    .join("\n");
  const devs = Object.entries(p.devRepo)
    .map(([d, r]) => `${d} → ${r}`)
    .join(", ");
  return `## Dự án đang làm: ${p.name}
- Workspace: \`${p.workspace}\`${p.jiraKey ? ` · Jira: ${p.jiraKey}` : " · không dùng Jira"}
- Repo:
${repos}
- Dev phụ trách: ${devs}
${p.id === "nha-minh" ? "" : `- Các quy ước riêng của dự án "Nhà Mình" trong lời dặn bên trên KHÔNG áp dụng cho dự án này — theo ghi chú bên dưới và CLAUDE.md của workspace.\n`}
### Ghi chú dự án (anh viết)
${p.notes.trim() || "(chưa có)"}`;
}

// taskDir() trong config.ts đọc workspace của dự án hiện tại
setWorkspaceGetter(() => currentProject().workspace);

/** Gỡ dự án khỏi danh sách (KHÔNG xoá file trên máy). */
export function removeProject(id: string) {
  if (store.projects.length <= 1) throw new Error("Phải còn ít nhất một dự án");
  const i = store.projects.findIndex((p) => p.id === id);
  if (i < 0) throw new Error("Không có dự án này");
  store.projects.splice(i, 1);
  if (store.active === id) store.active = store.projects[0].id;
  save();
}
