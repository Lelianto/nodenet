export function add(a: number, b: number): number {
  return a + b;
}

export const PI = 3.14159;

export interface Vec {
  x: number;
  y: number;
}

export function dot(v1: Vec, v2: Vec): number {
  return v1.x * v2.x + v1.y * v2.y;
}
