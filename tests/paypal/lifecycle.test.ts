import { describe, expect, it, beforeEach } from "vitest";
import { createPayPalStore } from "../../src/paypal/store/sqlite-store.js";
import type { PayPalClaimResult, PayPalClaimCollision } from "../../src/paypal/types.js";
import { PayPalLifecycleState, PayPalPaymentRecord, PayPalApprovalBinding } from "../../src/paypal/types.js";
import Database from "better-sqlite3";

const TEST_DB = "/tmp/opencode/paypal-phase4b-test.db";

function cleanDb(): void {
  try {
    const db = new Database(TEST_DB);
    db.exec("DROP TABLE IF EXISTS paypal_payments");
    db.exec("DROP TABLE IF EXISTS paypal_audit_events");
    db.close();
  } catch {}
}

beforeEach(() => cleanDb());

function setupStore() {
  return createPayPalStore(TEST_DB);
}

function makePolicyDigest(): string {
  const cfg = {
    allowedReceivers: ["merchant@example.com"],
    maxPerPaymentMinor: 1000n,
    currency: "USD",
    requireHumanApproval: true,
  };
  return "0x" + "00".repeat(32);
}

function makePaymentDigest(): string {
  return "0x" + Buffer.alloc(32, 0).toString("hex");
}

function hasReused(result: PayPalClaimResult | PayPalClaimCollision): result is PayPalClaimCollision {
  return "reused" in result;
}

describe("paypal phase 4b lifecycle and store", () => {
  it("reserves a new payment record with RESERVED state", () => {
    const store = setupStore();
    const result = store.claim({
      requestId: "req-001", nonce: "nonce-001",
      receiver: "merchant@example.com", amountMinor: 100n,
      currency: "USD", purpose: "demo",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      policyDigest: makePolicyDigest(), paymentDigest: makePaymentDigest(),
    });
    expect(result).toHaveProperty("ok", true);
    const rec = store.getRecord("req-001");
    expect(rec).not.toBeNull();
    expect(rec!.state).toBe("RESERVED");
    expect(rec!.receiver).toBe("merchant@example.com");
    expect(rec!.amountMinor).toBe(100n);
    expect(rec!.currency).toBe("USD");
    store.close();
  });

  it("rejects duplicate nonce on claim", () => {
    const store = setupStore();
    store.claim({
      requestId: "req-002", nonce: "nonce-dup",
      receiver: "merchant@example.com", amountMinor: 100n,
      currency: "USD", purpose: "demo",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      policyDigest: makePolicyDigest(), paymentDigest: makePaymentDigest(),
    });
    const result = store.claim({
      requestId: "req-003", nonce: "nonce-dup",
      receiver: "merchant@example.com", amountMinor: 200n,
      currency: "USD", purpose: "demo",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      policyDigest: makePolicyDigest(), paymentDigest: makePaymentDigest(),
    });
    expect(result).toHaveProperty("ok", false);
    if (hasReused(result)) expect(result.reused).toBe("nonce");
    store.close();
  });

  it("rejects duplicate requestId on claim", () => {
    const store = setupStore();
    store.claim({
      requestId: "req-004", nonce: "nonce-unique-4",
      receiver: "merchant@example.com", amountMinor: 100n,
      currency: "USD", purpose: "demo",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      policyDigest: makePolicyDigest(), paymentDigest: makePaymentDigest(),
    });
    const result = store.claim({
      requestId: "req-004", nonce: "nonce-unique-5",
      receiver: "merchant@example.com", amountMinor: 200n,
      currency: "USD", purpose: "demo",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      policyDigest: makePolicyDigest(), paymentDigest: makePaymentDigest(),
    });
    expect(result).toHaveProperty("ok", false);
    if (hasReused(result)) expect(result.reused).toBe("requestId");
    store.close();
  });

  it("permits valid lifecycle transitions stepwise", () => {
    const store = setupStore();
    const result = store.claim({
      requestId: "req-trans-001", nonce: "nonce-trans-001",
      receiver: "merchant@example.com", amountMinor: 100n,
      currency: "USD", purpose: "demo",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      policyDigest: makePolicyDigest(), paymentDigest: makePaymentDigest(),
    });
    expect(result.ok).toBe(true);
    let rec = store.transitionState("req-trans-001", "ORDER_CREATED" as const, "operator-001");
    expect(rec.state).toBe("ORDER_CREATED");
    rec = store.transitionState("req-trans-001", "APPROVED" as const, "operator-001");
    expect(rec.state).toBe("APPROVED");
    const binding: PayPalApprovalBinding = {
      paymentDigest: makePaymentDigest(),
      policyDigest: makePolicyDigest(),
      requestId: "req-trans-001",
      operatorId: "operator-001",
      verifiedAt: Math.floor(Date.now() / 1000),
    };
    rec = store.bindApproval("req-trans-001", binding);
    expect(rec.approvalBinding).not.toBeNull();
    rec = store.transitionState("req-trans-001", "CAPTURING" as const, "operator-001");
    expect(rec.state).toBe("CAPTURING");
    rec = store.verifyCompletion("req-trans-001", "cap-001", 100n, "USD" as const, "operator-001", "merchant@example.com");
    expect(rec.state).toBe("CAPTURED");
    expect(rec.captureId).toBe("cap-001");
    store.close();
  });

  it("rejects invalid direct lifecycle transitions", () => {
    const store = setupStore();
    const result = store.claim({
      requestId: "req-invalid-001", nonce: "nonce-invalid-001",
      receiver: "merchant@example.com", amountMinor: 100n,
      currency: "USD", purpose: "demo",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      policyDigest: makePolicyDigest(), paymentDigest: makePaymentDigest(),
    });
    expect(result.ok).toBe(true);
    const canSkip = store.validateTransition("RESERVED", "CAPTURING");
    expect(canSkip).toBe(false);
    const canSkip2 = store.validateTransition("RESERVED", "APPROVED");
    expect(canSkip2).toBe(false);
    store.close();
  });

  it("records uncertain capture outcome as UNKNOWN stepwise", () => {
    const store = setupStore();
    const result = store.claim({
      requestId: "req-uncertain-001", nonce: "nonce-uncertain-001",
      receiver: "merchant@example.com", amountMinor: 100n,
      currency: "USD", purpose: "demo",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      policyDigest: makePolicyDigest(), paymentDigest: makePaymentDigest(),
    });
    expect(result.ok).toBe(true);
    let rec = store.transitionState("req-uncertain-001", "ORDER_CREATED" as const, "operator-001");
    expect(rec.state).toBe("ORDER_CREATED");
    rec = store.transitionState("req-uncertain-001", "APPROVED" as const, "operator-001");
    expect(rec.state).toBe("APPROVED");
    rec = store.transitionState("req-uncertain-001", "CAPTURING" as const, "operator-001");
    expect(rec.state).toBe("CAPTURING");
    rec = store.recordUnknown("req-uncertain-001", "operator-001");
    expect(rec.state).toBe("UNKNOWN");
    const cannotReturn = store.validateTransition("UNKNOWN", "RESERVED");
    expect(cannotReturn).toBe(false);
    rec = store.transitionState("req-uncertain-001", "FAILED" as const, "operator-001");
    expect(rec.state).toBe("FAILED");
    store.close();
  });

  it("persists state across store close and reopen", () => {
    const store1 = setupStore();
    const result = store1.claim({
      requestId: "req-persist-001", nonce: "nonce-persist-001",
      receiver: "merchant@example.com", amountMinor: 100n,
      currency: "USD", purpose: "demo",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      policyDigest: makePolicyDigest(), paymentDigest: makePaymentDigest(),
    });
    expect(result.ok).toBe(true);
    let rec = store1.transitionState("req-persist-001", "ORDER_CREATED" as const, "operator-001");
    const binding: PayPalApprovalBinding = {
      paymentDigest: makePaymentDigest(),
      policyDigest: makePolicyDigest(),
      requestId: "req-persist-001",
      operatorId: "operator-001",
      verifiedAt: Math.floor(Date.now() / 1000),
    };
    rec = store1.bindApproval("req-persist-001", binding);
    expect(rec.approvalBinding).not.toBeNull();
    rec = store1.transitionState("req-persist-001", "APPROVED" as const, "operator-001");
    expect(rec.state).toBe("APPROVED");
    rec = store1.transitionState("req-persist-001", "CAPTURING" as const, "operator-001");
    expect(rec.state).toBe("CAPTURING");
    rec = store1.verifyCompletion("req-persist-001", "cap-persist-001", 100n, "USD" as const, "operator-001", "merchant@example.com");
    store1.close();
    const store2 = setupStore();
    const rec2 = store2.getRecord("req-persist-001");
    expect(rec2).not.toBeNull();
    expect(rec2!.state).toBe("CAPTURED");
    expect(rec2!.lastOperator).toBe("operator-001");
    store2.close();
  });

  it("enforces replay prevention across store instances", () => {
    const store1 = setupStore();
    const result1 = store1.claim({
      requestId: "req-replay-001", nonce: "nonce-replay-001",
      receiver: "merchant@example.com", amountMinor: 100n,
      currency: "USD", purpose: "demo",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      policyDigest: makePolicyDigest(), paymentDigest: makePaymentDigest(),
    });
    expect(result1.ok).toBe(true);
    const store2 = setupStore();
    const result2 = store2.claim({
      requestId: "req-replay-002", nonce: "nonce-replay-001",
      receiver: "merchant@example.com", amountMinor: 100n,
      currency: "USD", purpose: "demo",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      policyDigest: makePolicyDigest(), paymentDigest: makePaymentDigest(),
    });
    expect(result2.ok).toBe(false);
    if (hasReused(result2)) expect(result2.reused).toBe("nonce");
    store1.close();
    store2.close();
  });

  it("allows full lifecycle from RESERVED to CAPTURED stepwise via verifyCompletion", () => {
    const store = setupStore();
    const result = store.claim({
      requestId: "req-full-001", nonce: "nonce-full-001",
      receiver: "merchant@example.com", amountMinor: 100n,
      currency: "USD", purpose: "demo",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      policyDigest: makePolicyDigest(), paymentDigest: makePaymentDigest(),
    });
    expect(result.ok).toBe(true);
    let rec = store.transitionState("req-full-001", "ORDER_CREATED" as const, "operator-001");
    expect(rec.state).toBe("ORDER_CREATED");
    rec = store.transitionState("req-full-001", "APPROVED" as const, "operator-001");
    expect(rec.state).toBe("APPROVED");
    const binding: PayPalApprovalBinding = {
      paymentDigest: makePaymentDigest(),
      policyDigest: makePolicyDigest(),
      requestId: "req-full-001",
      operatorId: "operator-001",
      verifiedAt: Math.floor(Date.now() / 1000),
    };
    rec = store.bindApproval("req-full-001", binding);
    expect(rec.approvalBinding).not.toBeNull();
    rec = store.transitionState("req-full-001", "CAPTURING" as const, "operator-001");
    expect(rec.state).toBe("CAPTURING");
    rec = store.verifyCompletion("req-full-001", "cap-full-001", 100n, "USD" as const, "operator-001", "merchant@example.com");
    expect(rec.state).toBe("CAPTURED");
    expect(rec.captureId).toBe("cap-full-001");
    store.close();
  });

  it("rejects transition from FAILED state", () => {
    const store = setupStore();
    const result = store.claim({
      requestId: "req-failed-001", nonce: "nonce-failed-001",
      receiver: "merchant@example.com", amountMinor: 100n,
      currency: "USD", purpose: "demo",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      policyDigest: makePolicyDigest(), paymentDigest: makePaymentDigest(),
    });
    expect(result.ok).toBe(true);
    const canTrans = store.validateTransition("FAILED", "CAPTURED");
    expect(canTrans).toBe(false);
    store.close();
  });

  it("allows STALE → RESERVED transition for recovery", () => {
    const store = setupStore();
    const canTrans = store.validateTransition("STALE", "RESERVED");
    expect(canTrans).toBe(true);
    store.close();
  });
});