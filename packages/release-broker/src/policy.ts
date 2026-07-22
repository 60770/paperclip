import { BrokerError } from "./errors.js";
import { isFullSha, isUuid } from "./validation.js";
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
const FEATURE_JIRA_KEY = /^feature\/(TAIA-\d+)(?:-|$)/;
const TITLE_JIRA_KEY = /\b(TAIA-\d+)\b/;
const MAIN_LOCK = "[MAIN_LOCKED]:";
const MAIN_UNLOCK = "[MAIN_UNLOCKED]:";
const HUMAN_REQUIRED = /^\[HUMAN_DECISION_REQUIRED\]:/m;
const HUMAN_UNBLOCKED = /^\[HUMAN_DECISION_UNBLOCKED\]:[^\n]*\bvia=([^\s]+)/m;
const SECURITY_SEVERITY = /^(?:BLOCKER|MEDIUM|HIGH|CRITICAL)/i;
const SECURITY_FINDING_SEPARATOR = /^(?:\s*(?::|[–—])|\s+|$)/;
const AMBIGUOUS_SECURITY_PREFIX = /^(?:<[^>\n]{1,64}>|\[[^\]\n]{0,32}\]|[^A-Za-z0-9<\[]+)[ \t]*/;
const MAX_SECURITY_MARKDOWN_DEPTH = 8;

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

function approvalLines(markdown: string): string[] {
  const lines: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  let quotedParagraph = false;

  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1]![0] === fence.marker &&
        fenceMatch[1]!.length >= fence.length &&
        fenceMatch[2]!.trim().length === 0
      ) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      continue;
    }
    if (trimmed.startsWith(">")) {
      quotedParagraph = trimmed.slice(1).trim().length > 0;
      continue;
    }
    if (quotedParagraph) {
      if (trimmed.length === 0) quotedParagraph = false;
      continue;
    }
    lines.push(line);
  }
  return lines;
}

function hasSecurityFinding(lines: string[]): boolean {
  return lines.some(hasSecurityFindingLine);
}

// Grammar: up to eight total list, task-list, heading, emphasis, or inline-code
// containers, followed by a severity label. Excess depth and severity-like
// labels hidden by other Markdown forms fail closed.
function hasSecurityFindingLine(line: string): boolean {
  let normalized = line.trimStart();
  let depth = 0;

  while (depth < MAX_SECURITY_MARKDOWN_DEPTH) {
    const next = stripSecurityMarkdownContainer(normalized);
    if (next === null) break;
    normalized = next.trimStart();
    depth += 1;
  }

  if (stripSecurityMarkdownContainer(normalized) !== null) return true;
  if (hasAllowlistedSecurityLabel(normalized, MAX_SECURITY_MARKDOWN_DEPTH - depth)) return true;
  return hasAmbiguousSecurityLabel(normalized);
}

function stripSecurityMarkdownContainer(value: string): string | null {
  const list = /^(?:[-*+]|\d{1,9}[.)])[ \t]+/.exec(value);
  if (list) return value.slice(list[0].length);

  const task = /^\[[ xX]\][ \t]+/.exec(value);
  if (task) return value.slice(task[0].length);

  const heading = /^#{1,6}(?:[ \t]+|$)/.exec(value);
  if (heading) return value.slice(heading[0].length);

  return null;
}

function hasAllowlistedSecurityLabel(value: string, remainingDepth: number): boolean {
  const closers: string[] = [];
  let offset = 0;

  while (value[offset] === "*" || value[offset] === "_" || value[offset] === "`") {
    const marker = value[offset]!;
    let length = 1;
    while (value[offset + length] === marker) length += 1;
    if (length > 3) return hasAmbiguousSecurityLabel(value);
    if (closers.length >= remainingDepth) return true;
    const delimiter = marker.repeat(length);
    closers.push(delimiter);
    offset += length;
  }

  const severity = SECURITY_SEVERITY.exec(value.slice(offset));
  if (!severity) return false;
  offset += severity[0].length;

  for (const closer of closers.reverse()) {
    if (!value.startsWith(closer, offset)) return true;
    offset += closer.length;
  }

  const suffix = value.slice(offset);
  if (SECURITY_FINDING_SEPARATOR.test(suffix)) return true;
  if (closers.length === 0 && /^-[A-Za-z0-9]/.test(suffix)) return false;
  return !/^[A-Za-z0-9]/.test(suffix);
}

function hasAmbiguousSecurityLabel(value: string): boolean {
  let candidate = value;

  for (let depth = 0; depth < MAX_SECURITY_MARKDOWN_DEPTH; depth += 1) {
    const wrapper = /^(?:<([^>\n]{1,64})>|\[([^\]\n]{0,32})\])/.exec(candidate);
    const wrappedLabel = wrapper?.[1] ?? wrapper?.[2];
    if (wrappedLabel && hasSecurityLabelCandidate(wrappedLabel.trimStart())) return true;

    const prefix = AMBIGUOUS_SECURITY_PREFIX.exec(candidate);
    if (!prefix) break;
    candidate = candidate.slice(prefix[0].length);
  }

  if (AMBIGUOUS_SECURITY_PREFIX.test(candidate)) return true;
  return hasSecurityLabelCandidate(candidate);
}

function hasSecurityLabelCandidate(value: string): boolean {
  const severity = SECURITY_SEVERITY.exec(value);
  if (!severity) return false;
  const suffix = value.slice(severity[0].length);
  if (SECURITY_FINDING_SEPARATOR.test(suffix)) return true;
  return !/^[A-Za-z0-9-]/.test(suffix);
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
    const waiverAllowed = await this.#allowsQaWaiver(issue);
    const releaseBotMention = `(agent://${this.#config.releaseBotAgentId})`;

    for (const comment of comments.filter(isLive)) {
      const tokenKey = keyOf(comment);
      const target = markers.filter((marker) => compareKeys(keyOf(marker.comment), tokenKey) <= 0).at(-1);
      if (!target || target.iid !== expectedIid || comment.authorType !== "agent") continue;
      const tokenLines = approvalLines(comment.body);
      if (!tokenLines.some((line) => line.includes(releaseBotMention))) continue;

      const agent = await this.#paperclip.getAgent(comment.authorAgentId!);
      const isReviewer = agent.role === "engineer" && agent.urlKey.startsWith("reviewer");
      const isTester = agent.role === "qa" && agent.urlKey.startsWith("tester");

      if (
        isReviewer &&
        comment.authorAgentId !== candidate.authorAgentId &&
        tokenLines.some((line) => REVIEW_TOKEN.test(line)) &&
        !hasSecurityFinding(comment.body.split(/\r?\n/))
      ) {
        review = true;
      }
      if (isTester && tokenLines.some((line) => QA_TOKEN.test(line))) qa = true;
      const waiver = tokenLines.map((line) => WAIVER_TOKEN.exec(line)).find((match) => match !== null);
      if (waiverAllowed && isReviewer && waiver && waiver[1]!.trim().length >= 5) qa = true;
    }

    if (!review || !qa) throw new BrokerError("paperclip_not_ready", 409);
  }

  async #allowsQaWaiver(issue: PaperclipIssue): Promise<boolean> {
    const policy = record(issue.executionPolicy);
    const state = record(issue.executionState);
    const stages = policy && Array.isArray(policy.stages) ? policy.stages : [];
    if (
      policy?.mode !== "normal" ||
      policy.commentRequired !== true ||
      stages.length !== 2 ||
      !state ||
      state.status !== "pending"
    ) return false;

    const reviewStage = record(stages[0]);
    const approvalStage = record(stages[1]);
    const reviewParticipants = reviewStage && Array.isArray(reviewStage.participants)
      ? reviewStage.participants.map(record)
      : [];
    const approvalParticipants = approvalStage && Array.isArray(approvalStage.participants)
      ? approvalStage.participants.map(record)
      : [];
    if (
      !reviewStage ||
      reviewStage.type !== "review" ||
      reviewStage.approvalsNeeded !== 1 ||
      !isUuid(reviewStage.id) ||
      reviewParticipants.length === 0 ||
      reviewParticipants.some((participant) =>
        !participant ||
        participant.type !== "agent" ||
        !isUuid(participant.id) ||
        !isUuid(participant.agentId) ||
        participant.userId !== null
      ) ||
      !approvalStage ||
      approvalStage.type !== "approval" ||
      approvalStage.approvalsNeeded !== 1 ||
      !isUuid(approvalStage.id) ||
      approvalParticipants.length !== 1 ||
      approvalParticipants[0]?.type !== "agent" ||
      !isUuid(approvalParticipants[0]?.id) ||
      approvalParticipants[0]?.agentId !== this.#config.releaseBotAgentId ||
      approvalParticipants[0]?.userId !== null
    ) return false;

    const currentParticipant = record(state.currentParticipant);
    const completedStageIds = Array.isArray(state.completedStageIds) ? state.completedStageIds : [];
    if (
      state.currentStageId !== approvalStage.id ||
      state.currentStageIndex !== 1 ||
      state.currentStageType !== "approval" ||
      currentParticipant?.type !== "agent" ||
      currentParticipant.agentId !== this.#config.releaseBotAgentId ||
      currentParticipant.userId !== null ||
      completedStageIds.length !== 1 ||
      completedStageIds[0] !== reviewStage.id ||
      !isUuid(state.lastDecisionId) ||
      state.lastDecisionOutcome !== "approved"
    ) return false;

    for (const participant of reviewParticipants) {
      const agent = await this.#paperclip.getAgent(participant!.agentId as string);
      if (agent.role !== "engineer" || !agent.urlKey.startsWith("reviewer")) return false;
    }
    return true;
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
    if (mr.head_pipeline === null) throw new BrokerError("mr_not_ready", 409);
    if (!isFullSha(mr.head_pipeline.sha) || mr.head_pipeline.sha !== expectedHeadSha) {
      throw new BrokerError("sha_mismatch", 409);
    }
    if (
      mr.state !== "opened" ||
      mr.draft ||
      mr.target_branch !== "main" ||
      mr.merge_status !== "can_be_merged" ||
      mr.has_conflicts ||
      mr.diverged_commits_count !== 0 ||
      mr.head_pipeline.status !== "success"
    ) {
      throw new BrokerError("mr_not_ready", 409);
    }
    const pipeline = await this.#gitlab.getPipeline(mr.head_pipeline.id);
    if (!isFullSha(pipeline.sha) || pipeline.sha !== expectedHeadSha) {
      throw new BrokerError("sha_mismatch", 409);
    }
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
