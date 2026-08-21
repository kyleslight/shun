import { tag, esc, num } from "../xml.js";
import { textWidth } from "../measure.js";

const FONT = 12, ROW_H = 26, PADX = 16, TOP = 50, LABEL_W = 150, BAR_PAD = 4;

const DAY = 86400000;
const dayNum = (s) => {
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY : null;
};
const durDays = (s) => {
  const m = s.match(/^([\d.]+)\s*([dwhm]?)/);
  if (!m) return 1;
  const n = +m[1];
  return m[2] === "w" ? n * 7 : m[2] === "h" ? n / 24 : m[2] === "m" ? n / 1440 : n;
};

const parse = (body) => {
  const lines = body.split("\n").slice(1);
  let title = "";
  const rows = []; // [type, name, start, end]  type: 0 task 1 section-header
  const ids = new Map();
  let prevEnd = 0;
  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln) continue;
    let m;
    if ((m = ln.match(/^title\s+(.+)/))) { title = m[1].trim(); continue; }
    if (/^(dateFormat|axisFormat|excludes|todayMarker)/.test(ln)) continue;
    if ((m = ln.match(/^section\s+(.+)/))) { rows.push([1, m[1].trim(), 0, 0]); continue; }
    const c = ln.indexOf(":");
    if (c < 0) continue;
    const name = ln.slice(0, c).trim(),
      parts = ln.slice(c + 1).split(",").map((p) => p.trim());
    // 去掉前导状态标签和可选 id
    let rest = parts.filter((p) => !/^(done|active|crit|milestone)$/.test(p));
    let id = null;
    // 第一个非日期/非after/非dur 视为 id
    if (rest.length > 1 && !dayNum(rest[0]) && !/^after\s/.test(rest[0]) && !/^[\d.]+[dwhm]?$/.test(rest[0])) id = rest.shift();
    let start = prevEnd, end;
    const a = rest[0] || "", b = rest[1];
    if (/^after\s+(\S+)/.test(a)) { const ref = a.match(/^after\s+(\S+)/)[1]; start = ids.has(ref) ? ids.get(ref)[1] : prevEnd; }
    else if (dayNum(a)) start = dayNum(a);
    if (b != null && dayNum(b)) end = dayNum(b);
    else if (b != null) end = start + durDays(b);
    else if (dayNum(a) && rest.length === 1) end = start + 1;
    else end = start + (rest.length ? durDays(rest[rest.length - 1]) : 1);
    if (!(end > start)) end = start + 1;
    if (id) ids.set(id, [start, end]);
    rows.push([0, name, start, end]);
    prevEnd = end;
  }
  return [title, rows];
};

const render = (body) => {
  const [title, rows] = parse(body);
  const tasks = rows.filter((r) => r[0] === 0);
  if (!tasks.length) return [200, 80, ""];
  const lo = Math.min(...tasks.map((t) => t[2])), hi = Math.max(...tasks.map((t) => t[3])),
    span = hi - lo || 1,
    plotW = 460,
    W = PADX * 2 + LABEL_W + plotW,
    H = TOP + rows.length * ROW_H + 20,
    xOf = (d) => PADX + LABEL_W + ((d - lo) / span) * plotW;
  let out = "";
  if (title) out += tag("text", { x: W / 2, y: 26, "text-anchor": "middle", "font-size": 16, "font-weight": 700, fill: "var(--_text)" }, esc(title));
  // 网格竖线
  for (let t = 0; t <= 4; ++t) {
    const x = PADX + LABEL_W + (plotW * t) / 4;
    out += tag("line", { x1: num(x), y1: TOP, x2: num(x), y2: num(H - 20), stroke: "var(--_line)", "stroke-opacity": 0.15 });
  }
  let y = TOP;
  for (const [type, name, s, e] of rows) {
    if (type === 1) {
      out += tag("text", { x: PADX, y: num(y + 17), "font-size": 12, "font-weight": 700, fill: "var(--_text-muted)" }, esc(name));
    } else {
      out += tag("text", { x: PADX, y: num(y + 17), "font-size": FONT, fill: "var(--_text)" }, esc(name.length > 20 ? name.slice(0, 19) + "…" : name));
      const x1 = xOf(s), x2 = xOf(e);
      out += tag("rect", { x: num(x1), y: num(y + BAR_PAD), width: num(Math.max(3, x2 - x1)), height: ROW_H - 2 * BAR_PAD, rx: 4, fill: "var(--_arrow)" });
    }
    y += ROW_H;
  }
  return [num(W), num(H), out];
};

export default render;
