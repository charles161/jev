import { formatCount } from "../sd-estimate";
import { starterBoard, type BoardDef } from "./kit";

const PSP_P99_SECONDS = 2;
const ENTRIES_PER_PAYMENT = 2;

const def: BoardDef = {
  id: "payments",
  title: "Payments",
  blurb: "Idempotency keys, an external PSP with retries, outbox to a double-entry ledger, nightly reconciliation.",
  functional: [
    "Charge a card through a PSP; refunds",
    "Payment status: pending -> authorized -> captured / failed",
    "Double-entry ledger of every money movement",
  ],
  nonFunctional: [
    "Exactly-once effect: a retry never charges twice",
    "Strong consistency on payment state; 99.99% available",
    "Every cent reconciles with the PSP daily; 7 y audit trail",
  ],
  numbers: {
    input: { dau: 20e6, writesPerUser: 0.5, readWriteRatio: 10, payloadBytes: 2000, retentionYears: 7, peakFactor: 5 },
    writeName: "payment",
    readName: "status read",
    extra: (r) => [
      `Ledger rows: ${formatCount(r.writesPerDay)} × ${ENTRIES_PER_PAYMENT} entries ≈ ${formatCount(r.writesPerDay * ENTRIES_PER_PAYMENT)}/day`,
      `PSP calls in flight (Little): ${formatCount(r.peakWriteQps)}/s × ${PSP_P99_SECONDS} s ≈ ${formatCount(r.peakWriteQps * PSP_P99_SECONDS)}`,
    ],
  },
  api: {
    label: "POST /payments",
    lines: [
      "req: {amount_cents, currency, source}",
      "res: 201 {payment_id, status}",
      "err: 402 card declined",
      "err: 409 key reused, other body",
      "idem: Idempotency-Key (24 h)",
    ],
  },
  tradeoffs: [
    "Idempotency key checked before the PSP call and sent to the PSP too: a client or worker retry returns the first result",
    "Transactional outbox: the payment row and its event commit together; CDC publishes, so no event is lost or invented",
    "Ledger is append-only debit + credit pairs; balances are sums, never updated in place",
  ],
  zoneLabel: "PCI zone · us-east-1",
  nodes: [
    { id: "psp", kind: "external", label: "PSP", sublabel: "Stripe / Adyen", col: 2, row: -1, outside: true },
    { id: "idem", kind: "cache", label: "Redis", sublabel: "idempotency keys", col: 1, row: 0 },
    { id: "recon", kind: "node", label: "Reconciliation", sublabel: "nightly job", col: 4, row: 0 },
    { id: "client", kind: "actor", label: "Client", col: 0, row: 1, outside: true },
    { id: "lb", kind: "lb", label: "API Gateway", sublabel: "TLS · auth", col: 1, row: 1 },
    { id: "payment", kind: "node", label: "Payment Service", col: 2, row: 1 },
    { id: "ledgerdb", kind: "database", label: "Ledger DB", sublabel: "append-only", col: 3, row: 1 },
    { id: "db", kind: "database", label: "Payments DB", sublabel: "payments + outbox", col: 2, row: 2 },
    { id: "kafka", kind: "queue", label: "Kafka: events", col: 3, row: 2 },
    { id: "ledger", kind: "node", label: "Ledger Service", col: 4, row: 2 },
  ],
  edges: [
    { from: "client", to: "lb", label: "HTTPS", path: "both" },
    { from: "lb", to: "payment", label: "POST /payments", path: "write" },
    { from: "payment", to: "idem", label: "SET NX", path: "write" },
    { from: "payment", to: "psp", label: "authorize · HTTPS", path: "write" },
    { from: "payment", to: "db", label: "1 txn", path: "write" },
    { from: "db", to: "kafka", label: "outbox CDC", path: "write", async: true },
    { from: "kafka", to: "ledger", label: "consume", path: "write", async: true },
    { from: "ledger", to: "ledgerdb", label: "debit + credit", path: "write" },
    { from: "recon", to: "ledgerdb", label: "diff", path: "read" },
    { from: "recon", to: "psp", label: "settlement file", path: "read" },
  ],
  breaks: {
    culprit: "db",
    side: "below",
    lines: [
      "10× = 5.8K payments/s at peak, each 3+ row writes on one Postgres primary, and big merchants serialise on their rows",
      "Fix: shard payments by merchant_id; keep balances as summed ledger entries plus snapshots, never one hot balance row",
    ],
  },
  er: {
    from: ["payment", "db"],
    caption: "payments and ledger",
    entities: [
      { id: "ent_merchants", name: "merchants", attributes: ["id bigint PK", "name text", "country char(2)"] },
      { id: "ent_payments", name: "payments", attributes: ["id bigint PK", "merchant_id bigint FK", "amount_cents bigint", "status text", "idem_key text UK"] },
      { id: "ent_accounts", name: "accounts", attributes: ["id bigint PK", "merchant_id bigint FK", "kind text"] },
      { id: "ent_entries", name: "ledger_entries", attributes: ["id bigint PK", "payment_id bigint FK", "account_id bigint FK", "direction text", "amount_cents bigint"] },
    ],
    relations: [
      { id: "rel_merchant_payments", from: "ent_merchants", to: "ent_payments", cardinality: "1:0..n", label: "takes" },
      { id: "rel_merchant_accounts", from: "ent_merchants", to: "ent_accounts", cardinality: "1:1..n", label: "owns" },
      { id: "rel_payment_entries", from: "ent_payments", to: "ent_entries", cardinality: "1:1..n", label: "posts" },
      { id: "rel_account_entries", from: "ent_accounts", to: "ent_entries", cardinality: "1:0..n", label: "has" },
    ],
    grid: { ent_merchants: [0, 0], ent_payments: [1, 0], ent_accounts: [0, 1], ent_entries: [1, 1] },
  },
  sequence: {
    from: ["client", "payment", "idem", "db", "psp"],
    caption: "charge with idempotency",
    summary: "Charge a card exactly once with an idempotency key and PSP retries",
    messages: [
      { from: "client", to: "payment", label: "POST (Idempotency-Key)" },
      { from: "payment", to: "idem", label: "SET key NX" },
      { from: "idem", to: "payment", label: "OK, first try", isReturn: true },
      { from: "payment", to: "db", label: "INSERT pending" },
      { from: "db", to: "payment", label: "ok", isReturn: true },
      { from: "payment", to: "psp", label: "authorize(key)" },
      { from: "psp", to: "payment", label: "approved", isReturn: true },
      { from: "payment", to: "db", label: "UPDATE + outbox" },
      { from: "db", to: "payment", label: "commit", isReturn: true },
      { from: "payment", to: "client", label: "201 authorized", isReturn: true },
    ],
    fragments: [{ operator: "loop", guard: "timeout: retry ≤3, same key", fromOrder: 6, toOrder: 7 }],
  },
};

export const payments = starterBoard(def);
