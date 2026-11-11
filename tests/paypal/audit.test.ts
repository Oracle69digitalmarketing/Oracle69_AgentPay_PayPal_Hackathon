import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createPayPalStore } from "../../src/paypal/store/sqlite-store.js";

const TEST_DB = "/tmp/opencode/paypal-audit-test.db";
const POLICY_DIGEST = "0x" + "11".repeat(32);
const PAYMENT_DIGEST = "0x" + "22".repeat(32);

beforeEach(() => {
  const db = new Database(TEST_DB);
  db.exec("DROP TABLE IF EXISTS paypal_payments");
  db.exec("DROP TABLE IF EXISTS paypal_audit_events");
  db.close();
});

function reserve(store: ReturnType<typeof createPayPalStore>, requestId: string): void {
  const result = store.claim({
    requestId,
    nonce: `nonce-${requestId}`,
    receiver: "merchant@example.com",
    amountMinor: 100n,
    currency: "USD",
    purpose: "audit test",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    policyDigest: POLICY_DIGEST,
    paymentDigest: PAYMENT_DIGEST,
  });
  expect(result.ok).toBe(true);
}

function approve(store: ReturnType<typeof createPayPalStore>, requestId: string): void {
  store.bindApproval(requestId, {
    paymentDigest: PAYMENT_DIGEST,
    policyDigest: POLICY_DIGEST,
    requestId,
    operatorId: "operator-test",
    verifiedAt: Math.floor(Date.now() / 1000),
  });
}

describe("PayPal append-only audit trail", () => {
  it("records the full lifecycle in chronological order", () => {
    const store = createPayPalStore(TEST_DB);
    reserve(store, "req-audit-full");
    store.attachProviderOrder("req-audit-full", "ORDER-AUDIT-1", "operator-test");
    store.transitionState("req-audit-full", "APPROVED", "operator-test");
    approve(store, "req-audit-full");
    store.transitionState("req-audit-full", "CAPTURING", "operator-test");
    store.verifyCompletion(
      "req-audit-full",
      "CAPTURE-AUDIT-1",
      100n,
      "USD",
      "operator-test",
      "merchant@example.com",
    );

    const events = store.getAuditTrail("req-audit-full");
    expect(events.map((event) => event.eventType)).toEqual([
      "PAYMENT_INTENT_CREATED",
      "POLICY_EVALUATED",
      "PAYMENT_RESERVED",
      "PAYPAL_ORDER_CREATED",
      "STATE_CHANGED",
      "OPERATOR_APPROVAL_RECORDED",
      "CAPTURE_INITIATED",
      "CAPTURE_VERIFIED",
    ]);
    expect(events.every((event, index) => index === 0 || event.id > events[index - 1]!.id)).toBe(true);
    expect(events.at(-1)?.captureId).toBe("CAPTURE-AUDIT-1");
    expect(events.at(-1)?.state).toBe("CAPTURED");
    store.close();
  });

  it("keeps unknown and failure history after reopen without claiming capture", () => {
    const first = createPayPalStore(TEST_DB);
    reserve(first, "req-audit-unknown");
    first.attachProviderOrder("req-audit-unknown", "ORDER-AUDIT-2", "operator-test");
    first.transitionState("req-audit-unknown", "APPROVED", "operator-test");
    approve(first, "req-audit-unknown");
    first.transitionState("req-audit-unknown", "CAPTURING", "operator-test");
    first.recordUnknown("req-audit-unknown", "operator-test");
    first.close();

    const second = createPayPalStore(TEST_DB);
    const events = second.getAuditTrail("req-audit-unknown");
    expect(events.some((event) => event.eventType === "CAPTURE_UNKNOWN")).toBe(true);
    expect(events.some((event) => event.eventType === "CAPTURE_VERIFIED")).toBe(false);
    expect(second.getRecord("req-audit-unknown")?.captureId).toBeNull();
    second.close();
  });

  it("does not overwrite terminal payment states with recordFailure", () => {
    const store = createPayPalStore(TEST_DB);
    reserve(store, "req-audit-terminal");
    store.attachProviderOrder("req-audit-terminal", "ORDER-AUDIT-3", "operator-test");
    store.transitionState("req-audit-terminal", "APPROVED", "operator-test");
    approve(store, "req-audit-terminal");
    store.transitionState("req-audit-terminal", "CAPTURING", "operator-test");
    store.verifyCompletion(
      "req-audit-terminal",
      "CAPTURE-AUDIT-3",
      100n,
      "USD",
      "operator-test",
      "merchant@example.com",
    );
    expect(() => store.recordFailure("req-audit-terminal", "late failure", "operator-test")).toThrow(
      /terminal/i,
    );
    expect(store.getRecord("req-audit-terminal")?.state).toBe("CAPTURED");
    store.close();
  });
});
