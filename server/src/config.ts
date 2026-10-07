import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../..");
export const AGENTS_DIR = path.join(ROOT, "agents");
export const DATA_DIR = path.join(ROOT, "data");

type Config = {
  /** Thư mục dự án mà các agent làm việc trong đó (cwd). */
  workspace: string;
  port: number;
  /** Số vòng sửa tối đa cho mỗi cặp Pual↔James và Lucas↔Rio. */
  maxReviewRounds: number;
};

const defaults: Config = {
  workspace: "/Users/minhluan/Documents/db-moi/app-nha-xai",
  port: 4317,
  maxReviewRounds: 2,
};

function load(): Config {
  const file = path.join(ROOT, "config.json");
  if (!fs.existsSync(file)) return defaults;
  return { ...defaults, ...JSON.parse(fs.readFileSync(file, "utf8")) };
}

export const config = load();

/** Thư mục bàn giao của task, nằm trong workspace của dự án đang làm. */
export function taskDir(key: string) {
  // import muộn để tránh vòng phụ thuộc config ↔ projects
  return path.join(currentWorkspace(), ".claude", "tasks", key);
}

let wsGetter: () => string = () => config.workspace;
export const currentWorkspace = () => wsGetter();
export function setWorkspaceGetter(fn: () => string) {
  wsGetter = fn;
}
