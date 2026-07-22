import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAuditSink } from "./audit.js";
import { StaticAttestationProvider } from "./attestation.js";
import { ReleaseBroker } from "./broker.js";
import { CapabilityStore } from "./capability-store.js";
import { GitLabApiClient } from "./http-clients.js";
import { ReleasePolicy } from "./policy.js";
import type {
  GitLabMerger,
  MergeResult,
  PaperclipActivity,
  PaperclipAgent,
  PaperclipComment,
  PaperclipInteraction,
  PaperclipIssue,
  PaperclipReader,
} from "./types.js";

const CLIENT = `sha256:${"a".repeat(64)}`;
const REQUEST = {
  issueId: "11111111-1111-4111-8111-111111111111",
  mrIid: 42,
  expectedHeadSha: "a".repeat(40),
  requestId: "22222222-2222-4222-8222-222222222222",
};
afterEach(() => vi.unstubAllGlobals());

describe("release broker GitLab integration", () => {
  it("emits one exact-sha PUT and never repeats it on capability replay", async () => {
    let putCount = 0;
    let mergePayload: unknown;
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (init?.method !== "PUT" || url.pathname !== "/api/v4/projects/92/merge_requests/42/merge") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      putCount += 1;
      mergePayload = JSON.parse(String(init.body));
      return Response.json({
        state: "merged",
        sha: REQUEST.expectedHeadSha,
        merge_commit_sha: "c".repeat(40),
        squash_commit_sha: null,
      });
    }));
    const gitlab = new GitLabApiClient("https://gitlab.example.test", 92, "fixture-token");
    const context = {
      attestation: { generation: 7, manifestSha256: "d".repeat(64), sourceCommit: "e".repeat(40) },
      issue: {
        id: REQUEST.issueId,
        identifier: "GOT-1",
        companyId: "33333333-3333-4333-8333-333333333333",
        parentId: null,
        status: "in_review",
        assigneeAgentId: "44444444-4444-4444-8444-444444444444",
        executionPolicy: null,
        executionState: null,
      },
      mr: {
        iid: 42,
        state: "opened",
        draft: false,
        target_branch: "main",
        source_branch: "feature/TAIA-42-broker",
        title: "Broker",
        sha: REQUEST.expectedHeadSha,
        merge_status: "can_be_merged",
        has_conflicts: false,
        diverged_commits_count: 0,
        head_pipeline: { id: 1, sha: REQUEST.expectedHeadSha, status: "success" },
      },
      jiraKey: "TAIA-42",
    };
    const broker = new ReleaseBroker({
      config: {
        companyId: context.issue.companyId,
        gitlabProjectId: 92,
        allowedClientIdentities: new Set([CLIENT]),
      },
      store: new CapabilityStore({ now: () => 0 }, 10_000),
      policy: { authorize: async () => context, immediatePreflight: async () => context },
      gitlab,
      audit: new MemoryAuditSink(),
    });

    const capability = await broker.requestCapability(CLIENT, REQUEST);
    await broker.merge(CLIENT, { capability: capability.capability, requestId: REQUEST.requestId });
    await expect(broker.merge(CLIENT, { capability: capability.capability, requestId: REQUEST.requestId }))
      .rejects.toMatchObject({ code: "capability_replayed" });

    expect(putCount).toBe(1);
    expect(mergePayload).toEqual({
      sha: REQUEST.expectedHeadSha,
      squash: true,
      should_remove_source_branch: true,
    });
  });

  it("binds issuance and immediate preflight to matching pipeline SHAs before merge PUT", async () => {
    const issuanceMismatch = boundFixture();
    issuanceMismatch.gitlab.mr.head_pipeline!.sha = "b".repeat(40);
    await expect(issuanceMismatch.broker.requestCapability(CLIENT, REQUEST))
      .rejects.toMatchObject({ code: "sha_mismatch" });
    expect(issuanceMismatch.gitlab.mergeCalls).toBe(0);

    const preflightMismatch = boundFixture();
    const capability = await preflightMismatch.broker.requestCapability(CLIENT, REQUEST);
    preflightMismatch.gitlab.pipelineSha = "b".repeat(40);
    await expect(preflightMismatch.broker.merge(CLIENT, {
      capability: capability.capability,
      requestId: REQUEST.requestId,
    })).rejects.toMatchObject({ code: "sha_mismatch" });
    expect(preflightMismatch.gitlab.mergeCalls).toBe(0);

    const happy = boundFixture();
    const happyCapability = await happy.broker.requestCapability(CLIENT, REQUEST);
    await expect(happy.broker.merge(CLIENT, {
      capability: happyCapability.capability,
      requestId: REQUEST.requestId,
    })).resolves.toMatchObject({ status: "merged" });
    expect(happy.gitlab.mergeCalls).toBe(1);
  });

  it.each([
    "- [ ] ### **MEDIUM**: authorization bypass remains",
    "- - ### **HIGH**: authorization bypass remains",
    "### `CRITICAL`: authorization bypass remains",
    "### HIGH: authorization bypass remains",
    "### HIGH- authorization bypass remains",
    "- MEDIUM: authorization bypass remains",
    "### [HIGH]: authorization bypass remains",
    "[MEDIUM](https://example.invalid): authorization bypass remains",
    "![CRITICAL](badge): authorization bypass remains",
    "### <HIGH>: authorization bypass remains",
    "[**HIGH**](https://example.invalid): authorization bypass remains",
    "[`CRITICAL`](https://example.invalid): authorization bypass remains",
    "![**CRITICAL**](badge): authorization bypass remains",
    "![`HIGH`](badge): authorization bypass remains",
    "[__MEDIUM__]: authorization bypass remains",
    "<**BLOCKER**>: authorization bypass remains",
    "### H**IG**H: authorization bypass remains",
    "### H`IG`H: authorization bypass remains",
    "### H&#73;GH: authorization bypass remains",
    "### H&#x49;GH: authorization bypass remains",
    "### H~~IG~~H: authorization bypass remains",
    "### H[IG](https://example.invalid)H: authorization bypass remains",
    "### H<!-- hidden -->IGH: authorization bypass remains",
    "> HIGH: authorization bypass remains",
    "```text\nCRITICAL: authorization bypass remains\n```",
  ])("keeps merge PUT at zero for a Markdown security finding: %s", async (finding) => {
    const fixture = boundFixture(finding);
    await expect(fixture.broker.requestCapability(CLIENT, REQUEST))
      .rejects.toMatchObject({ code: "paperclip_not_ready" });
    expect(fixture.gitlab.mergeCalls).toBe(0);
  });

  it("keeps the broker open for a clear non-finding control", async () => {
    const fixture = boundFixture("### High-level review summary");
    const capability = await fixture.broker.requestCapability(CLIENT, REQUEST);
    await expect(fixture.broker.merge(CLIENT, {
      capability: capability.capability,
      requestId: REQUEST.requestId,
    })).resolves.toMatchObject({ status: "merged" });
    expect(fixture.gitlab.mergeCalls).toBe(1);
  });
});

const COMPANY = "33333333-3333-4333-8333-333333333333";
const LOCK_ISSUE = "44444444-4444-4444-8444-444444444440";
const RELEASE_BOT = "44444444-4444-4444-8444-444444444444";
const DEV = "55555555-5555-4555-8555-555555555555";
const REVIEWER = "66666666-6666-4666-8666-666666666666";
const REVIEW_STAGE = "77777777-7777-4777-8777-777777777771";
const APPROVAL_STAGE = "77777777-7777-4777-8777-777777777772";

function boundFixture(reviewBody = "Review clean: no security findings remain") {
  const gitlab = new BoundGitLab();
  const policy = new ReleasePolicy(
    new BoundPaperclip(reviewBody),
    gitlab,
    new StaticAttestationProvider({
      generation: 7,
      manifestSha256: "d".repeat(64),
      sourceCommit: "e".repeat(40),
    }),
    {
      companyId: COMPANY,
      gitlabProjectId: 92,
      releaseBotAgentId: RELEASE_BOT,
      mainLockIssue: "GOT-66",
      allowedPipelineSources: new Set(["push", "merge_request_event"]),
    },
  );
  const broker = new ReleaseBroker({
    config: { companyId: COMPANY, gitlabProjectId: 92, allowedClientIdentities: new Set([CLIENT]) },
    store: new CapabilityStore({ now: () => 0 }, 10_000),
    policy,
    gitlab,
    audit: new MemoryAuditSink(),
  });
  return { broker, gitlab };
}

class BoundGitLab implements GitLabMerger {
  mr = {
    iid: 42,
    state: "opened",
    draft: false,
    target_branch: "main",
    source_branch: "feature/TAIA-42-release-broker",
    title: "Release broker",
    sha: REQUEST.expectedHeadSha,
    merge_status: "can_be_merged",
    has_conflicts: false,
    diverged_commits_count: 0,
    head_pipeline: { id: 91, sha: REQUEST.expectedHeadSha, status: "success" },
  };
  pipelineSha = REQUEST.expectedHeadSha;
  mergeCalls = 0;

  async getMergeRequest() { return structuredClone(this.mr); }
  async getPipeline() {
    return { id: 91, sha: this.pipelineSha, status: "success", source: "merge_request_event" };
  }
  async merge(_iid: number, expectedHeadSha: string): Promise<MergeResult> {
    this.mergeCalls += 1;
    return {
      state: "merged",
      sha: expectedHeadSha,
      merge_commit_sha: "c".repeat(40),
      squash_commit_sha: null,
    };
  }
}

class BoundPaperclip implements PaperclipReader {
  readonly #reviewBody: string;

  constructor(reviewBody: string) {
    this.#reviewBody = reviewBody;
  }

  async getIssue(issueId: string): Promise<PaperclipIssue> {
    if (issueId === "GOT-66") {
      return {
        id: LOCK_ISSUE,
        identifier: "GOT-66",
        companyId: COMPANY,
        parentId: null,
        status: "backlog",
        assigneeAgentId: null,
        executionPolicy: null,
        executionState: null,
      };
    }
    return {
      id: REQUEST.issueId,
      identifier: "GOT-1",
      companyId: COMPANY,
      parentId: null,
      status: "in_review",
      assigneeAgentId: RELEASE_BOT,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: REVIEW_STAGE,
            type: "review",
            approvalsNeeded: 1,
            participants: [{
              id: "77777777-7777-4777-8777-777777777773",
              type: "agent",
              agentId: REVIEWER,
              userId: null,
            }],
          },
          {
            id: APPROVAL_STAGE,
            type: "approval",
            approvalsNeeded: 1,
            participants: [{
              id: "77777777-7777-4777-8777-777777777774",
              type: "agent",
              agentId: RELEASE_BOT,
              userId: null,
            }],
          },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: APPROVAL_STAGE,
        currentStageIndex: 1,
        currentStageType: "approval",
        currentParticipant: { type: "agent", agentId: RELEASE_BOT, userId: null },
        returnAssignee: { type: "agent", agentId: DEV, userId: null },
        completedStageIds: [REVIEW_STAGE],
        lastDecisionId: "77777777-7777-4777-8777-777777777775",
        lastDecisionOutcome: "approved",
      },
    };
  }

  async getComments(issueId: string): Promise<PaperclipComment[]> {
    if (issueId === LOCK_ISSUE) return [];
    return [
      {
        id: "88888888-8888-4888-8888-888888888881",
        issueId: REQUEST.issueId,
        body: "MR: https://gitlab.tidycode.it/tidycode/TaIA/-/merge_requests/42",
        createdAt: "2026-07-22T12:00:00.000Z",
        deletedAt: null,
        authorType: "agent",
        authorAgentId: DEV,
        authorUserId: null,
      },
      {
        id: "88888888-8888-4888-8888-888888888882",
        issueId: REQUEST.issueId,
        body: `APPROVED-REVIEW\n\n${this.#reviewBody}\nAPPROVED-QA-WAIVED: Backend-only broker\n\ncc [@ReleaseBot](agent://${RELEASE_BOT})`,
        createdAt: "2026-07-22T12:01:00.000Z",
        deletedAt: null,
        authorType: "agent",
        authorAgentId: REVIEWER,
        authorUserId: null,
      },
    ];
  }

  async getComment() { return null; }
  async getAgent(agentId: string): Promise<PaperclipAgent> {
    if (agentId === DEV) return { id: DEV, role: "engineer", urlKey: "dev1" };
    if (agentId === REVIEWER) return { id: REVIEWER, role: "engineer", urlKey: "reviewer1" };
    return { id: RELEASE_BOT, role: "release", urlKey: "releasebot" };
  }
  async getActivity(): Promise<PaperclipActivity[]> { return []; }
  async getInteractions(): Promise<PaperclipInteraction[]> { return []; }
}
