// @ts-expect-error The in-house Mermaid renderer is intentionally plain JS.
import clean from "./clean.js";
// @ts-expect-error The in-house Mermaid renderer is intentionally plain JS.
import detect from "./detect.js";
// @ts-expect-error The in-house Mermaid renderer is intentionally plain JS.
import parse from "./flow/parse.js";
// @ts-expect-error The in-house Mermaid renderer is intentionally plain JS.
import layout from "./flow/layout.js";
// @ts-expect-error The in-house Mermaid renderer is intentionally plain JS.
import size from "./flow/size.js";
// @ts-expect-error The in-house Mermaid renderer is intentionally plain JS.
import { FLOWCHART } from "./const/TYPE.js";
// @ts-expect-error The in-house Mermaid renderer is intentionally plain JS.
import { CIRCLE, DIAMOND, ROUND, STADIUM } from "./const/SHAPE.js";

export type MermaidExcalidrawPalette = { bg: string; fg: string; line: string; surface: string; border: string; muted: string };
export type MermaidExcalidrawSkeleton = Record<string, unknown> & { type: string };

const SCALE = 1.45;
const NODE_MIN_WIDTH = 104;
const NODE_MIN_HEIGHT = 58;
const EXCALIDRAW_HAND_DRAWN_FONT = 5;

export function stableExcalidrawSeed(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

const nodeId = (id: string) =>
  `mermaid-node-${id.replace(/[^\w-]/g, "-")}-${stableExcalidrawSeed(id).toString(36)}`;

function shapeType(shape: number) {
  if (shape === CIRCLE) return "ellipse";
  if (shape === DIAMOND) return "diamond";
  return "rectangle";
}

function roundness(shape: number) {
  return shape === ROUND || shape === STADIUM ? { type: 3 } : null;
}

function border(cx: number, cy: number, width: number, height: number, tx: number, ty: number) {
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const t = 1 / Math.max(Math.abs(dx) / (width / 2 + 1), Math.abs(dy) / (height / 2 + 1));
  return [cx + dx * t, cy + dy * t];
}

function arrowheads(conn: string) {
  return { startArrowhead: conn.startsWith("<") ? "arrow" : null, endArrowhead: conn.endsWith(">") ? "arrow" : null };
}

export function buildExcalidrawFlowSkeleton(source: string, palette: MermaidExcalidrawPalette) {
  const [body] = clean(source);
  if (detect(body) !== FLOWCHART) return null;
  const [direction, nodes, edges, subgraphs] = parse(body);
  if (!nodes.size) return [] as MermaidExcalidrawSkeleton[];

  const sizes = new Map<string, [number, number]>();
  for (const [id, node] of nodes) {
    const [rawWidth, rawHeight] = size(node[1], node[2]);
    sizes.set(id, [Math.max(NODE_MIN_WIDTH, rawWidth * SCALE), Math.max(NODE_MIN_HEIGHT, rawHeight * SCALE)]);
  }
  const [positions] = layout(direction, sizes, edges);
  const skeletons: MermaidExcalidrawSkeleton[] = [];

  for (const [index, [, title, members]] of subgraphs.entries()) {
    const memberPositions = members.map((id: string) => positions.get(id)).filter(Boolean) as [number, number, number, number][];
    if (!memberPositions.length) continue;
    const left = Math.min(...memberPositions.map((entry) => entry[0] - entry[2] / 2)) - 30;
    const top = Math.min(...memberPositions.map((entry) => entry[1] - entry[3] / 2)) - 48;
    const right = Math.max(...memberPositions.map((entry) => entry[0] + entry[2] / 2)) + 30;
    const bottom = Math.max(...memberPositions.map((entry) => entry[1] + entry[3] / 2)) + 30;
    skeletons.push({
      id: `mermaid-group-${index}`, type: "rectangle", x: left, y: top, width: right - left, height: bottom - top,
      strokeColor: palette.border, backgroundColor: "transparent", fillStyle: "solid", strokeStyle: "solid", strokeWidth: 2,
      roughness: 1, opacity: 72, seed: stableExcalidrawSeed(`group:${index}:${title}`),
      label: { text: title, fontSize: 14, fontFamily: EXCALIDRAW_HAND_DRAWN_FONT, textAlign: "center", verticalAlign: "top", strokeColor: palette.muted },
    });
  }

  for (const [index, [from, to, conn, label]] of edges.entries()) {
    const start = positions.get(from) as [number, number, number, number] | undefined;
    const end = positions.get(to) as [number, number, number, number] | undefined;
    if (!start || !end) continue;
    const [sx, sy] = border(start[0], start[1], start[2], start[3], end[0], end[1]);
    const [ex, ey] = border(end[0], end[1], end[2], end[3], start[0], start[1]);
    const dx = ex - sx;
    const dy = ey - sy;
    const bend = Math.min(28, Math.max(10, Math.hypot(dx, dy) * 0.055)) * (index % 2 ? -1 : 1);
    const midpoint: [number, number] = Math.abs(dx) > Math.abs(dy) ? [dx / 2, dy / 2 + bend] : [dx / 2 + bend, dy / 2];
    skeletons.push({
      id: `mermaid-edge-${index}`, type: conn.endsWith(">") || conn.startsWith("<") ? "arrow" : "line",
      x: sx, y: sy, width: dx, height: dy, points: [[0, 0], midpoint, [dx, dy]], strokeColor: palette.line,
      backgroundColor: "transparent", strokeStyle: conn.includes(".") ? "dashed" : "solid", strokeWidth: conn.includes("=") ? 3 : 2,
      roughness: 2, roundness: { type: 2 }, seed: stableExcalidrawSeed(`edge:${from}:${to}:${index}`),
      start: { id: nodeId(from) }, end: { id: nodeId(to) }, ...arrowheads(conn),
      ...(label ? { label: { text: label, fontSize: 16, fontFamily: EXCALIDRAW_HAND_DRAWN_FONT, strokeColor: palette.fg } } : {}),
    });
  }

  for (const [id, node] of nodes) {
    const position = positions.get(id) as [number, number, number, number] | undefined;
    if (!position) continue;
    const [cx, cy, width, height] = position;
    skeletons.push({
      id: nodeId(id), type: shapeType(node[1]), x: cx - width / 2, y: cy - height / 2, width, height,
      strokeColor: palette.fg, backgroundColor: palette.surface, fillStyle: "solid", strokeStyle: "solid", strokeWidth: 2,
      roughness: 1, roundness: roundness(node[1]), seed: stableExcalidrawSeed(`node:${id}`),
      label: { text: node[2], fontSize: 16, fontFamily: EXCALIDRAW_HAND_DRAWN_FONT, textAlign: "center", verticalAlign: "middle", strokeColor: palette.fg },
    });
  }
  return skeletons;
}
