import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { BrokerError } from "./errors.js";
import type { AuditEvent, AuditSink } from "./types.js";

export class JsonlAuditSink implements AuditSink {
  readonly #path: string;
  readonly #clock: () => Date;

  constructor(path: string, clock: () => Date = () => new Date()) {
    this.#path = path;
    this.#clock = clock;
  }

  async write(event: AuditEvent): Promise<void> {
    const record = `${JSON.stringify({
      schemaVersion: 1,
      at: this.#clock().toISOString(),
      ...event,
    })}\n`;

    let handle;
    try {
      handle = await open(
        this.#path,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
        throw new Error("unsafe audit file");
      }
      await handle.writeFile(record, { encoding: "utf8" });
      await handle.sync();
    } catch {
      throw new BrokerError("audit_failed", 503);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  async write(event: AuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}
