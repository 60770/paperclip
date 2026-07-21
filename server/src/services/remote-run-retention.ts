import path from "node:path";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import {
  overrideAdapterExecutionTargetRemoteCwd,
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { and, inArray, or } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

export const DEFAULT_REMOTE_RUN_RETENTION_HOURS = 24;
export const DEFAULT_REMOTE_RUN_DISK_WARNING_PERCENT = 85;

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "scheduled_retry", "running"]);
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRASH_ENTRY_PATTERN = /^([0-9a-f-]{36})\.([0-9a-f-]{36})$/i;
const REMOTE_COMMAND_TIMEOUT_SEC = 120;

interface RemoteRunState {
  id: string;
  status: string;
  finishedAt: Date | null;
  retryOfRunId?: string | null;
}

interface RemoteCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

interface RemoteRunDirectory {
  kind: "run" | "trash";
  runId: string;
  entryName: string;
  bytes: number;
}

export interface RemoteRunRetentionConfig {
  retentionHours: number;
  diskWarningPercent: number;
}

export interface RemoteRunRetentionResult {
  enabled: boolean;
  runRoot: string | null;
  scannedCount: number;
  eligibleCount: number;
  deletedCount: number;
  bytesFreed: number;
  errorCount: number;
  skippedActiveCount: number;
  skippedRecentTerminalCount: number;
  skippedUnverifiableCount: number;
  skippedInvalidCount: number;
  diskUsedPercentBefore: number | null;
  diskUsedPercentAfter: number | null;
  diskUsedPercent: number | null;
  diskWarning: boolean;
  retentionHours: number;
  diskWarningPercent: number;
}

type RemoteCommandExecutor = (input: {
  target: AdapterExecutionTarget;
  command: string;
  timeoutSec: number;
}) => Promise<RemoteCommandResult>;

type RemoteRunLookup = (runIds: string[]) => Promise<RemoteRunState[]>;

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseWarningPercent(value: string | undefined) {
  const parsed = parseNonNegativeInteger(value, DEFAULT_REMOTE_RUN_DISK_WARNING_PERCENT);
  return parsed >= 1 && parsed <= 99 ? parsed : DEFAULT_REMOTE_RUN_DISK_WARNING_PERCENT;
}

export function resolveRemoteRunRetentionConfig(
  env: Record<string, string | undefined> = process.env,
): RemoteRunRetentionConfig {
  return {
    retentionHours: parseNonNegativeInteger(
      env.PAPERCLIP_REMOTE_RUN_RETENTION_HOURS,
      DEFAULT_REMOTE_RUN_RETENTION_HOURS,
    ),
    diskWarningPercent: parseWarningPercent(env.PAPERCLIP_REMOTE_RUN_DISK_WARNING_PERCENT),
  };
}

export function resolveRemoteRunRoot(remoteCwd: string) {
  const normalized = path.posix.normalize(remoteCwd);
  if (!normalized.startsWith("/")) {
    throw new Error("Remote run retention requires an absolute remote cwd");
  }
  const runRootSuffix = "/.paperclip-runtime/runs";
  if (normalized.endsWith(runRootSuffix)) return normalized;
  const marker = `${runRootSuffix}/`;
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) {
    return normalized.slice(0, markerIndex + marker.length - 1);
  }
  return path.posix.join(normalized, ".paperclip-runtime", "runs");
}

function emptyResult(config: RemoteRunRetentionConfig, runRoot: string | null, enabled: boolean): RemoteRunRetentionResult {
  return {
    enabled,
    runRoot,
    scannedCount: 0,
    eligibleCount: 0,
    deletedCount: 0,
    bytesFreed: 0,
    errorCount: 0,
    skippedActiveCount: 0,
    skippedRecentTerminalCount: 0,
    skippedUnverifiableCount: 0,
    skippedInvalidCount: 0,
    diskUsedPercentBefore: null,
    diskUsedPercentAfter: null,
    diskUsedPercent: null,
    diskWarning: false,
    retentionHours: config.retentionHours,
    diskWarningPercent: config.diskWarningPercent,
  };
}

function buildProbeCommand(runRoot: string, diskPath: string) {
  return [
    `run_root=${shellQuote(runRoot)}`,
    `disk_path=${shellQuote(diskPath)}`,
    'if [ -L "$run_root" ]; then printf "ROOT_UNSAFE\\n"; exit 0; fi',
    'if [ -d "$run_root" ]; then',
    '  for entry in "$run_root"/*; do',
    '    [ -d "$entry" ] && [ ! -L "$entry" ] || continue',
    '    name=${entry##*/}',
    '    bytes=$(du -sk "$entry" 2>/dev/null | awk \'NR == 1 { print $1 * 1024 }\')',
    '    if [ -n "$bytes" ]; then printf "ENTRY\\t%s\\t%s\\n" "$name" "$bytes"; else printf "PROBE_ERROR\\t%s\\n" "$name"; fi',
    '  done',
    '  trash_root="$run_root/.paperclip-prune-trash"',
    '  if [ -d "$trash_root" ] && [ ! -L "$trash_root" ]; then',
    '    for entry in "$trash_root"/*; do',
    '      [ -d "$entry" ] && [ ! -L "$entry" ] || continue',
    '      stale=$(find "$entry" -maxdepth 0 -mmin +10 -print 2>/dev/null)',
    '      [ -n "$stale" ] || continue',
    '      name=${entry##*/}',
    '      bytes=$(du -sk "$entry" 2>/dev/null | awk \'NR == 1 { print $1 * 1024 }\')',
    '      if [ -n "$bytes" ]; then printf "TRASH\\t%s\\t%s\\n" "$name" "$bytes"; else printf "PROBE_ERROR\\t%s\\n" "$name"; fi',
    '    done',
    '  fi',
    'fi',
    'df -Pk "$disk_path" 2>/dev/null | awk \'NR == 2 { gsub(/%/, "", $5); printf "DISK\\t%s\\n", $5 }\'',
  ].join("\n");
}

function parseProbeOutput(stdout: string) {
  const directories: RemoteRunDirectory[] = [];
  let diskUsedPercent: number | null = null;
  let errorCount = 0;
  let unsafeRoot = false;
  let skippedInvalidCount = 0;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [type, first, second] = line.split("\t");
    if (type === "ROOT_UNSAFE") {
      unsafeRoot = true;
      errorCount += 1;
      continue;
    }
    if (type === "PROBE_ERROR") {
      errorCount += 1;
      continue;
    }
    if (type === "DISK") {
      const parsed = Number(first);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) diskUsedPercent = parsed;
      else errorCount += 1;
      continue;
    }
    if (type !== "ENTRY" && type !== "TRASH") {
      errorCount += 1;
      continue;
    }

    const bytes = Number(second);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      errorCount += 1;
      continue;
    }
    if (type === "ENTRY") {
      if (!RUN_ID_PATTERN.test(first ?? "")) {
        skippedInvalidCount += 1;
        continue;
      }
      directories.push({ kind: "run", runId: first!, entryName: first!, bytes });
      continue;
    }

    const match = TRASH_ENTRY_PATTERN.exec(first ?? "");
    if (!match || !RUN_ID_PATTERN.test(match[1]!) || !RUN_ID_PATTERN.test(match[2]!)) {
      skippedInvalidCount += 1;
      continue;
    }
    directories.push({ kind: "trash", runId: match[1]!, entryName: first!, bytes });
  }

  return { directories, diskUsedPercent, errorCount, unsafeRoot, skippedInvalidCount };
}

function buildDeleteCommand(input: {
  runRoot: string;
  sweepId: string;
  directories: RemoteRunDirectory[];
  diskPath: string;
}) {
  const lines = [
    `run_root=${shellQuote(input.runRoot)}`,
    `disk_path=${shellQuote(input.diskPath)}`,
    'if [ ! -d "$run_root" ] || [ -L "$run_root" ]; then printf "DELETE_ERROR\\troot\\n"; exit 0; fi',
    'trash_root="$run_root/.paperclip-prune-trash"',
    'mkdir -p "$trash_root" || { printf "DELETE_ERROR\\ttrash-root\\n"; exit 0; }',
    'if [ -L "$trash_root" ]; then printf "DELETE_ERROR\\ttrash-symlink\\n"; exit 0; fi',
  ];

  for (const directory of input.directories) {
    const source = directory.kind === "run"
      ? path.posix.join(input.runRoot, directory.runId)
      : path.posix.join(input.runRoot, ".paperclip-prune-trash", directory.entryName);
    const claimName = `${directory.runId}.${input.sweepId}`;
    const claim = path.posix.join(input.runRoot, ".paperclip-prune-trash", claimName);
    lines.push(
      `source=${shellQuote(source)}`,
      `claim=${shellQuote(claim)}`,
      'if [ -d "$source" ] && [ ! -L "$source" ]; then',
      '  if mv "$source" "$claim" 2>/dev/null; then',
      '    touch "$claim" 2>/dev/null || true',
      '    bytes=$(du -sk "$claim" 2>/dev/null | awk \'NR == 1 { print $1 * 1024 }\')',
      '    if rm -rf "$claim" && [ ! -e "$claim" ]; then',
      `      printf "FREED\\t%s\\t%s\\n" ${shellQuote(directory.runId)} "\${bytes:-0}"`,
      '    else',
      `      printf "DELETE_ERROR\\t%s\\n" ${shellQuote(directory.runId)}`,
      '    fi',
      '  elif [ -e "$source" ]; then',
      `    printf "DELETE_ERROR\\t%s\\n" ${shellQuote(directory.runId)}`,
      '  fi',
      'fi',
    );
  }

  lines.push(
    'df -Pk "$disk_path" 2>/dev/null | awk \'NR == 2 { gsub(/%/, "", $5); printf "DISK\\t%s\\n", $5 }\'',
  );
  return lines.join("\n");
}

function parseDeleteOutput(stdout: string) {
  let deletedCount = 0;
  let bytesFreed = 0;
  let errorCount = 0;
  let diskUsedPercent: number | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [type, first, second] = line.split("\t");
    if (type === "DELETE_ERROR") {
      errorCount += 1;
      continue;
    }
    if (type === "DISK") {
      const parsed = Number(first);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) diskUsedPercent = parsed;
      else errorCount += 1;
      continue;
    }
    if (type !== "FREED" || !RUN_ID_PATTERN.test(first ?? "")) {
      errorCount += 1;
      continue;
    }
    const bytes = Number(second);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      errorCount += 1;
      continue;
    }
    deletedCount += 1;
    bytesFreed += bytes;
  }

  return { deletedCount, bytesFreed, errorCount, diskUsedPercent };
}

async function defaultExecuteRemoteCommand(input: {
  currentRunId: string;
  target: AdapterExecutionTarget;
  command: string;
  timeoutSec: number;
}) {
  const commandTarget = input.target.kind === "remote" && input.target.transport === "sandbox"
    ? overrideAdapterExecutionTargetRemoteCwd(input.target, "/")!
    : input.target;
  return await runAdapterExecutionTargetShellCommand(input.currentRunId, commandTarget, input.command, {
    cwd: "/",
    env: {},
    timeoutSec: input.timeoutSec,
  });
}

export async function sweepRemoteRunRetention(input: {
  db: Db;
  currentRunId: string;
  target: AdapterExecutionTarget | null | undefined;
  env?: Record<string, string | undefined>;
  now?: Date;
  lookupRuns?: RemoteRunLookup;
  executeRemoteCommand?: RemoteCommandExecutor;
}): Promise<RemoteRunRetentionResult> {
  const config = resolveRemoteRunRetentionConfig(input.env);
  if (!input.target || input.target.kind !== "remote" || config.retentionHours === 0) {
    return emptyResult(config, null, false);
  }

  let runRoot: string;
  try {
    runRoot = resolveRemoteRunRoot(input.target.remoteCwd);
  } catch (error) {
    logger.warn({ err: error, runId: input.currentRunId, errorCount: 1 }, "remote run retention refused target");
    return { ...emptyResult(config, null, true), errorCount: 1 };
  }
  const diskPath = runRoot.slice(0, -"/.paperclip-runtime/runs".length) || "/";
  const result = emptyResult(config, runRoot, true);
  const executeRemoteCommand = input.executeRemoteCommand ?? ((commandInput) => defaultExecuteRemoteCommand({
    currentRunId: input.currentRunId,
    ...commandInput,
  }));

  let probe: RemoteCommandResult;
  try {
    probe = await executeRemoteCommand({
      target: input.target,
      command: buildProbeCommand(runRoot, diskPath),
      timeoutSec: REMOTE_COMMAND_TIMEOUT_SEC,
    });
  } catch (error) {
    logger.warn({ err: error, runId: input.currentRunId, runRoot, errorCount: 1 }, "remote run retention probe failed");
    return { ...result, errorCount: 1 };
  }
  if (probe.exitCode !== 0 || probe.timedOut) {
    logger.warn(
      { runId: input.currentRunId, runRoot, exitCode: probe.exitCode, timedOut: probe.timedOut, errorCount: 1 },
      "remote run retention probe failed",
    );
    return { ...result, errorCount: 1 };
  }

  const parsedProbe = parseProbeOutput(probe.stdout);
  result.scannedCount = parsedProbe.directories.length;
  result.errorCount = parsedProbe.errorCount;
  result.skippedInvalidCount = parsedProbe.skippedInvalidCount;
  result.diskUsedPercentBefore = parsedProbe.diskUsedPercent;
  result.diskUsedPercent = parsedProbe.diskUsedPercent;
  if (result.diskUsedPercent === null) result.errorCount += 1;
  if (parsedProbe.unsafeRoot) {
    result.diskWarning = result.diskUsedPercent !== null && result.diskUsedPercent >= config.diskWarningPercent;
    logger.warn({ ...result, runId: input.currentRunId }, "remote run retention refused unsafe run root");
    return result;
  }

  const runIds = [...new Set(parsedProbe.directories.map((directory) => directory.runId))];
  const lookupRuns = input.lookupRuns ?? (async (ids: string[]) => {
    if (ids.length === 0) return [];
    return await input.db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        finishedAt: heartbeatRuns.finishedAt,
        retryOfRunId: heartbeatRuns.retryOfRunId,
      })
      .from(heartbeatRuns)
      .where(
        or(
          inArray(heartbeatRuns.id, ids),
          and(
            inArray(heartbeatRuns.retryOfRunId, ids),
            inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
          ),
        ),
      );
  });

  let states: RemoteRunState[];
  try {
    states = await lookupRuns(runIds);
  } catch (error) {
    result.errorCount += 1;
    result.skippedUnverifiableCount += parsedProbe.directories.length;
    result.diskWarning = result.diskUsedPercent !== null && result.diskUsedPercent >= config.diskWarningPercent;
    logger.warn({ err: error, ...result, runId: input.currentRunId }, "remote run retention state lookup failed");
    return result;
  }

  const stateById = new Map(states.map((state) => [state.id, state]));
  const activeRetryParents = new Set(
    states
      .filter((state) => state.retryOfRunId && ACTIVE_RUN_STATUSES.has(state.status))
      .map((state) => state.retryOfRunId!),
  );
  const cutoff = (input.now ?? new Date()).getTime() - config.retentionHours * 60 * 60 * 1_000;
  const eligible: RemoteRunDirectory[] = [];
  for (const directory of parsedProbe.directories) {
    if (directory.runId === input.currentRunId || activeRetryParents.has(directory.runId)) {
      result.skippedActiveCount += 1;
      continue;
    }
    const state = stateById.get(directory.runId);
    if (!state || !TERMINAL_RUN_STATUSES.has(state.status) || !state.finishedAt) {
      if (state && ACTIVE_RUN_STATUSES.has(state.status)) {
        result.skippedActiveCount += 1;
      } else {
        result.skippedUnverifiableCount += 1;
      }
      continue;
    }
    const finishedAt = state.finishedAt.getTime();
    if (!Number.isFinite(finishedAt)) {
      result.skippedUnverifiableCount += 1;
      continue;
    }
    if (finishedAt > cutoff) {
      result.skippedRecentTerminalCount += 1;
      continue;
    }
    eligible.push(directory);
  }
  result.eligibleCount = eligible.length;

  if (eligible.length > 0) {
    let deletion: RemoteCommandResult;
    try {
      deletion = await executeRemoteCommand({
        target: input.target,
        command: buildDeleteCommand({
          runRoot,
          sweepId: input.currentRunId,
          directories: eligible,
          diskPath,
        }),
        timeoutSec: REMOTE_COMMAND_TIMEOUT_SEC,
      });
    } catch (error) {
      result.errorCount += 1;
      logger.warn({ err: error, ...result, runId: input.currentRunId }, "remote run retention deletion failed");
      return result;
    }
    if (deletion.exitCode !== 0 || deletion.timedOut) {
      result.errorCount += 1;
      logger.warn(
        { ...result, runId: input.currentRunId, exitCode: deletion.exitCode, timedOut: deletion.timedOut },
        "remote run retention deletion failed",
      );
      return result;
    }
    const parsedDeletion = parseDeleteOutput(deletion.stdout);
    result.deletedCount = parsedDeletion.deletedCount;
    result.bytesFreed = parsedDeletion.bytesFreed;
    result.errorCount += parsedDeletion.errorCount;
    result.diskUsedPercentAfter = parsedDeletion.diskUsedPercent;
    result.diskUsedPercent = parsedDeletion.diskUsedPercent ?? result.diskUsedPercent;
  }

  result.diskWarning = [result.diskUsedPercentBefore, result.diskUsedPercentAfter]
    .some((value) => value !== null && value >= config.diskWarningPercent);
  const logContext = { ...result, runId: input.currentRunId };
  if (result.diskWarning || result.errorCount > 0) {
    logger.warn(logContext, "remote run retention sweep needs attention");
  } else if (result.deletedCount > 0) {
    logger.info(logContext, "remote run retention sweep completed");
  }
  return result;
}
