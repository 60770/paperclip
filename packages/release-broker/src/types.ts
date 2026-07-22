export interface CapabilityRequest {
  issueId: string;
  mrIid: number;
  expectedHeadSha: string;
  requestId: string;
}

export interface MergeCapabilityRequest {
  capability: string;
  requestId: string;
}

export interface CapabilityClaims extends CapabilityRequest {
  clientIdentity: string;
  companyId: string;
  gitlabProjectId: number;
  targetBranch: "main";
  generation: number;
  issuedAt: number;
  expiresAt: number;
}

export interface CapabilityResponse {
  capability: string;
  expiresAt: string;
  requestId: string;
}

export interface MergeResponse {
  status: "merged" | "already_merged";
  mergeCommitSha: string;
  requestId: string;
}

export interface PaperclipAgent {
  id: string;
  role: string;
  urlKey: string;
}

export interface PaperclipComment {
  id: string;
  issueId: string;
  body: string;
  createdAt: string;
  deletedAt: string | null;
  authorType: "agent" | "user" | "system";
  authorAgentId: string | null;
  authorUserId: string | null;
}

export interface PaperclipIssue {
  id: string;
  identifier: string;
  companyId: string;
  parentId: string | null;
  status: string;
  assigneeAgentId: string | null;
  executionPolicy: unknown;
  executionState: unknown;
}

export interface PaperclipActivity {
  action: string;
  actorType: string;
  actorId: string | null;
  entityType: string;
  entityId: string;
  createdAt: string;
  details: unknown;
}

export interface PaperclipInteraction {
  id: string;
  issueId: string;
  kind: string;
  status: string;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
}

export interface GitLabPipeline {
  id: number;
  sha: string;
  status: string;
  source: string;
  web_url?: string;
}

export interface GitLabMergeRequest {
  iid: number;
  state: string;
  draft: boolean;
  target_branch: string;
  source_branch: string;
  title: string;
  sha: string;
  merge_status: string;
  has_conflicts: boolean;
  diverged_commits_count: number;
  head_pipeline: { id: number; sha: string; status: string } | null;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
}

export interface MergeResult {
  state: string;
  sha: string;
  merge_commit_sha: string | null;
  squash_commit_sha: string | null;
}

export interface PaperclipReader {
  getIssue(issueId: string): Promise<PaperclipIssue>;
  getComments(issueId: string): Promise<PaperclipComment[]>;
  getComment(issueId: string, commentId: string): Promise<PaperclipComment | null>;
  getAgent(agentId: string): Promise<PaperclipAgent>;
  getActivity(issueId: string): Promise<PaperclipActivity[]>;
  getInteractions(issueId: string): Promise<PaperclipInteraction[]>;
}

export interface GitLabReader {
  getMergeRequest(iid: number): Promise<GitLabMergeRequest>;
  getPipeline(pipelineId: number): Promise<GitLabPipeline>;
}

export interface GitLabMerger extends GitLabReader {
  merge(iid: number, expectedHeadSha: string): Promise<MergeResult>;
}

export interface AttestationEvidence {
  generation: number;
  manifestSha256: string;
  sourceCommit: string;
}

export interface AttestationProvider {
  verify(): Promise<AttestationEvidence>;
}

export interface AuditEvent {
  event: string;
  decision: "allow" | "deny" | "result";
  reason: string;
  requestId: string;
  issueId?: string;
  mrIid?: number;
  expectedHeadSha?: string;
  generation?: number;
  clientIdentity?: string;
  mergeCommitSha?: string;
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}

export interface Clock {
  now(): number;
}

export interface ReleasePolicyConfig {
  companyId: string;
  gitlabProjectId: number;
  releaseBotAgentId: string;
  mainLockIssue: string;
  allowedPipelineSources: ReadonlySet<string>;
}
