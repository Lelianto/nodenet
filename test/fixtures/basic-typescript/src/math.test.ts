import { add } from "./math";

export function testAdd(): void {
  const result = add(2, 2);
  if (result !== 4) {
    throw new Error("add(2,2) should be 4");
  }
}
