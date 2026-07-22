import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  resolveRemoteRunRoot,
  sweepRemoteRunRetention,
} from "../services/remote-run-retention.js";

const execFileAsync = promisify(execFile);
const CURRENT_RUN_ID = "10000000-0000-4000-8000-000000000001";
const SOURCE_RUN_ID = "30000000-0000-4000-8000-000000000001";
const RETRY_RUN_ID = "30000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-07-21T12:00:00.000Z");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping remote run retention concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fn();
}

describeEmbeddedPostgres("remote run retention retry serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-remote-retention-lock-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createFixture() {
    const company = await db
      .insert(companies)
      .values({ name: "Remote retention", issuePrefix: `R${Date.now().toString(36).slice(-6)}` })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Retention agent", role: "engineer" })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(heartbeatRuns).values({
      id: SOURCE_RUN_ID,
      companyId: company.id,
      agentId: agent.id,
      status: "failed",
      finishedAt: new Date("2026-07-20T11:00:00.000Z"),
    });

    const remoteCwd = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-retention-lock-"));
    cleanupDirs.push(remoteCwd);
    const runRoot = resolveRemoteRunRoot(remoteCwd);
    const sourceDir = path.join(runRoot, SOURCE_RUN_ID);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "payload.bin"), Buffer.alloc(4_096, SOURCE_RUN_ID));
    return { agent, company, remoteCwd, sourceDir };
  }

  async function executeLocalCommand(input: { command: string; timeoutSec: number }) {
    try {
      const result = await execFileAsync("sh", ["-lc", input.command], {
        timeout: input.timeoutSec * 1_000,
        maxBuffer: 1024 * 1024,
      });
      return { exitCode: 0, timedOut: false, stdout: result.stdout, stderr: result.stderr };
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

  async function sweep(remoteCwd: string) {
    return sweepRemoteRunRetention({
      db,
      currentRunId: CURRENT_RUN_ID,
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "warden-test",
        remoteCwd,
      },
      env: {
        PAPERCLIP_REMOTE_RUN_RETENTION_HOURS: "24",
        PAPERCLIP_REMOTE_RUN_DISK_WARNING_PERCENT: "99",
      },
      now: NOW,
      executeRemoteCommand: executeLocalCommand,
    });
  }

  it("retains the source directory when the retry transaction wins", async () => {
    const { agent, company, remoteCwd, sourceDir } = await createFixture();
    let markRetryInserted!: () => void;
    let releaseRetry!: () => void;
    const retryInserted = new Promise<void>((resolve) => {
      markRetryInserted = resolve;
    });
    const retryRelease = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const retryTransaction = db.transaction(async (tx) => {
      await tx.insert(heartbeatRuns).values({
        id: RETRY_RUN_ID,
        companyId: company.id,
        agentId: agent.id,
        status: "scheduled_retry",
        retryOfRunId: SOURCE_RUN_ID,
      });
      markRetryInserted();
      await retryRelease;
    });
    await retryInserted;

    const sweepPromise = sweep(remoteCwd);
    const retentionWaitedForRetry = await waitForCondition(async () => {
      const rows = await db.execute<{ waiting: number }>(sql`
        select count(*)::int as waiting
        from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
      `);
      return Number(rows[0]?.waiting ?? 0) > 0;
    });
    releaseRetry();
    expect(retentionWaitedForRetry).toBe(true);
    await retryTransaction;

    const result = await sweepPromise;

    expect(result).toMatchObject({ eligibleCount: 0, deletedCount: 0, skippedActiveCount: 1, errorCount: 0 });
    await expect(access(sourceDir)).resolves.toBeUndefined();
    const source = await db
      .select({ claimedAt: heartbeatRuns.remoteRetentionClaimedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, SOURCE_RUN_ID))
      .then((rows) => rows[0]!);
    expect(source.claimedAt).toBeNull();
  });

  it("rolls back retry creation when the retention claim wins", async () => {
    const { agent, company, remoteCwd, sourceDir } = await createFixture();

    const result = await sweep(remoteCwd);
    expect(result).toMatchObject({ eligibleCount: 1, deletedCount: 1, errorCount: 0 });
    await expect(access(sourceDir)).rejects.toMatchObject({ code: "ENOENT" });

    let retryError: unknown;
    try {
      await db.insert(heartbeatRuns).values({
        id: RETRY_RUN_ID,
        companyId: company.id,
        agentId: agent.id,
        status: "scheduled_retry",
        retryOfRunId: SOURCE_RUN_ID,
      });
    } catch (error) {
      retryError = error;
    }
    const postgresError = retryError as {
      code?: string;
      constraint_name?: string;
      cause?: { code?: string; constraint_name?: string };
    };
    expect(postgresError.code ?? postgresError.cause?.code).toBe("23514");
    expect(postgresError.constraint_name ?? postgresError.cause?.constraint_name).toBe(
      "heartbeat_runs_retry_source_not_retention_claimed",
    );
    await db.insert(heartbeatRuns).values({
      id: RETRY_RUN_ID,
      companyId: company.id,
      agentId: agent.id,
      status: "failed",
      retryOfRunId: SOURCE_RUN_ID,
    });
    await expect(
      db
        .update(heartbeatRuns)
        .set({ status: "scheduled_retry" })
        .where(eq(heartbeatRuns.id, RETRY_RUN_ID)),
    ).rejects.toBeDefined();
    const retry = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, RETRY_RUN_ID))
      .then((rows) => rows[0]!);
    expect(retry.status).toBe("failed");
  });
});
