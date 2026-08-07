import { Button } from "./Button";
import { useCounter } from "./useCounter";

export function App() {
  const { count, increment } = useCounter(0);
  return (
    <div>
      <Button label={`count: ${count}`} onClick={increment} />
    </div>
  );
}
