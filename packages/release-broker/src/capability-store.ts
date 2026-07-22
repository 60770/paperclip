import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BrokerError } from "./errors.js";
import type { CapabilityClaims, Clock } from "./types.js";

interface CapabilityRecord {
  claims: CapabilityClaims;
  digest: Buffer;
}

const REQUEST_RETENTION_MS = 5 * 60_000;

export class CapabilityStore {
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #records = new Map<string, CapabilityRecord>();
  readonly #requestIds = new Map<string, number>();

  constructor(clock: Clock, ttlMs: number) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 30_000) {
      throw new Error("Capability TTL must be between 1 and 30 seconds");
    }
    this.#clock = clock;
    this.#ttlMs = ttlMs;
  }

  issue(claims: Omit<CapabilityClaims, "issuedAt" | "expiresAt">): {
    capability: string;
    claims: CapabilityClaims;
  } {
    const now = this.#clock.now();
    this.#sweep(now);
    if (this.#requestIds.has(claims.requestId)) {
      throw new BrokerError("request_replayed", 409);
    }

    const secret = randomBytes(32);
    const token = `rb1.${secret.toString("base64url")}`;
    const digest = createHash("sha256").update(token, "utf8").digest();
    const key = digest.toString("hex");
    const completeClaims: CapabilityClaims = {
      ...claims,
      issuedAt: now,
      expiresAt: now + this.#ttlMs,
    };

    this.#records.set(key, { claims: completeClaims, digest });
    this.#requestIds.set(claims.requestId, now + REQUEST_RETENTION_MS);
    return { capability: token, claims: completeClaims };
  }

  consume(capability: string, requestId: string, clientIdentity: string): CapabilityClaims {
    const now = this.#clock.now();
    const presentedDigest = createHash("sha256").update(capability, "utf8").digest();
    const key = presentedDigest.toString("hex");
    const record = this.#records.get(key);

    if (!record || !timingSafeEqual(presentedDigest, record.digest)) {
      throw new BrokerError("capability_replayed", 409);
    }

    this.#records.delete(key);
    if (record.claims.expiresAt <= now) {
      throw new BrokerError("capability_expired", 409);
    }
    if (record.claims.requestId !== requestId || record.claims.clientIdentity !== clientIdentity) {
      throw new BrokerError("capability_invalid", 403);
    }
    return record.claims;
  }

  #sweep(now: number): void {
    for (const [key, record] of this.#records) {
      if (record.claims.expiresAt <= now) this.#records.delete(key);
    }
    for (const [requestId, expiresAt] of this.#requestIds) {
      if (expiresAt <= now) this.#requestIds.delete(requestId);
    }
  }
}

export const systemClock: Clock = { now: () => Date.now() };
