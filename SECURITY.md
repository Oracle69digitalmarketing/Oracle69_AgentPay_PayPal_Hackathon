# Oracle69 AgentPay — Security Documentation

## Sandbox-Only Payment Execution

All PayPal API calls use `PAYPAL_MODE=sandbox` and `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`. Live/PayPal production endpoints are strictly refused at provider construction (`isPayPalSandboxBaseUrl` validates the hostname). No real‑money transactions occur; this is a Sandbox‑only integration.

## API Credential Protection

- PayPal `clientId`, `clientSecret`, and `merchantId` are held exclusively in `.env`, which is git‑ignored (verified in `.gitignore`).
- These values never appear in API responses, server logs, or error messages.
- `.env` is never committed to source control.
- `.env.example` contains placeholders only; never copy actual credential values from `.env` into documentation or source.

## Operator Authentication

- State‑changing PayPal routes (`/api/paypal/ai-extract`, order creation, capture) require `x-agentpay-operator-token` HTTP header when `PAYPAL_REQUIRE_OPERATOR_AUTH=true` (default for production/public deployments).
- Missing or invalid operator authentication returns HTTP 401 (Unauthorized).
- The operator token value is never logged or exposed in responses.
- Production/public deployments refuse to start without a token when `PAYPAL_PUBLIC_DEPLOYMENT=true` or `PAYPAL_REQUIRE_OPERATOR_AUTH=true`.

## Deterministic Policy Enforcement

- The policy engine is the **sole authorization authority**. All payment intents are evaluated against `PAYPAL_ALLOWED_RECEIVERS`, `USD` currency, `PAYPAL_MAX_MINOR` ($10.00) ceiling, expiry, and approval requirements.
- Rejection codes are stably ordered (`INVALID_CONFIG`, `INVALID_REQUEST`, `INVALID_CURRENCY`, `INVALID_RECEIVER`, `INVALID_AMOUNT`, `NOT_ALLOWLISTED`, `EXCEEDS_LIMIT`, `EXPIRED_REQUEST`, `MISSING_APPROVAL`).
- No AI‑generated field can override a policy decision. `evaluatePayPalPolicy` always re‑checks all constraints regardless of AI output.
- Policy digest is correctly computed and bound to every payment record; changes to `PAYPAL_ALLOWED_RECEIVERS` invalidate the original authorization.

## Human Approval

- Mandatory for all state‑changing operations. No payment proceeds without a verified operator token and approval binding.
- Approval binding ties the operator identity to the exact `paymentDigest`, `policyDigest`, and `requestId` (EIP‑712 style).
- The binding is stored in `approval_digest` in SQLite and re‑checked at capture time. Without a valid binding, capture is rejected and the payment remains in `ORDER_CREATED` state.

## Payment Amount Ceiling

- Absolute $10.00 (1000 cents). Enforced at policy evaluation and config validation boundaries.
- No configuration can permit amounts above this boundary. Exactly $10.00 (1000 cents) is accepted at the boundary.
- `PAYPAL_MAX_MINOR=1000` in `.env` is the authoritative ceiling.

## Replay Protection

- UNIQUE constraints on `nonce` and `request_id` in the `paypal_payments` SQLite table.
- `BEGIN IMMEDIATE` transactions ensure fail‑closed duplicate detection across store instances.
- Duplicate claims return `{ ok: false, reused: "nonce" | "requestId" }`.
- Replay prevention applies across store close/reopen cycles.

## Independent Capture Verification

- `verifyCompletion` independently checks:
  - Capture amount matches the approved amount (cents comparison)
  - Capture currency matches (always `USD`)
  - Capture receiver matches the approved receiver
  - Approval binding is present and binds to the exact `requestId`, `paymentDigest`, and `policyDigest`
- Verification is **independent of provider implementation** — it re‑checks all constraints from the stored record.
- On success: state transitions to `CAPTURED`, `captureId` is persisted, `CAPTURE_VERIFIED` audit event is appended.
- On failure: an error is thrown; state remains unchanged.

## UNKNOWN State Handling

- If capture outcome cannot be verified (e.g., network error, ambiguous response), the state becomes `UNKNOWN` via `recordUnknown`.
- Automatic retry is **disabled** pending manual reconciliation.
- From `UNKNOWN`, only transition to `FAILED` is permitted.
- `UNKNOWN` without a recorded hash stops for explicit operator intervention (fresh approval with fresh identifiers).
- Consumed identifiers are never released.

## Security Vulnerability Reporting

If you discover a security issue in this project, please report it by opening an issue in the GitHub repository with a detailed description. Do not disclose vulnerabilities in public forums until they have been addressed.

The project maintains the following invariants:
- Sandbox‑only execution
- Credential protection (`.env` only, never in logs/responses)
- Operator authentication enforced
- Deterministic policy is sole authorization authority
- Human approval is mandatory and verified
- $10.00 absolute ceiling
- Replay protection via UNIQUE constraints
- Independent capture verification
- UNKNOWN state disables automatic retry