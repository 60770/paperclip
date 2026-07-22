import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "./audit.js";
import { ReleaseBroker } from "./broker.js";
import { CapabilityStore } from "./capability-store.js";
import { BrokerError } from "./errors.js";
import type {
  AttestationEvidence,
  AuditEvent,
  AuditSink,
  CapabilityRequest,
  Clock,
  GitLabMerger,
  MergeResult,
} from "./types.js";

const CLIENT = `sha256:${"a".repeat(64)}`;
const OTHER_CLIENT = `sha256:${"b".repeat(64)}`;

describe("ReleaseBroker", () => {
  it("performs exactly one merge PUT on the happy path and audits without the capability", async () => {
    const fixture = createFixture();
    const issued = await fixture.broker.requestCapability(CLIENT, request());
    const result = await fixture.broker.merge(CLIENT, { capability: issued.capability, requestId: request().requestId });

    expect(result).toEqual({
      status: "merged",
      mergeCommitSha: "c".repeat(40),
      requestId: request().requestId,
    });
    expect(fixture.gitlab.mergeCalls).toBe(1);
    expect(fixture.audit.events.map((event) => event.event)).toEqual([
      "capability_issued",
      "capability_consumed",
      "merge_completed",
    ]);
    expect(JSON.stringify(fixture.audit.events)).not.toContain(issued.capability);

    await expect(fixture.broker.merge(CLIENT, { capability: issued.capability, requestId: request().requestId }))
      .rejects.toMatchObject({ code: "capability_replayed" });
    expect(fixture.gitlab.mergeCalls).toBe(1);
    expect(fixture.audit.events.at(-1)).toMatchObject({
      event: "merge_denied",
      reason: "capability_replayed",
    });
  });

  it.each([
    "human_gate_blocked",
    "main_lock_active",
    "sha_mismatch",
    "mr_not_ready",
    "paperclip_not_ready",
    "company_mismatch",
    "attestation_failed",
    "ambiguous_response",
    "upstream_failed",
  ] as const)("keeps merge PUT at zero when immediate preflight denies with %s", async (code) => {
    const fixture = createFixture({ immediateError: new BrokerError(code, 409) });
    const issued = await fixture.broker.requestCapability(CLIENT, request());
    await expect(fixture.broker.merge(CLIENT, { capability: issued.capability, requestId: request().requestId }))
      .rejects.toMatchObject({ code });
    expect(fixture.gitlab.mergeCalls).toBe(0);
  });

  it.each([
    "human_gate_blocked",
    "main_lock_active",
    "sha_mismatch",
    "mr_not_ready",
    "paperclip_not_ready",
    "company_mismatch",
    "attestation_failed",
    "ambiguous_response",
    "upstream_failed",
  ] as const)("keeps merge PUT at zero when capability issuance denies with %s", async (code) => {
    const fixture = createFixture({ authorizeError: new BrokerError(code, 409) });
    await expect(fixture.broker.requestCapability(CLIENT, request())).rejects.toMatchObject({ code });
    expect(fixture.gitlab.mergeCalls).toBe(0);
    expect(fixture.audit.events.at(-1)).toMatchObject({
      event: "capability_denied",
      reason: code,
    });
  });

  it("allows only one outstanding capability for the same merge tuple", async () => {
    const fixture = createFixture();
    const issued = await fixture.broker.requestCapability(CLIENT, request());
    await expect(fixture.broker.requestCapability(CLIENT, {
      ...request(),
      requestId: "33333333-3333-4333-8333-333333333333",
    })).rejects.toMatchObject({ code: "request_replayed" });

    await fixture.broker.merge(CLIENT, { capability: issued.capability, requestId: request().requestId });
    expect(fixture.gitlab.mergeCalls).toBe(1);
  });

  it("keeps merge PUT at zero for expiry, identity mismatch, request replay and audit failure", async () => {
    const expired = createFixture({ ttlMs: 1_000 });
    const expiredCapability = await expired.broker.requestCapability(CLIENT, request());
    expired.clock.value = 1_000;
    await expect(expired.broker.merge(CLIENT, {
      capability: expiredCapability.capability,
      requestId: request().requestId,
    })).rejects.toMatchObject({ code: "capability_expired" });
    expect(expired.gitlab.mergeCalls).toBe(0);
    expect((expired.audit as MemoryAuditSink).events.at(-1)).toMatchObject({ reason: "capability_expired" });

    const mismatch = createFixture();
    const mismatchedCapability = await mismatch.broker.requestCapability(CLIENT, request());
    await expect(mismatch.broker.merge(OTHER_CLIENT, {
      capability: mismatchedCapability.capability,
      requestId: request().requestId,
    })).rejects.toMatchObject({ code: "capability_invalid" });
    expect(mismatch.gitlab.mergeCalls).toBe(0);
    expect((mismatch.audit as MemoryAuditSink).events.at(-1)).toMatchObject({ reason: "capability_invalid" });

    const replay = createFixture();
    await replay.broker.requestCapability(CLIENT, request());
    await expect(replay.broker.requestCapability(CLIENT, request()))
      .rejects.toMatchObject({ code: "request_replayed" });
    expect(replay.gitlab.mergeCalls).toBe(0);
    expect((replay.audit as MemoryAuditSink).events.at(-1)).toMatchObject({ reason: "request_replayed" });

    const failingAudit = createFixture({ audit: new FailOnWriteAuditSink(2) });
    const capability = await failingAudit.broker.requestCapability(CLIENT, request());
    await expect(failingAudit.broker.merge(CLIENT, {
      capability: capability.capability,
      requestId: request().requestId,
    })).rejects.toMatchObject({ code: "audit_failed" });
    expect(failingAudit.gitlab.mergeCalls).toBe(0);

    const failingIssueAudit = createFixture({ audit: new FailOnWriteAuditSink(1) });
    await expect(failingIssueAudit.broker.requestCapability(CLIENT, request()))
      .rejects.toMatchObject({ code: "audit_failed" });
    expect(failingIssueAudit.gitlab.mergeCalls).toBe(0);
  });

  it("audits transport and client-allowlist denials without recording request payloads", async () => {
    const fixture = createFixture();
    await expect(fixture.broker.requestCapability(`sha256:${"f".repeat(64)}`, request()))
      .rejects.toMatchObject({ code: "client_denied" });
    await fixture.broker.auditBoundaryDenial("unverified", "33333333-3333-4333-8333-333333333333", "invalid_request");
    expect(fixture.audit.events.map((event) => [event.event, event.reason])).toEqual([
      ["capability_denied", "client_denied"],
      ["request_denied", "invalid_request"],
    ]);
    expect(fixture.gitlab.mergeCalls).toBe(0);
  });
});

function request(): CapabilityRequest {
  return {
    issueId: "11111111-1111-4111-8111-111111111111",
    mrIid: 42,
    expectedHeadSha: "a".repeat(40),
    requestId: "22222222-2222-4222-8222-222222222222",
  };
}

function createFixture(options: {
  authorizeError?: BrokerError;
  immediateError?: BrokerError;
  ttlMs?: number;
  audit?: AuditSink;
} = {}) {
  const clock: Clock & { value: number } = { value: 0, now() { return this.value; } };
  const audit = options.audit ?? new MemoryAuditSink();
  const gitlab = new FakeGitLab();
  const evidence: AttestationEvidence = {
    generation: 7,
    manifestSha256: "d".repeat(64),
    sourceCommit: "e".repeat(40),
  };
  const context = {
    attestation: evidence,
    issue: {
      id: request().issueId,
      identifier: "GOT-1",
      companyId: "33333333-3333-4333-8333-333333333333",
      parentId: null,
      status: "in_review",
      assigneeAgentId: "44444444-4444-4444-8444-444444444444",
      executionPolicy: null,
      executionState: null,
    },
    mr: fakeMr(),
    jiraKey: "TAIA-42",
  };
  const policy = {
    authorize: async () => {
      if (options.authorizeError) throw options.authorizeError;
      return context;
    },
    immediatePreflight: async () => {
      if (options.immediateError) throw options.immediateError;
      return context;
    },
  };
  const broker = new ReleaseBroker({
    config: {
      companyId: context.issue.companyId,
      gitlabProjectId: 92,
      allowedClientIdentities: new Set([CLIENT, OTHER_CLIENT]),
    },
    store: new CapabilityStore(clock, options.ttlMs ?? 10_000),
    policy,
    gitlab,
    audit,
  });
  return { broker, clock, gitlab, audit: audit as MemoryAuditSink };
}

function fakeMr() {
  return {
    iid: 42,
    state: "opened",
    draft: false,
    target_branch: "main",
    source_branch: "feature/TAIA-42-broker",
    title: "Broker",
    sha: request().expectedHeadSha,
    merge_status: "can_be_merged",
    has_conflicts: false,
    diverged_commits_count: 0,
    head_pipeline: { id: 1, sha: request().expectedHeadSha, status: "success" },
  };
}

class FakeGitLab implements GitLabMerger {
  mergeCalls = 0;

  async getMergeRequest() { return fakeMr(); }
  async getPipeline() {
    return { id: 1, sha: request().expectedHeadSha, status: "success", source: "merge_request_event" };
  }
  async merge(): Promise<MergeResult> {
    this.mergeCalls += 1;
    return {
      state: "merged",
      sha: request().expectedHeadSha,
      merge_commit_sha: "c".repeat(40),
      squash_commit_sha: null,
    };
  }
}

class FailOnWriteAuditSink implements AuditSink {
  #writes = 0;
  readonly #failureWrite: number;

  constructor(failureWrite: number) {
    this.#failureWrite = failureWrite;
  }

  async write(_event: AuditEvent): Promise<void> {
    this.#writes += 1;
    if (this.#writes === this.#failureWrite) throw new BrokerError("audit_failed", 503);
  }
}
