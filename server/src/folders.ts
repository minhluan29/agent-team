import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);
let picking = false;

/**
 * Mở hộp thoại chọn thư mục của macOS (Finder) ngay trên máy anh — server chạy local nên làm
 * được, còn trình duyệt thì không bao giờ trả đường dẫn thật. Huỷ thì trả null.
 * Lần đầu macOS có thể hỏi quyền cho phép điều khiển "System Events".
 */
export async function pickFolder(prompt: string, defaultPath?: string): Promise<string | null> {
  if (process.platform !== "darwin") throw new Error("Hộp thoại chọn thư mục hiện chỉ hỗ trợ macOS");
  if (picking) throw new Error("Hộp thoại chọn thư mục đang mở");
  picking = true;
  const start = defaultPath && fs.existsSync(defaultPath) ? defaultPath : os.homedir();
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = [
    'tell application "System Events"',
    "activate",
    `set f to choose folder with prompt "${esc(prompt)}" default location (POSIX file "${esc(start)}")`,
    "end tell",
    "return POSIX path of f",
  ];
  try {
    const { stdout } = await pexec("osascript", script.flatMap((l) => ["-e", l]), { timeout: 5 * 60_000 });
    return stdout.trim().replace(/\/$/, "") || null;
  } catch (e: any) {
    // -128 = người dùng bấm Huỷ
    if (/-128|User canceled/i.test(String(e.stderr ?? e.message))) return null;
    throw new Error(`Không mở được hộp thoại: ${String(e.stderr ?? e.message).trim()}`);
  } finally {
    picking = false;
  }
}

/** Tạo thư mục dự án mới bên trong `parent`. */
export function makeProjectFolder(parent: string, name: string) {
  const clean = name.trim().replace(/[/\\:]/g, "-");
  if (!clean) throw new Error("Thiếu tên dự án");
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error(`Không thấy thư mục ${parent}`);
  const dir = path.join(parent, clean);
  if (fs.existsSync(dir)) throw new Error(`Đã có thư mục ${dir} — chọn "Thư mục có sẵn" nếu muốn dùng nó`);
  fs.mkdirSync(dir);
  return dir;
}
