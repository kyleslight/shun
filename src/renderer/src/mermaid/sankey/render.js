import { tag, esc, num } from "../xml.js";

const COLW = 170, NODE_W = 18, PADX = 10, TOP = 16, H = 420, VGAP = 8;

// CSV: src,dst,value
const parse = (body) =>
  body.split("\n").slice(1).map((l) => l.trim()).filter(Boolean).map((ln) => {
    const m = ln.match(/^"?([^",]+)"?\s*,\s*"?([^",]+)"?\s*,\s*([\d.]+)/);
    return m ? [m[1].trim(), m[2].trim(), +m[3]] : null;
  }).filter(Boolean);

const render = (body) => {
  const links = parse(body);
  if (!links.length) return [200, 80, ""];
  const nodes = new Map(); // name -> {in,out,rank}
  const get = (n) => { if (!nodes.has(n)) nodes.set(n, { in: 0, out: 0, rank: 0 }); return nodes.get(n); };
  for (const [s, d, v] of links) { get(s).out += v; get(d).in += v; }
  // 最长路径分层
  for (let it = 0; it < nodes.size; ++it) {
    let changed = false;
    for (const [s, d] of links) { const r = get(s).rank + 1; if (get(d).rank < r) { get(d).rank = r; changed = true; } }
    if (!changed) break;
  }
  const maxRank = Math.max(...[...nodes.values()].map((n) => n.rank));
  const cols = [];
  for (const [name, n] of nodes) { (cols[n.rank] = cols[n.rank] || []).push(name); }
  const scale = (H - TOP - 20) / (Math.max(...cols.map((c) => c.reduce((s, nm) => s + Math.max(get(nm).in, get(nm).out), 0) + (c.length - 1) * VGAP)) || 1);

  // 节点几何
  const geo = new Map();
  cols.forEach((col, r) => {
    if (!col) return;
    let y = TOP;
    for (const nm of col) {
      const h = Math.max(4, Math.max(get(nm).in, get(nm).out) * scale),
        x = PADX + r * COLW;
      geo.set(nm, { x, y, h, oy: y, iy: y });
      y += h + VGAP;
    }
  });
  let svg = "";
  // 先画 ribbon
  for (const [s, d, v] of links) {
    const a = geo.get(s), b = geo.get(d);
    if (!a || !b) continue;
    const w = Math.max(1, v * scale),
      x1 = a.x + NODE_W, x2 = b.x,
      y1 = a.oy + w / 2, y2 = b.iy + w / 2,
      mx = (x1 + x2) / 2;
    svg += tag("path", { d: "M" + num(x1) + " " + num(y1) + "C" + num(mx) + " " + num(y1) + " " + num(mx) + " " + num(y2) + " " + num(x2) + " " + num(y2), fill: "none", stroke: "var(--_arrow)", "stroke-opacity": 0.28, "stroke-width": num(w) });
    a.oy += w; b.iy += w;
  }
  // 节点矩形 + 标签
  for (const [nm, g] of geo) {
    svg += tag("rect", { x: num(g.x), y: num(g.y), width: NODE_W, height: num(g.h), fill: "var(--_text-muted)" });
    const right = g.x < PADX + maxRank * COLW / 2;
    svg += tag("text", { x: num(right ? g.x + NODE_W + 4 : g.x - 4), y: num(g.y + g.h / 2 + 4), "text-anchor": right ? "start" : "end", "font-size": 11, fill: "var(--_text)" }, esc(nm));
  }
  const W = PADX * 2 + maxRank * COLW + COLW;
  return [num(W), H, svg];
};

export default render;
