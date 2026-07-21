import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRemoteRunRoot, sweepRemoteRunRetention } from "./remote-run-retention.js";

const execFileAsync = promisify(execFile);
const CURRENT_RUN_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_SWEEP_RUN_ID = "10000000-0000-4000-8000-000000000002";
const QUEUED_RUN_ID = "20000000-0000-4000-8000-000000000001";
const RUNNING_RUN_ID = "20000000-0000-4000-8000-000000000002";
const OLD_TERMINAL_RUN_ID = "30000000-0000-4000-8000-000000000001";
const RECENT_TERMINAL_RUN_ID = "30000000-0000-4000-8000-000000000002";
const RETRY_RUN_ID = "30000000-0000-4000-8000-000000000003";
const UNKNOWN_RUN_ID = "40000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-21T12:00:00.000Z");

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createRemoteRoot(runIds: string[]) {
  const remoteCwd = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-retention-"));
  cleanupDirs.push(remoteCwd);
  const runRoot = resolveRemoteRunRoot(remoteCwd);
  for (const runId of runIds) {
    const runDir = path.join(runRoot, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "payload.bin"), Buffer.alloc(4_096, runId));
  }
  return { remoteCwd, runRoot };
}

async function executeLocalCommand(input: { command: string; timeoutSec: number }) {
  try {
    const result = await execFileAsync("sh", ["-lc", input.command], {
      timeout: input.timeoutSec * 1_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      exitCode: 0,
      timedOut: false,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      timedOut: failure.killed === true,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function target(remoteCwd: string) {
  return {
    kind: "remote" as const,
    transport: "sandbox" as const,
    providerKey: "warden-test",
    remoteCwd,
  };
}

function sweep(input: {
  remoteCwd: string;
  currentRunId?: string;
  states: Array<{ id: string; status: string; finishedAt: Date | null; retryOfRunId?: string | null }>;
  executeRemoteCommand?: typeof executeLocalCommand;
}) {
  return sweepRemoteRunRetention({
    db: {} as Db,
    currentRunId: input.currentRunId ?? CURRENT_RUN_ID,
    target: target(input.remoteCwd),
    env: {
      PAPERCLIP_REMOTE_RUN_RETENTION_HOURS: "24",
      PAPERCLIP_REMOTE_RUN_DISK_WARNING_PERCENT: "99",
    },
    now: NOW,
    lookupRuns: async (runIds) => input.states.filter(
      (state) => runIds.includes(state.id) || (state.retryOfRunId && runIds.includes(state.retryOfRunId)),
    ),
    executeRemoteCommand: input.executeRemoteCommand ?? executeLocalCommand,
  });
}

describe("remote run retention", () => {
  it("keeps queued and running run directories", async () => {
    const { remoteCwd, runRoot } = await createRemoteRoot([QUEUED_RUN_ID, RUNNING_RUN_ID]);

    const result = await sweep({
      remoteCwd,
      states: [
        { id: QUEUED_RUN_ID, status: "queued", finishedAt: null },
        { id: RUNNING_RUN_ID, status: "running", finishedAt: null },
      ],
    });

    expect(result).toMatchObject({
      scannedCount: 2,
      eligibleCount: 0,
      deletedCount: 0,
      skippedActiveCount: 2,
      errorCount: 0,
    });
    await expect(mkdir(path.join(runRoot, QUEUED_RUN_ID))).rejects.toMatchObject({ code: "EEXIST" });
    await expect(mkdir(path.join(runRoot, RUNNING_RUN_ID))).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("removes only terminal runs older than the retention window", async () => {
    const { remoteCwd, runRoot } = await createRemoteRoot([OLD_TERMINAL_RUN_ID, RECENT_TERMINAL_RUN_ID]);

    const result = await sweep({
      remoteCwd,
      states: [
        { id: OLD_TERMINAL_RUN_ID, status: "succeeded", finishedAt: new Date("2026-07-20T11:59:59.000Z") },
        { id: RECENT_TERMINAL_RUN_ID, status: "failed", finishedAt: new Date("2026-07-20T13:00:00.000Z") },
      ],
    });

    expect(result).toMatchObject({
      eligibleCount: 1,
      deletedCount: 1,
      skippedRecentTerminalCount: 1,
      errorCount: 0,
    });
    expect(result.bytesFreed).toBeGreaterThan(0);
    await expect(mkdir(path.join(runRoot, OLD_TERMINAL_RUN_ID))).resolves.toBeUndefined();
    await expect(mkdir(path.join(runRoot, RECENT_TERMINAL_RUN_ID))).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("keeps a terminal run while an active retry references it", async () => {
    const { remoteCwd, runRoot } = await createRemoteRoot([OLD_TERMINAL_RUN_ID]);

    const result = await sweep({
      remoteCwd,
      states: [
        { id: OLD_TERMINAL_RUN_ID, status: "failed", finishedAt: new Date("2026-07-20T11:00:00.000Z") },
        {
          id: RETRY_RUN_ID,
          status: "scheduled_retry",
          finishedAt: null,
          retryOfRunId: OLD_TERMINAL_RUN_ID,
        },
      ],
    });

    expect(result).toMatchObject({
      scannedCount: 1,
      eligibleCount: 0,
      deletedCount: 0,
      skippedActiveCount: 1,
      errorCount: 0,
    });
    await expect(mkdir(path.join(runRoot, OLD_TERMINAL_RUN_ID))).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("fails closed when a directory cannot be resolved to a run state", async () => {
    const { remoteCwd, runRoot } = await createRemoteRoot([UNKNOWN_RUN_ID]);

    const result = await sweep({ remoteCwd, states: [] });

    expect(result).toMatchObject({
      scannedCount: 1,
      eligibleCount: 0,
      deletedCount: 0,
      skippedUnverifiableCount: 1,
      errorCount: 0,
    });
    await expect(mkdir(path.join(runRoot, UNKNOWN_RUN_ID))).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("fails closed when the runtime ancestor is a symlink outside the trusted root", async () => {
    const remoteCwd = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-retention-"));
    const outsideRuntime = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-retention-outside-"));
    cleanupDirs.push(remoteCwd, outsideRuntime);
    const outsideRunRoot = path.join(outsideRuntime, "runs");
    const outsideRunDir = path.join(outsideRunRoot, OLD_TERMINAL_RUN_ID);
    await mkdir(outsideRunDir, { recursive: true });
    await writeFile(path.join(outsideRunDir, "payload.bin"), Buffer.alloc(4_096, OLD_TERMINAL_RUN_ID));
    await symlink(outsideRuntime, path.join(remoteCwd, ".paperclip-runtime"), "dir");

    const result = await sweep({
      remoteCwd,
      states: [
        { id: OLD_TERMINAL_RUN_ID, status: "succeeded", finishedAt: new Date("2026-07-20T11:00:00.000Z") },
      ],
    });

    expect(result).toMatchObject({
      scannedCount: 0,
      eligibleCount: 0,
      deletedCount: 0,
      errorCount: 1,
    });
    await expect(mkdir(outsideRunDir)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("fails closed when the runtime ancestor changes between probe and delete", async () => {
    const { remoteCwd, runRoot } = await createRemoteRoot([OLD_TERMINAL_RUN_ID]);
    const outsideRuntime = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-retention-outside-"));
    cleanupDirs.push(outsideRuntime);
    const outsideRunDir = path.join(outsideRuntime, "runs", OLD_TERMINAL_RUN_ID);
    await mkdir(outsideRunDir, { recursive: true });
    await writeFile(path.join(outsideRunDir, "payload.bin"), Buffer.alloc(4_096, OLD_TERMINAL_RUN_ID));
    const originalRuntime = path.dirname(runRoot);
    const displacedRuntime = path.join(remoteCwd, ".paperclip-runtime-original");
    let commandCount = 0;

    const result = await sweep({
      remoteCwd,
      states: [
        { id: OLD_TERMINAL_RUN_ID, status: "succeeded", finishedAt: new Date("2026-07-20T11:00:00.000Z") },
      ],
      executeRemoteCommand: async (input) => {
        commandCount += 1;
        if (commandCount === 2) {
          await rename(originalRuntime, displacedRuntime);
          await symlink(outsideRuntime, originalRuntime, "dir");
        }
        return await executeLocalCommand(input);
      },
    });

    expect(result).toMatchObject({
      scannedCount: 1,
      eligibleCount: 1,
      deletedCount: 0,
      errorCount: 1,
    });
    await expect(mkdir(outsideRunDir)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(mkdir(path.join(displacedRuntime, "runs", OLD_TERMINAL_RUN_ID))).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("uses atomic claims when concurrent sweeps target the same terminal run", async () => {
    const { remoteCwd, runRoot } = await createRemoteRoot([OLD_TERMINAL_RUN_ID]);
    const states = [
      { id: OLD_TERMINAL_RUN_ID, status: "cancelled", finishedAt: new Date("2026-07-20T11:00:00.000Z") },
    ];

    const [first, second] = await Promise.all([
      sweep({ remoteCwd, currentRunId: CURRENT_RUN_ID, states }),
      sweep({ remoteCwd, currentRunId: SECOND_SWEEP_RUN_ID, states }),
    ]);

    expect(first.deletedCount + second.deletedCount).toBe(1);
    expect(first.errorCount + second.errorCount).toBe(0);
    await expect(mkdir(path.join(runRoot, OLD_TERMINAL_RUN_ID))).resolves.toBeUndefined();
  });
});
