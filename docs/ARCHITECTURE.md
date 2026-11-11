# Oracle69 AgentPay — Architecture

## Overview

AgentPay is a policy-controlled payment framework for AI agents. The architecture separates three concerns:

1. **AI interpretation** — natural‑language instructions are interpreted by an LLM provider (Groq, Gemini, or regex fallback)
2. **Deterministic policy engine** — evaluates every extracted intent against security constraints (allowlist, currency, ceiling, expiry, approval)
3. **Provider execution** — PayPal Sandbox (or mock) operations are performed only after policy approval and mandatory human operator authorization

The framework is intentionally **fail‑closed**: if any layer rejects, no payment proceeds. No AI‑generated field can override policy decisions.

---

## AI Interpretation Layer

- **Provider selection**: environment‑driven via `AI_PROVIDER` env var
  - `groq` (default): OpenAI‑compatible chat/completions at `https://api.groq.com/openai/v1`
  - `gemini`: native REST at `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`
  - `openai`: disabled by default (API credits exhausted)
- **Fallthrough**: when AI is unavailable (missing key, network error), the application gracefully degrades to a deterministic regex parser. The regex parser extracts `{receiver, amount, currency, purpose}` from well‑formed instructions.
- **Output normalized**: every provider returns the same shape `{receiver, amountMinor, currency, purpose}`. AI never produces authorization or execution commands.
- **Security**: AI interpretation is an **interpretation layer only**. The AI cannot approve, authorize, or initiate payments. All extraction results are validated by the policy engine before any provider interaction.

### Provider Adapters (src/ai/providerAdapters.ts)

- `interpretWithProvider()` — unified dispatch function that selects the named provider and routes the instruction
- Each adapter builds the provider‑specific request body, sends it via the injected `fetchImpl`, and parses the response
- Auth headers are provider‑specific:
  - Groq: `Authorization: Bearer <token>` (header, not URL query string)
  - Gemini: `X-Goog-Api-Key` header (key in header, NOT in URL query string)
  - OpenAI: same body format as Groq (disabled by default)
- `getAuthHeader()` — returns the appropriate header for the selected provider
- `isValidAmountString()`, `isValidCurrency()`, `isValidReceiver()` — validation helpers used by all adapters
- Configuration errors (missing key, unsupported provider) are classified as `ExtractionReason.CONFIGURATION_ERROR`

### AI Interpreter (src/ai/payment-interpreter.ts)

- `buildSystemPrompt()` — constructs the natural‑language prompt sent to the LLM
- `isValidResponse()` — checks that the LLM response is well‑formed JSON with expected fields
- `extractPaymentIntent()` — parses the LLM JSON response into `{receiver, amount, currency, purpose}`
- All extraction tests (21/21 pass) verify correct receiver, amount, currency, and purpose extraction
- No silent fallback to AI output if extraction fails — explicit error is returned

---

## Deterministic Policy Engine (src/policy/)

- **`evaluatePolicy(intent, config, context)`** — pure function, no side effects, no LLM, no network, no clock dependency (time is injected via `context.now`)
- **Evaluates** a `PaymentIntent` against a `PolicyConfig`
- **Supported constraint types**:
  - Allowlisted receivers (case‑insensitive after canonicalization)
  - Currency (only `USD` accepted)
  - Amount ceiling (1 MON for M1; 1000 cents = $10.00 for PayPal)
  - Expiry (`now >= expiresAt` → expired; rejected)
  - Approval requirement (`requireHumanApproval` flag)
- **Rejection codes** are stably ordered (`PAYPAL_REASON_ORDER`):
  `INVALID_CONFIG`, `INVALID_REQUEST`, `INVALID_CURRENCY`, `INVALID_RECEIVER`, `INVALID_AMOUNT`, `NOT_ALLOWLISTED`, `EXCEEDS_LIMIT`, `EXPIRED_REQUEST`, `MISSING_APPROVAL`
- **Identical input always yields identical output** — reason ordering is deterministic; the same intent evaluated twice produces byte‑identical decisions
- **Approval flag is checked LAST** and never overrides any other violation. The engine does not verify signatures itself.
- **Policy digest** (`computePayPalPolicyDigest`) is a 32‑byte hex value computed from canonical allowlist, currency, maxPerPaymentMinor, and requireHumanApproval. Changes to `PAYPAL_ALLOWED_RECEIVERS` invalidate the original authorization.

### PayPal Policy Engine (src/paypal/engine.ts)

- PayPal‑specific evaluation of `PayPalIntent` against `PayPalPolicyConfig`
- Same constraint types as M1 policy but for PayPal domain (USD, receiver allowlist, $10 ceiling, expiry, approval)
- 40/40 tests pass (28 M1 + 12 PayPal policy engine tests)
- Rejection codes stably ordered per `PAYPAL_REASON_ORDER`

---

## Human Approval Mechanism

- **Operator token**: `x-agentpay-operator-token` HTTP header
- Enforced when `PAYPAL_REQUIRE_OPERATOR_AUTH=true` (default) and `PAYPAL_PUBLIC_DEPLOYMENT=true/false`
- Missing/invalid token → HTTP 401 (Unauthorized)
- Token value never logged or exposed in responses
- Approval binding ties operator identity to exact `paymentDigest`, `policyDigest`, and `requestId`
- Binding stored in SQLite `approval_digest` field; re‑checked at capture time
- Workflow:
  1. AI interprets instruction → policy evaluation
  2. If policy allows → operator approves (via `/api/paypal/approve`)
  3. Store transitions `RESERVED` → `ORDER_CREATED` → `APPROVED`
  4. Buyer approves via PayPal Sandbox
  5. Operator records approval → capture via PayPal Sandbox
  6. `verifyCompletion` independently verifies capture before recording `CAPTURED`

---

## PayPal Provider (src/paypal/provider.ts)

- **Two modes**:
  - `sandbox`: talks to real PayPal Sandbox REST API using OAuth client credentials
  - `mock`: deterministic, network‑free simulation for local/hackathon testing
- **Sandbox mode validation**:
  - Requires `clientId`, `clientSecret`, `baseUrl`, `merchantId`
  - `baseUrl` must be a PayPal Sandbox HTTPS endpoint (`isPayPalSandboxBaseUrl`)
  - Live/PayPal production endpoints are strictly refused
- **Sandbox API calls**:
  - `createOrder()` → `POST /v2/checkout/orders` with `intent: CAPTURE`
  - `getOrder()` → `GET /v2/checkout/orders/${orderId}`
  - `captureOrder()` → `POST /v2/checkout/orders/${orderId}/capture`
- **OAuth authentication**: client‑credentials Basic auth → `POST /v1/oauth2/token` → Bearer token for subsequent calls
- **Capture verification**: `verifyCompletion` independently checks amount, currency, receiver, and approval binding before recording `CAPTURED`
- **Ambiguous capture**: if outcome cannot be verified, state becomes `UNKNOWN`; no automatic retry

### Provider Configuration (src/server/paypal-server.ts)

- `createPayPalProviderFromEnv()` — reads `PAYPAL_MODE`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_ID`, `PAYPAL_BASE_URL`, `PAYPAL_ALLOWED_RECEIVERS`, `PAYPAL_MAX_MINOR` from `.env`
- `createPayPalPolicyFromEnv()` — reads same vars and constructs `PayPalPolicyConfig`
- Environment validation: refuses incomplete config, rejects unknown modes, defaults ceiling to $10.00

---

## Payment Lifecycle (SQLite Persistence)

### SQLite Schema (src/paypal/store/schema.sql)

```sql
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
  approval_digest TEXT,              -- set when state → APPROVED
  last_operator TEXT NOT NULL,
  last_transitioned_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  capture_id TEXT,                    -- set when capture completes
  provider_order_id TEXT,             -- set at ORDER_CREATED
  CONSTRAINT uq_paypal_nonce UNIQUE (nonce)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_paypal_capture_id ON paypal_payments(capture_id) WHERE capture_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_paypal_provider_order_id ON paypal_payments(provider_order_id) WHERE provider_order_id IS NOT NULL;
```

### Payment Record (`src/paypal/types.ts` — `PayPalPaymentRecord`)

Key fields:
- `requestId` — PRIMARY KEY, also used for nonce uniqueness
- `receiver` — canonical trimmed/lowercased email/payer-ID
- `amountMinor` — cents as bigint (e.g. `250` = $2.50)
- `currency` — always `USD`
- `state` — one of `RESERVED`, `ORDER_CREATED`, `APPROVED`, `CAPTURING`, `CAPTURED`, `UNKNOWN`, `FAILED`, `VOIDED`, `STALE`
- `policyDigest` — binds policy configuration at reservation time
- `paymentDigest` — binds payment intent at reservation time
- `approvalBinding` — `PayPalApprovalBinding | null`; populated when state → `APPROVED`
- `captureId` — PayPal capture ID; `null` until capture completes
- `providerOrderId` — PayPal order ID; `null` until order is created

### Lifecycle State Machine (`src/paypal/types.ts` — `PayPalLifecycleTransitions`)

| From → To | Condition |
|---|---|
| RESERVED → ORDER_CREATED | `attachProviderOrder` sets `provider_order_id` and advances state |
| ORDER_CREATED → APPROVED | `bindApproval` sets `approval_digest` |
| APPROVED → CAPTURING | `transitionState` |
| CAPTURING → CAPTURED | `verifyCompletion` independently verifies capture evidence |
| CAPTURING → UNKNOWN | `recordUnknown` captures ambiguous outcome |
| CAPTURING → FAILED | `recordFailure` records terminal failure |
| UNKNOWN → FAILED | final state |
| STALE → RESERVED | recovery transition |

### Audit Events (`src/paypal/types.ts` — `PayPalAuditEvent`, `paypal_payments` table)

Every transition appends an append‑only event:

| Event Type | State | Description |
|---|---|---|
| `PAYMENT_INTENT_CREATED` | RESERVED | Payment intent created from validated request |
| `POLICY_EVALUATED` | RESERVED | Deterministic policy allowed the request |
| `PAYMENT_RESERVED` | RESERVED | Payment identifiers reserved |
| `PAYPAL_ORDER_CREATED` | ORDER_CREATED | PayPal order created and bound |
| `BUYER_APPROVAL_VERIFIED` | ORDER_CREATED → APPROVED | Buyer approved via PayPal Sandbox |
| `OPERATOR_APPROVAL_RECORDED` | APPROVED | Operator approval bound to digests |
| `CAPTURE_INITIATED` | CAPTURING | Capture initiated via authorized workflow |
| `CAPTURE_VERIFIED` | CAPTURED | Capture evidence verified and recorded |
| `CAPTURE_UNKNOWN` | UNKNOWN | Capture outcome ambiguous |
| `PAYMENT_FAILED` | FAILED | Payment failed (terminal) |
| `PAYMENT_VOIDED` | VOIDED | Payment voided (terminal) |
| `STATE_CHANGED` | — | General state transition |

Index: `idx_paypal_audit_request` on `(request_id, id)` for trail retrieval.

### Replay Prevention

- UNIQUE constraints on `nonce` (across all records) and `request_id` (primary key)
- `BEGIN IMMEDIATE` transactions ensure fail‑closed duplicate detection
- Duplicate claims return `{ ok: false, reused: "nonce" | "requestId" }`
- Prevents duplicate claims across store close/reopen cycles

### Failure Handling

| Failure Type | Handling |
|---|---|
| AI extraction failure | Explicit error; app degrades to regex parser |
| Policy rejection | Rejection codes stably ordered; no AI override |
| Missing operator approval | `MISSING_APPROVAL`; HTTP 401 if token absent/invalid |
| Provider network error | `NETWORK_ERROR`; capture semantics: `ambiguous: true` |
| Ambiguous capture outcome | State → `UNKNOWN`; no automatic retry |
| Duplicate nonce/requestId | Claim rejected with `reused: "nonce" | "requestId"` |
| Terminal state overwrite | `recordFailure` / `recordUnknown` reject if state is `CAPTURED`/`UNKNOWN`/`FAILED`/`VOIDED` |

---

## SQLite Persistence (details)

### `paypal_payments` table

- One row per payment record. No DELETE or cleanup path by design.
- Consumed request IDs and nonces must never become reusable.
- Immutable fields (`createdAt`, `policyDigest`, `paymentDigest`) set once at reservation and never updated.
- `capture_id` and `provider_order_id` are nullable; UNIQUE indexes prevent duplicate captures/orders.

### `paypal_audit_events` table

- Append‑only: events are never updated or deleted.
- Each event has `id` (autoincrement), `request_id`, `event_type`, `state`, `message`, `code`, `operator_id`, `provider_order_id`, `capture_id`, `created_at`.
- Index `idx_paypal_audit_request` on `(request_id, id)` for ordered trail retrieval.

### Key store functions (src/paypal/store/sqlite-store.ts)

- `claim()` — reserve a new payment (RESERVED state), check nonce/requestId uniqueness, insert audit events (PAYMENT_INTENT_CREATED, POLICY_EVALUATED, PAYMENT_RESERVED)
- `getRecord()` — retrieve a payment record by `requestId`
- `transitionState()` — validate and advance state machine transition (e.g., RESERVED → ORDER_CREATED → APPROVED → CAPTURING)
- `verifyCompletion()` — independently verify capture (amount match, currency match, receiver match, approval binding validation) then transition to CAPTURED
- `recordFailure()` — transition to FAILED (reject if already in terminal state)
- `recordUnknown()` — transition to UNKNOWN (ambiguous capture; no auto-retry)
- `bindApproval()` — set `approval_digest`, record `OPERATOR_APPROVAL_RECORDED` audit event
- `attachProviderOrder()` — set `provider_order_id`, advance RESERVED → ORDER_CREATED
- `getAuditTrail()` — return ordered list of audit events for a payment
- `validateTransition()` — check if a state transition is permitted per the lifecycle machine

---

## Independent Verification

- `verifyCompletion()` in `sqlite-store.ts` independently checks:
  1. Payment must be in `CAPTURING` state
  2. Capture amount matches the stored `amountMinor`
  3. Capture currency matches the stored `currency` (always `USD`)
  4. Receiver matches the stored `receiver`
  5. Approval binding is present and binds to the exact `requestId`, `paymentDigest`, and `policyDigest`
  6. Payment is not expired (`now < expiresAt`)
- On success: state → `CAPTURED`, `capture_id` is persisted, `CAPTURE_VERIFIED` audit event appended
- On failure: error thrown; state unchanged. This verification is **independent of provider implementation** — it re‑checks all constraints from the stored record.

---

## Audit Events (append‑only timeline)

Typical full lifecycle event sequence:

```
PAYMENT_INTENT_CREATED → POLICY_EVALUATED → PAYMENT_RESERVED → PAYPAL_ORDER_CREATED → 
BUYER_APPROVAL_VERIFIED → OPERATOR_APPROVAL_RECORDED → CAPTURE_INITIATED → CAPTURE_VERIFIED
```

Each event is immutable and identified by an auto‑incrementing `id`. The audit trail can be retrieved with `getAuditTrail(requestId)`, which returns events ordered by `id` ASC.

---

## Failure Handling Summary

- **AI unavailable**: app degrades to deterministic regex parser; no payment proceeds without valid intent
- **Policy rejection**: rejection codes stably ordered; same input always produces same output; no AI override
- **Operator approval missing/invalid**: HTTP 401; no state transition permitted
- **Provider network error**: `NETWORK_ERROR`; capture semantics mark outcome as ambiguous (`ambiguous: true`)
- **Ambiguous capture**: state → `UNKNOWN`; no automatic retry; manual reconciliation required
- **Duplicate nonce/requestId**: claim rejected; `reused: "nonce" | "requestId"`
- **Terminal state overwrite**: `recordFailure`/`recordUnknown` reject if current state is `CAPTURED`/`UNKNOWN`/`FAILED`/`VOIDED`
- **Policy digest invalidation**: changes to `PAYPAL_ALLOWED_RECEIVERS` invalidate original authorization; independently verified via `verifyUnitBinding` at approval and capture

---

## Mermaid Architecture Diagram

```mermaid
flowchart TD
    A[Natural-language instruction] --> B[AI Interpretation Layer]
    B -->|Groq / Gemini / regex fallback| C[Extracted Intent: {receiver, amount, currency, purpose}]
    C --> D[Deterministic Policy Engine]
    D -->|allowed| E[Mandatory Human Approval]
    D -->|rejected| F[Explicit Error -- payment terminates]
    E -->|x-agentpay-operator-token| G[PayPal Provider: createOrder]
    G -->|Sandbox API| H[PayPal Order ID + Approval URL]
    H -->|Buyer approves via PayPal Sandbox| I[Provider order APPROVED]
    I --> J[PayPal Provider: captureOrder]
    J -->|Sandbox API| K[Capture ID + COMPLETED status]
    K --> L[Independent Verification: verifyCompletion]
    L -->|amount/currency/receiver/binding OK| M[Payment Status: CAPTURED]
    L -->|any check fails| N[Error -- payment remains in current state]
    M --> O[Append-only Audit: CAPTURE_VERIFIED]
    N --> P[Append-only Audit: CAPTURE_UNKNOWN or PAYMENT_FAILED]
    
    style A fill:#e3f2fd,stroke:#1976d2
    style B fill:#bbdefb,stroke:#1976d2
    style D fill:#c8e6c9,stroke:#388e3c
    style E fill:#ffecd2,stroke:#fb8c00
    style G fill:#e8f5e9,stroke:#2e7d32
```

*The diagram illustrates the complete flow from natural‑language instruction through AI interpretation, policy evaluation, mandatory human approval, PayPal Sandbox order and capture, and independent verification. All provider calls use the Sandbox only; live/PayPal production endpoints are refused.*