import { createSettlement, type SettlementInput } from "../payment/PaymentService";

export function checkout(cartId: string): string {
  const input: SettlementInput = { cartId, amount: 0 };
  return createSettlement(input);
}
