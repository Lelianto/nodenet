import { createSettlement, type SettlementInput } from "../payment/PaymentService";
import { checkRateLimit } from "../security/RateLimiter";

export function checkout(cartId: string, amount: number, cardToken: string): string {
  if (!checkRateLimit("client")) {
    throw new Error("rate limited");
  }
  const input: SettlementInput = { cartId, amount, cardToken };
  return createSettlement(input);
}
