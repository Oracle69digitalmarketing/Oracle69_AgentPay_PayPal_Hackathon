import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "..", "server", "public", "index.html"), "utf8");

function functionBlock(name: string, nextName: string): string {
  const start = html.indexOf("function " + name);
  const end = html.indexOf("function " + nextName, start);
  expect(start, name + " must exist").toBeGreaterThanOrEqual(0);
  expect(end, nextName + " must follow " + name).toBeGreaterThan(start);
  return html.slice(start, end);
}

function loadFunctionBlock(
  name: string,
  nextName: string,
  exportedName: string = name,
): (...args: unknown[]) => unknown {
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(functionBlock(name, nextName), sandbox);
  const fn = sandbox[exportedName];
  expect(typeof fn).toBe("function");
  return fn as (...args: unknown[]) => unknown;
}

describe("frontend capture and health regressions", () => {
  it("fails closed when health is unknown and distinguishes auth unavailability", () => {
    const authReady = functionBlock("authReady", "renderTokenStatus");
    expect(authReady).toContain('if (!state.health || state.healthError) return false;');
    expect(html).toContain("Authentication status unavailable");
    expect(html).toContain("state.healthError = true");
    expect(html).toContain("if (!state.health || state.healthError)");
  });

  it("treats network, timeout, and ambiguous capture responses as uncertain and non-retryable", () => {
    const capture = functionBlock("handleCapture", "handleRefreshCurrent");
    expect(capture).toContain("timeoutMs: 30_000");
    expect(capture).toContain("captureResponseIsUncertain(result.status, data)");
    expect(capture).toContain("markCaptureUncertain(");
    expect(capture).toContain("capture outcome is uncertain");
    expect(capture).toContain("Do not retry");
    expect(html).toContain("Capture outcome uncertain");
    expect(capture.match(/api\("\/api\/paypal\/capture"/g)?.length).toBe(1);
    expect(html).toContain("state.captureUncertain === true");
  });

  it("handles duplicate CAPTURED as an informative state and refreshes status", () => {
    const capture = functionBlock("handleCapture", "handleRefreshCurrent");
    expect(capture).toContain('result.status === 409 && data.state === "CAPTURED" && data.duplicate === true');
    expect(capture).toContain("state.captureAlreadyCaptured = true");
    expect(capture).toContain("Already captured — verified by the provider.");
    expect(capture).toContain('api("/api/paypal/payment/" + encodeURIComponent(id))');
    expect(html).toContain("state.captureAlreadyCaptured");
  });

  it("requires state CAPTURED plus verified provider evidence before success", () => {
    expect(html).toContain('return Boolean(record && record.state === "CAPTURED" && record.verified === true);');
    const capture = functionBlock("handleCapture", "handleRefreshCurrent");
    const guard = capture.indexOf("if (!isVerifiedCapture(data))");
    const successToast = capture.indexOf("toast(data.simulated ?");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(successToast).toBeGreaterThan(guard);
    expect(html).toContain("CAPTURED reported without verified provider evidence.");
  });

  it("keeps modal focus and mobile drawer accessibility safeguards", () => {
    expect(html).toContain("[els.app, els.mobileNav].forEach");
    expect(html).toContain('node.setAttribute("inert", "")');
    expect(html).toContain('node.removeAttribute("inert")');
    expect(html).toContain('event.key !== "Tab"');
    expect(html).toContain('els.sidebar.setAttribute("inert", "")');
    expect(html).toContain('els.sidebarToggle.setAttribute("aria-expanded", "false")');
    expect(html).toContain('aria-controls="sidebar"');
    expect(html).toContain('<dl class="detail-grid"');
    expect(html).not.toContain('<div class="detail-grid"');
  });

  it("uses captureResponseIsUncertain for generic HTTP 500 responses", () => {
    expect(html).toContain("captureResponseIsUncertain(result.status, data)");
  });

  it("treats generic HTTP 500 without state as uncertain", () => {
    const fn = loadFunctionBlock("isTerminalNonCaptureState", "captureButtonDisabled", "captureResponseIsUncertain");
    expect(fn(500, {error: "internal error"})).toBe(true);
  });

  it("treats HTTP 408 and 429 as uncertain even without state", () => {
    const fn = loadFunctionBlock("isTerminalNonCaptureState", "captureButtonDisabled", "captureResponseIsUncertain");
    expect(fn(408, {})).toBe(true);
    expect(fn(429, {})).toBe(true);
  });

  it("treats terminal non-capture 5xx (FAILED/VOIDED/STALE) as definite failure, not uncertain", () => {
    const fn = loadFunctionBlock("isTerminalNonCaptureState", "captureButtonDisabled", "captureResponseIsUncertain");
    expect(fn(500, {state: "FAILED"})).toBe(false);
    expect(fn(502, {state: "VOIDED"})).toBe(false);
    expect(fn(503, {state: "STALE"})).toBe(false);
  });

  it("treats verified CAPTURED as not uncertain", () => {
    const fn = loadFunctionBlock("isTerminalNonCaptureState", "captureButtonDisabled", "captureResponseIsUncertain");
    expect(fn(200, {state: "CAPTURED", verified: true})).toBe(false);
  });

  it("keeps capture button disabled while uncertainty remains after ambiguous capture refresh", () => {
    const fn = loadFunctionBlock("captureButtonDisabled", "updateActionStates");
    const record = {requestId: "x", orderId: "o", state: "APPROVED", receiver: "--", amountMinor: 0, currency: "USD", verifier: false, approvalVerifiedAt: "2026-01-01T00:00:00Z", captureVerifiedAt: "2026-01-01T00:00:00Z", explanation: "no reason", providerMode: "mock", simulated: false};
    expect(fn(false, record, false, true)).toBe(true);
    expect(fn(true, record, true, false)).toBe(false);
    expect(fn(true, record, true, true)).toBe(true);
  });

  it("does not silently clear capture uncertainty on a normal status refresh", () => {
    const refresh = functionBlock("refreshPayment", "renderAuditSelect");
    expect(refresh).toContain("A normal status refresh is not authoritative reconciliation.");
    expect(refresh).toContain("state.captureUncertain !== true");
    expect(refresh).not.toContain("state.captureUncertain = false;\n        state.captureUncertainMessage = \"\";\n        if (data.state !== \"CAPTURED\") state.captureAlreadyCaptured = false;");
  });

  it("requires verified CAPTURED before success styling", () => {
    const statusKind = functionBlock("statusKind", "statusLabel");
    expect(statusKind).toContain('case "CAPTURED":');
    expect(statusKind).toContain('return verified === true ? "success" : "warn";');
    const statusChip = functionBlock("statusChip", "providerKind");
    expect(statusChip).toContain("statusKind(value, verified === true)");
    const recordChip = functionBlock("recordStatusChip", "verificationKind");
    expect(recordChip).toContain("isVerifiedCapture(record)");
    const verification = functionBlock("verificationKind", "verificationChip");
    expect(verification).toContain('record.state === "CAPTURED") return "warn";');
  });

  it("marks flow capture completion only on verified CAPTURED and warns on unverified", () => {
    const flow = functionBlock("flowStageFor", "authUnavailableMessage");
    expect(flow).toContain("if (isVerifiedCapture(record)) stage = 4;");
    const renderFlow = functionBlock("renderFlow", "renderApprovalPanel");
    expect(renderFlow).toContain('node.classList.toggle("warn", step === 4 && unverifiedCapture);');
    expect(html).toContain(".step.warn .step-num { background: var(--amber-50); color: var(--amber-800); border-color: var(--amber-100); }");
  });
});

