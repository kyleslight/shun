import { tag, esc, num } from "../xml.js";
import { textWidth } from "../measure.js";
import layout from "../flow/layout.js";
import parse, { K_NORM, K_DOT, K_BAR, K_HIST } from "./parse.js";

const FONT = 13,
  PADX = 14,
  MIN_W = 56,
  H_NORM = 36,
  GPAD = 22;
const FILL = "var(--_node-fill)",
  STROKE = "var(--_node-stroke)",
  TEXT = "var(--_text)";

const sizeOf = (label, kind) => {
  if (kind === K_DOT) return [16, 16];
  if (kind === K_HIST) return [24, 24];
  if (kind === K_BAR) return [64, 12];
  return [Math.max(MIN_W, textWidth(label, FONT)[0] + 2 * PADX), H_NORM];
};

const border = (cx, cy, w, h, tx, ty) => {
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const t = 1 / Math.max(Math.abs(dx) / (w / 2 + 1), Math.abs(dy) / (h / 2 + 1));
  return [cx + dx * t, cy + dy * t];
};

const arrow = (px, py, ang) => {
  const d = 9, a = 0.42;
  return tag("path", { d: "M" + num(px) + " " + num(py) + "L" + num(px - d * Math.cos(ang - a)) + " " + num(py - d * Math.sin(ang - a)) + "L" + num(px - d * Math.cos(ang + a)) + " " + num(py - d * Math.sin(ang + a)) + "Z", fill: "var(--_arrow)" });
};

const render = (body) => {
  const [dir, nodes, edges] = parse(body);
  if (!nodes.size) return [40, 40, ""];

  const sizes = new Map();
  for (const [id, [label, kind]] of nodes) sizes.set(id, sizeOf(label, kind));
  const [pos, lw, lh] = layout(dir, sizes, edges);

  let edge_svg = "";
  for (const [from, to, label] of edges) {
    const pa = pos.get(from), pb = pos.get(to);
    if (!pa || !pb) continue;
    const [sx, sy] = border(pa[0], pa[1], pa[2], pa[3], pb[0], pb[1]),
      [ex, ey] = border(pb[0], pb[1], pb[2], pb[3], pa[0], pa[1]),
      ang = Math.atan2(ey - sy, ex - sx);
    edge_svg += tag("line", { x1: num(sx), y1: num(sy), x2: num(ex - 8 * Math.cos(ang)), y2: num(ey - 8 * Math.sin(ang)), stroke: "var(--_line)", "stroke-width": 1.5 });
    edge_svg += arrow(ex, ey, ang);
    if (label) {
      const mx = (sx + ex) / 2, my = (sy + ey) / 2;
      edge_svg += tag("rect", { x: num(mx - label.length * 3.4 - 3), y: num(my - 9), width: num(label.length * 6.8 + 6), height: 16, fill: "var(--bg)", opacity: 0.85 });
      edge_svg += tag("text", { x: num(mx), y: num(my + 3), "text-anchor": "middle", "font-size": 12, fill: "var(--_text-muted)" }, esc(label));
    }
  }

  let node_svg = "";
  for (const [id, [label, kind]] of nodes) {
    const p = pos.get(id);
    if (!p) continue;
    const [cx, cy, w, h] = p;
    if (kind === K_DOT) node_svg += tag("circle", { cx: num(cx), cy: num(cy), r: 7, fill: TEXT });
    else if (kind === K_BAR) node_svg += tag("rect", { x: num(cx - w / 2), y: num(cy - h / 2), width: num(w), height: num(h), rx: 3, fill: TEXT });
    else if (kind === K_HIST) {
      node_svg += tag("circle", { cx: num(cx), cy: num(cy), r: 11, fill: FILL, stroke: STROKE });
      node_svg += tag("text", { x: num(cx), y: num(cy + 4), "text-anchor": "middle", "font-size": 12, "font-weight": 700, fill: TEXT }, "H");
    } else {
      node_svg += tag("rect", { x: num(cx - w / 2), y: num(cy - h / 2), width: num(w), height: num(h), rx: 9, fill: FILL, stroke: STROKE, "stroke-width": 1.5 });
      node_svg += tag("text", { x: num(cx), y: num(cy + 5), "text-anchor": "middle", "font-size": FONT, fill: TEXT }, esc(label));
    }
  }

  const W = lw + 2 * GPAD, H = lh + 2 * GPAD,
    g = '<g transform="translate(' + GPAD + " " + GPAD + ')">' + edge_svg + node_svg + "</g>";
  return [num(W), num(H), g];
};

export default render;
