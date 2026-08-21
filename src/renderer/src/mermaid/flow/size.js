import { textWidth } from "../measure.js";
import { CIRCLE, DIAMOND, HEXAGON, PARALLELOGRAM, PARALLELOGRAM_ALT, TRAPEZOID, TRAPEZOID_ALT, CYLINDER, STADIUM, SUBROUTINE } from "../const/SHAPE.js";

export const FONT = 14,
  LINE_H = 17,
  PADX = 14,
  PADY = 9,
  MIN_W = 54,
  MIN_H = 38;

// 计算节点外接框 [w, h]
const size = (shape, label) => {
  const [tw, lines] = textWidth(label, FONT),
    th = lines * LINE_H;
  let w = Math.max(MIN_W, tw + 2 * PADX),
    h = Math.max(MIN_H, th + 2 * PADY);
  if (shape === CIRCLE) {
    const d = Math.max(tw, th) + 2 * PADX + 10;
    w = h = d;
  } else if (shape === DIAMOND) {
    w = Math.max(MIN_W, tw * 1.4 + 2 * PADX);
    h = th * 1.8 + 2 * PADY;
  } else if (shape === HEXAGON) {
    w += h;
  } else if (shape === PARALLELOGRAM || shape === PARALLELOGRAM_ALT || shape === TRAPEZOID || shape === TRAPEZOID_ALT) {
    w += 24;
  } else if (shape === CYLINDER) {
    h += 16;
  } else if (shape === STADIUM || shape === SUBROUTINE) {
    w += 12;
  }
  return [w, h];
};

export default size;
