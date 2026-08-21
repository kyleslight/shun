import { dirOf } from "../const/DIR.js";

// 关系标记：[end-marker 在右端, start-marker 在左端, 是否虚线]
// marker: 0 无 1 实心三角(继承/实现) 2 开放箭头 3 实心菱形(组合) 4 空心菱形(聚合)
const REL = /^(\S+)\s+([<|*o.\-]*(?:--|\.\.)[|>*o.\-]*)\s+(\S+)(?:\s*:\s*(.*))?$/;

const markerOf = (s, side) => {
  // side: 0=左端(看开头) 1=右端(看结尾)
  if (side === 0) {
    if (s.startsWith("<|")) return 1;
    if (s.startsWith("*")) return 3;
    if (s.startsWith("o")) return 4;
    if (s.startsWith("<")) return 2;
    return 0;
  }
  if (s.endsWith("|>")) return 1;
  if (s.endsWith("*")) return 3;
  if (s.endsWith("o")) return 4;
  if (s.endsWith(">")) return 2;
  return 0;
};

const cleanId = (s) => s.replace(/[~"]/g, "").trim();

const parse = (body) => {
  const lines = body.split("\n").slice(1),
    classes = new Map(), // id -> [name, members[]]
    edges = []; // [from, to, endMarker, startMarker, dashed, label]
  let dir = dirOf("TB");

  const cls = (id) => {
    id = cleanId(id);
    if (!classes.has(id)) classes.set(id, [id, []]);
    return classes.get(id);
  };

  for (let i = 0; i < lines.length; ++i) {
    let ln = lines[i].trim();
    if (!ln) continue;
    if (/^direction\s+/.test(ln)) {
      dir = dirOf(ln.split(/\s+/)[1]);
      continue;
    }
    if (/^(namespace|note|click|style|classDef|cssClass|<<)/.test(ln)) continue;

    // class Foo { ... }  或  class Foo
    const cm = ln.match(/^class\s+([^\s{:~]+)(?:\["[^"]*"\])?\s*(\{)?/);
    if (cm) {
      const c = cls(cm[1]);
      if (cm[2]) {
        // 收集到匹配的 }
        let body_lines = ln.slice(ln.indexOf("{") + 1);
        while (!body_lines.includes("}") && ++i < lines.length) body_lines += "\n" + lines[i];
        body_lines = body_lines.replace(/}.*$/s, "");
        for (const ml of body_lines.split(/\n|;/)) {
          const m = ml.trim();
          if (m) c[1].push(m);
        }
      }
      continue;
    }

    // 关系： A <|-- B : label
    const rm = ln.match(REL);
    if (rm) {
      const [, l, rel, r, label] = rm;
      cls(l);
      cls(r);
      edges.push([cleanId(l), cleanId(r), markerOf(rel, 1), markerOf(rel, 0), rel.includes(".."), (label || "").trim()]);
      continue;
    }

    // 成员： Foo : +bar()
    const mm = ln.match(/^([^\s:]+)\s*:\s*(.+)$/);
    if (mm) {
      cls(mm[1])[1].push(mm[2].trim());
      continue;
    }
  }

  return [dir, classes, edges];
};

export default parse;
