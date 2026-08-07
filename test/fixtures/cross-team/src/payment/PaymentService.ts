export interface SettlementInput {
  cartId: string;
  amount: number;
}

export function createSettlement(input: SettlementInput): string {
  return "stl-" + input.cartId;
}
