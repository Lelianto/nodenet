import { checkout } from "./CheckoutService";
import { PromoEngine } from "./PromoEngine";

export interface CheckoutRequest {
  cartId: string;
  amount: number;
  cardToken: string;
}

export function runCheckout(request: CheckoutRequest): string {
  const engine = new PromoEngine();
  const adjusted = engine.apply(request.cartId, request.amount);
  return checkout(request.cartId, adjusted, request.cardToken);
}
