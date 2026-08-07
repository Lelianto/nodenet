import type { Settlement } from "./SettlementSchema";

export function saveSettlement(settlement: Settlement): void {
  // persisted downstream
}

export function findByCartId(cartId: string): Settlement | undefined {
  return undefined;
}
