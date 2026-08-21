import { tag, esc, num } from "../xml.js";

const BITS = 32, CELL = 18, ROW_H = 40, PADX = 30, TOP = 24, LABEL_W = 0;

// "start-end: label" 或 "start: label"
const parse = (body) =>
  body.split("\n").slice(1).map((l) => l.trim()).filter(Boolean).map((ln) => {
    const m = ln.match(/^(\d+)\s*(?:-\s*(\d+))?\s*:\s*"?([^"]*)"?/);
    if (!m) return null;
    return [+m[1], m[2] ? +m[2] : +m[1], m[3].trim()];
  }).filter(Boolean);

const render = (body) => {
  const fields = parse(body);
  if (!fields.length) return [200, 80, ""];
  const maxBit = Math.max(...fields.map((f) => f[1])),
    rows = Math.ceil((maxBit + 1) / BITS),
    cw = CELL,
    W = PADX * 2 + BITS * cw,
    H = TOP + rows * ROW_H + 16;
  let out = "";
  // 顶部 bit 刻度
  for (let b = 0; b < BITS; b += 8)
    out += tag("text", { x: num(PADX + b * cw + 2), y: TOP - 8, "font-size": 9, fill: "var(--_text-muted)" }, "" + b);

  for (const [s, e, lbl] of fields) {
    let b = s;
    while (b <= e) {
      const row = Math.floor(b / BITS),
        col = b % BITS,
        rowEnd = Math.min(e, (row + 1) * BITS - 1),
        span = rowEnd - b + 1,
        x = PADX + col * cw,
        y = TOP + row * ROW_H;
      out += tag("rect", { x: num(x), y: num(y), width: num(span * cw), height: ROW_H - 8, fill: "var(--_node-fill)", stroke: "var(--_node-stroke)" });
      const t = lbl.length > span * 2.4 ? lbl.slice(0, Math.max(1, span * 2 - 1)) + "…" : lbl;
      out += tag("text", { x: num(x + (span * cw) / 2), y: num(y + (ROW_H - 8) / 2 + 4), "text-anchor": "middle", "font-size": 11, fill: "var(--_text)" }, esc(t));
      b = rowEnd + 1;
    }
  }
  return [num(W), num(H), out];
};

export default render;
