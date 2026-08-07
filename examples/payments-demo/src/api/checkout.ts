import { runCheckout, type CheckoutRequest } from "../checkout/CheckoutFlow";

export function postCheckout(body: unknown): string {
  const request = body as CheckoutRequest;
  return runCheckout(request);
}
