import Database from "better-sqlite3";
import type {
  PayPalAuditEvent,
  PayPalAuditEventType,
  PayPalAuditInput,
  PayPalClaimResult,
  PayPalClaimCollision,
  PayPalLifecycleState,
  PayPalPaymentRecord,
  PayPalApprovalBinding,
} from "../types.js";
import { isWellFormedPayPalReceiver, normalizePayPalReceiver } from "../validation.js";
import { PayPalCurrency } from "../types.js";

const BUSY_TIMEOUT_MS = 5000;

function isCAPTUREDState(to: string): to is "CAPTURED" {
  return to === "CAPTURED";
}

export function createPayPalStore(path: string) {
  if (typeof path !== "string" || path.length === 0) throw new Error("paypal store path must be non-empty");
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = " + BUSY_TIMEOUT_MS);
    db.exec("CREATE TABLE IF NOT EXISTS paypal_payments (request_id TEXT PRIMARY KEY, nonce TEXT NOT NULL, receiver TEXT NOT NULL, amount_minor TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', purpose TEXT NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RESERVED', policy_digest TEXT NOT NULL, payment_digest TEXT NOT NULL, approval_digest TEXT, last_operator TEXT NOT NULL, last_transitioned_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), capture_id TEXT, provider_order_id TEXT, CONSTRAINT uq_paypal_nonce UNIQUE (nonce))");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_paypal_capture_id ON paypal_payments(capture_id) WHERE capture_id IS NOT NULL");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_paypal_provider_order_id ON paypal_payments(provider_order_id) WHERE provider_order_id IS NOT NULL");
    db.exec("CREATE TABLE IF NOT EXISTS paypal_audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, event_type TEXT NOT NULL, state TEXT NOT NULL, message TEXT NOT NULL, code TEXT, operator_id TEXT, provider_order_id TEXT, capture_id TEXT, created_at INTEGER NOT NULL)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_paypal_audit_request ON paypal_audit_events(request_id, id)");
  } catch (err) {
    db.close();
    throw new Error("cannot init paypal db: " + (err as Error).message);
  }

  const transMap: Record<string, string[]> = {
    RESERVED: ["ORDER_CREATED"], ORDER_CREATED: ["APPROVED", "FAILED", "VOIDED"],
    APPROVED: ["CAPTURING", "FAILED", "VOIDED"], CAPTURING: ["CAPTURED", "UNKNOWN", "FAILED", "VOIDED"],
    CAPTURED: [], UNKNOWN: ["FAILED"], FAILED: [], VOIDED: [], STALE: ["RESERVED"],
  };
  function vt(from: string, to: string): boolean {
    const allowed = transMap[from];
    return allowed !== undefined && allowed.includes(to);
  }

  function errorMsg(err: Error): string { return "error: " + err.message; }

  function auditText(value: string, max: number): string {
    return value.replace(/[\u0000\r\n]/g, " ").slice(0, max);
  }

  function insertAudit(requestId: string, input: PayPalAuditInput, at?: number): void {
    const createdAt = at ?? Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO paypal_audit_events (request_id, event_type, state, message, code, operator_id, provider_order_id, capture_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
      requestId,
      input.eventType,
      input.state,
      auditText(input.message, 500),
      input.code === undefined ? null : auditText(input.code, 80),
      input.operatorId === undefined ? null : auditText(input.operatorId, 128),
      input.providerOrderId === undefined ? null : auditText(input.providerOrderId, 256),
      input.captureId === undefined ? null : auditText(input.captureId, 256),
      createdAt,
    );
  }

  const stateAuditType: Record<PayPalLifecycleState, PayPalAuditEventType> = {
    RESERVED: "PAYMENT_RESERVED",
    ORDER_CREATED: "PAYPAL_ORDER_CREATED",
    APPROVED: "STATE_CHANGED",
    CAPTURING: "CAPTURE_INITIATED",
    CAPTURED: "CAPTURE_VERIFIED",
    UNKNOWN: "CAPTURE_UNKNOWN",
    FAILED: "PAYMENT_FAILED",
    VOIDED: "PAYMENT_VOIDED",
    STALE: "STATE_CHANGED",
  };

  function rowToRec(row: any): PayPalPaymentRecord {
    let binding: PayPalApprovalBinding | null = null;
    if (row.approval_digest) {
      const parts = String(row.approval_digest).split("|");
      binding = {
        paymentDigest: parts[1] ?? "",
        policyDigest: parts[2] ?? "",
        requestId: parts[3] ?? String(row.request_id),
        operatorId: parts[4] ?? String(row.last_operator),
        verifiedAt: Number(parts[5] ?? row.last_transitioned_at),
      };
    }
    return {
      requestId: String(row.request_id), receiver: String(row.receiver),
      amountMinor: BigInt(row.amount_minor), currency: String(row.currency),
      purpose: String(row.purpose), nonce: String(row.nonce), expiresAt: Number(row.expires_at),
      state: row.state as PayPalLifecycleState, policyDigest: String(row.policy_digest),
      paymentDigest: String(row.payment_digest), approvalBinding: binding,
      lastOperator: String(row.last_operator), lastTransitionedAt: Number(row.last_transitioned_at),
      createdAt: Number(row.created_at),
      captureId: row.capture_id != null ? String(row.capture_id) : null,
      providerOrderId: row.provider_order_id != null ? String(row.provider_order_id) : null,
    } as PayPalPaymentRecord;
  }

  const claim = function(entry: any): PayPalClaimResult | PayPalClaimCollision {
    try {
      const nRow = db.prepare("SELECT request_id FROM paypal_payments WHERE nonce = ?").get(entry.nonce);
      const rRow = db.prepare("SELECT nonce FROM paypal_payments WHERE request_id = ?").get(entry.requestId);
      const nc = nRow !== undefined;
      const rc = rRow !== undefined;
      if (nc || rc) {
        const reused = nc ? "nonce" : "requestId";
        return { ok: false, reused };
      }
      const now = Math.floor(Date.now() / 1000);
      const canon = normalizePayPalReceiver(entry.receiver);
      if (canon === null) {
        return { ok: false, reused: "requestId" };
      }
      const amtStr = entry.amountMinor.toString();
      db.prepare("INSERT INTO paypal_payments (request_id, nonce, receiver, amount_minor, currency, purpose, expires_at, state, policy_digest, payment_digest, last_operator, last_transitioned_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        entry.requestId, entry.nonce, canon, amtStr,
        entry.currency, entry.purpose, entry.expiresAt, "RESERVED",
        entry.policyDigest, entry.paymentDigest, entry.requestId, now, now
      );
      insertAudit(entry.requestId, {
        eventType: "PAYMENT_INTENT_CREATED",
        state: "RESERVED",
        message: "Payment intent created from the validated request.",
        code: "INTENT_CREATED",
        operatorId: entry.requestId,
      }, now);
      insertAudit(entry.requestId, {
        eventType: "POLICY_EVALUATED",
        state: "RESERVED",
        message: "Deterministic spending policy allowed the request before reservation.",
        code: "POLICY_ALLOWED",
        operatorId: entry.requestId,
      }, now);
      insertAudit(entry.requestId, {
        eventType: "PAYMENT_RESERVED",
        state: "RESERVED",
        message: "Payment identifiers reserved for a later provider order.",
        code: "PAYMENT_RESERVED",
        operatorId: entry.requestId,
      }, now);
      return { ok: true, record: {
        requestId: entry.requestId, receiver: canon,
        amountMinor: entry.amountMinor, currency: entry.currency,
        purpose: entry.purpose, nonce: entry.nonce, expiresAt: entry.expiresAt,
        state: "RESERVED", policyDigest: entry.policyDigest,
        paymentDigest: entry.paymentDigest, approvalBinding: null,
        lastOperator: entry.requestId, lastTransitionedAt: now,
        createdAt: now,
        captureId: null, providerOrderId: null,
      } };
    } catch (e: any) {
      throw new Error("claim failed: " + e.message);
    }
  };

  const getRecord = function(rid: string): PayPalPaymentRecord | null {
    const row = db.prepare("SELECT request_id, receiver, amount_minor, currency, purpose, nonce, expires_at, state, policy_digest, payment_digest, approval_digest, last_operator, last_transitioned_at, created_at, capture_id, provider_order_id FROM paypal_payments WHERE request_id = ?").get(rid);
    if (!row) return null;
    return rowToRec(row) as PayPalPaymentRecord;
  };

  const validateTransition = function(from: string, to: string): boolean {
    return vt(from, to);
  };

  const transitionState = function(rid: string, to: string, opId: string): PayPalPaymentRecord {
    const rec = getRecord(rid);
    if (!rec) throw new Error("no such requestId " + rid);
    if (!validateTransition(rec.state, to)) throw new Error("invalid transition " + rec.state + "→" + to);
    if (to === "CAPTURED") throw new Error("use verifyCompletion to transition to CAPTURED; ordinary state-update cannot manufacture verified evidence");
    const now = Math.floor(Date.now() / 1000);
    const createdAt = rec.createdAt;
    db.prepare("UPDATE paypal_payments SET state=?, last_operator=?, last_transitioned_at=? WHERE request_id=?").run(to, opId, now, rid);
    insertAudit(rid, {
      eventType: stateAuditType[to as PayPalLifecycleState],
      state: to as PayPalLifecycleState,
      message: `Payment state changed from ${rec.state} to ${to}.`,
      code: to,
      operatorId: opId,
      providerOrderId: rec.providerOrderId ?? undefined,
      captureId: rec.captureId ?? undefined,
    }, now);
    return {
      requestId: rec.requestId, receiver: rec.receiver,
      amountMinor: BigInt(rec.amountMinor), currency: rec.currency,
      purpose: rec.purpose, nonce: rec.nonce, expiresAt: rec.expiresAt,
      state: to as PayPalLifecycleState, policyDigest: rec.policyDigest,
      paymentDigest: rec.paymentDigest, approvalBinding: rec.approvalBinding,
      lastOperator: opId, lastTransitionedAt: now,
      createdAt: createdAt,
      captureId: rec.captureId,
      providerOrderId: rec.providerOrderId,
    };
  };

  function getRec(rid: string): PayPalPaymentRecord | null {
    const row = db.prepare("SELECT request_id, receiver, amount_minor, currency, purpose, nonce, expires_at, state, policy_digest, payment_digest, approval_digest, last_operator, last_transitioned_at, created_at, capture_id, provider_order_id FROM paypal_payments WHERE request_id = ?").get(rid);
    if (!row) return null;
    return rowToRec(row) as PayPalPaymentRecord | null;
  }

  const verifyCompletion = function(rid: string, captureId: string, expectedAmountMinor: bigint, expectedCurrency: PayPalCurrency, opId: string, receiver: string): PayPalPaymentRecord {
    const rec = getRec(rid);
    if (!rec) throw new Error("no such requestId " + rid);
    if (rec.state !== "CAPTURING") throw new Error("payment must be in CAPTURING state for completion verification");
    if (rec.amountMinor !== expectedAmountMinor) throw new Error("capture amount mismatch: expected " + expectedAmountMinor + ", got " + rec.amountMinor);
    if (rec.currency !== expectedCurrency) throw new Error("capture currency mismatch: expected " + expectedCurrency + ", got " + rec.currency);
    if (!isWellFormedPayPalReceiver(receiver)) throw new Error("capture receiver is not a valid PayPal receiver");
    if (rec.receiver !== normalizePayPalReceiver(receiver)) throw new Error("capture receiver mismatch: expected " + rec.receiver + ", got " + receiver);
    // Recompute and verify payment-intent digest: approval must bind to the exact request ID, payment digest and policy digest.
    if (!rec.approvalBinding) throw new Error("payment must have a bound approval before capture");
    if (rec.approvalBinding.paymentDigest !== rec.paymentDigest) throw new Error("approval binding does not bind to the current payment-intent digest");
    if (rec.approvalBinding.policyDigest !== rec.policyDigest) throw new Error("approval binding does not bind to the current policy digest");
    if (rec.approvalBinding.requestId !== rec.requestId) throw new Error("approval binding does not bind to the exact request ID");
    // Reject expired or modified payment intents.
    const now = Math.floor(Date.now() / 1000);
    if (now >= rec.expiresAt) throw new Error("capture of expired payment denied");
    db.prepare("UPDATE paypal_payments SET state=?, capture_id=?, last_operator=?, last_transitioned_at=? WHERE request_id=?").run("CAPTURED", captureId, opId, now, rid);
    insertAudit(rid, {
      eventType: "CAPTURE_VERIFIED",
      state: "CAPTURED",
      message: "PayPal capture evidence verified and recorded.",
      code: "CAPTURE_VERIFIED",
      operatorId: opId,
      providerOrderId: rec.providerOrderId ?? undefined,
      captureId,
    }, now);
    return {
      requestId: rec.requestId, receiver: rec.receiver,
      amountMinor: BigInt(rec.amountMinor), currency: rec.currency,
      purpose: rec.purpose, nonce: rec.nonce, expiresAt: rec.expiresAt,
      state: "CAPTURED", policyDigest: rec.policyDigest,
      paymentDigest: rec.paymentDigest, approvalBinding: rec.approvalBinding,
      lastOperator: opId, lastTransitionedAt: now,
      createdAt: rec.createdAt,
      captureId: captureId,
      providerOrderId: rec.providerOrderId,
    };
  };

  const recordFailure = function(rid: string, failureDetails: string, opId: string): PayPalPaymentRecord {
    const rec = getRec(rid);
    if (!rec) throw new Error("no such requestId " + rid);
    if (rec.state === "CAPTURED" || rec.state === "UNKNOWN" || rec.state === "FAILED" || rec.state === "VOIDED") {
      throw new Error("terminal payment state cannot be overwritten as FAILED");
    }
    const now = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE paypal_payments SET state=?, last_operator=?, last_transitioned_at=? WHERE request_id=?").run("FAILED", opId, now, rid);
    insertAudit(rid, {
      eventType: "PAYMENT_FAILED",
      state: "FAILED",
      message: failureDetails,
      code: "PAYMENT_FAILED",
      operatorId: opId,
      providerOrderId: rec.providerOrderId ?? undefined,
      captureId: rec.captureId ?? undefined,
    }, now);
    return {
      requestId: rec.requestId, receiver: rec.receiver,
      amountMinor: BigInt(rec.amountMinor), currency: rec.currency,
      purpose: rec.purpose, nonce: rec.nonce, expiresAt: rec.expiresAt,
      state: "FAILED", policyDigest: rec.policyDigest,
      paymentDigest: rec.paymentDigest, approvalBinding: rec.approvalBinding,
      lastOperator: rec.lastOperator, lastTransitionedAt: now,
      createdAt: rec.createdAt,
      captureId: rec.captureId,
      providerOrderId: rec.providerOrderId,
    };
  };

  const recordUnknown = function(rid: string, opId: string): PayPalPaymentRecord {
    const rec = getRec(rid);
    if (!rec) throw new Error("no such requestId " + rid);
    const now = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE paypal_payments SET state=?, last_operator=?, last_transitioned_at=? WHERE request_id=?").run("UNKNOWN", opId, now, rid);
    insertAudit(rid, {
      eventType: "CAPTURE_UNKNOWN",
      state: "UNKNOWN",
      message: "Capture outcome is unknown; automatic retry is disabled pending reconciliation.",
      code: "CAPTURE_UNKNOWN",
      operatorId: opId,
      providerOrderId: rec.providerOrderId ?? undefined,
      captureId: rec.captureId ?? undefined,
    }, now);
    return {
      requestId: rec.requestId, receiver: rec.receiver,
      amountMinor: BigInt(rec.amountMinor), currency: rec.currency,
      purpose: rec.purpose, nonce: rec.nonce, expiresAt: rec.expiresAt,
      state: "UNKNOWN", policyDigest: rec.policyDigest,
      paymentDigest: rec.paymentDigest, approvalBinding: rec.approvalBinding,
      lastOperator: rec.lastOperator, lastTransitionedAt: now,
      createdAt: rec.createdAt,
      captureId: rec.captureId,
      providerOrderId: rec.providerOrderId,
    };
  };

  const bindApproval = function(rid: string, binding: PayPalApprovalBinding): PayPalPaymentRecord {
    const rec = getRecord(rid);
    if (!rec) throw new Error("no such requestId " + rid);
    const ad = "paypal-approval-v1|" + binding.paymentDigest + "|" + binding.policyDigest + "|" + binding.requestId + "|" + binding.operatorId + "|" + String(binding.verifiedAt);
    db.prepare("UPDATE paypal_payments SET approval_digest=? WHERE request_id=?").run(ad, rid);
    insertAudit(rid, {
      eventType: "OPERATOR_APPROVAL_RECORDED",
      state: rec.state,
      message: "Operator approval bound to the payment and policy digests.",
      code: "OPERATOR_APPROVED",
      operatorId: binding.operatorId,
      providerOrderId: rec.providerOrderId ?? undefined,
    }, binding.verifiedAt);
    return {
      requestId: rec.requestId, receiver: rec.receiver,
      amountMinor: BigInt(rec.amountMinor), currency: rec.currency,
      purpose: rec.purpose, nonce: rec.nonce, expiresAt: rec.expiresAt,
      state: rec.state, policyDigest: rec.policyDigest,
      paymentDigest: rec.paymentDigest, approvalBinding: binding,
      lastOperator: rec.lastOperator, lastTransitionedAt: rec.lastTransitionedAt,
      createdAt: rec.createdAt,
      captureId: rec.captureId,
    } as PayPalPaymentRecord;
  };

  const getRecordByProviderOrderId = function(orderId: string): PayPalPaymentRecord | null {
    if (typeof orderId !== "string" || orderId.length === 0) return null;
    const row = db.prepare("SELECT request_id, receiver, amount_minor, currency, purpose, nonce, expires_at, state, policy_digest, payment_digest, approval_digest, last_operator, last_transitioned_at, created_at, capture_id, provider_order_id FROM paypal_payments WHERE provider_order_id = ?").get(orderId);
    if (!row) return null;
    return rowToRec(row) as PayPalPaymentRecord;
  };

  /**
   * Binds a provider order ID to a reserved payment and advances
   * RESERVED → ORDER_CREATED atomically. A provider order can belong to at
   * most one payment record (unique partial index).
   */
  const attachProviderOrder = function(rid: string, orderId: string, opId: string): PayPalPaymentRecord {
    const rec = getRecord(rid);
    if (!rec) throw new Error("no such requestId " + rid);
    if (typeof orderId !== "string" || orderId.length === 0 || orderId.length > 256) throw new Error("invalid provider order id");
    if (rec.providerOrderId === orderId && rec.state === "ORDER_CREATED") return rec;
    if (rec.state !== "RESERVED") throw new Error("provider order can only be attached to a RESERVED payment");
    const now = Math.floor(Date.now() / 1000);
    const info = db.prepare("UPDATE paypal_payments SET provider_order_id=?, state='ORDER_CREATED', last_operator=?, last_transitioned_at=? WHERE request_id=? AND state='RESERVED'").run(orderId, opId, now, rid);
    if (info.changes !== 1) throw new Error("provider order binding lost a race");
    insertAudit(rid, {
      eventType: "PAYPAL_ORDER_CREATED",
      state: "ORDER_CREATED",
      message: "PayPal order created and bound to the reserved payment.",
      code: "PAYPAL_ORDER_CREATED",
      operatorId: opId,
      providerOrderId: orderId,
    }, now);
    const updated = getRecord(rid);
    if (!updated) throw new Error("provider order binding vanished");
    return updated;
  };

  const recordAudit = function(rid: string, input: PayPalAuditInput): void {
    const rec = getRec(rid);
    if (!rec) throw new Error("no such requestId " + rid);
    insertAudit(rid, input);
  };

  const getAuditTrail = function(rid: string): PayPalAuditEvent[] {
    const rows = db.prepare("SELECT id, request_id, event_type, state, message, code, operator_id, provider_order_id, capture_id, created_at FROM paypal_audit_events WHERE request_id = ? ORDER BY id ASC").all(rid);
    return (rows as any[]).map((row) => ({
      id: Number(row.id),
      requestId: String(row.request_id),
      eventType: String(row.event_type) as PayPalAuditEventType,
      state: String(row.state) as PayPalLifecycleState,
      message: String(row.message),
      code: row.code == null ? null : String(row.code),
      operatorId: row.operator_id == null ? null : String(row.operator_id),
      providerOrderId: row.provider_order_id == null ? null : String(row.provider_order_id),
      captureId: row.capture_id == null ? null : String(row.capture_id),
      createdAt: Number(row.created_at),
    }));
  };

  const close = function(): void { db.close(); };

  return { claim, getRecord, getRecordByProviderOrderId, validateTransition, transitionState, verifyCompletion, recordFailure, recordUnknown, bindApproval, attachProviderOrder, recordAudit, getAuditTrail, close };
}

export type PayPalStore = ReturnType<typeof createPayPalStore>;
