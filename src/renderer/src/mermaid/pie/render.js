import { tag, esc, num } from "../xml.js";
import { textWidth } from "../measure.js";
import parse from "./parse.js";

const R = 110, // 饼半径
  PAD = 24,
  TITLE_H = 34,
  LEGEND_GAP = 22, // 图例项行高
  SWATCH = 16,
  FONT = 14,
  TITLE_FONT = 18;

// 分类色：固定饱和度/亮度，旋转色相，与主题无关（同 mermaid 行为）
const sliceColor = (i, n) => "hsl(" + Math.round((360 * i) / Math.max(n, 1)) + ",62%,58%)";

// 极坐标 → 笛卡尔
const pt = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];

const render = (body) => {
  const [title, rows] = parse(body);
  const total = rows.reduce((s, [, v]) => s + v, 0) || 1;
  const n = rows.length;

  // 图例宽度 = 最长 "label 数值" + 色块
  let legend_w = 0;
  const items = rows.map(([label, v], i) => {
    const pct = ((v / total) * 100).toFixed(1) + "%",
      txt = label + " (" + pct + ")",
      [w] = textWidth(txt, FONT);
    legend_w = Math.max(legend_w, w);
    return [txt, i];
  });
  legend_w += SWATCH + 10;

  const cx = PAD + R,
    cy = TITLE_H + PAD + R,
    legend_h = n * LEGEND_GAP,
    body_h = Math.max(2 * R, legend_h),
    W = PAD + 2 * R + 36 + legend_w + PAD,
    H = TITLE_H + PAD + body_h + PAD;

  let out = "";
  if (title)
    out += tag(
      "text",
      { x: W / 2, y: 26, "text-anchor": "middle", "font-size": TITLE_FONT, "font-weight": 600, fill: "var(--_text)" },
      esc(title),
    );

  // 扇形
  let a0 = -Math.PI / 2; // 从正上方开始
  rows.forEach(([, v], i) => {
    const a1 = a0 + (v / total) * Math.PI * 2,
      [x0, y0] = pt(cx, cy, R, a0),
      [x1, y1] = pt(cx, cy, R, a1),
      large = a1 - a0 > Math.PI ? 1 : 0,
      d =
        "M" + num(cx) + " " + num(cy) + "L" + num(x0) + " " + num(y0) +
        "A" + R + " " + R + " 0 " + large + " 1 " + num(x1) + " " + num(y1) + "Z";
    out += tag("path", { d, fill: sliceColor(i, n), stroke: "var(--bg)", "stroke-width": 2 });
    a0 = a1;
  });

  // 图例
  const lx = PAD + 2 * R + 36,
    ly0 = TITLE_H + PAD + (body_h - legend_h) / 2;
  items.forEach(([txt, i]) => {
    const y = ly0 + i * LEGEND_GAP;
    out += tag("rect", { x: lx, y, width: SWATCH, height: SWATCH, rx: 3, fill: sliceColor(i, n) });
    out += tag(
      "text",
      { x: lx + SWATCH + 8, y: y + SWATCH - 3, "font-size": FONT, fill: "var(--_text)" },
      esc(txt),
    );
  });

  return [W, H, out];
};

export default render;
