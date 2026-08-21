import { tag, esc, num } from "../xml.js";
import { textWidth } from "../measure.js";

const FONT = 13, COLW = 150, PAD = 24, TOP = 56, AXIS_Y = 90, EVT_H = 30, EVT_GAP = 8;

// timeline: "period : event" 或续行 ": event"
const parse = (body) => {
  const lines = body.split("\n").slice(1);
  let title = "";
  const periods = []; // [label, events[]]
  let cur = null;
  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln) continue;
    let m;
    if ((m = ln.match(/^title\s+(.+)/))) { title = m[1].trim(); continue; }
    if (/^section\s+/.test(ln)) continue;
    if (ln.startsWith(":")) {
      if (cur) cur[1].push(ln.slice(1).trim());
      continue;
    }
    const parts = ln.split(":");
    const label = parts[0].trim();
    cur = [label, []];
    periods.push(cur);
    for (let i = 1; i < parts.length; ++i) if (parts[i].trim()) cur[1].push(parts[i].trim());
  }
  return [title, periods];
};

const render = (body) => {
  const [title, periods] = parse(body);
  if (!periods.length) return [200, 80, ""];
  const maxEvt = Math.max(...periods.map((p) => p[1].length), 1),
    W = PAD * 2 + periods.length * COLW,
    H = AXIS_Y + maxEvt * (EVT_H + EVT_GAP) + 30;
  let out = "";
  if (title) out += tag("text", { x: W / 2, y: 28, "text-anchor": "middle", "font-size": 17, "font-weight": 700, fill: "var(--_text)" }, esc(title));
  // 主轴
  out += tag("line", { x1: PAD, y1: AXIS_Y, x2: num(W - PAD), y2: AXIS_Y, stroke: "var(--_line)", "stroke-width": 2 });
  periods.forEach((p, i) => {
    const cx = PAD + i * COLW + COLW / 2;
    out += tag("circle", { cx: num(cx), cy: AXIS_Y, r: 5, fill: "var(--_arrow)" });
    out += tag("text", { x: num(cx), y: AXIS_Y - 12, "text-anchor": "middle", "font-size": 13, "font-weight": 700, fill: "var(--_text)" }, esc(p[0]));
    p[1].forEach((e, k) => {
      const y = AXIS_Y + 16 + k * (EVT_H + EVT_GAP), w = COLW - 20, x = PAD + i * COLW + 10;
      out += tag("rect", { x: num(x), y: num(y), width: num(w), height: EVT_H, rx: 6, fill: "var(--_node-fill)", stroke: "var(--_node-stroke)" });
      const label = e.length > 18 ? e.slice(0, 17) + "…" : e;
      out += tag("text", { x: num(x + w / 2), y: num(y + 19), "text-anchor": "middle", "font-size": 12, fill: "var(--_text)" }, esc(label));
    });
  });
  return [num(W), num(H), out];
};

export default render;
