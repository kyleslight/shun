// 解析 sequenceDiagram。事件用 [类型, ...] 数组表示。
export const E_MSG = 0, // [E_MSG, from, to, text, arrow, act, deact]  act/deact: 是否激活目标/停用源
  E_NOTE = 1, // [E_NOTE, place, a, b, text]   place: 0=over 1=right 2=left
  E_OPEN = 2, // [E_OPEN, keyword, text]
  E_ELSE = 3, // [E_ELSE, text]
  E_CLOSE = 4, // [E_CLOSE]
  E_ACT = 5, // [E_ACT, idx]
  E_DEACT = 6, // [E_DEACT, idx]
  E_AUTONUM = 7; // [E_AUTONUM, on, start, step]

export const OVER = 0, RIGHT = 1, LEFT = 2;

const ARROW = /(<<-->>|-->>|->>|--x|-x|--\)|-\)|-->|->)/;
const MSG = new RegExp("^(.+?)\\s*" + ARROW.source + "\\s*([+-]?)\\s*(.+?)\\s*:\\s*(.*)$");
const BLOCK = /^(alt|opt|loop|par|critical|rect|box|break)\b\s*(.*)$/;
const ELSE = /^(else|and|option)\b\s*(.*)$/;

const unquote = (s) => s.replace(/^"(.*)"$/, "$1").trim();

const parse = (body) => {
  const lines = body.split("\n").slice(1), // 去掉首行 sequenceDiagram
    idx = new Map(), // id -> 序号
    actors = [], // [id, label]
    events = [];

  // 取得/创建参与者序号
  const actor = (raw) => {
    const id = unquote(raw);
    if (!idx.has(id)) {
      idx.set(id, actors.length);
      actors.push([id, id]);
    }
    return idx.get(id);
  };

  for (let raw of lines) {
    const ln = raw.trim();
    if (!ln) continue;

    const decl = ln.match(/^(?:participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/);
    if (decl) {
      const id = unquote(decl[1]),
        label = decl[2] ? unquote(decl[2]) : id;
      if (!idx.has(id)) {
        idx.set(id, actors.length);
        actors.push([id, label]);
      } else actors[idx.get(id)][1] = label;
      continue;
    }

    const an = ln.match(/^autonumber\b\s*(.*)$/);
    if (an) {
      const rest = an[1].trim();
      if (rest === "off") events.push([E_AUTONUM, false]);
      else {
        const [s, step] = rest.split(/\s+/);
        events.push([E_AUTONUM, true, +s || 1, +step || 1]);
      }
      continue;
    }

    const note = ln.match(/^Note\s+(right of|left of|over)\s+(.+?)\s*:\s*(.*)$/i);
    if (note) {
      const place = /over/i.test(note[1]) ? OVER : /right/i.test(note[1]) ? RIGHT : LEFT,
        parts = note[2].split(",").map((s) => actor(s.trim())),
        a = parts[0],
        b = parts.length > 1 ? parts[1] : a;
      events.push([E_NOTE, place, a, b, note[3]]);
      continue;
    }

    const blk = ln.match(BLOCK);
    if (blk) {
      events.push([E_OPEN, blk[1], blk[2].trim()]);
      continue;
    }
    if (/^end\b/.test(ln)) {
      events.push([E_CLOSE]);
      continue;
    }
    const els = ln.match(ELSE);
    if (els) {
      events.push([E_ELSE, els[2].trim()]);
      continue;
    }

    const act = ln.match(/^(activate|deactivate)\s+(.+)$/);
    if (act) {
      events.push([/^a/.test(act[1]) ? E_ACT : E_DEACT, actor(act[2])]);
      continue;
    }

    const m = ln.match(MSG);
    if (m) {
      const from = actor(m[1]),
        arrow = m[2],
        marker = m[3],
        to = actor(m[4]),
        text = m[5];
      events.push([E_MSG, from, to, text, arrow, marker === "+", marker === "-"]);
    }
  }

  return [actors, events];
};

export default parse;
