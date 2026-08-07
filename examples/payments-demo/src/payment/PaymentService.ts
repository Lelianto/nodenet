import { validateSettlement, type Settlement, type SettlementInput } from "./SettlementSchema";
import { saveSettlement } from "./SettlementRepository";

export function createSettlement(input: SettlementInput): string {
  if (!validateSettlement(input)) {
    throw new Error("invalid settlement input");
  }
  const settlement: Settlement = {
    id: "stl-" + input.cartId,
    cartId: input.cartId,
    amount: input.amount,
    status: "pending",
  };
  saveSettlement(settlement);
  return settlement.id;
}
