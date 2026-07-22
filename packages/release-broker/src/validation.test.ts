import { describe, expect, it } from "vitest";
import { parseCapabilityRequest, parseMergeCapabilityRequest } from "./validation.js";

describe("release broker request validation", () => {
  it("accepts only exact allowlisted capability fields", () => {
    const input = {
      issueId: "11111111-1111-4111-8111-111111111111",
      mrIid: 1,
      expectedHeadSha: "a".repeat(40),
      requestId: "22222222-2222-4222-8222-222222222222",
    };
    expect(parseCapabilityRequest(input)).toEqual(input);
    expect(() => parseCapabilityRequest({ ...input, pipelineStatus: "success" }))
      .toThrowError(expect.objectContaining({ code: "invalid_request" }));
    expect(() => parseCapabilityRequest({ ...input, expectedHeadSha: "A".repeat(40) }))
      .toThrowError(expect.objectContaining({ code: "invalid_request" }));
  });

  it("rejects malformed merge tokens and extra caller-provided state", () => {
    const input = {
      capability: `rb1.${"a".repeat(43)}`,
      requestId: "22222222-2222-4222-8222-222222222222",
    };
    expect(parseMergeCapabilityRequest(input)).toEqual(input);
    expect(() => parseMergeCapabilityRequest({ ...input, sha: "a".repeat(40) }))
      .toThrowError(expect.objectContaining({ code: "invalid_request" }));
  });
});
