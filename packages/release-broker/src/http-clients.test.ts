import { afterEach, describe, expect, it, vi } from "vitest";
import { GitLabApiClient, PaperclipApiClient } from "./http-clients.js";

afterEach(() => vi.unstubAllGlobals());

describe("release broker upstream clients", () => {
  it("treats an exact Paperclip comment 404 as an absent release reference", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ error: "Comment not found" }, { status: 404 })));

    const client = new PaperclipApiClient("https://paperclip.example.test", "fixture-key");
    await expect(client.getComment(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    )).resolves.toBeNull();
  });

  it("rejects non-positive GitLab response identifiers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      iid: 0,
      state: "opened",
      draft: false,
      target_branch: "main",
      source_branch: "feature/TAIA-1-test",
      title: "Test",
      sha: "a".repeat(40),
      merge_status: "can_be_merged",
      has_conflicts: false,
      diverged_commits_count: 0,
      head_pipeline: { id: 1, sha: "a".repeat(40), status: "success" },
    })));

    const client = new GitLabApiClient("https://gitlab.example.test", 92, "fixture-token");
    await expect(client.getMergeRequest(1)).rejects.toMatchObject({ code: "ambiguous_response" });
  });

  it.each([
    ["merge request", "/merge_requests/1", {
      iid: 1,
      state: "opened",
      draft: false,
      target_branch: "main",
      source_branch: "feature/TAIA-1-test",
      title: "Test",
      sha: "a".repeat(40),
      merge_status: "can_be_merged",
      has_conflicts: false,
      diverged_commits_count: 0,
      head_pipeline: { id: 1, status: "success" },
    }],
    ["live pipeline", "/pipelines/1", {
      id: 1,
      status: "success",
      source: "merge_request_event",
    }],
  ])("rejects %s payloads without a full pipeline SHA", async (_name, path, payload) => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      return url.pathname.endsWith(path) ? Response.json(payload) : Response.json({}, { status: 404 });
    }));

    const client = new GitLabApiClient("https://gitlab.example.test", 92, "fixture-token");
    const call = path.startsWith("/merge_requests")
      ? client.getMergeRequest(1)
      : client.getPipeline(1);
    await expect(call).rejects.toMatchObject({ code: "ambiguous_response" });
  });

  it("preserves exact full SHAs from MR and live pipeline payloads", async () => {
    const sha = "a".repeat(40);
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.endsWith("/merge_requests/1")) {
        return Response.json({
          iid: 1,
          state: "opened",
          draft: false,
          target_branch: "main",
          source_branch: "feature/TAIA-1-test",
          title: "Test",
          sha,
          merge_status: "can_be_merged",
          has_conflicts: false,
          diverged_commits_count: 0,
          head_pipeline: { id: 1, sha, status: "success" },
        });
      }
      return Response.json({ id: 1, sha, status: "success", source: "merge_request_event" });
    }));

    const client = new GitLabApiClient("https://gitlab.example.test", 92, "fixture-token");
    await expect(client.getMergeRequest(1)).resolves.toMatchObject({ sha, head_pipeline: { sha } });
    await expect(client.getPipeline(1)).resolves.toMatchObject({ sha });
  });
});
