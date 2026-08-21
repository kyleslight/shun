import { dirOf } from "../const/DIR.js";

// 节点种类
export const K_NORM = 0, K_DOT = 1, K_BAR = 2, K_HIST = 3;

const parse = (body) => {
  const lines = body.split("\n").slice(1),
    nodes = new Map(), // id -> [label, kind]
    edges = []; // [from, to, label]
  let dir = dirOf("TB"),
    pseudo = 0;

  const node = (id, label, kind) => {
    if (!nodes.has(id)) nodes.set(id, [label != null ? label : id, kind || K_NORM]);
    else if (label != null) nodes.get(id)[0] = label;
    return id;
  };

  // 解析端点 token：[*] / [H] / [H*] / id / "name"
  const endp = (raw) => {
    const s = raw.trim();
    if (s === "[*]") return node("__p" + pseudo++, "", K_DOT);
    if (s === "[H]" || s === "[H*]") return node("__h" + pseudo++, "H", K_HIST);
    const q = s.match(/^"(.+)"$/);
    if (q) return node(s, q[1], K_NORM);
    return node(s.replace(/[":]/g, ""), null, K_NORM);
  };

  for (let i = 0; i < lines.length; ++i) {
    let ln = lines[i].trim();
    if (!ln) continue;
    if (/^direction\s+/.test(ln)) {
      dir = dirOf(ln.split(/\s+/)[1]);
      continue;
    }
    if (/^note\b/i.test(ln)) continue;
    if (/^end\b/.test(ln) || ln === "}") continue;

    // state "X" as Y
    const al = ln.match(/^state\s+"([^"]*)"\s+as\s+(\S+)/);
    if (al) {
      node(al[2], al[1], K_NORM);
      continue;
    }
    // state Name <<fork|join>>
    const fk = ln.match(/^state\s+(\S+)\s+<<(fork|join)>>/);
    if (fk) {
      node(fk[1], "", K_BAR);
      continue;
    }
    // state Name { → 复合状态：扁平化处理，仅把 Name 作为普通节点，内部行照常解析
    const co = ln.match(/^state\s+(\S+)\s*\{/);
    if (co) {
      node(co[1], null, K_NORM);
      continue;
    }
    // 转换 A --> B : label
    const tr = ln.match(/^(.+?)\s*--+>\s*(.+)$/);
    if (tr) {
      const from = endp(tr[1]);
      let rest = tr[2],
        label = "";
      const ci = rest.indexOf(":");
      if (ci >= 0) {
        label = rest.slice(ci + 1).trim();
        rest = rest.slice(0, ci);
      }
      edges.push([from, endp(rest), label]);
      continue;
    }
    // 描述 Id : desc
    const ds = ln.match(/^([^\s:]+)\s*:\s*(.+)$/);
    if (ds) {
      node(ds[1], ds[2].trim(), K_NORM);
      continue;
    }
    // 裸 state Name
    const st = ln.match(/^state\s+(\S+)$/) || ln.match(/^([A-Za-z0-9_]+)$/);
    if (st) node(st[1], null, K_NORM);
  }

  return [dir, nodes, edges];
};

export default parse;
