export interface SettlementInput {
  cartId: string;
  amount: number;
  cardToken: string;
}

export interface Settlement {
  id: string;
  cartId: string;
  amount: number;
  status: "pending" | "settled" | "failed";
}

export function validateSettlement(input: SettlementInput): boolean {
  return input.amount > 0 && input.amount <= 1_000_000;
}
