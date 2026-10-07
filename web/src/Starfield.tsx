import { useEffect, useRef } from "react";

/**
 * Nền không gian: ba lớp sao trôi chậm với tốc độ khác nhau (thị sai), sao lấp lánh,
 * thỉnh thoảng một vệt sao băng. Vẽ bằng canvas để nhẹ; tắt chuyển động khi máy bật
 * "giảm chuyển động".
 */
export function Starfield() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let raf = 0;
    type Star = { x: number; y: number; r: number; z: number; tw: number; hue: number };
    let stars: Star[] = [];
    let meteor: { x: number; y: number; vx: number; vy: number; life: number } | null = null;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round((w * h) / 2600);
      stars = Array.from({ length: count }, () => {
        const z = Math.random();
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          r: 0.3 + z * 1.3,
          z,
          tw: Math.random() * Math.PI * 2,
          hue: [220, 260, 190, 300][Math.floor(Math.random() * 4)],
        };
      });
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        if (!reduce) {
          s.x -= 0.02 + s.z * 0.08;
          if (s.x < -2) s.x = w + 2;
        }
        const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t / 900 + s.tw)) * (0.4 + s.z * 0.6);
        ctx.beginPath();
        ctx.fillStyle = `hsla(${s.hue}, 90%, 85%, ${a})`;
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
        if (s.r > 1.2) {
          ctx.fillStyle = `hsla(${s.hue}, 100%, 75%, ${a * 0.12})`;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (!reduce) {
        if (!meteor && Math.random() < 0.002) {
          meteor = { x: Math.random() * w * 0.8 + w * 0.2, y: Math.random() * h * 0.3, vx: -7, vy: 3.2, life: 1 };
        }
        if (meteor) {
          const g = ctx.createLinearGradient(meteor.x, meteor.y, meteor.x - meteor.vx * 14, meteor.y - meteor.vy * 14);
          g.addColorStop(0, `rgba(200,220,255,${meteor.life})`);
          g.addColorStop(1, "rgba(200,220,255,0)");
          ctx.strokeStyle = g;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(meteor.x, meteor.y);
          ctx.lineTo(meteor.x - meteor.vx * 14, meteor.y - meteor.vy * 14);
          ctx.stroke();
          meteor.x += meteor.vx;
          meteor.y += meteor.vy;
          meteor.life -= 0.012;
          if (meteor.life <= 0 || meteor.x < -100 || meteor.y > h + 100) meteor = null;
        }
      }
      raf = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener("resize", resize);
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div className="space" aria-hidden>
      <div className="nebula n1" />
      <div className="nebula n2" />
      <div className="nebula n3" />
      <canvas ref={ref} />
    </div>
  );
}
