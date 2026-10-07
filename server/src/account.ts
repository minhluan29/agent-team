import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { broadcast } from "./state.js";

const pexec = promisify(execFile);

export type Account = {
  loggedIn: boolean;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  authMethod?: string;
  loggingIn?: boolean;
};

let cached: Account | null = null;
let loggingIn = false;

/** Tài khoản Claude mà các agent đang dùng — đọc từ `claude auth status`, không tốn token. */
export async function getAccount(fresh = false): Promise<Account> {
  if (cached && !fresh) return { ...cached, loggingIn };
  try {
    const { stdout } = await pexec("claude", ["auth", "status", "--json"], { timeout: 20_000 });
    const s = JSON.parse(stdout);
    cached = { loggedIn: !!s.loggedIn, email: s.email, orgName: s.orgName, subscriptionType: s.subscriptionType, authMethod: s.authMethod };
  } catch {
    cached = { loggedIn: false };
  }
  return { ...cached, loggingIn };
}

/**
 * Mở luồng đăng nhập Claude (trình duyệt) bằng `claude auth login`. Xong thì đọc lại trạng thái
 * và báo cho giao diện qua WebSocket.
 */
export function startLogin() {
  if (loggingIn) return;
  loggingIn = true;
  broadcast({ t: "account", account: { ...(cached ?? { loggedIn: false }), loggingIn } });
  const child = spawn("claude", ["auth", "login", "--claudeai"], { stdio: "ignore" });
  const done = async () => {
    loggingIn = false;
    broadcast({ t: "account", account: await getAccount(true) });
  };
  child.on("exit", done);
  child.on("error", done);
  // người dùng bỏ dở trên trình duyệt: thôi chờ sau 5 phút
  setTimeout(() => {
    if (loggingIn) child.kill();
  }, 5 * 60_000);
}
