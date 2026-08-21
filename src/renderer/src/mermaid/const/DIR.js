// 流向：是否水平（LR/RL）、是否反向（BT/RL）
export const TB = 0,
  BT = 1,
  LR = 2,
  RL = 3;

export const dirOf = (s) =>
  s === "LR" ? LR : s === "RL" ? RL : s === "BT" ? BT : TB;

export const isHoriz = (d) => d === LR || d === RL;
export const isRev = (d) => d === BT || d === RL;
