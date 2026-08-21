import { tag, esc, num } from "../xml.js";

const CW = 120, CH = 54, GAP = 16, PAD = 16, TOP = 16;

const labelOf = (tok) => {
  const m = tok.match(/^[\w-]+\s*[[({<]+(.+?)[\])}>\]]*\s*$/);
  let s = m ? m[1] : tok;
  return s.replace(/["[\](){}<>]/g, "").replace(/&nbsp;/g, " ").trim() || tok.replace(/[^\w-].*$/, "");
};
const idOf = (tok) => (tok.match(/^[\w-]+/) || [tok])[0];

const parse = (body) => {
  const lines = body.split("\n").slice(1);
  let cols = 3;
  const cells = [], edges = []; // cells: [id, label] or null(space)
  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln) continue;
    let m;
    if ((m = ln.match(/^columns\s+(\d+)/))) { cols = +m[1]; continue; }
    if (/^(style|class|classDef|click)\b/.test(ln)) continue;
    if (/^(block:|end\b)/.test(ln)) continue; // 扁平化分组
    // 边： a --> b
    const em = ln.match(/^([\w-]+)\s*[<xo]?[-.=]{2,}[->ox|]*\s*([\w-]+)\s*$/);
    if (em) { edges.push([em[1], em[2]]); continue; }
    // 块 token（按括号感知切分）
    const re = /([\w-]+(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|<[^>]*>\([^)]*\))?)/g;
    let t;
    while ((t = re.exec(ln))) {
      const tok = t[1];
      if (!tok) continue;
      if (tok === "space") { cells.push(null); continue; }
      cells.push([idOf(tok), labelOf(tok)]);
    }
  }
  return [cols, cells, edges];
};

const render = (body) => {
  const [cols, cells, edges] = parse(body);
  const real = cells.filter(Boolean);
  if (!real.length) return [120, 60, ""];
  const rows = Math.ceil(cells.length / cols),
    W = PAD * 2 + cols * CW + (cols - 1) * GAP,
    H = TOP + rows * CH + (rows - 1) * GAP + PAD,
    pos = new Map();
  cells.forEach((c, i) => {
    if (!c) return;
    const r = Math.floor(i / cols), col = i % cols,
      x = PAD + col * (CW + GAP), y = TOP + r * (CH + GAP);
    pos.set(c[0], [x + CW / 2, y + CH / 2]);
    c._xy = [x, y];
  });
  let out = "";
  for (const [a, b] of edges) {
    const pa = pos.get(a), pb = pos.get(b);
    if (!pa || !pb) continue;
    const ang = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]),
      ex = pb[0] - Math.cos(ang) * (CW / 2), ey = pb[1] - Math.sin(ang) * (CH / 2);
    out += tag("line", { x1: num(pa[0]), y1: num(pa[1]), x2: num(ex), y2: num(ey), stroke: "var(--_line)", "stroke-width": 1.5 });
    out += tag("path", { d: "M" + num(ex) + " " + num(ey) + "L" + num(ex - 9 * Math.cos(ang - 0.4)) + " " + num(ey - 9 * Math.sin(ang - 0.4)) + "L" + num(ex - 9 * Math.cos(ang + 0.4)) + " " + num(ey - 9 * Math.sin(ang + 0.4)) + "Z", fill: "var(--_arrow)" });
  }
  for (const c of cells) {
    if (!c || !c._xy) continue;
    const [x, y] = c._xy;
    out += tag("rect", { x: num(x), y: num(y), width: CW, height: CH, rx: 6, fill: "var(--_node-fill)", stroke: "var(--_node-stroke)", "stroke-width": 1.5 });
    const t = c[1].length > 16 ? c[1].slice(0, 15) + "…" : c[1];
    out += tag("text", { x: num(x + CW / 2), y: num(y + CH / 2 + 4), "text-anchor": "middle", "font-size": 13, fill: "var(--_text)" }, esc(t));
  }
  return [num(W), num(H), out];
};

export default render;
