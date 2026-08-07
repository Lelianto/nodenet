#!/usr/bin/env bash
# NodeNet demo — build, visualize, query, and run a PR-style impact analysis.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLI="$ROOT/dist/cli/cli.js"

if [ ! -f "$CLI" ]; then
  echo "Building NodeNet first…"
  (cd "$ROOT" && npm run build >/dev/null)
fi

section() { printf "\n\033[1m%s\033[0m\n" "$*"; }

cd "$HERE"

section "nodenet build"
node "$CLI" build

section "nodenet graph → open .nodenet/graph.html in a browser"
node "$CLI" graph -o .nodenet/graph.html

section "nodenet graph -f svg → static image graph-preview.svg"
node "$CLI" graph -f svg -o graph-preview.svg

section "nodenet owner src/payment/PaymentService.ts"
node "$CLI" owner src/payment/PaymentService.ts

section "nodenet governed-by src/payment/PaymentService.ts"
node "$CLI" governed-by src/payment/PaymentService.ts

section "nodenet trace runCheckout saveSettlement"
node "$CLI" trace runCheckout saveSettlement

section "nodenet context createSettlement (MSC bundle)"
node "$CLI" context createSettlement

section "nodenet health"
node "$CLI" health

# --- PR-style impact analysis on a throwaway git checkout --------------------
section "PR scenario: Checkout Team changes CheckoutService (impact --base main)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -R "$HERE/." "$TMP/"
(
  cd "$TMP"
  git init -q
  git config user.email demo@example.com
  git config user.name Demo
  git branch -M main
  git add .
  git commit -qm "demo baseline"
  git checkout -qb feature/gift-cards
  cat >> src/checkout/CheckoutService.ts <<'EOF'

export function checkoutWithGiftCard(cartId: string, amount: number, cardToken: string): string {
  // Checkout team: gift-card settlement changes payment semantics
  const input = { cartId, amount, cardToken };
  return createSettlement(input);
}
EOF
  git add .
  git commit -qm "checkout-team: add gift card settlement"
  node "$CLI" impact --base main
  printf "\n"
  node "$CLI" reviewers --base main
)
