import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAuditSink } from "./audit.js";
import { ReleaseBroker } from "./broker.js";
import { CapabilityStore } from "./capability-store.js";
import { GitLabApiClient } from "./http-clients.js";

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
        head_pipeline: { id: 1, status: "success" },
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
});
