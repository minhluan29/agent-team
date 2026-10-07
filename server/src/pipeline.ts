import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEVS, agentMeta, type AgentId, type DevId } from "./agents.js";
import { formatChecks, runChecks, type CheckResult } from "./checks.js";
import { config, taskDir } from "./config.js";
import {
  adfToMd,
  changedFiles,
  createJiraTask,
  dirtyFiles,
  git,
  gitlab,
  jira,
  jiraTransition,
  prepareBranch,
  repoCfg,
  slugify,
  textToAdf,
  type Repo,
} from "./integrations.js";
import { currentProject, withProject } from "./projects.js";
import { runAgent, stopAgent } from "./runner.js";
import { log, putTask, say, state, updateAgent, type Party, type Step, type Task } from "./state.js";

/*
 * Flow (đội mới):
 *   [code]  Chuẩn bị: Jira nếu dự án có mã Jira (tạo nếu chưa có, assign, ngày, In Progress; lỗi thì làm theo mô tả)
 *           + git (pull, nhánh) + 00-ticket.md (ticket Jira, hoặc mô tả anh gửi + ghi chú dự án)
 *   Vũ      PM — phân tích task từ góc nhìn sản phẩm (00-vu-analysis.md)
 *   Lucas   Product Leader — phân tích tính năng, phân cỡ S/M/L, chia việc cho dev (01-lucas-plan.md)
 *   ┌ Pual → James           chỉ cỡ L có UI
 *   ├ Min (BE)               chạy NGAY, song song với thiết kế
 *   └ Rio (web) / Paul (mobile) / Mouse (game)  chờ thiết kế chốt (nếu có) rồi chạy song song
 *     mỗi dev xong → [code] kiểm tự động repo của mình → đỏ thì dev đó sửa (nối tiếp phiên)
 *   Lucas   duyệt kỹ thuật (bỏ qua với cỡ S) → CHANGES_REQUIRED thì các dev được nêu tên sửa song song
 *   Vũ      viết commit/MR/comment (một lượt, không tool)
 *   [code]  commit, push, MR từng repo, comment Jira + chuyển Preview (nếu có ticket)
 */

const ASSIGNEE_ID = 21280070; // minhluann291 (anh)
const REVIEWER_ID = 30985724; // Rin (người review MR)
const MAX_CHECK_FIXES = 3;

/** Repo mà mỗi dev làm — theo cấu hình dự án (Nhà Mình: min→app-be, rio→app-fe, paul/mouse→app-ui). */
const devRepo = (d: DevId): Repo => currentProject().devRepo[d] ?? Object.keys(currentProject().repos)[0];
const repoDev = (r: Repo): DevId => DEVS.find((d) => currentProject().devRepo[d] === r) ?? "paul";

const queue: string[] = [];
let current: { taskId: string; agents: Set<AgentId>; stopped: boolean } | null = null;

const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD theo giờ máy
const nameOf = (id: AgentId) => agentMeta(id).name;

class Stop extends Error {}

export function enqueueTask(input: string): Task {
  const task: Task = { id: `t${Date.now().toString(36)}`, projectId: currentProject().id, input: input.trim(), status: "queued", steps: [], createdAt: Date.now() };
  putTask(task);
  queue.push(task.id);
  void drain();
  return task;
}

export function stopTask(taskId: string) {
  const qi = queue.indexOf(taskId);
  if (qi >= 0) {
    queue.splice(qi, 1);
    const t = state.tasks.find((x) => x.id === taskId);
    if (t) putTask({ ...t, status: "stopped" });
    return;
  }
  if (current?.taskId === taskId) {
    current.stopped = true;
    for (const a of current.agents) stopAgent(a);
  }
}

export function currentTaskId() {
  return current?.taskId ?? null;
}

async function drain() {
  if (current) return;
  const id = queue.shift();
  if (!id) return;
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return drain();
  current = { taskId: id, agents: new Set(), stopped: false };
  task.status = "running";
  putTask(task);
  try {
    await withProject(task.projectId, () => runPipeline(task));
    task.status = "done";
  } catch (e) {
    task.status = e instanceof Stop || current.stopped ? "stopped" : "failed";
    task.error = (e as Error).message;
    log("vu", task.id, "error", `Task dừng: ${task.error}`);
    say("vu", "user", `Task ${task.key ?? ""} ${task.status === "stopped" ? "đã dừng" : "bị lỗi"}: ${task.error}`, { taskId: task.id });
  }
  putTask(task);
  current = null;
  void drain();
}

// ---------------- bước ----------------

type StepOut = { text: string; file: string; fileName?: string; step?: Step };
type StepOpts = { resume?: boolean; tools?: string[]; effort?: "low" | "medium" | "high"; maxTurns?: number };

function openStep(task: Task, agent: AgentId, label: string): Step {
  if (current?.stopped) throw new Stop("Anh đã dừng task");
  const s: Step = { id: `${task.steps.length}`, agent, label, status: "running", startedAt: Date.now() };
  task.steps.push(s);
  putTask(task);
  return s;
}

function closeStep(task: Task, s: Step, ok: boolean) {
  s.endedAt = Date.now();
  s.status = ok ? "done" : "failed";
  putTask(task);
}

function setVerdict(task: Task, s: Step | undefined, v: string) {
  if (!s) return;
  s.verdict = v;
  putTask(task);
}

/** Một lượt agent. Nhiều lượt của các agent khác nhau được chạy cùng lúc. */
async function step(task: Task, agent: AgentId, label: string, prompt: string, read?: string, opts: StepOpts = {}): Promise<StepOut> {
  const s = openStep(task, agent, label);
  current!.agents.add(agent);
  const res = await runAgent(agent, prompt, { taskId: task.id, ...opts });
  current?.agents.delete(agent);
  if (current?.stopped) {
    closeStep(task, s, false);
    throw new Stop("Anh đã dừng task");
  }
  let file = "";
  if (read && task.key) {
    const p = path.join(taskDir(task.key), read);
    if (fs.existsSync(p)) file = fs.readFileSync(p, "utf8");
  }
  const ok = res.ok && (!read || !!file);
  closeStep(task, s, ok);
  if (!ok) throw new Error(!res.ok ? `${label}: ${nameOf(agent)} báo lỗi` : `${label}: không thấy file ${read}`);
  return { text: res.text, file, fileName: read, step: s };
}

/** Bước chạy bằng code (git/Jira/GitLab/kiểm tra) — hiện trên sơ đồ dưới tên Vũ. Có thể chạy song song. */
let sysBusy = 0;
async function sysStep<T>(task: Task, label: string, fn: (note: (line: string) => void) => Promise<T>): Promise<{ out: T; step: Step }> {
  const s = openStep(task, "vu", label);
  sysBusy++;
  updateAgent("vu", { status: "working", activity: label, taskId: task.id });
  const note = (line: string) => {
    log("vu", task.id, "tool", line);
    updateAgent("vu", { activity: line });
  };
  try {
    const out = await fn(note);
    closeStep(task, s, true);
    return { out, step: s };
  } catch (e) {
    closeStep(task, s, false);
    throw e;
  } finally {
    if (--sysBusy === 0) updateAgent("vu", { status: "idle", activity: "" });
  }
}

/** Agent vừa xong bước gửi kết quả cho người nhận kế tiếp — hiện ở tab "Trao đổi". */
function handoff(task: Task, from: AgentId, to: Party, out: StepOut) {
  const text = out.text.replace(/```json[\s\S]*?```/g, "").trim() || "(xong)";
  say(from, to, text, { taskId: task.id, file: out.fileName });
}

/** Kết luận nằm ở đầu file; lấy từ khoá nào xuất hiện trước. */
function verdict(file: string, pass: string, fail = "CHANGES_REQUIRED") {
  const a = file.indexOf(pass);
  const b = file.indexOf(fail);
  if (a < 0) return fail; // không rõ thì coi như chưa đạt, an toàn hơn
  if (b < 0) return pass;
  return a < b ? pass : fail;
}

function lastJson(text: string): Record<string, unknown> | null {
  const raw = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Đọc danh sách id dev trên một dòng kiểu "Dev: min, paul" / "Sửa: paul". */
function parseDevs(file: string, label: string): DevId[] {
  const line = file.match(new RegExp(`^\\s*\\**${label}\\**\\s*:\\s*(.+)$`, "im"))?.[1] ?? "";
  return DEVS.filter((d) => new RegExp(`\\b${d}\\b`, "i").test(line));
}

/** Chạy song song; chờ TẤT CẢ xong rồi mới báo lỗi (để không bỏ dở agent đang chạy). */
async function all<T>(jobs: Promise<T>[]): Promise<T[]> {
  const res = await Promise.allSettled(jobs);
  const failed = res.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return res.map((r) => (r as PromiseFulfilledResult<T>).value);
}

// ---------------- chuẩn bị (code) ----------------

type Prep = { jiraKey: string | null; notes: string[]; resumed: boolean };

/** Repo bị ảnh hưởng: tên repo được nhắc trong ticket, hoặc từ khoá theo mảng của dev phụ trách. */
function detectRepos(text: string): Repo[] {
  const p = currentProject();
  const out = new Set<Repo>(Object.keys(p.repos).filter((r) => r !== "." && text.includes(r)));
  const kw: [DevId, RegExp][] = [
    ["min", /\[BE\]|backend|\bapi\b/i],
    ["rio", /\[WEB\]|\bweb\b|frontend/i],
    ["paul", /\[FE\]|\[MOBILE\]|mobile|\bapp\b/i],
    ["mouse", /\[GAME\]|\bgame\b/i],
  ];
  for (const [d, re] of kw) if (re.test(text) && p.devRepo[d]) out.add(p.devRepo[d]!);
  if (!out.size) out.add(p.devRepo.paul ?? Object.keys(p.repos)[0]);
  return [...out];
}

/** Đưa repo về nhánh task: repo có việc dở đúng nhánh thì làm tiếp; bẩn ở nhánh khác thì dừng. */
async function ensureRepos(task: Task, repos: Repo[], note: (l: string) => void) {
  const branch = task.branch!;
  const done = new Set((task.repos ?? []) as Repo[]);
  let resumed = false;
  for (const r of repos) {
    if (done.has(r)) continue;
    const dirty = await dirtyFiles(r);
    const cur = (await git(r, "branch", "--show-current")).trim();
    if (dirty.length && cur !== branch) throw new Error(`${r} đang có thay đổi chưa commit trên nhánh ${cur}, em không tự stash/xoá:\n${dirty.slice(0, 10).join("\n")}`);
    if (dirty.length) {
      note(`$ git ${r}: làm tiếp trên ${branch} (có việc dở)`);
      resumed = true;
    } else {
      note(`$ git ${r}: pull ${repoCfg(r).base} → ${branch}`);
      await prepareBranch(r, branch);
    }
    done.add(r);
  }
  task.repos = [...done];
  putTask(task);
  return resumed;
}

async function prepare(task: Task, note: (l: string) => void): Promise<Prep> {
  const proj = currentProject();
  const notes: string[] = [];
  let key: string | null;
  let summary: string;
  let ticket: string;
  let desc = "";
  let isBug = false;
  let f: any = null;

  // Jira chỉ dùng khi dự án khai báo mã Jira. Gọi Jira lỗi (thiếu MCP, mất mạng, hết quyền)
  // thì KHÔNG dừng task: báo lại rồi làm theo mô tả anh gửi + ghi chú dự án.
  let useJira = !!proj.jiraKey;
  key = null;
  if (useJira) {
    try {
      // Chỉ là ticket khi tin nhắn là link Jira hoặc MỞ ĐẦU bằng mã. Mã nhắc giữa câu
      // ("task trước là NM-694") không phải ticket của task này.
      key = task.input.match(/atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/)?.[1] ?? task.input.match(/^\s*([A-Z][A-Z0-9]+-\d+)\b/)?.[1] ?? null;

      // Không có ticket → tạo ticket trước, để nhánh / MR / commit đều mang mã Jira.
      if (!key) {
        // kiểm repo sạch TRƯỚC khi tạo ticket, khỏi để lại ticket mồ côi nếu phải dừng
        for (const r of detectRepos(task.input)) {
          const dirty = await dirtyFiles(r);
          if (dirty.length) throw new Error(`${r} đang có thay đổi chưa commit, em không tự stash/xoá:\n${dirty.slice(0, 10).join("\n")}`);
        }
        const first = task.input.split("\n")[0].replace(/^(\s*\[[^\]]*\]\s*)+/, "").trim();
        const title = first.length > 120 ? `${first.slice(0, 117)}…` : first;
        note(`Jira · tạo ticket mới trong ${proj.jiraKey}`);
        key = await createJiraTask(proj.jiraKey!, title, `### Yêu cầu\n\n${task.input.trim()}\n\n### Git\n\nBranch: feat/<mã ticket>-${slugify(title)}`, detectRepos(task.input));
        notes.push(`tạo ticket ${key}`);
      }

      note(`Jira · đọc ${key}`);
      const issue = await jira("GET", `/rest/api/3/issue/${key}?fields=summary,description,status,duedate,customfield_10015,assignee,issuetype`);
      f = issue.fields;
    } catch (e) {
      const msg = (e as Error).message;
      // repo bẩn là lỗi thật, không phải lỗi Jira
      if (/chưa commit/.test(msg)) throw e;
      note(`Jira lỗi, làm tiếp theo mô tả: ${msg.slice(0, 200)}`);
      notes.push("Jira lỗi nên làm theo mô tả, chưa cập nhật ticket");
      useJira = false;
      key = null;
      f = null;
    }
  }

  if (useJira && f && key) {
    summary = f.summary;
    desc = adfToMd(f.description);
    ticket = `# ${key} — ${summary}\n\nLoại: ${f.issuetype?.name ?? "?"} · Trạng thái: ${f.status?.name ?? "?"}\n\n${desc}`;
    isBug = /bug|lỗi/i.test(`${f.issuetype?.name} ${summary}`);
  } else {
    // Không dùng Jira: đầu vào là mô tả anh gửi + ghi chú dự án; key + nhánh đặt theo mô tả.
    summary = task.input.split("\n")[0].replace(/^(\s*\[[^\]]*\]\s*)+/, "").trim().slice(0, 120);
    ticket = `# ${summary}\n\n## Mô tả anh gửi\n\n${task.input}\n\n## Ghi chú dự án ${proj.name}\n\n${proj.notes.trim() || "(chưa có)"}`;
    const stamp = today().replaceAll("-", "");
    const slug = slugify(summary, 4) || "task";
    key = `TASK-${stamp}-${slug}`;
    for (let i = 2; fs.existsSync(taskDir(key)); i++) key = `TASK-${stamp}-${slug}-${i}`;
    isBug = /\b(bug|fix)\b|lỗi/i.test(summary);
  }

  const repos = detectRepos(`${summary}\n${ticket}`);

  // Đã có nhánh của ticket (làm dở từ lần trước) thì dùng lại, không đặt tên mới.
  let existing: string | null = null;
  for (const r of Object.keys(currentProject().repos)) {
    const found = (await git(r, "branch", "--list", `*/${key}-*`, `*/${key}`)).split("\n").map((l) => l.replace(/^[*+ ]+/, "").trim()).filter(Boolean);
    if (found.length) {
      existing = found[0];
      break;
    }
  }
  const branch =
    existing ?? (desc && desc.match(new RegExp(`\\b((?:feat|fix|chore|refactor)/${key}[\\w\\-.]*)`, "i"))?.[1]) ?? (useJira ? `${isBug ? "fix" : "feat"}/${key}-${slugify(summary)}` : `${isBug ? "fix" : "feat"}/${slugify(summary, 6) || key.toLowerCase()}`);

  if (useJira && f) {
    const me = await jira<{ accountId: string }>("GET", "/rest/api/3/myself");
    if (f.assignee?.accountId !== me.accountId) {
      note(`Jira · assign ${key} cho anh`);
      await jira("PUT", `/rest/api/3/issue/${key}/assignee`, { accountId: me.accountId });
      notes.push("assign cho anh");
    }
    const fields: Record<string, string> = {};
    if (!f.customfield_10015) fields.customfield_10015 = today();
    if (!f.duedate) fields.duedate = today();
    if (Object.keys(fields).length) {
      note(`Jira · điền ${Object.keys(fields).map((k) => (k === "duedate" ? "Due date" : "Start date")).join(", ")} = ${today()}`);
      await jira("PUT", `/rest/api/3/issue/${key}`, { fields });
      notes.push(`điền ngày ${today()}`);
    }
    if (f.status?.statusCategory?.key === "new") {
      note("Jira · chuyển In Progress");
      const to = await jiraTransition(key, /accept|in progress/i);
      if (to) notes.push(`chuyển ${to}`);
    }
  }
  Object.assign(task, { key, summary, branch, repos: [] });
  putTask(task);

  const resumed = await ensureRepos(task, repos, note);
  if (resumed) notes.push("làm tiếp việc dở");

  const dir = taskDir(key);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, "00-ticket.md")) || !resumed) fs.writeFileSync(path.join(dir, "00-ticket.md"), ticket);
  notes.unshift(`nhánh \`${branch}\` trên ${task.repos!.join(" + ")}`);
  return { jiraKey: useJira ? key : null, notes, resumed };
}

// ---------------- kiểm tự động ----------------

/** Kiểm repo của một dev; đỏ thì dán lỗi cho chính dev đó sửa (nối tiếp phiên) rồi kiểm lại. */
async function checkLoop(task: Task, dev: DevId, ctx: string): Promise<CheckResult[]> {
  const repo = devRepo(dev);
  for (let attempt = 1; ; attempt++) {
    const { out: results, step: s } = await sysStep(task, `Kiểm tự động · ${nameOf(dev)}${attempt > 1 ? ` (lần ${attempt})` : ""}`, async (note) => {
      note(`$ tsc · eslint · jest — ${repo}`);
      return runChecks(repo);
    });
    const failed = results.filter((r) => !r.ok);
    setVerdict(task, s, failed.length ? `Lỗi ${failed.length}` : "Đạt");
    if (!failed.length) return results;
    say("vu", dev, `Kiểm tự động ${repo} chưa qua:\n\n${formatChecks(results)}`, { taskId: task.id });
    if (attempt > MAX_CHECK_FIXES) throw new Error(`Kiểm tự động ${repo} vẫn đỏ sau ${MAX_CHECK_FIXES} lần ${nameOf(dev)} sửa`);
    const fix = await step(
      task,
      dev,
      `Sửa lỗi kiểm (lần ${attempt})`,
      `${ctx}\nHệ thống kiểm tự động báo lỗi trên file em đổi ở ${repo} — sửa hết rồi cập nhật 04-${dev}-impl.md:\n\n${formatChecks(results)}\n\nCâu trả lời cuối: 1–2 câu đã sửa gì.`,
      `04-${dev}-impl.md`,
      { resume: true },
    );
    handoff(task, dev, "vu", fix);
  }
}

// ---------------- pipeline ----------------

async function runPipeline(task: Task) {
  const rounds = config.maxReviewRounds;

  // 1. Chuẩn bị bằng code
  const { out: prep } = await sysStep(task, currentProject().jiraKey ? "Chuẩn bị (Jira + git)" : "Chuẩn bị (git)", (note) => prepare(task, note));
  const dir = taskDir(task.key!);
  const ctx = `Task ${task.key} — ${task.summary}\nNhánh: ${task.branch}\nThư mục bàn giao: ${dir}\nTicket đầy đủ: ${dir}/00-ticket.md`;
  const reply = (to: string) => `\nCâu trả lời cuối là lời nhắn gửi ${to}: 2–5 câu tóm tắt việc em vừa làm và điều họ cần chú ý (chi tiết đã nằm trong file).`;

  // Làm tiếp task dở: bước nào đã có file bàn giao (và mới hơn đầu vào của nó) thì không chạy lại.
  const have = (f: string) => {
    const p = path.join(dir, f);
    return prep.resumed && fs.existsSync(p) ? { text: "", file: fs.readFileSync(p, "utf8"), mtime: fs.statSync(p).mtimeMs, fileName: f } : null;
  };
  const newer = (a: { mtime: number } | null, ...b: ({ mtime: number } | null)[]) => !!a && b.every((x) => !x || a.mtime >= x.mtime);
  const skip = (agent: AgentId, label: string, f: string) => {
    const s = openStep(task, agent, `${label} (đã có)`);
    closeStep(task, s, true);
    log(agent, task.id, "system", `Bỏ qua — đã có ${f} từ lần chạy trước`);
    return s;
  };

  // 2. Vũ phân tích task (góc nhìn sản phẩm)
  const prevVu = have("00-vu-analysis.md");
  const vu = prevVu
    ? (skip("vu", "Phân tích task", "00-vu-analysis.md"), prevVu)
    : await step(
        task,
        "vu",
        "Phân tích task",
        `${ctx}\nĐã chuẩn bị: ${prep.notes.join("; ")}.\nPhân tích task theo vai PM, ghi ${dir}/00-vu-analysis.md (ngắn).${reply("Lucas")}`,
        "00-vu-analysis.md",
        { effort: "low" },
      );
  if (!prevVu) handoff(task, "vu", "lucas", vu);

  // 3. Lucas phân tích tính năng, phân cỡ, chia việc
  const prevPlan = newer(have("01-lucas-plan.md"), prevVu) ? have("01-lucas-plan.md") : null;
  const plan = prevPlan
    ? { ...prevPlan, step: skip("lucas", "Phân tích & chia việc", "01-lucas-plan.md") }
    : await step(
        task,
        "lucas",
        "Phân tích & chia việc",
        `Vai 1 — Phân tích tính năng & chia việc.\n${ctx}\nPhân tích sản phẩm của Vũ: ${dir}/00-vu-analysis.md\nRepo đã có nhánh: ${task.repos!.join(", ")} (repo khác sẽ được tạo nhánh theo danh sách Dev của em).\nGhi ${dir}/01-lucas-plan.md.${reply("các dev được giao")}`,
        "01-lucas-plan.md",
      );
  const size = plan.file.match(/Cỡ:\s*\**\s*([SML])\b/i)?.[1]?.toUpperCase() ?? "M";
  const needsUi = !/UI:\s*\**\s*KHÔNG/i.test(plan.file);
  let devs = parseDevs(plan.file, "Dev");
  if (!devs.length) devs = task.repos!.map((r) => repoDev(r)); // plan không ghi → suy từ repo
  const design = size === "L" && needsUi && devs.some((d) => d !== "min");
  task.size = size;
  setVerdict(task, plan.step, `Cỡ ${size} · ${devs.map(nameOf).join(" + ")}`);

  await sysStep(task, "Tạo nhánh cho dev", async (note) => {
    await ensureRepos(task, [...new Set(devs.map((d) => devRepo(d)))], note);
  });
  if (!prevPlan) {
    const planMsg = plan.text.replace(/```json[\s\S]*?```/g, "").trim();
    for (const d of devs) {
      if (design && d !== "min") continue; // FE/mobile nhận việc khi thiết kế đã chốt
      say("lucas", d, planMsg || `Phần của ${nameOf(d)} ở mục "Việc của ${nameOf(d)}".`, { taskId: task.id, file: "01-lucas-plan.md" });
    }
    if (design) say("lucas", "pual", planMsg || "Thiết kế theo brief trong plan.", { taskId: task.id, file: "01-lucas-plan.md" });
  }

  // 4. Thiết kế (Pual ↔ James) chạy song song với Backend
  const designDone = (async () => {
    if (!design) return;
    const prevReview = have("03-james-review.md");
    if (newer(prevReview, have("01-lucas-plan.md"), have("02-pual-design.md")) && verdict(prevReview!.file, "APPROVED") === "APPROVED") {
      skip("pual", "Thiết kế", "02-pual-design.md");
      setVerdict(task, skip("james", "Duyệt UI/UX", "03-james-review.md"), "APPROVED");
      return;
    }
    for (let round = 1; ; round++) {
      const d = await step(
        task,
        "pual",
        round === 1 ? "Thiết kế" : `Thiết kế lại (vòng ${round})`,
        round === 1 ? `${ctx}\nThiết kế theo ${dir}/01-lucas-plan.md. Ghi ${dir}/02-pual-design.md.${reply("James")}` : `James yêu cầu sửa — xem ${dir}/03-james-review.md, cập nhật ${dir}/02-pual-design.md.${reply("James")}`,
        "02-pual-design.md",
        { resume: round > 1 },
      );
      handoff(task, "pual", "james", d);
      const last = round > rounds;
      const review = await step(
        task,
        "james",
        `Duyệt UI/UX (vòng ${round})`,
        `${round === 1 ? `${ctx}\nDuyệt thiết kế ${dir}/02-pual-design.md theo ${dir}/01-lucas-plan.md.` : `Pual đã sửa ${dir}/02-pual-design.md — duyệt lại phần đã sửa.`} Ghi ${dir}/03-james-review.md.${last ? '\nĐây là vòng cuối: em PHẢI chốt APPROVED và tự gộp chỉnh sửa còn lại vào mục "Thiết kế chốt cho dev".' : ""}${reply("Pual nếu cần sửa, hoặc các dev nếu đã duyệt")}`,
        "03-james-review.md",
        { resume: round > 1 },
      );
      const v = verdict(review.file, "APPROVED");
      setVerdict(task, review.step, v);
      const ok = v === "APPROVED" || last;
      if (!ok) {
        handoff(task, "james", "pual", review);
        continue;
      }
      for (const dv of devs.filter((x) => x !== "min")) handoff(task, "james", dv, review);
      return;
    }
  })();

  // 5. Hợp đồng API: có cả BE lẫn client thì Min chốt hợp đồng TRƯỚC khi ai code,
  //    để Rio / Paul / Mouse dùng đúng tên field, kiểu, mã lỗi mà BE sẽ trả.
  const clients = devs.filter((d) => d !== "min");
  const contractMode = devs.includes("min") && clients.length > 0;
  const CONTRACT = "02-api-contract.md";
  const contractReady = (async () => {
    if (!contractMode) return;
    const prev = have(CONTRACT);
    if (newer(prev, have("01-lucas-plan.md")) && /Đã chốt/i.test(prev!.file)) {
      skip("min", "Chốt hợp đồng API", CONTRACT);
      return;
    }
    const c = await step(
      task,
      "min",
      "Chốt hợp đồng API",
      `${ctx}
Trước khi code: chốt hợp đồng API giữa Backend và ${clients.map(nameOf).join(", ")} (họ sẽ code client theo hợp đồng này, song song với em).
` +
        `Bản nháp của Lucas: ${dir}/${CONTRACT} (nếu chưa có thì lấy mục hợp đồng trong ${dir}/01-lucas-plan.md và tạo file).
` +
        `Đối chiếu với quy ước THẬT của app-be (controller/DTO/entity/mã lỗi có sẵn), chỉnh cho đúng rồi ghi lại ${dir}/${CONTRACT}, thêm dòng "Đã chốt: Min" ở đầu file.${reply(clients.map(nameOf).join(", "))}`,
      CONTRACT,
      { effort: "medium" },
    );
    for (const d of clients) handoff(task, "min", d, c);
  })();

  // 6. Các dev làm song song. Min: chốt hợp đồng → code. Client: chờ thiết kế + hợp đồng → code.
  const checks: Partial<Record<DevId, CheckResult[]>> = {};
  const runDev = async (d: DevId) => {
    if (d === "min") await contractReady;
    else await all([designDone, contractReady]);
    const prevImpl = have(`04-${d}-impl.md`);
    if (newer(prevImpl, have("01-lucas-plan.md"), have("03-james-review.md"), have(CONTRACT))) {
      skip(d, "Code", `04-${d}-impl.md`);
    } else {
      const impl = await step(
        task,
        d,
        "Code",
        `${ctx}\nCỡ ${size}. Làm mục "Việc của ${nameOf(d)}" trong ${dir}/01-lucas-plan.md${design && d !== "min" ? ` theo "Thiết kế chốt cho dev" trong ${dir}/03-james-review.md` : ""}.` +
          (contractMode ? ` Hợp đồng API đã chốt: ${dir}/${CONTRACT} — ${d === "min" ? "server PHẢI trả đúng hợp đồng; buộc phải đổi thì sửa file hợp đồng và ghi vào mục \"## Thay đổi\" ở cuối file" : "client dùng ĐÚNG tên field / kiểu / mã lỗi trong hợp đồng, không tự đặt; chỗ hợp đồng thiếu thì ghi vào báo cáo"}.` : "") +
          ` Các dev khác đang làm song song: ${devs.filter((x) => x !== d).map(nameOf).join(", ") || "không"} — chỉ sửa file của phần em. Repo: ${devRepo(d)}. Ghi ${dir}/04-${d}-impl.md.${reply(size === "S" ? "Vũ" : "Lucas")}`,
        `04-${d}-impl.md`,
        { resume: d === "min" && contractMode }, // Min nối tiếp phiên chốt hợp đồng
      );
      handoff(task, d, size === "S" ? "vu" : "lucas", impl);
    }
    // Client có BE đi kèm: kiểm sau bước đối chiếu với Min, đỡ chạy hai lần.
    if (d === "min" || !contractMode) checks[d] = await checkLoop(task, d, ctx);
  };
  const devDone = Object.fromEntries(devs.map((d) => [d, runDev(d)])) as Record<DevId, Promise<void>>;

  // 7. Đối chiếu: Min xong thì từng client so code của mình với code BE THẬT, lệch thì sửa phía client.
  const syncs = !contractMode
    ? []
    : clients.map(async (d) => {
        await all([devDone.min, devDone[d]]);
        const prev = have(`04-${d}-impl.md`);
        if (prev && /##\s*Đối chiếu API/i.test(prev.file) && newer(prev, have("04-min-impl.md"))) {
          skip(d, "Đối chiếu API với Min", `04-${d}-impl.md`);
        } else {
          const changed = have(CONTRACT) && /##\s*Thay đổi/i.test(fs.readFileSync(path.join(dir, CONTRACT), "utf8"));
          // Min nhắn thẳng cho client (không qua Lucas): BE xong, đối chiếu giúp.
          say(
            "min",
            d,
            changed
              ? `Anh xong Backend rồi. Hợp đồng API có thay đổi trong lúc anh làm — xem mục "Thay đổi" cuối ${CONTRACT}, em đối chiếu client với code BE thật giúp anh.`
              : `Anh xong Backend rồi, đúng hợp đồng đã chốt. Em đối chiếu client với code BE thật giúp anh nhé.`,
            { taskId: task.id, file: changed ? CONTRACT : "04-min-impl.md" },
          );
          const sync = await step(
            task,
            d,
            "Đối chiếu API với Min",
            `Min đã xong Backend. Đối chiếu code client của em với hợp đồng ${dir}/${CONTRACT} VÀ code BE thật của Min ` +
              `(\`git -C ${path.join(currentProject().workspace, devRepo("min"))} diff ${repoCfg(devRepo("min")).base}\` + file mới chưa track; báo cáo ${dir}/04-min-impl.md): ` +
              `đường dẫn, method, tên field, kiểu, nullable, enum, mã lỗi, khung { data, code }, phân trang, định dạng ngày.\n` +
              `Lệch thì sửa phía client. Nếu BE làm sai hợp đồng thì KHÔNG sửa app-be — ghi rõ vào mục "Lệch hợp đồng" để Lucas xử lý.\n` +
              `Thêm/cập nhật mục "## Đối chiếu API" trong ${dir}/04-${d}-impl.md.\nCâu trả lời cuối gửi Min: khớp hết hay đã sửa / còn lệch gì.`,
            `04-${d}-impl.md`,
            { resume: true },
          );
          handoff(task, d, "min", sync);
        }
        checks[d] = await checkLoop(task, d, ctx);
      });
  await all([designDone, contractReady, ...Object.values(devDone), ...syncs]);

  // 8. Lucas duyệt kỹ thuật (trừ cỡ S); ai được nêu tên thì sửa song song
  const prevReview = have("05-lucas-review.md");
  const reviewDone = !!prevReview && devs.every((d) => newer(prevReview, have(`04-${d}-impl.md`))) && verdict(prevReview.file, "PASS") === "PASS";
  if (reviewDone) setVerdict(task, skip("lucas", "Duyệt kỹ thuật", "05-lucas-review.md"), "PASS");
  if (size !== "S" && !reviewDone) {
    for (let round = 1; ; round++) {
      const allChecks = devs.flatMap((d) => checks[d] ?? []);
      const review = await step(
        task,
        "lucas",
        `Duyệt kỹ thuật (vòng ${round})`,
        round === 1
          ? `Vai 2 — Kiểm duyệt kỹ thuật.\n${ctx}\nDev đã làm: ${devs.map((d) => `${nameOf(d)} (${devRepo(d)}, ${dir}/04-${d}-impl.md)`).join("; ")}. Đọc diff trên nhánh ${task.branch} ở các repo đó. ${contractMode ? `Hợp đồng API: ${dir}/${CONTRACT} — kiểm client và server khớp nhau, xem mục "Đối chiếu API" / "Lệch hợp đồng" trong báo cáo của client. ` : ""}Kiểm tự động đã xanh:\n${formatChecks(allChecks)}\nGhi ${dir}/05-lucas-review.md.${reply("các dev cần sửa, hoặc Vũ nếu PASS")}`
          : `Các dev đã sửa theo yêu cầu của em và kiểm tự động lại xanh. Duyệt lại phần đã sửa, cập nhật ${dir}/05-lucas-review.md.${reply("các dev cần sửa, hoặc Vũ nếu PASS")}`,
        "05-lucas-review.md",
        { resume: true }, // vòng 1 nối tiếp phiên phân tích — Lucas đã nắm code liên quan
      );
      const v = verdict(review.file, "PASS");
      setVerdict(task, review.step, v);
      if (v === "PASS") {
        handoff(task, "lucas", "vu", review);
        break;
      }
      if (round >= rounds) throw new Error(`Lucas vẫn CHANGES_REQUIRED sau ${rounds} vòng — xem ${dir}/05-lucas-review.md`);
      const fixers = parseDevs(review.file, "Sửa").filter((d) => devs.includes(d));
      const who = fixers.length ? fixers : devs;
      for (const d of who) handoff(task, "lucas", d, review);
      await all(
        who.map(async (d) => {
          const fix = await step(task, d, `Sửa theo Lucas (vòng ${round})`, `Lucas yêu cầu sửa — xem phần của em trong ${dir}/05-lucas-review.md. Sửa hết rồi cập nhật ${dir}/04-${d}-impl.md.${reply("Lucas")}`, `04-${d}-impl.md`, { resume: true });
          handoff(task, d, "lucas", fix);
          checks[d] = await checkLoop(task, d, ctx);
        }),
      );
    }
  }

  // 9. Chốt: diff → Vũ viết lời → code commit/push/MR/Jira
  await finalize(task, devs, prep.jiraKey, devs.flatMap((d) => checks[d] ?? []));
}

async function finalize(task: Task, devs: DevId[], jiraKey: string | null, checks: CheckResult[]) {
  const dir = taskDir(task.key!);
  const repos = [...new Set([...(task.repos as Repo[]), ...devs.map((d) => devRepo(d))])];
  const { out: staged } = await sysStep(task, "Gom thay đổi", async (note) => {
    const out: { repo: Repo; stat: string; diff: string }[] = [];
    for (const r of repos) {
      if (!(await changedFiles(r)).length) continue;
      note(`$ git ${r}: add`);
      await git(r, "add", "-A", "--", ".", ...repoCfg(r).exclude.map((x) => `:(exclude)${x}`));
      // repo mới chưa có nhánh gốc để so: so phần đã stage
      const stat = await git(r, "diff", "--cached", "--stat", repoCfg(r).base).catch(() => git(r, "diff", "--cached", "--stat"));
      const diff = await git(r, "diff", "--cached", repoCfg(r).base).catch(() => git(r, "diff", "--cached"));
      out.push({ repo: r, stat, diff: diff.length > 40_000 ? diff.slice(0, 40_000) + "\n…(cắt bớt)" : diff });
    }
    if (!out.length) throw new Error("Không có thay đổi nào để commit");
    return out;
  });

  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : "(không có)");
  const compose = await step(
    task,
    "vu",
    "Viết commit & MR",
    `Viết lời chốt task ${task.key} — ${task.summary}. Nhánh ${task.branch}. ${jiraKey ? `Ticket Jira ${jiraKey}.` : "Task này không có ticket Jira — không nhắc Jira trong commit/MR."}

## Ticket
${read("00-ticket.md").slice(0, 6000)}

${devs.map((d) => `## Báo cáo của ${nameOf(d)} (${devRepo(d)})\n${read(`04-${d}-impl.md`).slice(0, 6000)}`).join("\n\n")}

## Kết luận duyệt của Lucas (05)
${read("05-lucas-review.md").slice(0, 4000)}

## Kiểm tự động
${formatChecks(checks)}

## Diff
${staged.map((s) => `### ${s.repo}\n${s.stat}\n\`\`\`diff\n${s.diff}\n\`\`\``).join("\n\n")}

Một commit/MR cho mỗi repo nhưng dùng chung title. Chỉ trả về đúng một khối:
\`\`\`json
{"title": "feat(${task.key}): ...", "body": "commit body", "mrDescription": "markdown"${jiraKey ? `, "jiraComment": "văn bản thường, gạch đầu dòng bằng '- '; KHÔNG ghi link hay chỗ trống cho MR — hệ thống tự gắn link MR thật vào cuối"` : ""}}
\`\`\``,
    undefined,
    { tools: [], effort: "low", maxTurns: 1 },
  );
  const words = lastJson(compose.text) as { title?: string; body?: string; mrDescription?: string; jiraComment?: string } | null;
  if (!words?.title) throw new Error("Vũ không trả về commit/MR đúng định dạng");

  const { out: urls } = await sysStep(task, "Push & tạo MR", async (note) => {
    const urls: string[] = [];
    for (const { repo } of staged) {
      const msgFile = path.join(os.tmpdir(), `agent-team-${task.id}-${repo}.txt`);
      fs.writeFileSync(msgFile, `${words.title}\n\n${words.body ?? ""}\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>\n`);
      note(`$ git ${repo}: commit${repoCfg(repo).project ? ` + push ${task.branch}` : ""}`);
      await git(repo, "commit", "-F", msgFile);
      if (!repoCfg(repo).project) {
        // repo chưa có remote (dự án mới tạo trên máy): commit tại chỗ, không push / MR
        urls.push(`(${repo}: đã commit trên nhánh ${task.branch}, repo chưa có remote nên chưa push / tạo MR)`);
        continue;
      }
      await git(repo, "push", "-u", "origin", task.branch!);
      const project = encodeURIComponent(repoCfg(repo).project);
      note(`gitlab · tạo MR ${repo} → ${repoCfg(repo).base}`);
      const existing = await gitlab<{ web_url: string }[]>("GET", `/projects/${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(task.branch!)}`);
      const mr =
        existing[0] ??
        (await gitlab<{ web_url: string }>("POST", `/projects/${project}/merge_requests`, {
          source_branch: task.branch,
          target_branch: repoCfg(repo).base,
          title: words.title,
          description: `${words.mrDescription ?? ""}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
          assignee_id: ASSIGNEE_ID,
          reviewer_ids: [REVIEWER_ID],
          remove_source_branch: true,
        }));
      urls.push(mr.web_url);
    }
    if (jiraKey) {
      note(`Jira · comment + chuyển Preview ${jiraKey}`);
      await jira("POST", `/rest/api/3/issue/${jiraKey}/comment`, { body: textToAdf(`${words.jiraComment ?? ""}\n\n${urls.map((u) => `- MR: ${u}`).join("\n")}`) });
      await jiraTransition(jiraKey, /preview/i);
    }
    return urls;
  });

  task.mrUrls = urls;
  task.mrUrl = urls[0];
  putTask(task);
  say(
    "vu",
    "user",
    `Xong **${task.key}** (cỡ ${task.size} · ${devs.map(nameOf).join(" + ")}).\n\n${urls.map((u) => `- MR: ${u}`).join("\n")}${jiraKey ? `\n- Jira ${jiraKey}: đã comment và chuyển Preview` : ""}\n\nBáo cáo từng dev ở ${devs.map((d) => `04-${d}-impl.md`).join(", ")} (có mục phần chưa kiểm).`,
    { taskId: task.id, file: `04-${devs[0]}-impl.md` },
  );
}
