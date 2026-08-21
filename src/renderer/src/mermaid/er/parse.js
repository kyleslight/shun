import { dirOf } from "../const/DIR.js";

// cardinality 数字常量：0 恰好一 | 1 零或一 | 2 零或多 | 3 一或多
export const ONE = 0, ZERO_ONE = 1, ZERO_MANY = 2, ONE_MANY = 3;

// 把一侧 token 映射为 cardinality（left/right 写法对称）
const card = (t) => {
  if (t === "||") return ONE;
  if (t === "|o" || t === "o|") return ZERO_ONE;
  if (t === "}o" || t === "o{") return ZERO_MANY;
  return ONE_MANY; // }| 或 |{
};

const REL = /^(\S+)\s+([|}o][|o{])(--|\.\.)([|}o][|o{])\s+(\S+)\s*(?::\s*(.+))?$/;

const unq = (s) => s.replace(/^"(.*)"$/, "$1").trim();

const parse = (body) => {
  const lines = body.split("\n").slice(1),
    ents = new Map(), // id -> [name, attrs[]]
    rels = []; // [from, to, lcard, rcard, dashed, label]
  let dir = dirOf("LR");

  const ent = (id) => {
    id = unq(id);
    if (!ents.has(id)) ents.set(id, [id, []]);
    return id;
  };

  for (let i = 0; i < lines.length; ++i) {
    let ln = lines[i].trim();
    if (!ln) continue;
    if (/^direction\s+/.test(ln)) {
      dir = dirOf(ln.split(/\s+/)[1]);
      continue;
    }

    // 实体属性块： NAME { ... }
    const eb = ln.match(/^(\S+)\s*\{$/) || ln.match(/^(\S+)\s*\{(.*)$/);
    if (eb && ln.includes("{")) {
      const e = ents.get(ent(eb[1]));
      let inner = ln.slice(ln.indexOf("{") + 1);
      while (!inner.includes("}") && ++i < lines.length) inner += "\n" + lines[i];
      inner = inner.replace(/}.*$/s, "");
      for (const row of inner.split("\n")) {
        const r = row.trim();
        if (r) e[1].push(r);
      }
      continue;
    }

    const rm = ln.match(REL);
    if (rm) {
      const [, l, lc, line, rc, r, label] = rm;
      rels.push([ent(l), ent(r), card(lc), card(rc), line === "..", (label || "").trim()]);
      continue;
    }

    // 裸实体
    const bare = ln.match(/^([A-Za-z0-9_"-]+)$/);
    if (bare) ent(bare[1]);
  }

  return [dir, ents, rels];
};

export default parse;
