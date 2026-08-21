import { UNKNOWN, PIE, SEQUENCE, FLOWCHART, CLASS, STATE, ER, XYCHART, JOURNEY, TIMELINE, MINDMAP, QUADRANT, KANBAN, PACKET, REQUIREMENT, GITGRAPH, GANTT, SANKEY, BLOCK } from "./const/TYPE.js";

// 从已清洗的正文判别图类型（看首个有效关键字）
const detect = (body) => {
  const head = body.slice(0, 40);
  if (/^\s*pie\b/.test(head)) return PIE;
  if (/^\s*sequenceDiagram\b/.test(head)) return SEQUENCE;
  if (/^\s*(?:flowchart|graph)\b/.test(head)) return FLOWCHART;
  if (/^\s*classDiagram\b/.test(head)) return CLASS;
  if (/^\s*stateDiagram(?:-v2)?\b/.test(head)) return STATE;
  if (/^\s*erDiagram\b/.test(head)) return ER;
  if (/^\s*xychart(?:-beta)?\b/.test(head)) return XYCHART;
  if (/^\s*journey\b/.test(head)) return JOURNEY;
  if (/^\s*timeline\b/.test(head)) return TIMELINE;
  if (/^\s*mindmap\b/.test(head)) return MINDMAP;
  if (/^\s*quadrantChart\b/.test(head)) return QUADRANT;
  if (/^\s*kanban\b/.test(head)) return KANBAN;
  if (/^\s*packet(?:-beta)?\b/.test(head)) return PACKET;
  if (/^\s*requirementDiagram\b/.test(head)) return REQUIREMENT;
  if (/^\s*gitGraph\b/.test(head)) return GITGRAPH;
  if (/^\s*gantt\b/.test(head)) return GANTT;
  if (/^\s*sankey(?:-beta)?\b/.test(head)) return SANKEY;
  if (/^\s*block(?:-beta)?\b/.test(head)) return BLOCK;
  return UNKNOWN;
};

export default detect;
