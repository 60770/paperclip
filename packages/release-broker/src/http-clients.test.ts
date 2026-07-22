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
      head_pipeline: { id: 1, status: "success" },
    })));

    const client = new GitLabApiClient("https://gitlab.example.test", 92, "fixture-token");
    await expect(client.getMergeRequest(1)).rejects.toMatchObject({ code: "ambiguous_response" });
  });
});
