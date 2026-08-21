import { tag, esc, num } from "../xml.js";
import { textWidth } from "../measure.js";
import layout from "../flow/layout.js";
import { dirOf } from "../const/DIR.js";

const FONT = 13, HEAD = 26, ROW = 18, PADX = 14, MIN_W = 130, GPAD = 24;

const parse = (body) => {
  const lines = body.split("\n");
  const nodes = new Map(); // id -> [kind, name, fields[]]
  const edges = []; // [from, to, label]
  for (let i = 1; i < lines.length; ++i) {
    const ln = lines[i].trim();
    if (!ln || /^acc/.test(ln)) continue;
    // 块： <kind> <name> {
    const b = ln.match(/^(\w+)\s+([\w.-]+)\s*\{/);
    if (b) {
      const fields = [];
      while (++i < lines.length && !lines[i].includes("}")) {
        const f = lines[i].trim();
        if (f) fields.push(f);
      }
      nodes.set(b[2], [b[1], b[2], fields]);
      continue;
    }
    // 关系： a - verb -> b  /  a -> b  /  a - verb - b
    const r = ln.match(/^([\w.-]+)\s*-\s*(\w+)?\s*-?>?\s*([\w.-]+)$/);
    if (r && (ln.includes(">") || ln.includes(" - "))) {
      const from = r[1], to = r[3], label = r[2] || "";
      if (!nodes.has(from)) nodes.set(from, ["", from, []]);
      if (!nodes.has(to)) nodes.set(to, ["", to, []]);
      edges.push([from, to, label]);
    }
  }
  return [nodes, edges];
};

const render = (body) => {
  const [nodes, edges] = parse(body);
  if (!nodes.size) return [40, 40, ""];
  const dir = dirOf("TB"), sizes = new Map();
  for (const [id, [kind, name, fields]] of nodes) {
    let w = textWidth(name, FONT)[0] + 24;
    for (const f of fields) w = Math.max(w, textWidth(f, FONT)[0] + 2 * PADX);
    sizes.set(id, [Math.max(MIN_W, w), HEAD + fields.length * ROW + 6]);
  }
  const [pos, lw, lh] = layout(dir, sizes, edges);

  let edge_svg = "", node_svg = "";
  for (const [from, to, label] of edges) {
    const pa = pos.get(from), pb = pos.get(to);
    if (!pa || !pb) continue;
    const sx = pa[0], sy = pa[1] + pa[3] / 2, ex = pb[0], ey = pb[1] - pb[3] / 2,
      midY = (sy + ey) / 2;
    edge_svg += tag("path", { d: "M" + num(sx) + " " + num(sy) + "V" + num(midY) + "H" + num(ex) + "V" + num(ey - 8), fill: "none", stroke: "var(--_line)", "stroke-width": 1.5, "stroke-dasharray": "5 4" });
    edge_svg += tag("path", { d: "M" + num(ex) + " " + num(ey) + "l-5 -8 h10 z", fill: "var(--_arrow)" });
    if (label) {
      edge_svg += tag("rect", { x: num((sx + ex) / 2 - label.length * 3.4 - 3), y: num(midY - 9), width: num(label.length * 6.8 + 6), height: 16, fill: "var(--bg)", opacity: 0.85 });
      edge_svg += tag("text", { x: num((sx + ex) / 2), y: num(midY + 3), "text-anchor": "middle", "font-size": 11, fill: "var(--_text-muted)" }, esc(label));
    }
  }
  for (const [id, [kind, name, fields]] of nodes) {
    const p = pos.get(id);
    if (!p) continue;
    const [cx, cy, w, h] = p, x = cx - w / 2, y = cy - h / 2;
    node_svg += tag("rect", { x: num(x), y: num(y), width: num(w), height: num(h), rx: 4, fill: "var(--_node-fill)", stroke: "var(--_node-stroke)", "stroke-width": 1.5 });
    node_svg += tag("rect", { x: num(x), y: num(y), width: num(w), height: HEAD, fill: "var(--_group-hdr)" });
    node_svg += tag("text", { x: num(cx), y: num(y + 13), "text-anchor": "middle", "font-size": 10, fill: "var(--_text-muted)" }, esc("«" + (kind || "req") + "»"));
    node_svg += tag("text", { x: num(cx), y: num(y + 24), "text-anchor": "middle", "font-size": FONT, "font-weight": 700, fill: "var(--_text)" }, esc(name));
    fields.forEach((f, k) => (node_svg += tag("text", { x: num(x + PADX), y: num(y + HEAD + 14 + k * ROW), "font-size": 11, fill: "var(--_text-muted)" }, esc(f.length > 22 ? f.slice(0, 21) + "…" : f))));
  }
  const W = lw + 2 * GPAD, H = lh + 2 * GPAD;
  return [num(W), num(H), '<g transform="translate(' + GPAD + " " + GPAD + ')">' + edge_svg + node_svg + "</g>"];
};

export default render;
