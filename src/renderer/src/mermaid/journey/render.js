import { tag, esc, num } from "../xml.js";
import { textWidth } from "../measure.js";

const FONT = 13, BW = 120, BH = 52, GAP = 14, PAD = 20, TOP = 60, SECT_H = 26;

// 满意度 1..7 → 红到绿
const scoreColor = (s) => "hsl(" + Math.round((Math.max(0, Math.min(7, s)) / 7) * 120) + ",60%,55%)";

const parse = (body) => {
  const lines = body.split("\n").slice(1);
  let title = "";
  const sections = []; // [name, tasks[[name,score,actors]]]
  let cur = null;
  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln) continue;
    let m;
    if ((m = ln.match(/^title\s+(.+)/))) { title = m[1].trim(); continue; }
    if ((m = ln.match(/^section\s+(.+)/))) { cur = [m[1].trim(), []]; sections.push(cur); continue; }
    if ((m = ln.match(/^(.+?)\s*:\s*([\d.]+)\s*:\s*(.*)$/))) {
      if (!cur) { cur = ["", []]; sections.push(cur); }
      cur[1].push([m[1].trim(), parseFloat(m[2]), m[3].trim()]);
    }
  }
  return [title, sections];
};

const render = (body) => {
  const [title, sections] = parse(body);
  const tasks = [];
  sections.forEach((s, si) => s[1].forEach((t) => tasks.push([t, si])));
  if (!tasks.length) return [200, 80, ""];

  const W = PAD * 2 + tasks.length * (BW + GAP) - GAP,
    H = TOP + SECT_H + BH + 40;
  let out = "";
  if (title) out += tag("text", { x: W / 2, y: 28, "text-anchor": "middle", "font-size": 17, "font-weight": 700, fill: "var(--_text)" }, esc(title));

  // section 头部（跨其任务）
  let x = PAD;
  sections.forEach((s, si) => {
    const cnt = s[1].length;
    if (!cnt) return;
    const span = cnt * (BW + GAP) - GAP;
    out += tag("rect", { x: num(x), y: TOP, width: num(span), height: SECT_H, rx: 6, fill: "var(--_group-hdr)" });
    out += tag("text", { x: num(x + span / 2), y: TOP + 17, "text-anchor": "middle", "font-size": 12, "font-weight": 600, fill: "var(--_text-muted)" }, esc(s[0]));
    x += span + GAP;
  });

  // 任务行 + 连线
  const ty = TOP + SECT_H + 14;
  out += tag("line", { x1: PAD, y1: num(ty + BH / 2), x2: num(W - PAD), y2: num(ty + BH / 2), stroke: "var(--_line)", "stroke-opacity": 0.3 });
  tasks.forEach(([t], i) => {
    const tx = PAD + i * (BW + GAP),
      [name, score] = t;
    out += tag("rect", { x: num(tx), y: num(ty), width: BW, height: BH, rx: 8, fill: "var(--_node-fill)", stroke: "var(--_node-stroke)" });
    out += tag("circle", { cx: num(tx + 16), cy: num(ty + BH / 2), r: 8, fill: scoreColor(score) });
    out += tag("text", { x: num(tx + 16), y: num(ty + BH / 2 + 4), "text-anchor": "middle", "font-size": 11, "font-weight": 700, fill: "#fff" }, num(score));
    const label = name.length > 14 ? name.slice(0, 13) + "…" : name;
    out += tag("text", { x: num(tx + 30), y: num(ty + BH / 2 + 4), "font-size": 12, fill: "var(--_text)" }, esc(label));
  });

  return [num(W), num(H), out];
};

export default render;
