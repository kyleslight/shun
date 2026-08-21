import { tag, esc, num } from "../xml.js";
import { textWidth } from "../measure.js";
import layout from "../flow/layout.js";
import parse, { ONE, ZERO_ONE, ZERO_MANY } from "./parse.js";

const FONT = 13,
  HEAD = 28,
  ROW = 20,
  PADX = 12,
  MIN_W = 90,
  GPAD = 24;
const FILL = "var(--_node-fill)",
  STROKE = "var(--_node-stroke)",
  TEXT = "var(--_text)",
  LINE = "var(--_line)";

const boxOf = (name, attrs) => {
  let w = textWidth(name, FONT)[0] + 20;
  for (const a of attrs) w = Math.max(w, textWidth(a, FONT)[0] + 2 * PADX);
  return [Math.max(MIN_W, w), HEAD + attrs.length * ROW + (attrs.length ? 6 : 0)];
};

const SG = (n) => (n < 0 ? -1 : 1);

// 鸦掌 cardinality 标记：从实体边缘(px,py)沿外向 ang 画
const erMark = (px, py, ang, c) => {
  const ux = Math.cos(ang), uy = Math.sin(ang),
    nx = -uy, ny = ux, // 垂直
    at = (d) => [px + ux * d, py + uy * d],
    bar = (d) => {
      const [x, y] = at(d);
      return tag("line", { x1: num(x + nx * 6), y1: num(y + ny * 6), x2: num(x - nx * 6), y2: num(y - ny * 6), stroke: LINE, "stroke-width": 1.5 });
    },
    circle = (d) => {
      const [x, y] = at(d);
      return tag("circle", { cx: num(x), cy: num(y), r: 4, fill: "var(--bg)", stroke: LINE, "stroke-width": 1.5 });
    },
    foot = () => {
      const [ax, ay] = at(12);
      let s = "";
      for (const k of [-6, 0, 6])
        s += tag("line", { x1: num(ax), y1: num(ay), x2: num(px + nx * k), y2: num(py + ny * k), stroke: LINE, "stroke-width": 1.5 });
      return s;
    };
  if (c === ONE) return bar(6) + bar(11);
  if (c === ZERO_ONE) return bar(8) + circle(15);
  if (c === ZERO_MANY) return foot() + circle(18);
  return foot() + bar(15); // ONE_MANY
};

const render = (body) => {
  const [dir, ents, rels] = parse(body);
  if (!ents.size) return [40, 40, ""];

  const sizes = new Map(),
    info = new Map();
  for (const [id, [name, attrs]] of ents) {
    const [w, h] = boxOf(name, attrs);
    sizes.set(id, [w, h]);
    info.set(id, attrs);
  }
  const [pos, lw, lh] = layout(dir, sizes, rels);

  let edge_svg = "";
  for (const [from, to, lc, rc, dashed, label] of rels) {
    const pa = pos.get(from), pb = pos.get(to);
    if (!pa || !pb) continue;
    const dx = pb[0] - pa[0], dy = pb[1] - pa[1],
      vert = Math.abs(dy) >= Math.abs(dx),
      s = (vert ? dy : dx) < 0 ? -1 : 1,
      ux = vert ? 0 : s, uy = vert ? s : 0,
      sx = pa[0] + ux * (pa[2] / 2), sy = pa[1] + uy * (pa[3] / 2),
      ex = pb[0] - ux * (pb[2] / 2), ey = pb[1] - uy * (pb[3] / 2),
      d = vert
        ? "M" + num(sx) + " " + num(sy) + "V" + num((sy + ey) / 2) + "H" + num(ex) + "V" + num(ey)
        : "M" + num(sx) + " " + num(sy) + "H" + num((sx + ex) / 2) + "V" + num(ey) + "H" + num(ex);
    edge_svg += tag("path", { d, fill: "none", stroke: LINE, "stroke-width": 1.5, "stroke-dasharray": dashed ? "5 4" : null });
    // 标记朝实体外侧
    edge_svg += erMark(sx, sy, Math.atan2(-uy, -ux), lc);
    edge_svg += erMark(ex, ey, Math.atan2(uy, ux), rc);
    if (label) {
      const mx = (sx + ex) / 2, my = (sy + ey) / 2;
      edge_svg += tag("rect", { x: num(mx - label.length * 3.4 - 3), y: num(my - 9), width: num(label.length * 6.8 + 6), height: 16, fill: "var(--bg)", opacity: 0.85 });
      edge_svg += tag("text", { x: num(mx), y: num(my + 3), "text-anchor": "middle", "font-size": 12, fill: "var(--_text-muted)" }, esc(label));
    }
  }

  let node_svg = "";
  for (const [id, [name]] of ents) {
    const p = pos.get(id);
    if (!p) continue;
    const [cx, cy, w, h] = p, x = cx - w / 2, y = cy - h / 2, attrs = info.get(id);
    node_svg += tag("rect", { x: num(x), y: num(y), width: num(w), height: num(h), rx: 4, fill: FILL, stroke: STROKE, "stroke-width": 1.5 });
    node_svg += tag("rect", { x: num(x), y: num(y), width: num(w), height: HEAD, rx: 4, fill: "var(--_group-hdr)", stroke: "none" });
    node_svg += tag("text", { x: num(cx), y: num(y + 18), "text-anchor": "middle", "font-size": FONT, "font-weight": 700, fill: TEXT }, esc(name));
    attrs.forEach((a, k) => {
      const ry = y + HEAD + k * ROW;
      if (k === 0) node_svg += tag("line", { x1: num(x), y1: num(ry), x2: num(x + w), y2: num(ry), stroke: STROKE });
      node_svg += tag("text", { x: num(x + PADX), y: num(ry + 14), "font-size": FONT, fill: TEXT }, esc(a));
    });
  }

  const W = lw + 2 * GPAD, H = lh + 2 * GPAD,
    g = '<g transform="translate(' + GPAD + " " + GPAD + ')">' + edge_svg + node_svg + "</g>";
  return [num(W), num(H), g];
};

export default render;
