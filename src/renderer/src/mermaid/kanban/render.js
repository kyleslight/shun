import { tag, esc, num } from "../xml.js";
import { textWidth } from "../measure.js";

const COLW = 180, PAD = 16, TOP = 16, HEAD = 34, CARD_H = 40, CARD_GAP = 10;

// 取 id[Label] / id(Label) 的 Label，否则用整行
const textOf = (s) => {
  const m = s.match(/[[({]+(.+?)[\])}]+\s*$/);
  return m ? m[1] : s.replace(/^[\w-]+/, "").trim() || s;
};

const parse = (body) => {
  const lines = body.split("\n").slice(1);
  const cols = []; // [title, cards[]]
  let cur = null, baseIndent = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length,
      ln = raw.trim();
    if (baseIndent === null) baseIndent = indent;
    if (indent <= baseIndent) { cur = [textOf(ln), []]; cols.push(cur); }
    else if (cur) cur[1].push(textOf(ln));
  }
  return cols;
};

const render = (body) => {
  const cols = parse(body);
  if (!cols.length) return [200, 80, ""];
  const maxCards = Math.max(...cols.map((c) => c[1].length), 0),
    W = PAD * 2 + cols.length * (COLW + PAD) - PAD,
    H = TOP + HEAD + 10 + maxCards * (CARD_H + CARD_GAP) + PAD;
  let out = "";
  cols.forEach((c, i) => {
    const x = PAD + i * (COLW + PAD);
    out += tag("rect", { x: num(x), y: TOP, width: COLW, height: num(H - TOP - PAD), rx: 10, fill: "var(--_group-hdr)" });
    out += tag("text", { x: num(x + COLW / 2), y: TOP + 22, "text-anchor": "middle", "font-size": 13, "font-weight": 700, fill: "var(--_text)" }, esc(c[0]));
    c[1].forEach((card, k) => {
      const y = TOP + HEAD + 6 + k * (CARD_H + CARD_GAP);
      out += tag("rect", { x: num(x + 10), y: num(y), width: COLW - 20, height: CARD_H, rx: 6, fill: "var(--_node-fill)", stroke: "var(--_node-stroke)" });
      const t = card.length > 22 ? card.slice(0, 21) + "…" : card;
      out += tag("text", { x: num(x + 20), y: num(y + CARD_H / 2 + 4), "font-size": 12, fill: "var(--_text)" }, esc(t));
    });
  });
  return [num(W), num(H), out];
};

export default render;
