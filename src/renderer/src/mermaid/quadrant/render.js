import { tag, esc, num } from "../xml.js";

const S = 420, PAD = 70, TOP = 50;

const parse = (body) => {
  const lines = body.split("\n").slice(1);
  let title = "", xa = "", ya = "";
  const quads = [], points = [];
  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln) continue;
    let m;
    if ((m = ln.match(/^title\s+(.+)/))) { title = m[1].trim(); continue; }
    if ((m = ln.match(/^x-axis\s+(.+)/))) { xa = m[1].replace(/-->/g, "→").trim(); continue; }
    if ((m = ln.match(/^y-axis\s+(.+)/))) { ya = m[1].replace(/-->/g, "→").trim(); continue; }
    if ((m = ln.match(/^quadrant-([1-4])\s+(.+)/))) { quads[+m[1] - 1] = m[2].trim(); continue; }
    if ((m = ln.match(/^(.+?):\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/))) points.push([m[1].trim(), +m[2], +m[3]]);
  }
  return [title, xa, ya, quads, points];
};

const render = (body) => {
  const [title, xa, ya, quads, points] = parse(body);
  const W = PAD + S + 30, H = TOP + S + 50,
    x0 = PAD, y0 = TOP, cx = x0 + S / 2, cy = y0 + S / 2;
  let out = "";
  if (title) out += tag("text", { x: W / 2, y: 28, "text-anchor": "middle", "font-size": 16, "font-weight": 700, fill: "var(--_text)" }, esc(title));
  // 四象限底色
  const qfill = (i) => "color-mix(in srgb, " + ["#7aa2f7", "#9ece6a", "#e0af68", "#f7768e"][i] + " 12%, var(--bg))";
  // 象限位置：q1 右上, q2 左上, q3 左下, q4 右下
  const pos = [[cx, y0], [x0, y0], [x0, cy], [cx, cy]];
  pos.forEach(([qx, qy], i) => {
    out += tag("rect", { x: num(qx), y: num(qy), width: num(S / 2), height: num(S / 2), fill: qfill(i) });
    if (quads[i]) out += tag("text", { x: num(qx + S / 4), y: num(qy + S / 4), "text-anchor": "middle", "font-size": 12, "font-weight": 600, fill: "var(--_text-muted)" }, esc(quads[i]));
  });
  out += tag("rect", { x: num(x0), y: num(y0), width: S, height: S, fill: "none", stroke: "var(--_node-stroke)" });
  out += tag("line", { x1: num(cx), y1: num(y0), x2: num(cx), y2: num(y0 + S), stroke: "var(--_node-stroke)" });
  out += tag("line", { x1: num(x0), y1: num(cy), x2: num(x0 + S), y2: num(cy), stroke: "var(--_node-stroke)" });
  // 点
  for (const [name, px, py] of points) {
    const dx = x0 + px * S, dy = y0 + (1 - py) * S;
    out += tag("circle", { cx: num(dx), cy: num(dy), r: 6, fill: "var(--_arrow)" });
    out += tag("text", { x: num(dx + 9), y: num(dy + 4), "font-size": 11, fill: "var(--_text)" }, esc(name));
  }
  // 轴标题
  if (xa) out += tag("text", { x: num(cx), y: num(y0 + S + 30), "text-anchor": "middle", "font-size": 12, fill: "var(--_text-muted)" }, esc(xa));
  if (ya) out += tag("text", { x: 18, y: num(cy), "text-anchor": "middle", "font-size": 12, fill: "var(--_text-muted)", transform: "rotate(-90 18 " + num(cy) + ")" }, esc(ya));
  return [num(W), num(H), out];
};

export default render;
