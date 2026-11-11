# Oracle69 AgentPay — Contribution Guidelines

## Development Setup

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Verify the build passes:
   ```bash
   pnpm build
   ```

3. Run the test suite to confirm everything is working:
   ```bash
   pnpm test
   ```

4. The project uses `.env` for configuration. Copy `.env.example` to `.env` and fill in the placeholders:
   ```bash
   cp .env.example .env
   ```
   **Never commit `.env` or actual credentials.**

## Coding Conventions

- All source code is TypeScript (ES modules, `type: "module"` in `package.json`).
- Use `pnpm lint` if a linter is configured (currently no dedicated lint script; `pnpm typecheck` enforces TS correctness).
- Follow existing code style in the repository (see `src/` and `tests/` for conventions).
- Keep functions small and focused; the project emphasizes deterministic, testable units.
- All new functionality should have corresponding tests in the `tests/` directory.

## Test Requirements

- Run the full test suite before submitting changes:
  ```bash
  pnpm test
  ```
- Add tests for new functionality in the appropriate test file:
  - `tests/paypal/` — PayPal Sandbox provider, lifecycle, policy, validation, digest, explanation, config tests
  - `tests/auth/` — Authorization, replay‑protection tests
  - `tests/policy/` — Policy engine tests
  - `tests/execution/` — Monad testnet execution tests
  - `tests/demo/` — Demo driver import‑graph audit
  - `tests/server/` — Web demo server HTTP tests
- Tests must pass with `pnpm test`. Do not modify test expectations to make failing tests pass — fix the implementation instead.
- No real‑money testing: all PayPal interactions use the Sandbox environment only.
- No credentials in test code: never hard‑code API keys, operator tokens, or client secrets in test files.

## Security Expectations

- The following security invariants must be preserved by any contribution:
  - Sandbox‑only payment execution (no Live/PayPal production endpoints)
  - API credential protection (`.env` only, never in source, logs, or responses)
  - Operator authentication enforced on all state‑changing routes
  - Deterministic policy engine is the sole authorization authority
  - Human approval is mandatory and verified before any provider interaction
  - $10.00 absolute payment ceiling enforced
  - Replay prevention via UNIQUE constraints on nonce + request_id
  - Independent capture verification (amount, currency, receiver, approval binding)
  - Ambiguous capture outcomes become `UNKNOWN`; no automatic retry
- If a contribution weakens any of these invariants, it will be rejected.
- Run `pnpm typecheck` and `pnpm build` to confirm no TypeScript errors are introduced.

## Pull Request Expectations

1. Describe the change and the problem it solves in the PR title and body.
2. Include test results: run `pnpm test` and confirm all tests pass (or document any known failures).
3. Run `pnpm typecheck` and `pnpm build` — these must pass.
4. Ensure no secrets (API keys, operator tokens, merchant IDs) are included in the diff.
5. If the change affects the PayPal lifecycle, include tests that cover the new behavior.
5. Follow the existing commit message style if applicable.
6. Tag the PR with relevant labels (e.g., `paypal`, `policy`, `security`).

## No Real‑Money Testing

- All PayPal interactions must use the Sandbox environment only.
- No real‑money transactions are permitted at any time.
- The `PAYPAL_MODE=sandbox` and `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com` must remain configured.
- Any test that attempts to use Live PayPal endpoints will be rejected.

## No Credentials in Source Control

- `.env` is git‑ignored (verified in `.gitignore`). Never commit actual credentials.
- `.env.example` contains placeholders only — do not replace placeholders with real values.
- PayPal client ID, client secret, merchant ID, and operator token must be provided via `.env` at runtime only.
- If adding a new environment variable, also add it to `.env.example` with a placeholder description.

---

Thank you for contributing to Oracle69 AgentPay!