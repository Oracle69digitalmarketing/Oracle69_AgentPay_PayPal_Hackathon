-- PayPal payment lifecycle schema — Oracle69 AgentPay (Phase 4B).
--
-- One row per payment record. No DELETE or cleanup path exists by design:
-- consumed request IDs and nonces must never become reusable.
--
-- State machine enforcement is applied by the application layer;
-- the schema enforces uniqueness and immutability.
--
-- Columns marked NOT NULL must never be NULL at any time after init.
-- Immutable fields (createdAt, policyDigest, paymentDigest) are set once
-- at reservation and never updated.
CREATE TABLE IF NOT EXISTS paypal_payments (
  request_id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  receiver TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  purpose TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'RESERVED',
  policy_digest TEXT NOT NULL,
  payment_digest TEXT NOT NULL,
  approval_digest TEXT,           -- nullable: set when state → APPROVED
  last_operator TEXT NOT NULL,
  last_transitioned_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  capture_id TEXT,                -- nullable: set when capture completes
  provider_order_id TEXT,         -- nullable
  provider_capture_id TEXT,       -- nullable
  -- Uniqueness constraints below are enforced by UNIQUE constraints + BEGIN IMMEDIATE.
  -- They guarantee single-use across processes on the same host.
  CONSTRAINT uq_paypal_nonce UNIQUE (nonce)
);