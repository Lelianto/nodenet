export interface Settlement {
  id: string;
  cartId: string;
  status: "pending" | "settled" | "failed";
}
