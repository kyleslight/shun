import { tag, esc, num } from "../xml.js";
import parse, { BAR, LINE } from "./parse.js";

const W = 560,
  H = 340,
  ML = 56, // 左留白（y 轴标签）
  MR = 20,
  MT = 40, // 标题
  MB = 44, // x 轴标签
  TICKS = 5;

const seriesColor = (i, n) => "hsl(" + Math.round((210 + (i * 360) / Math.max(n, 1)) % 360) + ",65%,55%)";

// "好看"的刻度上界
const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))),
    f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};

const render = (body) => {
  const [title, x_cats, series, y_title, x_title, y_range] = parse(body);
  if (!series.length) return [W, 120, tag("text", { x: W / 2, y: 60, "text-anchor": "middle", "font-size": 14, fill: "var(--_text-muted)" }, "empty chart")];

  const n = Math.max(...series.map((s) => s[1].length)),
    cats = x_cats.length ? x_cats : series[0][1].map((_, i) => "" + (i + 1)),
    data_max = Math.max(...series.flatMap((s) => s[1]), 0),
    y_min = y_range ? y_range[0] : 0,
    y_max = y_range ? y_range[1] : niceMax(data_max),
    px = ML, py = MT, pw = W - ML - MR, ph = H - MT - MB,
    yOf = (v) => py + ph - ((v - y_min) / (y_max - y_min || 1)) * ph,
    slot = pw / n,
    xMid = (i) => px + slot * (i + 0.5);

  let out = "";
  if (title) out += tag("text", { x: W / 2, y: 24, "text-anchor": "middle", "font-size": 16, "font-weight": 700, fill: "var(--_text)" }, esc(title));

  // y 轴网格 + 刻度
  for (let t = 0; t <= TICKS; ++t) {
    const v = y_min + ((y_max - y_min) * t) / TICKS, y = yOf(v);
    out += tag("line", { x1: px, y1: num(y), x2: px + pw, y2: num(y), stroke: "var(--_line)", "stroke-opacity": 0.18 });
    out += tag("text", { x: px - 8, y: num(y + 4), "text-anchor": "end", "font-size": 11, fill: "var(--_text-muted)" }, "" + Math.round(v));
  }
  // 轴线
  out += tag("line", { x1: px, y1: py, x2: px, y2: py + ph, stroke: "var(--_line)" });
  out += tag("line", { x1: px, y1: py + ph, x2: px + pw, y2: py + ph, stroke: "var(--_line)" });

  // x 轴标签
  cats.forEach((c, i) => {
    out += tag("text", { x: num(xMid(i)), y: num(py + ph + 16), "text-anchor": "middle", "font-size": 11, fill: "var(--_text-muted)" }, esc(c));
  });
  if (x_title) out += tag("text", { x: num(px + pw / 2), y: H - 6, "text-anchor": "middle", "font-size": 12, fill: "var(--_text)" }, esc(x_title));
  if (y_title) out += tag("text", { x: 14, y: num(py + ph / 2), "text-anchor": "middle", "font-size": 12, fill: "var(--_text)", transform: "rotate(-90 14 " + num(py + ph / 2) + ")" }, esc(y_title));

  const bars = series.filter((s) => s[0] === BAR).length;
  let bi = 0;
  series.forEach(([kind, vals], si) => {
    const color = seriesColor(si, series.length);
    if (kind === BAR) {
      const bw = (slot * 0.7) / bars, off = -slot * 0.35 + bi * bw;
      vals.forEach((v, i) => {
        const y = yOf(v), x = xMid(i) + off;
        out += tag("rect", { x: num(x), y: num(y), width: num(bw * 0.9), height: num(py + ph - y), rx: 2, fill: color });
      });
      ++bi;
    } else {
      const pts = vals.map((v, i) => num(xMid(i)) + "," + num(yOf(v))).join(" ");
      out += tag("polyline", { points: pts, fill: "none", stroke: color, "stroke-width": 2.5, "stroke-linejoin": "round" });
      vals.forEach((v, i) => (out += tag("circle", { cx: num(xMid(i)), cy: num(yOf(v)), r: 3, fill: color })));
    }
  });

  return [W, H, out];
};

export default render;
