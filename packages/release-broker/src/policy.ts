import { BrokerError } from "./errors.js";
import { isFullSha } from "./validation.js";
import type {
  AttestationEvidence,
  AttestationProvider,
  CapabilityRequest,
  GitLabMergeRequest,
  GitLabReader,
  PaperclipActivity,
  PaperclipComment,
  PaperclipIssue,
  PaperclipReader,
  ReleasePolicyConfig,
} from "./types.js";

const MR_LINE = /^MR: https:\/\/gitlab\.tidycode\.it\/tidycode\/TaIA\/-\/merge_requests\/(\d+)$/;
const REVIEW_TOKEN = /^APPROVED-REVIEW$/m;
const QA_TOKEN = /^APPROVED-QA$/m;
const WAIVER_TOKEN = /^APPROVED-QA-WAIVED: (\S(?:.*\S)?)$/m;
const SECURITY_FINDING = /^(?:\s*[-*]\s*)?(?:BLOCKER|HIGH)(?:\s|:)/im;
const FEATURE_JIRA_KEY = /^feature\/(TAIA-\d+)(?:-|$)/;
const TITLE_JIRA_KEY = /\b(TAIA-\d+)\b/;
const MAIN_LOCK = "[MAIN_LOCKED]:";
const MAIN_UNLOCK = "[MAIN_UNLOCKED]:";
const HUMAN_REQUIRED = /^\[HUMAN_DECISION_REQUIRED\]:/m;
const HUMAN_UNBLOCKED = /^\[HUMAN_DECISION_UNBLOCKED\]:[^\n]*\bvia=([^\s]+)/m;

interface MrMarker {
  iid: number;
  comment: PaperclipComment;
  authorAgentId: string | null;
}

export interface AuthorizedContext {
  attestation: AttestationEvidence;
  issue: PaperclipIssue;
  mr: GitLabMergeRequest;
  jiraKey: string;
}

interface MarkerEvent {
  kind: "lock" | "unlock";
  createdAt: string;
  commentId: string;
  lineIndex: number;
  key?: string;
  comment: PaperclipComment;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function keyOf(comment: PaperclipComment): [string, string] {
  return [comment.createdAt, comment.id];
}

function compareKeys(left: [string, string], right: [string, string]): number {
  return Date.parse(left[0]) - Date.parse(right[0]) || left[1].localeCompare(right[1]);
}

function isAfter(left: string, right: string): boolean {
  return Date.parse(left) > Date.parse(right);
}

function isLive(comment: PaperclipComment): boolean {
  return comment.deletedAt === null;
}

function assertAuthorShape(comment: PaperclipComment): void {
  const valid =
    (comment.authorType === "agent" && comment.authorAgentId !== null && comment.authorUserId === null) ||
    (comment.authorType === "user" && comment.authorAgentId === null && comment.authorUserId !== null) ||
    (comment.authorType === "system" && comment.authorAgentId === null && comment.authorUserId === null);
  if (!valid) throw new BrokerError("ambiguous_response", 503);
}

export class ReleasePolicy {
  readonly #paperclip: PaperclipReader;
  readonly #gitlab: GitLabReader;
  readonly #attestation: AttestationProvider;
  readonly #config: ReleasePolicyConfig;

  constructor(
    paperclip: PaperclipReader,
    gitlab: GitLabReader,
    attestation: AttestationProvider,
    config: ReleasePolicyConfig,
  ) {
    this.#paperclip = paperclip;
    this.#gitlab = gitlab;
    this.#attestation = attestation;
    this.#config = config;
  }

  async authorize(request: CapabilityRequest): Promise<AuthorizedContext> {
    const attestation = await this.#attestation.verify();
    const issue = await this.#paperclip.getIssue(request.issueId);
    this.#assertIssue(issue);
    await this.#assertFreshApprovals(issue, request.mrIid);

    const mr = await this.#gitlab.getMergeRequest(request.mrIid);
    await this.#assertMergeRequest(mr, request.mrIid, request.expectedHeadSha);
    const jiraKey = deriveJiraKey(mr);
    await this.#assertMainLock(jiraKey);
    await this.#assertHumanGate(issue.id);

    return { attestation, issue, mr, jiraKey };
  }

  async immediatePreflight(request: CapabilityRequest, generation: number): Promise<AuthorizedContext> {
    const attestation = await this.#attestation.verify();
    if (attestation.generation !== generation) {
      throw new BrokerError("attestation_failed", 503);
    }

    const issue = await this.#paperclip.getIssue(request.issueId);
    this.#assertIssue(issue);
    await this.#assertFreshApprovals(issue, request.mrIid);
    const firstMr = await this.#mergeRequestJiraKey(request);
    await this.#assertMainLock(firstMr.jiraKey);
    await this.#assertHumanGate(issue.id);

    const finalMr = await this.#mergeRequestJiraKey(request);
    if (finalMr.jiraKey !== firstMr.jiraKey) throw new BrokerError("mr_not_ready", 409);
    return { attestation, issue, mr: finalMr.mr, jiraKey: finalMr.jiraKey };
  }

  #assertIssue(issue: PaperclipIssue): void {
    if (issue.companyId !== this.#config.companyId) {
      throw new BrokerError("company_mismatch", 403);
    }
    if (issue.status !== "in_review" || issue.assigneeAgentId !== this.#config.releaseBotAgentId) {
      throw new BrokerError("paperclip_not_ready", 409);
    }
  }

  async #assertFreshApprovals(issue: PaperclipIssue, expectedIid: number): Promise<void> {
    const comments = await this.#paperclip.getComments(issue.id);
    for (const comment of comments) assertAuthorShape(comment);
    const markers: MrMarker[] = [];

    for (const comment of comments.filter(isLive)) {
      const matches = comment.body.split("\n")
        .map((line) => MR_LINE.exec(line))
        .filter((match): match is RegExpExecArray => match !== null);
      if (matches.length === 0) continue;
      if (matches.length !== 1 || comment.authorType === "system") {
        throw new BrokerError("paperclip_not_ready", 409);
      }

      let eligible = comment.authorType === "user";
      if (comment.authorType === "agent") {
        const agent = await this.#paperclip.getAgent(comment.authorAgentId!);
        eligible = agent.role === "cto" || (agent.role === "engineer" && agent.urlKey.startsWith("dev"));
      }
      if (!eligible) continue;
      markers.push({
        iid: Number(matches[0][1]),
        comment,
        authorAgentId: comment.authorAgentId,
      });
    }

    markers.sort((left, right) => compareKeys(keyOf(left.comment), keyOf(right.comment)));
    const candidate = markers.at(-1);
    if (!candidate || candidate.iid !== expectedIid) {
      throw new BrokerError("paperclip_not_ready", 409);
    }

    let review = false;
    let qa = false;
    const releaseBotMention = `(agent://${this.#config.releaseBotAgentId})`;

    for (const comment of comments.filter(isLive)) {
      const tokenKey = keyOf(comment);
      const target = markers.filter((marker) => compareKeys(keyOf(marker.comment), tokenKey) <= 0).at(-1);
      if (!target || target.iid !== expectedIid || comment.authorType !== "agent") continue;
      if (!comment.body.includes(releaseBotMention)) continue;

      const agent = await this.#paperclip.getAgent(comment.authorAgentId!);
      const isReviewer = agent.role === "engineer" && agent.urlKey.startsWith("reviewer");
      const isTester = agent.role === "qa" && agent.urlKey.startsWith("tester");

      if (
        isReviewer &&
        comment.authorAgentId !== candidate.authorAgentId &&
        REVIEW_TOKEN.test(comment.body) &&
        !SECURITY_FINDING.test(comment.body)
      ) {
        review = true;
      }
      if (isTester && QA_TOKEN.test(comment.body)) qa = true;
      const waiver = WAIVER_TOKEN.exec(comment.body);
      if (isReviewer && waiver && waiver[1]!.trim().length >= 5) qa = true;
    }

    if (!review || !qa) throw new BrokerError("paperclip_not_ready", 409);
  }

  async #mergeRequestJiraKey(request: CapabilityRequest): Promise<{ mr: GitLabMergeRequest; jiraKey: string }> {
    const mr = await this.#gitlab.getMergeRequest(request.mrIid);
    await this.#assertMergeRequest(mr, request.mrIid, request.expectedHeadSha);
    return { mr, jiraKey: deriveJiraKey(mr) };
  }

  async #assertMergeRequest(mr: GitLabMergeRequest, expectedIid: number, expectedHeadSha: string): Promise<void> {
    if (mr.iid !== expectedIid) {
      throw new BrokerError("ambiguous_response", 503);
    }
    if (!isFullSha(mr.sha) || mr.sha !== expectedHeadSha) {
      throw new BrokerError("sha_mismatch", 409);
    }
    if (
      mr.state !== "opened" ||
      mr.draft ||
      mr.target_branch !== "main" ||
      mr.merge_status !== "can_be_merged" ||
      mr.has_conflicts ||
      mr.diverged_commits_count !== 0 ||
      mr.head_pipeline === null ||
      mr.head_pipeline.status !== "success"
    ) {
      throw new BrokerError("mr_not_ready", 409);
    }
    const pipeline = await this.#gitlab.getPipeline(mr.head_pipeline.id);
    if (
      pipeline.id !== mr.head_pipeline.id ||
      pipeline.status !== "success" ||
      !this.#config.allowedPipelineSources.has(pipeline.source)
    ) {
      throw new BrokerError("mr_not_ready", 409);
    }
  }

  async #assertMainLock(candidateKey: string): Promise<void> {
    const issue = await this.#paperclip.getIssue(this.#config.mainLockIssue);
    if (issue.companyId !== this.#config.companyId) {
      throw new BrokerError("company_mismatch", 403);
    }
    const comments = await this.#paperclip.getComments(issue.id);
    const events: MarkerEvent[] = [];

    for (const comment of comments) {
      assertAuthorShape(comment);
      if (!isLive(comment)) continue;
      for (const [lineIndex, line] of comment.body.split("\n").entries()) {
        if (line.startsWith(MAIN_LOCK)) {
          if (comment.authorType === "system") continue;
          const match = /^(?:\[MAIN_LOCKED\]:)\s+([A-Z][A-Z0-9]+-\d+|NO-JIRA)(?:\s|$)/.exec(line);
          if (!match) throw new BrokerError("ambiguous_response", 503);
          events.push({
            kind: "lock",
            createdAt: comment.createdAt,
            commentId: comment.id,
            lineIndex,
            key: match[1],
            comment,
          });
        } else if (line.startsWith(MAIN_UNLOCK)) {
          events.push({ kind: "unlock", createdAt: comment.createdAt, commentId: comment.id, lineIndex, comment });
        }
      }
    }

    const timestamps = [...new Set(events.map((event) => Date.parse(event.createdAt)))].sort((left, right) => right - left);
    for (const createdAt of timestamps) {
      const tied = events.filter((event) => Date.parse(event.createdAt) === createdAt);
      const locks = tied.filter((event) => event.kind === "lock")
        .sort((left, right) => left.commentId.localeCompare(right.commentId) || left.lineIndex - right.lineIndex);
      if (locks.length > 0) {
        if (locks[0]!.key !== candidateKey) throw new BrokerError("main_lock_active", 409);
        return;
      }

      for (const unlock of tied.filter((event) => event.kind === "unlock")) {
        const author = unlock.comment;
        if (author.authorType === "user") return;
        if (author.authorType === "agent") {
          if (author.authorAgentId === this.#config.releaseBotAgentId) return;
          const agent = await this.#paperclip.getAgent(author.authorAgentId!);
          if (agent.role === "cto") return;
        }
      }
    }
  }

  async #assertHumanGate(candidateIssueId: string): Promise<void> {
    const seen = new Set<string>();
    let currentId: string | null = candidateIssueId;

    for (let depth = 0; currentId !== null && depth < 100; depth += 1) {
      if (seen.has(currentId)) throw new BrokerError("ambiguous_response", 503);
      seen.add(currentId);
      const issue = await this.#paperclip.getIssue(currentId);
      if (issue.companyId !== this.#config.companyId) throw new BrokerError("company_mismatch", 403);
      const comments = await this.#paperclip.getComments(issue.id);
      const required = comments
        .filter((comment) => isLive(comment) && comment.authorType !== "system" && HUMAN_REQUIRED.test(comment.body))
        .sort((left, right) => compareKeys(keyOf(left), keyOf(right)))
        .at(-1);

      if (required && !(await this.#isHumanDecisionReleased(issue, required, comments))) {
        throw new BrokerError("human_gate_blocked", 409);
      }
      currentId = issue.parentId;
    }
    if (currentId !== null) throw new BrokerError("ambiguous_response", 503);
  }

  async #isHumanDecisionReleased(
    issue: PaperclipIssue,
    required: PaperclipComment,
    comments: PaperclipComment[],
  ): Promise<boolean> {
    if (await this.#isExecutionDecisionReleased(issue, required.createdAt)) return true;

    const unblocked = comments
      .filter((comment) => {
        const match = HUMAN_UNBLOCKED.exec(comment.body);
        return isLive(comment) && match !== null && compareKeys(keyOf(comment), keyOf(required)) > 0;
      })
      .sort((left, right) => compareKeys(keyOf(left), keyOf(right)))
      .at(-1);
    if (!unblocked) return false;
    const via = HUMAN_UNBLOCKED.exec(unblocked.body)?.[1];
    if (!via) return false;

    const interactions = await this.#paperclip.getInteractions(issue.id);
    if (interactions.some((interaction) =>
      interaction.id === via &&
      interaction.kind === "request_confirmation" &&
      interaction.status === "accepted" &&
      interaction.resolvedByUserId !== null &&
      interaction.resolvedAt !== null &&
      isAfter(interaction.resolvedAt, required.createdAt)
    )) return true;

    const comment = await this.#paperclip.getComment(issue.id, via);
    return comment !== null &&
      isLive(comment) &&
      comment.authorType === "user" &&
      comment.authorUserId !== null &&
      isAfter(comment.createdAt, required.createdAt);
  }

  async #isExecutionDecisionReleased(issue: PaperclipIssue, requiredAt: string): Promise<boolean> {
    const policy = record(issue.executionPolicy);
    const state = record(issue.executionState);
    const stages = policy && Array.isArray(policy.stages) ? policy.stages : [];
    if (!state || stages.length !== 1) return false;
    const stage = record(stages[0]);
    const participants = stage && Array.isArray(stage.participants) ? stage.participants : [];
    const participant = record(participants[0]);
    const completed = Array.isArray(state.completedStageIds) ? state.completedStageIds : [];
    if (
      !stage ||
      stage.type !== "approval" ||
      typeof stage.id !== "string" ||
      participants.length !== 1 ||
      !participant ||
      participant.type !== "user" ||
      typeof participant.userId !== "string" ||
      state.lastDecisionOutcome !== "approved" ||
      typeof state.lastDecisionId !== "string" ||
      completed.length !== 1 ||
      !completed.includes(stage.id)
    ) return false;

    const activity = await this.#paperclip.getActivity(issue.id);
    return activity.some((entry) => this.#activityProvesDecision(
      entry,
      requiredAt,
      participant.userId as string,
      state.lastDecisionId as string,
      stage.id as string,
    ));
  }

  #activityProvesDecision(
    activity: PaperclipActivity,
    requiredAt: string,
    userId: string,
    decisionId: string,
    stageId: string,
  ): boolean {
    if (
      activity.action !== "issue.updated" ||
      activity.actorType !== "user" ||
      activity.actorId !== userId ||
      !isAfter(activity.createdAt, requiredAt)
    ) return false;
    const details = record(activity.details);
    const executionState = record(details?.executionState);
    const completed = Array.isArray(executionState?.completedStageIds) ? executionState.completedStageIds : [];
    const exactDecision = executionState?.lastDecisionId === decisionId &&
      executionState.lastDecisionOutcome === "approved" && completed.includes(stageId);
    const automaticComment = details?.source === "auto_approval_comment" &&
      details.status === "done" && record(details._previous)?.status === "in_review";
    return exactDecision || automaticComment;
  }
}

export function deriveJiraKey(mr: GitLabMergeRequest): string {
  return FEATURE_JIRA_KEY.exec(mr.source_branch)?.[1] ?? TITLE_JIRA_KEY.exec(mr.title)?.[1] ?? "NO-JIRA";
}
