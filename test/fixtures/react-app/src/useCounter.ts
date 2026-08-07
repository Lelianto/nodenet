import { useState } from "react";

export function useCounter(initial: number) {
  const [count, setCount] = useState(initial);
  const increment = () => setCount((c) => c + 1);
  return { count, increment };
}
