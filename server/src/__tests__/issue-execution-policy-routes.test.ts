import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
}));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{
      companyId: "company-1",
      agentId: "33333333-3333-4333-8333-333333333333",
      contextSnapshot: null,
      permissions: null,
    }]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async (agentId: string) => ({
        id: agentId,
        companyId: "company-1",
        permissions: null,
      })),
      resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: {
          id: reference,
          companyId: "company-1",
          status: "idle",
          orgChainHealth: { status: "healthy" },
        },
      })),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({
      getById: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: "local_implicit";
      isInstanceAdmin: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId: string | null;
    };

async function createApp(actor?: TestActor) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue execution policy routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{
          companyId: "company-1",
          agentId: "33333333-3333-4333-8333-333333333333",
          contextSnapshot: null,
          permissions: null,
        }]).then(onFulfilled, onRejected),
    }));
    mockIssueService.createChild.mockResolvedValue({
      issue: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        companyId: "company-1",
        identifier: "issue-1002",
        title: "Child issue",
      },
      parentBlockerAdded: false,
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
      const allowed = input.actor?.type === "board" && input.actor.source === "local_implicit"
        ? true
        : input.actor?.type === "agent" && [
            "company_scope:read",
            "issue:read",
            "issue:mutate",
            "runtime:manage",
          ].includes(input.action ?? "")
          ? true
          : Boolean(await mockAccessService.canUser() || await mockAccessService.hasPermission());
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("rejects an agent-authored in_review transition without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "issue-1003",
      title: "Missing review path",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
    expect(res.body.error).toContain("request_confirmation");
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows an agent-authored in_review transition with a pending confirmation interaction", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "issue-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      { id: "interaction-1", kind: "request_confirmation", status: "pending" },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ status: "in_review" }),
    );
  });

  it("allows an agent-authored in_review transition with a typed execution participant", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "issue-1005",
      title: "Execution participant",
      executionPolicy: null,
      executionState: null,
    };
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
        },
      ],
    })!;
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        executionState: expect.objectContaining({
          status: "pending",
          currentParticipant: expect.objectContaining({
            type: "agent",
            agentId: "44444444-4444-4444-8444-444444444444",
          }),
        }),
      }),
    );
  });

  it("allows an agent-authored in_review transition with a scheduled monitor", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "issue-1006",
      title: "External review monitor",
      executionPolicy: null,
      executionState: null,
      monitorAttemptCount: 0,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
      monitorNotes: null,
      monitorScheduledBy: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            scheduledBy: "assignee",
            notes: "Wait for external QA report.",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        monitorNextCheckAt: new Date("2026-12-01T12:00:00.000Z"),
      }),
    );
  });

  it("allows board-authored in_review repair updates without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "issue-1007",
      title: "Board repair",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueThreadInteractionService.listForIssue).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("does not auto-start execution review when reviewers are added to an already in_review issue", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "issue-999",
      title: "Execution policy edit",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: policy,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBeUndefined();
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(updatePatch.executionState).toBeUndefined();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("triggers a scheduled monitor immediately from the dedicated route", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "issue-1001",
      title: "Manual monitor trigger",
      executionPolicy: normalizeIssueExecutionPolicy({
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      }),
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/monitor/check-now")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockHeartbeatService.triggerIssueMonitor).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        actorType: "user",
        actorId: "local-board",
        agentId: null,
      }),
    );
  });

  it("lets a board user create a child issue with a scheduled monitor", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "issue-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "assignee",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("board");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        details: expect.objectContaining({
          scheduledBy: "board",
        }),
      }),
    );
  });

  it("rejects child monitor scheduling by a non-assignee agent even with task assignment permission", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "issue-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the assignee agent or a board user can manage issue monitors");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("normalizes spoofed child monitor scheduledBy to the assignee actor", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "issue-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
            externalRef: "https://example.test/deploy?token=secret",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string; externalRef: string | null } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("assignee");
    expect(createPayload.executionPolicy.monitor.externalRef).toBe("[redacted]");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        entityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        details: expect.not.objectContaining({ externalRef: expect.anything() }),
      }),
    );
  });

  it("rejects a PATCH that drops the active stage together with status:done", async () => {
    const actorAgentId = "33333333-3333-4333-8333-333333333333";
    const devAgentId = "44444444-4444-4444-8444-444444444444";
    const reviewStageId = "55555555-5555-4555-8555-555555555555";
    const approvalStageId = "66666666-6666-4666-8666-666666666666";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: actorAgentId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "issue-1010",
      title: "Gate bypass attempt",
      executionPolicy: {
        stages: [
          { id: reviewStageId, type: "review", participants: [{ type: "agent", agentId: actorAgentId }] },
          { id: approvalStageId, type: "approval", participants: [{ type: "user", userId: "cto-user" }] },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: actorAgentId },
        returnAssignee: { type: "agent", agentId: devAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: actorAgentId,
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "done",
        comment: "approving my own work",
        // Attacker drops the active review stage and makes themselves the sole
        // approver, in the same request that asks for terminal `done`.
        executionPolicy: {
          stages: [
            { id: approvalStageId, type: "approval", participants: [{ type: "agent", agentId: actorAgentId }] },
          ],
        },
      });

    // The attacker is the untrusted active reviewer, so the route trust
    // gate now blocks this same-PATCH ladder rewrite (403) before it ever reaches
    // the engine's ladder guard (422). The attack is still fully blocked
    // — `update` is never called. The engine 422 backstop is exercised on its own
    // via a trusted actor below, and directly in issue-execution-policy.test.ts.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain("execution_policy:manage");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  describe("two-step clear-then-done trust gate", () => {
    const devAgentId = "44444444-4444-4444-8444-444444444444";
    const reviewStageId = "55555555-5555-4555-8555-555555555555";
    const approvalStageId = "66666666-6666-4666-8666-666666666666";
    const trustedAgentId = "77777777-7777-4777-8777-777777777777";
    const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    function attachedPolicy() {
      return {
        stages: [
          { id: reviewStageId, type: "review", participants: [{ type: "agent", agentId: trustedAgentId }] },
          { id: approvalStageId, type: "approval", participants: [{ type: "user", userId: "cto-user" }] },
        ],
      };
    }

    function activeChangesRequestedIssue() {
      // Engine rebounded the issue to the Dev (returnAssignee): in_progress,
      // assigned to the Dev, stage still active (changes_requested). The Dev is
      // the work-actor the done-gate must constrain.
      return {
        id: ISSUE_ID,
        companyId: "company-1",
        status: "in_progress",
        assigneeAgentId: devAgentId,
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "issue-1011",
        title: "Two-step clear attempt",
        executionPolicy: attachedPolicy(),
        executionState: {
          status: "changes_requested",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: trustedAgentId },
          returnAssignee: { type: "agent", agentId: devAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: "changes_requested",
        },
      };
    }

    it("blocks step 1 of the two-step bypass: the Dev clearing their own active gate is 403", async () => {
      const issue = activeChangesRequestedIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: devAgentId,
        companyId: "company-1",
        runId: "run-1",
      }))
        .patch(`/api/issues/${ISSUE_ID}`)
        // The bare clear that today slips past the same-PATCH fail-closed
        // (no status:done in this request) and would leave the issue legacy so a
        // follow-up { status: done } lands ungated.
        .send({ executionPolicy: null });

      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toContain("execution_policy:manage");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("blocks the pre-activation twin: Dev clears an attached policy before the workflow starts (403)", async () => {
      // Policy attached at creation, but the issue is still in_progress and the
      // workflow has not started (executionState: null). The same clear-then-done
      // bypass applies; the gate must fire even though no stage is active.
      const issue = {
        id: ISSUE_ID,
        companyId: "company-1",
        status: "in_progress",
        assigneeAgentId: devAgentId,
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "issue-1012",
        title: "Pre-activation clear attempt",
        executionPolicy: attachedPolicy(),
        executionState: null,
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: devAgentId,
        companyId: "company-1",
        runId: "run-1",
      }))
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({ executionPolicy: null });

      expect(res.status).toBe(403);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("preserves the waive path: a board user may clear an attached active policy", async () => {
      const issue = activeChangesRequestedIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      // Default actor is a local board user.
      const res = await request(await createApp())
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({ executionPolicy: null });

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain("execution_policy:manage");
      expect(mockIssueService.update).toHaveBeenCalled();
    });

    it("preserves the waive path: the assignee recovery agent holding execution_policy:manage may clear its active policy", async () => {
      // Faithful to the production ReleaseBot recovery path: the trusted agent is
      // the issue ASSIGNEE (final approval stage), so it clears the assignment
      // write-boundary (assertAgentIssueMutationAllowed) as the assignee AND the
      // trust gate via its execution_policy:manage grant. A non-assignee
      // trusted agent is already blocked upstream by the assignment boundary
      // is already blocked by the assignment boundary, independent of this gate.
      mockAccessService.hasPermission.mockResolvedValue(true);
      const issue = {
        id: ISSUE_ID,
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: trustedAgentId,
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "issue-1014",
        title: "Recovery clear by the assignee agent",
        executionPolicy: attachedPolicy(),
        executionState: {
          status: "pending",
          currentStageId: approvalStageId,
          currentStageIndex: 1,
          currentStageType: "approval",
          currentParticipant: { type: "agent", agentId: trustedAgentId },
          returnAssignee: { type: "agent", agentId: devAgentId },
          completedStageIds: [reviewStageId],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: trustedAgentId,
        companyId: "company-1",
        runId: "run-1",
      }))
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({ executionPolicy: null });

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalled();
    });

    it("does not fire on an identical-ladder PATCH (no false positive)", async () => {
      // Re-submitting the same stage ladder is not a clear or a change, so the
      // gate must not fire even for the assignee Dev (e.g. a monitor-only
      // reschedule keeps the ladder signature identical).
      const issue = activeChangesRequestedIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: devAgentId,
        companyId: "company-1",
        runId: "run-1",
      }))
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({ executionPolicy: attachedPolicy() });

      expect(res.status).not.toBe(403);
      expect(JSON.stringify(res.body)).not.toContain("execution_policy:manage");
    });

    it("closes the sibling executionState twin: clearing the active state via the body cannot land terminal done", async () => {
      // The sibling vector to clearing executionPolicy is neutralizing the active
      // executionState directly (keep the policy, drop the state) then landing
      // `done`. `executionState` is NOT a writable field in the update schema, so
      // it is stripped from the body — the gate state cannot be cleared via the
      // PATCH at all. The leftover { status: done } on a changes_requested,
      // policy-backed issue is then re-gated by the engine (premature-done
      // redirect): the issue goes back to in_review with the review stage
      // re-activated, NOT to terminal done.
      const issue = activeChangesRequestedIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: devAgentId,
        companyId: "company-1",
        runId: "run-1",
      }))
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({ executionState: null, status: "done" });

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalled();
      const patch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
      // Terminal `done` is never reached; the done-gate is re-established.
      expect(patch.status).not.toBe("done");
      expect(patch.status).toBe("in_review");
      expect(patch.executionState).toBeTruthy();
      expect((patch.executionState as { status?: string }).status).toBe("pending");
    });

    it("engine 422 backstop still fires for a trusted actor rewriting an active ladder + status:done", async () => {
      // A trusted actor passes the route trust gate, so the same-PATCH
      // engine guard must still independently refuse rewriting an active ladder
      // together with status:done (defense in depth — the trust gate and the
      // engine guard are layered, not redundant).
      mockAccessService.hasPermission.mockResolvedValue(true);
      const issue = {
        id: ISSUE_ID,
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: trustedAgentId,
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "issue-1013",
        title: "Trusted rewrite attempt",
        executionPolicy: attachedPolicy(),
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: trustedAgentId },
          returnAssignee: { type: "agent", agentId: devAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: trustedAgentId,
        companyId: "company-1",
        runId: "run-1",
      }))
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({
          status: "done",
          comment: "rewrite and self-approve",
          executionPolicy: {
            stages: [
              { id: approvalStageId, type: "approval", participants: [{ type: "agent", agentId: trustedAgentId }] },
            ],
          },
        });

      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toContain("Cannot modify execution policy stages while a review or approval stage is active");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });
  });
});
