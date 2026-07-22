import { describe, expect, it } from "vitest";
import { CapabilityStore } from "./capability-store.js";
import { BrokerError } from "./errors.js";
import type { Clock } from "./types.js";

describe("CapabilityStore", () => {
  it("stores only a digest and enforces single use", () => {
    const clock = mutableClock();
    const store = new CapabilityStore(clock, 10_000);
    const issued = store.issue(baseClaims());

    expect(issued.capability).toMatch(/^rb1\.[A-Za-z0-9_-]{43}$/);
    expect(store.consume(issued.capability, baseClaims().requestId, "sha256:client").expectedHeadSha)
      .toBe(baseClaims().expectedHeadSha);
    expect(() => store.consume(issued.capability, baseClaims().requestId, "sha256:client"))
      .toThrowError(expect.objectContaining({ code: "capability_replayed" }));
  });

  it("denies expired and identity-mismatched capabilities after consuming them", () => {
    const clock = mutableClock();
    const store = new CapabilityStore(clock, 1_000);
    const expired = store.issue(baseClaims());
    clock.value = 1_000;
    expect(() => store.consume(expired.capability, baseClaims().requestId, "sha256:client"))
      .toThrowError(expect.objectContaining({ code: "capability_expired" }));

    clock.value = 2_000;
    const mismatch = store.issue({
      ...baseClaims(),
      mrIid: 43,
      requestId: "22222222-2222-4222-8222-222222222222",
    });
    expect(() => store.consume(mismatch.capability, mismatch.claims.requestId, "sha256:other"))
      .toThrowError(expect.objectContaining({ code: "capability_invalid" }));
    expect(() => store.consume(mismatch.capability, mismatch.claims.requestId, "sha256:client"))
      .toThrowError(expect.objectContaining({ code: "capability_replayed" }));
  });

  it("rejects request id replay", () => {
    const store = new CapabilityStore(mutableClock(), 10_000);
    store.issue(baseClaims());
    expect(() => store.issue(baseClaims())).toThrowError(BrokerError);
  });

  it("reserves one capability per company, issue, MR and head SHA", () => {
    const store = new CapabilityStore(mutableClock(), 10_000);
    store.issue(baseClaims());
    expect(() => store.issue({
      ...baseClaims(),
      requestId: "22222222-2222-4222-8222-222222222222",
    })).toThrowError(expect.objectContaining({ code: "request_replayed" }));
  });
});

function baseClaims() {
  return {
    issueId: "11111111-1111-4111-8111-111111111111",
    mrIid: 42,
    expectedHeadSha: "a".repeat(40),
    requestId: "11111111-1111-4111-8111-111111111112",
    clientIdentity: "sha256:client",
    companyId: "11111111-1111-4111-8111-111111111113",
    gitlabProjectId: 92,
    targetBranch: "main" as const,
    generation: 7,
  };
}

function mutableClock(): Clock & { value: number } {
  return { value: 0, now() { return this.value; } };
}
