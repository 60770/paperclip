import { BrokerError } from "./errors.js";
import type { CapabilityRequest, MergeCapabilityRequest } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const CAPABILITY_PATTERN = /^rb1\.[A-Za-z0-9_-]{43}$/;

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new BrokerError("invalid_request", 400);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError("invalid_request", 400);
  }
  return value as Record<string, unknown>;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isFullSha(value: unknown): value is string {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

export function parseCapabilityRequest(value: unknown): CapabilityRequest {
  const input = asObject(value);
  assertExactKeys(input, ["issueId", "mrIid", "expectedHeadSha", "requestId"]);
  if (
    !isUuid(input.issueId) ||
    !Number.isSafeInteger(input.mrIid) ||
    (input.mrIid as number) <= 0 ||
    !isFullSha(input.expectedHeadSha) ||
    !isUuid(input.requestId)
  ) {
    throw new BrokerError("invalid_request", 400);
  }
  return input as unknown as CapabilityRequest;
}

export function parseMergeCapabilityRequest(value: unknown): MergeCapabilityRequest {
  const input = asObject(value);
  assertExactKeys(input, ["capability", "requestId"]);
  if (
    typeof input.capability !== "string" ||
    !CAPABILITY_PATTERN.test(input.capability) ||
    !isUuid(input.requestId)
  ) {
    throw new BrokerError("invalid_request", 400);
  }
  return input as unknown as MergeCapabilityRequest;
}

export function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0 || raw.length > 8192) {
    throw new BrokerError("invalid_request", 400);
  }
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new BrokerError("invalid_request", 400);
  }
}
