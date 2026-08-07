import { add, PI, type Vec } from "./math";

export function main(): number {
  const v: Vec = { x: 1, y: 2 };
  return add(PI, dot(v, v));
}

function dot(v: Vec): number {
  return v.x * v.x + v.y * v.y;
}

export function unusedHelper(): string {
  return "hello";
}
