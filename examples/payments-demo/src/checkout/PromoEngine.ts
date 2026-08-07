export class PromoEngine {
  apply(cartId: string, amount: number): number {
    void cartId;
    return amount > 100 ? amount - 10 : amount;
  }
}
