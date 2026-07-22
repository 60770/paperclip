import { BrokerError, asBrokerError } from "./errors.js";
import type { CapabilityStore } from "./capability-store.js";
import type { ReleasePolicy } from "./policy.js";
import type {
  AuditEvent,
  AuditSink,
  CapabilityRequest,
  CapabilityResponse,
  GitLabMerger,
  MergeCapabilityRequest,
  MergeResponse,
} from "./types.js";

export interface ReleaseBrokerConfig {
  companyId: string;
  gitlabProjectId: number;
  allowedClientIdentities: ReadonlySet<string>;
}

export class ReleaseBroker {
  readonly #config: ReleaseBrokerConfig;
  readonly #store: CapabilityStore;
  readonly #policy: Pick<ReleasePolicy, "authorize" | "immediatePreflight">;
  readonly #gitlab: GitLabMerger;
  readonly #audit: AuditSink;

  constructor(options: {
    config: ReleaseBrokerConfig;
    store: CapabilityStore;
    policy: Pick<ReleasePolicy, "authorize" | "immediatePreflight">;
    gitlab: GitLabMerger;
    audit: AuditSink;
  }) {
    this.#config = options.config;
    this.#store = options.store;
    this.#policy = options.policy;
    this.#gitlab = options.gitlab;
    this.#audit = options.audit;
  }

  async requestCapability(clientIdentity: string, request: CapabilityRequest): Promise<CapabilityResponse> {
    try {
      this.#assertClient(clientIdentity);
      const context = await this.#policy.authorize(request);
      const issued = this.#store.issue({
        ...request,
        clientIdentity,
        companyId: this.#config.companyId,
        gitlabProjectId: this.#config.gitlabProjectId,
        targetBranch: "main",
        generation: context.attestation.generation,
      });
      await this.#writeAudit({
        event: "capability_issued",
        decision: "allow",
        reason: "policy_clear",
        requestId: request.requestId,
        issueId: request.issueId,
        mrIid: request.mrIid,
        expectedHeadSha: request.expectedHeadSha,
        generation: context.attestation.generation,
        clientIdentity,
      });
      return {
        capability: issued.capability,
        expiresAt: new Date(issued.claims.expiresAt).toISOString(),
        requestId: request.requestId,
      };
    } catch (error) {
      const brokerError = asBrokerError(error);
      await this.#writeAudit({
        event: "capability_denied",
        decision: "deny",
        reason: brokerError.code,
        requestId: request.requestId,
        issueId: request.issueId,
        mrIid: request.mrIid,
        expectedHeadSha: request.expectedHeadSha,
        clientIdentity,
      });
      throw brokerError;
    }
  }

  async merge(clientIdentity: string, request: MergeCapabilityRequest): Promise<MergeResponse> {
    let claims;
    try {
      this.#assertClient(clientIdentity);
      claims = this.#store.consume(request.capability, request.requestId, clientIdentity);
      await this.#writeAudit({
        event: "capability_consumed",
        decision: "allow",
        reason: "single_use_claimed",
        requestId: claims.requestId,
        issueId: claims.issueId,
        mrIid: claims.mrIid,
        expectedHeadSha: claims.expectedHeadSha,
        generation: claims.generation,
        clientIdentity,
      });

      await this.#policy.immediatePreflight(claims, claims.generation);
      const result = await this.#gitlab.merge(claims.mrIid, claims.expectedHeadSha);
      if (result.state !== "merged" || result.sha !== claims.expectedHeadSha) {
        throw new BrokerError("ambiguous_response", 503);
      }
      const mergeCommitSha = result.merge_commit_sha ?? result.squash_commit_sha;
      if (!mergeCommitSha) throw new BrokerError("ambiguous_response", 503);

      await this.#writeAudit({
        event: "merge_completed",
        decision: "result",
        reason: "merged",
        requestId: claims.requestId,
        issueId: claims.issueId,
        mrIid: claims.mrIid,
        expectedHeadSha: claims.expectedHeadSha,
        generation: claims.generation,
        clientIdentity,
        mergeCommitSha,
      });
      return { status: "merged", mergeCommitSha, requestId: claims.requestId };
    } catch (error) {
      const brokerError = asBrokerError(error);
      await this.#writeAudit({
        event: "merge_denied",
        decision: "deny",
        reason: brokerError.code,
        requestId: claims?.requestId ?? request.requestId,
        issueId: claims?.issueId,
        mrIid: claims?.mrIid,
        expectedHeadSha: claims?.expectedHeadSha,
        generation: claims?.generation,
        clientIdentity,
      });
      throw brokerError;
    }
  }

  #assertClient(clientIdentity: string): void {
    if (!this.#config.allowedClientIdentities.has(clientIdentity)) {
      throw new BrokerError("client_denied", 403);
    }
  }

  async auditBoundaryDenial(clientIdentity: string, requestId: string, reason: string): Promise<void> {
    await this.#writeAudit({
      event: "request_denied",
      decision: "deny",
      reason,
      requestId,
      clientIdentity,
    });
  }

  async #writeAudit(event: AuditEvent): Promise<void> {
    await this.#audit.write(event);
  }
}
