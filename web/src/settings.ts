import { useEffect, useState } from "react";

export type ThemeId = "galaxy" | "claude";

export const THEMES: { id: ThemeId; name: string; note: string }[] = [
  { id: "galaxy", name: "Galaxy", note: "Nền không gian, neon, kiểu HUD" },
  { id: "claude", name: "Claude", note: "Trắng kem, chữ serif, màu dịu" },
];

/** Màu nhấn: cặp [chính, phụ] — phụ dùng cho gradient, link, điểm nhấn thứ hai. */
export const ACCENTS: { id: string; name: string; colors: Record<ThemeId, [string, string]> }[] = [
  { id: "default", name: "Mặc định", colors: { galaxy: ["#8b5cf6", "#22d3ee"], claude: ["#d97757", "#b8613f"] } },
  { id: "clay", name: "Cam đất", colors: { galaxy: ["#f97316", "#fbbf24"], claude: ["#c96442", "#a8502f"] } },
  { id: "teal", name: "Xanh ngọc", colors: { galaxy: ["#14b8a6", "#22d3ee"], claude: ["#2a8c82", "#1f6f67"] } },
  { id: "blue", name: "Xanh dương", colors: { galaxy: ["#3b82f6", "#60a5fa"], claude: ["#3d6fb6", "#2f5791"] } },
  { id: "rose", name: "Hồng", colors: { galaxy: ["#ec4899", "#a855f7"], claude: ["#c2577a", "#9e4363"] } },
  { id: "olive", name: "Rêu", colors: { galaxy: ["#84cc16", "#22c55e"], claude: ["#6b7d3a", "#55642d"] } },
];

export type Settings = { theme: ThemeId; accent: string; stars: boolean; motion: boolean };
const DEFAULTS: Settings = { theme: "galaxy", accent: "default", stars: true, motion: true };
const KEY = "agent-team:settings";

function read(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/** Cài đặt giao diện, lưu trong trình duyệt (chỉ là tuỳ chọn hiển thị của người xem). */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(read);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.dataset.motion = settings.motion ? "on" : "off";
    const [a, b] = (ACCENTS.find((x) => x.id === settings.accent) ?? ACCENTS[0]).colors[settings.theme];
    root.style.setProperty("--accent", a);
    root.style.setProperty("--accent-2", b);
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* chế độ riêng tư: bỏ qua, chỉ không nhớ được */
    }
  }, [settings]);

  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  return { settings, update };
}
