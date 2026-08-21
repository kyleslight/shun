import { tag, esc, num } from "../xml.js";
import { textWidth } from "../measure.js";
import layout from "../flow/layout.js";
import parse from "./parse.js";

const FONT = 13,
  LINE_H = 18,
  PAD = 10,
  HEAD = 28,
  MIN_W = 84,
  GPAD = 24;
const FILL = "var(--_node-fill)",
  STROKE = "var(--_node-stroke)",
  TEXT = "var(--_text)";

const isMethod = (m) => /\(/.test(m);

// 类盒尺寸 [w,h]，并返回分区信息
const boxOf = (name, members) => {
  const attrs = members.filter((m) => !isMethod(m)),
    methods = members.filter(isMethod);
  let w = textWidth(name, FONT)[0];
  for (const m of members) w = Math.max(w, textWidth(m, FONT)[0]);
  w = Math.max(MIN_W, w + 2 * PAD);
  const h = HEAD + (attrs.length ? attrs.length * LINE_H + 8 : 0) + (methods.length ? methods.length * LINE_H + 8 : 0);
  return [w, Math.max(h, HEAD + 6), attrs, methods];
};

// 关系端点标记：1 空心三角 2 开放箭头 3 实心菱形 4 空心菱形
const marker = (px, py, ang, kind) => {
  if (!kind) return ["", 0];
  const c = Math.cos(ang), s = Math.sin(ang);
  if (kind === 2) {
    const d = 9, a = 0.42;
    return [
      tag("path", { d: "M" + num(px) + " " + num(py) + "L" + num(px - d * Math.cos(ang - a)) + " " + num(py - d * Math.sin(ang - a)) + "M" + num(px) + " " + num(py) + "L" + num(px - d * Math.cos(ang + a)) + " " + num(py - d * Math.sin(ang + a)), stroke: "var(--_line)", "stroke-width": 1.5, fill: "none" }),
      0,
    ];
  }
  if (kind === 1) {
    const d = 10, a = 0.42,
      p1 = [px - d * Math.cos(ang - a), py - d * Math.sin(ang - a)],
      p2 = [px - d * Math.cos(ang + a), py - d * Math.sin(ang + a)];
    return [tag("path", { d: "M" + num(px) + " " + num(py) + "L" + num(p1[0]) + " " + num(p1[1]) + "L" + num(p2[0]) + " " + num(p2[1]) + "Z", fill: "var(--bg)", stroke: "var(--_line)", "stroke-width": 1.5 }), d * 0.9];
  }
  // 菱形
  const d = 8,
    tip = [px, py],
    bl = [px - d * c + (d / 2) * s, py - d * s - (d / 2) * c],
    bk = [px - 2 * d * c, py - 2 * d * s],
    br = [px - d * c - (d / 2) * s, py - d * s + (d / 2) * c],
    path = "M" + num(tip[0]) + " " + num(tip[1]) + "L" + num(bl[0]) + " " + num(bl[1]) + "L" + num(bk[0]) + " " + num(bk[1]) + "L" + num(br[0]) + " " + num(br[1]) + "Z";
  return [tag("path", { d: path, fill: kind === 3 ? "var(--_line)" : "var(--bg)", stroke: "var(--_line)", "stroke-width": 1.5 }), 2 * d];
};

const render = (body) => {
  const [dir, classes, edges] = parse(body);
  if (!classes.size) return [40, 40, ""];

  const sizes = new Map(),
    info = new Map();
  for (const [id, [name, members]] of classes) {
    const [w, h, attrs, methods] = boxOf(name, members);
    sizes.set(id, [w, h]);
    info.set(id, [attrs, methods]);
  }
  const [pos, lw, lh] = layout(dir, sizes, edges);

  let edge_svg = "";
  for (const [from, to, em, sm, dashed, label] of edges) {
    const pa = pos.get(from), pb = pos.get(to);
    if (!pa || !pb) continue;
    const dx = pb[0] - pa[0], dy = pb[1] - pa[1],
      vert = Math.abs(dy) >= Math.abs(dx),
      s = (vert ? dy : dx) < 0 ? -1 : 1,
      ux = vert ? 0 : s,
      uy = vert ? s : 0,
      // 端点取在盒子边缘中点（正交进出）
      sx = pa[0] + ux * (pa[2] / 2),
      sy = pa[1] + uy * (pa[3] / 2),
      ex = pb[0] - ux * (pb[2] / 2),
      ey = pb[1] - uy * (pb[3] / 2),
      eAng = Math.atan2(uy, ux),
      sAng = Math.atan2(-uy, -ux),
      [emSvg, eBack] = marker(ex, ey, eAng, em),
      [smSvg, sBack] = marker(sx, sy, sAng, sm),
      // 直角折线：主轴方向先走到中点再横移
      sx2 = sx + ux * sBack, sy2 = sy + uy * sBack,
      ex2 = ex - ux * eBack, ey2 = ey - uy * eBack,
      d = vert
        ? "M" + num(sx2) + " " + num(sy2) + "V" + num((sy + ey) / 2) + "H" + num(ex) + "V" + num(ey2)
        : "M" + num(sx2) + " " + num(sy2) + "H" + num((sx + ex) / 2) + "V" + num(ey) + "H" + num(ex2);
    edge_svg += tag("path", { d, fill: "none", stroke: "var(--_line)", "stroke-width": 1.5, "stroke-dasharray": dashed ? "5 4" : null });
    edge_svg += emSvg + smSvg;
    if (label) {
      const mx = (sx + ex) / 2, my = (sy + ey) / 2;
      edge_svg += tag("rect", { x: num(mx - label.length * 3.4 - 3), y: num(my - 9), width: num(label.length * 6.8 + 6), height: 16, fill: "var(--bg)", opacity: 0.85 });
      edge_svg += tag("text", { x: num(mx), y: num(my + 3), "text-anchor": "middle", "font-size": 12, fill: "var(--_text-muted)" }, esc(label));
    }
  }

  let node_svg = "";
  for (const [id, [name]] of classes) {
    const p = pos.get(id);
    if (!p) continue;
    const [cx, cy, w, h] = p,
      x = cx - w / 2, y = cy - h / 2,
      [attrs, methods] = info.get(id);
    node_svg += tag("rect", { x: num(x), y: num(y), width: num(w), height: num(h), rx: 4, fill: FILL, stroke: STROKE, "stroke-width": 1.5 });
    node_svg += tag("text", { x: num(cx), y: num(y + 18), "text-anchor": "middle", "font-size": FONT, "font-weight": 700, fill: TEXT }, esc(name));
    let yy = y + HEAD;
    const sep = () => (node_svg += tag("line", { x1: num(x), y1: num(yy), x2: num(x + w), y2: num(yy), stroke: STROKE, "stroke-width": 1 }));
    const lines = (arr) => {
      if (!arr.length) return;
      sep();
      yy += 6;
      for (const m of arr) {
        yy += LINE_H;
        node_svg += tag("text", { x: num(x + PAD), y: num(yy - 4), "font-size": FONT, fill: TEXT }, esc(m));
      }
      yy += 2;
    };
    lines(attrs);
    lines(methods);
  }

  const W = lw + 2 * GPAD, H = lh + 2 * GPAD,
    g = '<g transform="translate(' + GPAD + " " + GPAD + ')">' + edge_svg + node_svg + "</g>";
  return [num(W), num(H), g];
};

export default render;
