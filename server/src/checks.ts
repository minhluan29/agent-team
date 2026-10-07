import fs from "node:fs";
import path from "node:path";
import { changedFiles, repoPath, sh, type Repo } from "./integrations.js";

export type CheckResult = { name: string; ok: boolean; output: string; skipped?: boolean };

const CODE = /\.(tsx?|jsx?)$/;
/** Test hỏng sẵn trên dev-ios, không phải do task gây ra. */
const KNOWN_BROKEN = ["authRefresh.test.ts"];

async function run(name: string, cwd: string, cmd: string, args: string[], filter?: (out: string) => string): Promise<CheckResult> {
  // Repo chưa cài node_modules (vd app-fe) hoặc không dùng công cụ này: ghi bỏ qua, không đánh trượt.
  if (cmd.includes("node_modules") && !fs.existsSync(cmd)) return { name, ok: true, output: "", skipped: true };
  try {
    await sh(cmd, args, cwd);
    return { name, ok: true, output: "" };
  } catch (e: any) {
    const raw = String(e.output ?? e.message);
    const out = filter ? filter(raw) : raw;
    // tsc lỗi sẵn ở file khác: lọc xong mà không còn dòng nào thì coi như đạt
    return { name, ok: filter ? out.trim() === "" : false, output: out.slice(-6000) };
  }
}

/**
 * Chạy tsc / eslint / jest chỉ trên phần task đụng tới. tsc phải chạy cả project nên lọc
 * kết quả theo file đã đổi — lỗi có sẵn ở file khác của nhánh gốc không làm task trượt.
 */
export async function runChecks(repo: Repo): Promise<CheckResult[]> {
  const cwd = repoPath(repo);
  const files = (await changedFiles(repo)).filter((f) => CODE.test(f) && fs.existsSync(path.join(cwd, f)));
  if (!files.length) return [{ name: `${repo}: không có file code đổi`, ok: true, output: "" }];

  const bin = (b: string) => path.join(cwd, "node_modules", ".bin", b);
  const onlyChanged = (out: string) =>
    out
      .split("\n")
      .filter((l) => files.some((f) => l.startsWith(f) || l.includes(`/${f}(`) || l.includes(`${f}(`)))
      .join("\n");
  // monorepo NestJS (app-be): tsconfig của app chính
  const tsconfig = fs.existsSync(path.join(cwd, "apps/api/tsconfig.app.json")) ? ["-p", "apps/api/tsconfig.app.json"] : [];

  const results = await Promise.all([
    run(`${repo}: tsc`, cwd, bin("tsc"), ["--noEmit", "--pretty", "false", ...tsconfig], onlyChanged),
    run(`${repo}: eslint`, cwd, bin("eslint"), ["--quiet", ...files]),
  ]);
  const testable = files.filter((f) => !KNOWN_BROKEN.some((k) => f.endsWith(k)));
  results.push(
    await run(`${repo}: jest`, cwd, bin("jest"), [
      "--findRelatedTests",
      ...testable,
      "--passWithNoTests",
      "--ci",
      ...KNOWN_BROKEN.flatMap((k) => ["--testPathIgnorePatterns", k]),
    ]),
  );
  return results;
}

export function formatChecks(results: CheckResult[]) {
  return results
    .map((r) => (r.skipped ? `⏭️ ${r.name} (bỏ qua: repo chưa cài công cụ này)` : `${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : `\n\`\`\`\n${r.output.trim()}\n\`\`\``}`))
    .join("\n");
}
