// 节点形状数字常量
export const RECT = 0,
  ROUND = 1,
  STADIUM = 2,
  SUBROUTINE = 3,
  CYLINDER = 4,
  CIRCLE = 5,
  DIAMOND = 6,
  HEXAGON = 7,
  PARALLELOGRAM = 8,
  PARALLELOGRAM_ALT = 9,
  TRAPEZOID = 10,
  TRAPEZOID_ALT = 11,
  ASYMMETRIC = 12;

// 新版 @{ shape: x } 名称 → 常量
export const NAMED = {
  rect: RECT,
  rectangle: RECT,
  rounded: ROUND,
  stadium: STADIUM,
  subroutine: SUBROUTINE,
  cylinder: CYLINDER,
  database: CYLINDER,
  circle: CIRCLE,
  diamond: DIAMOND,
  decision: DIAMOND,
  hexagon: HEXAGON,
  "lean-r": PARALLELOGRAM,
  "lean-l": PARALLELOGRAM_ALT,
  "trap-b": TRAPEZOID,
  "trap-t": TRAPEZOID_ALT,
};
