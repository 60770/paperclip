import { BrokerError } from "./errors.js";
import type {
  GitLabMergeRequest,
  GitLabMerger,
  GitLabPipeline,
  MergeResult,
  PaperclipActivity,
  PaperclipAgent,
  PaperclipComment,
  PaperclipInteraction,
  PaperclipIssue,
  PaperclipReader,
} from "./types.js";

const FETCH_TIMEOUT_MS = 10_000;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError("ambiguous_response", 503);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BrokerError("ambiguous_response", 503);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return string(value);
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new BrokerError("ambiguous_response", 503);
  return value as number;
}

function positiveInteger(value: unknown): number {
  const parsed = integer(value);
  if (parsed <= 0) throw new BrokerError("ambiguous_response", 503);
  return parsed;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = integer(value);
  if (parsed < 0) throw new BrokerError("ambiguous_response", 503);
  return parsed;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new BrokerError("ambiguous_response", 503);
  return value;
}

function timestamp(value: unknown): string {
  const parsed = string(value);
  if (!TIMESTAMP_PATTERN.test(parsed) || Number.isNaN(Date.parse(parsed))) {
    throw new BrokerError("ambiguous_response", 503);
  }
  return parsed;
}

async function fetchJson(
  url: URL,
  init: RequestInit,
  expectedStatuses: ReadonlySet<number>,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "application/json", ...init.headers },
    });
    if (!expectedStatuses.has(response.status)) {
      throw new BrokerError("upstream_failed", 503);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json") {
      throw new BrokerError("ambiguous_response", 503);
    }
    try {
      return await response.json();
    } catch {
      throw new BrokerError("ambiguous_response", 503);
    }
  } catch (error) {
    if (error instanceof BrokerError) throw error;
    throw new BrokerError("upstream_failed", 503);
  } finally {
    clearTimeout(timeout);
  }
}

function parseComment(value: unknown, expectedIssueId: string): PaperclipComment {
  const input = object(value);
  const issueId = string(input.issueId);
  if (issueId !== expectedIssueId) throw new BrokerError("ambiguous_response", 503);
  const authorType = string(input.authorType);
  if (authorType !== "agent" && authorType !== "user" && authorType !== "system") {
    throw new BrokerError("ambiguous_response", 503);
  }
  return {
    id: string(input.id),
    issueId,
    body: typeof input.body === "string" ? input.body : (() => { throw new BrokerError("ambiguous_response", 503); })(),
    createdAt: timestamp(input.createdAt),
    deletedAt: input.deletedAt === null ? null : timestamp(input.deletedAt),
    authorType,
    authorAgentId: nullableString(input.authorAgentId),
    authorUserId: nullableString(input.authorUserId),
  };
}

export class PaperclipApiClient implements PaperclipReader {
  readonly #baseUrl: URL;
  readonly #headers: Record<string, string>;

  constructor(apiUrl: string, apiKey: string) {
    this.#baseUrl = normalizeBaseUrl(apiUrl);
    this.#headers = { Authorization: `Bearer ${apiKey}` };
  }

  async getIssue(issueId: string): Promise<PaperclipIssue> {
    const input = object(await this.#get(`/api/issues/${encodeURIComponent(issueId)}`));
    const id = string(input.id);
    if (id !== issueId && string(input.identifier) !== issueId) {
      throw new BrokerError("ambiguous_response", 503);
    }
    return {
      id,
      identifier: string(input.identifier),
      companyId: string(input.companyId),
      parentId: nullableString(input.parentId),
      status: string(input.status),
      assigneeAgentId: nullableString(input.assigneeAgentId),
      executionPolicy: input.executionPolicy,
      executionState: input.executionState,
    };
  }

  async getComments(issueId: string): Promise<PaperclipComment[]> {
    const comments: PaperclipComment[] = [];
    let after: string | null = null;
    let priorKey: [string, string] | null = null;

    for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
      const query = new URLSearchParams({ order: "asc", limit: "100" });
      if (after) query.set("after", after);
      const payload = await this.#get(`/api/issues/${encodeURIComponent(issueId)}/comments?${query}`);
      if (!Array.isArray(payload) || payload.length > 100) {
        throw new BrokerError("ambiguous_response", 503);
      }
      let page = payload.map((entry) => parseComment(entry, issueId));
      if (after && page[0]?.id === after) page = page.slice(1);
      if (page.length === 0) return comments;

      for (const comment of page) {
        const key: [string, string] = [comment.createdAt, comment.id];
        if (priorKey && (key[0] < priorKey[0] || (key[0] === priorKey[0] && key[1] <= priorKey[1]))) {
          throw new BrokerError("ambiguous_response", 503);
        }
        comments.push(comment);
        priorKey = key;
      }
      after = page.at(-1)!.id;
    }
    throw new BrokerError("ambiguous_response", 503);
  }

  async getComment(issueId: string, commentId: string): Promise<PaperclipComment | null> {
    const url = this.#url(`/api/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`);
    const payload = await fetchJson(url, { headers: this.#headers }, new Set([200, 404]));
    const input = object(payload);
    if (Object.keys(input).length === 1 && input.error === "Comment not found") return null;
    return parseComment(payload, issueId);
  }

  async getAgent(agentId: string): Promise<PaperclipAgent> {
    const input = object(await this.#get(`/api/agents/${encodeURIComponent(agentId)}`));
    const agent: PaperclipAgent = {
      id: string(input.id),
      role: string(input.role),
      urlKey: string(input.urlKey),
    };
    if (agent.id !== agentId) throw new BrokerError("ambiguous_response", 503);
    return agent;
  }

  async getActivity(issueId: string): Promise<PaperclipActivity[]> {
    const payload = await this.#get(`/api/issues/${encodeURIComponent(issueId)}/activity`);
    if (!Array.isArray(payload)) throw new BrokerError("ambiguous_response", 503);
    return payload.map((entry) => {
      const input = object(entry);
      const entityId = string(input.entityId);
      if (entityId !== issueId || string(input.entityType) !== "issue") {
        throw new BrokerError("ambiguous_response", 503);
      }
      return {
        action: string(input.action),
        actorType: string(input.actorType),
        actorId: nullableString(input.actorId),
        entityType: "issue",
        entityId,
        createdAt: timestamp(input.createdAt),
        details: input.details,
      };
    });
  }

  async getInteractions(issueId: string): Promise<PaperclipInteraction[]> {
    const payload = await this.#get(`/api/issues/${encodeURIComponent(issueId)}/interactions`);
    if (!Array.isArray(payload)) throw new BrokerError("ambiguous_response", 503);
    return payload.map((entry) => {
      const input = object(entry);
      const returnedIssueId = string(input.issueId);
      if (returnedIssueId !== issueId) throw new BrokerError("ambiguous_response", 503);
      return {
        id: string(input.id),
        issueId: returnedIssueId,
        kind: string(input.kind),
        status: string(input.status),
        resolvedByUserId: nullableString(input.resolvedByUserId),
        resolvedAt: input.resolvedAt === null ? null : timestamp(input.resolvedAt),
      };
    });
  }

  async #get(path: string): Promise<unknown> {
    return fetchJson(this.#url(path), { headers: this.#headers }, new Set([200]));
  }

  #url(path: string): URL {
    return new URL(path, this.#baseUrl);
  }
}

export class GitLabApiClient implements GitLabMerger {
  readonly #baseUrl: URL;
  readonly #projectId: number;
  readonly #headers: Record<string, string>;

  constructor(apiUrl: string, projectId: number, token: string) {
    this.#baseUrl = normalizeBaseUrl(apiUrl);
    this.#projectId = projectId;
    this.#headers = { "PRIVATE-TOKEN": token };
  }

  async getMergeRequest(iid: number): Promise<GitLabMergeRequest> {
    const input = object(await fetchJson(
      this.#url(`/api/v4/projects/${this.#projectId}/merge_requests/${iid}?include_diverged_commits_count=true`),
      { headers: this.#headers },
      new Set([200]),
    ));
    const returnedIid = positiveInteger(input.iid);
    if (returnedIid !== iid) throw new BrokerError("ambiguous_response", 503);
    const pipeline = input.head_pipeline === null ? null : object(input.head_pipeline);
    return {
      iid: returnedIid,
      state: string(input.state),
      draft: boolean(input.draft),
      target_branch: string(input.target_branch),
      source_branch: string(input.source_branch),
      title: string(input.title),
      sha: string(input.sha),
      merge_status: string(input.merge_status),
      has_conflicts: boolean(input.has_conflicts),
      diverged_commits_count: nonNegativeInteger(input.diverged_commits_count),
      head_pipeline: pipeline ? { id: positiveInteger(pipeline.id), status: string(pipeline.status) } : null,
      merge_commit_sha: input.merge_commit_sha === undefined ? null : nullableString(input.merge_commit_sha),
      squash_commit_sha: input.squash_commit_sha === undefined ? null : nullableString(input.squash_commit_sha),
    };
  }

  async getPipeline(pipelineId: number): Promise<GitLabPipeline> {
    const input = object(await fetchJson(
      this.#url(`/api/v4/projects/${this.#projectId}/pipelines/${pipelineId}`),
      { headers: this.#headers },
      new Set([200]),
    ));
    const id = positiveInteger(input.id);
    if (id !== pipelineId) throw new BrokerError("ambiguous_response", 503);
    return {
      id,
      status: string(input.status),
      source: string(input.source),
      web_url: typeof input.web_url === "string" ? input.web_url : undefined,
    };
  }

  async merge(iid: number, expectedHeadSha: string): Promise<MergeResult> {
    const input = object(await fetchJson(
      this.#url(`/api/v4/projects/${this.#projectId}/merge_requests/${iid}/merge`),
      {
        method: "PUT",
        headers: { ...this.#headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          sha: expectedHeadSha,
          squash: true,
          should_remove_source_branch: true,
        }),
      },
      new Set([200, 201]),
    ));
    return {
      state: string(input.state),
      sha: string(input.sha),
      merge_commit_sha: nullableString(input.merge_commit_sha),
      squash_commit_sha: nullableString(input.squash_commit_sha),
    };
  }

  #url(path: string): URL {
    return new URL(path, this.#baseUrl);
  }
}

export function normalizeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid API URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid API URL");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  return url;
}
