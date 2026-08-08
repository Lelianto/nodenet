# NodeNet example — payments demo

A small checkout → payment project that shows what NodeNet produces. It models
a real-world cross-team scenario:

- **Checkout Team** owns `src/checkout/**` and `src/api/**`.
- **Payment Team** owns `src/payment/**`, governed by `PAYMENT-003`
  (settlement rule, STANDARD, Finance Team must approve).
- **Security Team** owns `src/security/**` and hardened context `SEC-009`
  (PCI payment data validation, HARDENED — immutable to AI agents).

Living Context lives in the canonical `.lcdd/contexts/` Registry; explicit ownership remains in
`.nodenet/ownership.json`, and a `CODEOWNERS` fallback exists too.

## Run it

```bash
# from the repo root
npm run build
cd examples/payments-demo
node ../../dist/cli/cli.js build        # scan + build the graph
node ../../dist/cli/cli.js graph        # interactive HTML at .nodenet/graph.html
```

Open `.nodenet/graph.html` in any browser: pan/zoom, hover to highlight
neighbors, click a node for details, search, and toggle layers. Communities
are detected automatically.

A static image preview is also exported as `graph-preview.svg`:

```bash
node ../../dist/cli/cli.js graph -f svg -o graph-preview.svg
```

## What you can ask

```bash
# who owns a file, and which rule governs it
node ../../dist/cli/cli.js owner src/payment/PaymentService.ts
node ../../dist/cli/cli.js governed-by src/payment/PaymentService.ts

# an explainable path between two symbols
node ../../dist/cli/cli.js trace runCheckout saveSettlement

# the AI context bundle (Minimum Sufficient Context) for a symbol
node ../../dist/cli/cli.js context createSettlement

# context health
node ../../dist/cli/cli.js health
```

Example outputs (from the shipped `graph.html`):

```
$ nodenet owner src/payment/PaymentService.ts
src/payment/PaymentService.ts → payment-team (source: lcdd, confidence: AUTHORITATIVE)

$ nodenet trace runCheckout saveSettlement
runCheckout() @ src/checkout/CheckoutFlow.ts:10
  --calls--> checkout() @ src/checkout/CheckoutService.ts:4
  --calls--> createSettlement() @ src/payment/PaymentService.ts:4
  --calls--> saveSettlement() @ src/payment/SettlementRepository.ts:3
```

## The PR scenario

`demo.sh` builds a git baseline on `main`, then adds a feature branch where
the **Checkout Team changes `CheckoutService`** to support gift-card
settlement. Because that change reaches Payment Team code governed by
`PAYMENT-003` and `SEC-009`:

```
$ nodenet impact --base main
Impact: HIGH
Ownership boundary crossed: checkout-team → payment-team (via src/payment/PaymentService.ts)

$ nodenet reviewers --base main
Required:
  payment-team   (ownership + CODEOWNERS)
Authority approval required:
  finance-team   (PAYMENT-003 is STANDARD)
  security-team  (SEC-009 is HARDENED — approval required)
```

Run it once to see the full report:

```bash
./demo.sh
```
