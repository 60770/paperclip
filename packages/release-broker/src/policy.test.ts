import { beforeEach, describe, expect, it } from "vitest";
import { StaticAttestationProvider } from "./attestation.js";
import { deriveJiraKey, ReleasePolicy } from "./policy.js";
import type {
  GitLabMergeRequest,
  GitLabPipeline,
  GitLabReader,
  PaperclipActivity,
  PaperclipAgent,
  PaperclipComment,
  PaperclipInteraction,
  PaperclipIssue,
  PaperclipReader,
} from "./types.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ISSUE = "22222222-2222-4222-8222-222222222222";
const LOCK_ISSUE = "33333333-3333-4333-8333-333333333333";
const RELEASE_BOT = "44444444-4444-4444-8444-444444444444";
const DEV = "55555555-5555-4555-8555-555555555555";
const REVIEWER = "66666666-6666-4666-8666-666666666666";
const TESTER = "88888888-8888-4888-8888-888888888888";
const REVIEW_STAGE = "99999999-9999-4999-8999-999999999991";
const QA_STAGE = "99999999-9999-4999-8999-999999999992";
const APPROVAL_STAGE = "99999999-9999-4999-8999-999999999993";
const REVIEW_PARTICIPANT = "99999999-9999-4999-8999-999999999994";
const QA_PARTICIPANT = "99999999-9999-4999-8999-999999999995";
const APPROVAL_PARTICIPANT = "99999999-9999-4999-8999-999999999996";
const REVIEW_DECISION = "99999999-9999-4999-8999-999999999997";
const REQUEST = {
  issueId: ISSUE,
  mrIid: 42,
  expectedHeadSha: "a".repeat(40),
  requestId: "77777777-7777-4777-8777-777777777777",
};

describe("ReleasePolicy", () => {
  let paperclip: FakePaperclip;
  let gitlab: FakeGitLab;

  beforeEach(() => {
    paperclip = new FakePaperclip();
    gitlab = new FakeGitLab();
  });

  it("authorizes fresh review plus waiver against exact live MR state", async () => {
    const context = await policy(paperclip, gitlab).authorize(REQUEST);
    expect(context.jiraKey).toBe("TAIA-42");
    expect(context.attestation.generation).toBe(7);
    expect(gitlab.pipelineReads).toBe(1);
  });

  it("denies stale approval tokens and false approver roles", async () => {
    paperclip.comments.get(ISSUE)!.push(comment({
      id: "00000000-0000-4000-8000-000000000003",
      createdAt: "2026-07-22T12:02:00.000Z",
      authorAgentId: DEV,
      body: "MR: https://gitlab.tidycode.it/tidycode/TaIA/-/merge_requests/43",
    }));
    await expect(policy(paperclip, gitlab).authorize(REQUEST))
      .rejects.toMatchObject({ code: "paperclip_not_ready" });

    paperclip = new FakePaperclip();
    paperclip.agents.set(REVIEWER, { id: REVIEWER, role: "engineer", urlKey: "dev-reviewer" });
    await expect(policy(paperclip, gitlab).authorize(REQUEST))
      .rejects.toMatchObject({ code: "paperclip_not_ready" });
  });

  it.each([
    ["draft", (mr: GitLabMergeRequest) => { mr.draft = true; }, "mr_not_ready"],
    ["conflict", (mr: GitLabMergeRequest) => { mr.has_conflicts = true; }, "mr_not_ready"],
    ["behind", (mr: GitLabMergeRequest) => { mr.diverged_commits_count = 1; }, "mr_not_ready"],
    ["wrong sha", (mr: GitLabMergeRequest) => { mr.sha = "b".repeat(40); }, "sha_mismatch"],
    ["head pipeline sha mismatch", (mr: GitLabMergeRequest) => { mr.head_pipeline!.sha = "b".repeat(40); }, "sha_mismatch"],
    ["pipeline fail", (mr: GitLabMergeRequest) => { mr.head_pipeline!.status = "failed"; }, "mr_not_ready"],
  ] as const)("denies %s with zero merge authorization", async (_name, mutate, code) => {
    mutate(gitlab.mr);
    await expect(policy(paperclip, gitlab).authorize(REQUEST)).rejects.toMatchObject({ code });
  });

  it("denies untrusted pipeline sources", async () => {
    gitlab.pipeline.source = "schedule";
    await expect(policy(paperclip, gitlab).authorize(REQUEST))
      .rejects.toMatchObject({ code: "mr_not_ready" });
  });

  it("denies a live pipeline for a different SHA during issuance and immediate preflight", async () => {
    gitlab.pipeline.sha = "b".repeat(40);
    await expect(policy(paperclip, gitlab).authorize(REQUEST))
      .rejects.toMatchObject({ code: "sha_mismatch" });
    await expect(policy(paperclip, gitlab).immediatePreflight(REQUEST, 7))
      .rejects.toMatchObject({ code: "sha_mismatch" });
  });

  it("requires a Tester token for UI policy and accepts a fresh one", async () => {
    const execution = uiExecution();
    const current = paperclip.issues.get(ISSUE)!;
    current.executionPolicy = execution.executionPolicy;
    current.executionState = execution.executionState;

    await expect(policy(paperclip, gitlab).authorize(REQUEST))
      .rejects.toMatchObject({ code: "paperclip_not_ready" });

    paperclip.comments.get(ISSUE)!.push(comment({
      id: "00000000-0000-4000-8000-000000000004",
      createdAt: "2026-07-22T12:02:00.000Z",
      authorAgentId: TESTER,
      body: `APPROVED-QA\n\ncc [@ReleaseBot](agent://${RELEASE_BOT})`,
    }));
    await expect(policy(paperclip, gitlab).authorize(REQUEST)).resolves.toBeDefined();
  });

  it("denies a Reviewer waiver when policy classification is ambiguous", async () => {
    const current = paperclip.issues.get(ISSUE)!;
    current.executionPolicy = null;
    current.executionState = null;
    await expect(policy(paperclip, gitlab).authorize(REQUEST))
      .rejects.toMatchObject({ code: "paperclip_not_ready" });
  });

  it("denies a Reviewer waiver when backend policy shape is malformed", async () => {
    const execution = backendExecution();
    const malformedPolicy = structuredClone(execution.executionPolicy) as {
      stages: Array<{ participants: Array<{ userId?: unknown }> }>;
    };
    delete malformedPolicy.stages[0]!.participants[0]!.userId;
    const current = paperclip.issues.get(ISSUE)!;
    current.executionPolicy = malformedPolicy;
    current.executionState = execution.executionState;
    await expect(policy(paperclip, gitlab).authorize(REQUEST))
      .rejects.toMatchObject({ code: "paperclip_not_ready" });
  });

  it.each([
    "- **HIGH**: unsafe authorization gap",
    "- ***HIGH***: unsafe authorization gap",
    "1. __HIGH__: unsafe authorization gap",
    "2) **BLOCKER** — unsafe authorization gap",
    "### **HIGH**: authorization bypass remains",
    "#### BLOCKER — authorization bypass remains",
    "- ### **HIGH**: authorization bypass remains",
    "### HIGH - authorization bypass remains",
    "- MEDIUM: authorization bypass remains",
    "### CRITICAL — authorization bypass remains",
    "- [ ] ### **HIGH**: authorization bypass remains",
    "- - ### **HIGH**: authorization bypass remains",
    "### `HIGH`: authorization bypass remains",
    "- [x] 2) #### __MEDIUM__: authorization bypass remains",
    "~~CRITICAL~~: authorization bypass remains",
    "[admonition] HIGH: authorization bypass remains",
  ])("rejects Markdown-equivalent security findings: %s", async (finding) => {
    paperclip.comments.get(ISSUE)![1]!.body =
      `APPROVED-REVIEW\n\n${finding}\nAPPROVED-QA-WAIVED: Backend-only broker\n\ncc [@ReleaseBot](agent://${RELEASE_BOT})`;
    await expect(policy(paperclip, gitlab).authorize(REQUEST))
      .rejects.toMatchObject({ code: "paperclip_not_ready" });
  });

  it("accepts a non-finding Markdown heading", async () => {
    paperclip.comments.get(ISSUE)![1]!.body =
      `APPROVED-REVIEW\n\n### Review clean: no HIGH or BLOCKER findings remain\nAPPROVED-QA-WAIVED: Backend-only broker\n\ncc [@ReleaseBot](agent://${RELEASE_BOT})`;
    await expect(policy(paperclip, gitlab).authorize(REQUEST)).resolves.toBeDefined();
  });

  it("accepts a hyphenated word at the start of a Markdown heading", async () => {
    paperclip.comments.get(ISSUE)![1]!.body =
      `APPROVED-REVIEW\n\n### High-level summary\nAPPROVED-QA-WAIVED: Backend-only broker\n\ncc [@ReleaseBot](agent://${RELEASE_BOT})`;
    await expect(policy(paperclip, gitlab).authorize(REQUEST)).resolves.toBeDefined();
  });

  it("fails closed when Markdown container depth exceeds the documented limit", async () => {
    paperclip.comments.get(ISSUE)![1]!.body =
      `APPROVED-REVIEW\n\n${"- ".repeat(9)}Review clean\nAPPROVED-QA-WAIVED: Backend-only broker\n\ncc [@ReleaseBot](agent://${RELEASE_BOT})`;
    await expect(policy(paperclip, gitlab).authorize(REQUEST))
      .rejects.toMatchObject({ code: "paperclip_not_ready" });
  });

  it("accepts non-finding severity-prefixed words", async () => {
    paperclip.comments.get(ISSUE)![1]!.body =
      `APPROVED-REVIEW\n\n### High-level summary\n- Medium-term follow-up\nCriticality reviewed\nAPPROVED-QA-WAIVED: Backend-only broker\n\ncc [@ReleaseBot](agent://${RELEASE_BOT})`;
    await expect(policy(paperclip, gitlab).authorize(REQUEST)).resolves.toBeDefined();
  });

  it.each([
    "```text\nAPPROVED-REVIEW\nAPPROVED-QA-WAIVED: Backend-only broker\n```",
    "> APPROVED-REVIEW\n> APPROVED-QA-WAIVED: Backend-only broker",
  ])("ignores approval tokens inside fences and quotes", async (quotedTokens) => {
    paperclip.comments.get(ISSUE)![1]!.body =
      `${quotedTokens}\n\ncc [@ReleaseBot](agent://${RELEASE_BOT})`;
    await expect(policy(paperclip, gitlab).authorize(REQUEST))
      .rejects.toMatchObject({ code: "paperclip_not_ready" });
  });

  it("fails closed when the MR endpoint returns a different iid", async () => {
    gitlab.mr.iid = 43;
    await expect(policy(paperclip, gitlab).authorize(REQUEST))
      .rejects.toMatchObject({ code: "ambiguous_response" });
  });

  it("enforces main lock carve-out and human decision release", async () => {
    paperclip.comments.get(LOCK_ISSUE)!.push(comment({
      issueId: LOCK_ISSUE,
      id: "00000000-0000-4000-8000-000000000010",
      createdAt: "2026-07-22T12:03:00.000Z",
      authorAgentId: DEV,
      body: "[MAIN_LOCKED]: TAIA-999 https://example.invalid failing-job",
    }));
    await expect(policy(paperclip, gitlab).authorize(REQUEST))
      .rejects.toMatchObject({ code: "main_lock_active" });

    paperclip = new FakePaperclip();
    paperclip.comments.get(ISSUE)!.push(comment({
      id: "00000000-0000-4000-8000-000000000011",
      createdAt: "2026-07-22T12:04:00.000Z",
      authorAgentId: DEV,
      body: "[HUMAN_DECISION_REQUIRED]: by=dev at=2026-07-22T12:04:00Z",
    }));
    await expect(policy(paperclip, gitlab).authorize(REQUEST))
      .rejects.toMatchObject({ code: "human_gate_blocked" });
  });

  it("repeats exact MR, lock and human checks during immediate preflight", async () => {
    await policy(paperclip, gitlab).immediatePreflight(REQUEST, 7);
    expect(gitlab.mrReads).toBe(2);
    expect(gitlab.pipelineReads).toBe(2);
    expect(paperclip.commentReads.get(LOCK_ISSUE)).toBe(1);
    expect(paperclip.commentReads.get(ISSUE)).toBe(2);
  });
});

describe("deriveJiraKey", () => {
  it("uses only the canonical feature branch shape before falling back to the MR title", () => {
    expect(deriveJiraKey({ ...mr(), source_branch: "feature/TAIA-99-fix", title: "TAIA-42 fallback" }))
      .toBe("TAIA-99");
    expect(deriveJiraKey({ ...mr(), source_branch: "bugfix/TAIA-99-fix", title: "TAIA-42 fallback" }))
      .toBe("TAIA-42");
    expect(deriveJiraKey({ ...mr(), source_branch: "bugfix/TAIA-99-fix", title: "No ticket" }))
      .toBe("NO-JIRA");
  });
});

function policy(paperclip: PaperclipReader, gitlab: GitLabReader): ReleasePolicy {
  return new ReleasePolicy(
    paperclip,
    gitlab,
    new StaticAttestationProvider({ generation: 7, manifestSha256: "b".repeat(64), sourceCommit: "c".repeat(40) }),
    {
      companyId: COMPANY,
      gitlabProjectId: 92,
      releaseBotAgentId: RELEASE_BOT,
      mainLockIssue: "GOT-66",
      allowedPipelineSources: new Set(["push", "merge_request_event"]),
    },
  );
}

class FakePaperclip implements PaperclipReader {
  issues = new Map<string, PaperclipIssue>([
    [ISSUE, issue({ id: ISSUE, identifier: "GOT-1" })],
    ["GOT-66", issue({ id: LOCK_ISSUE, identifier: "GOT-66", status: "backlog", assigneeAgentId: null })],
  ]);
  comments = new Map<string, PaperclipComment[]>([
    [ISSUE, [
      comment({
        id: "00000000-0000-4000-8000-000000000001",
        createdAt: "2026-07-22T12:00:00.000Z",
        authorAgentId: DEV,
        body: "MR: https://gitlab.tidycode.it/tidycode/TaIA/-/merge_requests/42",
      }),
      comment({
        id: "00000000-0000-4000-8000-000000000002",
        createdAt: "2026-07-22T12:01:00.000Z",
        authorAgentId: REVIEWER,
        body: `APPROVED-REVIEW\n\nReview clean: nessun BLOCKER/HIGH residuo.\nAPPROVED-QA-WAIVED: Backend-only broker\n\ncc [@ReleaseBot](agent://${RELEASE_BOT})`,
      }),
    ]],
    [LOCK_ISSUE, []],
  ]);
  agents = new Map<string, PaperclipAgent>([
    [DEV, { id: DEV, role: "engineer", urlKey: "dev1" }],
    [REVIEWER, { id: REVIEWER, role: "engineer", urlKey: "reviewer1" }],
    [TESTER, { id: TESTER, role: "qa", urlKey: "tester1" }],
    [RELEASE_BOT, { id: RELEASE_BOT, role: "release", urlKey: "releasebot" }],
  ]);
  commentReads = new Map<string, number>();

  async getIssue(issueId: string) { return structuredClone(this.issues.get(issueId)!); }
  async getComments(issueId: string) {
    this.commentReads.set(issueId, (this.commentReads.get(issueId) ?? 0) + 1);
    return structuredClone(this.comments.get(issueId) ?? []);
  }
  async getComment() { return null; }
  async getAgent(agentId: string) { return structuredClone(this.agents.get(agentId)!); }
  async getActivity(): Promise<PaperclipActivity[]> { return []; }
  async getInteractions(): Promise<PaperclipInteraction[]> { return []; }
}

class FakeGitLab implements GitLabReader {
  mr = mr();
  pipeline: GitLabPipeline = {
    id: 91,
    sha: REQUEST.expectedHeadSha,
    status: "success",
    source: "merge_request_event",
  };
  mrReads = 0;
  pipelineReads = 0;

  async getMergeRequest() { this.mrReads += 1; return structuredClone(this.mr); }
  async getPipeline() { this.pipelineReads += 1; return structuredClone(this.pipeline); }
}

function issue(overrides: Partial<PaperclipIssue>): PaperclipIssue {
  const execution = backendExecution();
  return {
    id: ISSUE,
    identifier: "GOT-1",
    companyId: COMPANY,
    parentId: null,
    status: "in_review",
    assigneeAgentId: RELEASE_BOT,
    executionPolicy: execution.executionPolicy,
    executionState: execution.executionState,
    ...overrides,
  };
}

function comment(overrides: Partial<PaperclipComment> & Pick<PaperclipComment, "id" | "createdAt" | "body">): PaperclipComment {
  return {
    id: overrides.id,
    issueId: overrides.issueId ?? ISSUE,
    body: overrides.body,
    createdAt: overrides.createdAt,
    deletedAt: null,
    authorType: overrides.authorType ?? "agent",
    authorAgentId: overrides.authorAgentId ?? null,
    authorUserId: overrides.authorUserId ?? null,
  };
}

function mr(): GitLabMergeRequest {
  return {
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
}

function backendExecution() {
  return execution([
    stage(REVIEW_STAGE, "review", REVIEW_PARTICIPANT, REVIEWER),
    stage(APPROVAL_STAGE, "approval", APPROVAL_PARTICIPANT, RELEASE_BOT),
  ], [REVIEW_STAGE], APPROVAL_STAGE, 1, "approval", RELEASE_BOT);
}

function uiExecution() {
  return execution([
    stage(REVIEW_STAGE, "review", REVIEW_PARTICIPANT, REVIEWER),
    stage(QA_STAGE, "review", QA_PARTICIPANT, TESTER),
    stage(APPROVAL_STAGE, "approval", APPROVAL_PARTICIPANT, RELEASE_BOT),
  ], [REVIEW_STAGE, QA_STAGE], APPROVAL_STAGE, 2, "approval", RELEASE_BOT);
}

function stage(id: string, type: string, participantId: string, agentId: string) {
  return {
    id,
    type,
    approvalsNeeded: 1,
    participants: [{ id: participantId, type: "agent", agentId, userId: null }],
  };
}

function execution(
  stages: unknown[],
  completedStageIds: string[],
  currentStageId: string,
  currentStageIndex: number,
  currentStageType: string,
  currentAgentId: string,
) {
  return {
    executionPolicy: { mode: "normal", commentRequired: true, stages },
    executionState: {
      status: "pending",
      currentStageId,
      currentStageIndex,
      currentStageType,
      currentParticipant: { type: "agent", agentId: currentAgentId, userId: null },
      returnAssignee: { type: "agent", agentId: DEV, userId: null },
      completedStageIds,
      lastDecisionId: REVIEW_DECISION,
      lastDecisionOutcome: "approved",
    },
  };
}
