import { request as httpsRequest } from "node:https";
import { lstat, readFile } from "node:fs/promises";
import { isFullSha, isUuid } from "./validation.js";
import type { CapabilityRequest, CapabilityResponse, MergeResponse } from "./types.js";

export interface ReleaseBrokerClientOptions {
  baseUrl: string;
  certPath: string;
  keyPath: string;
  caPath: string;
}

export class ReleaseBrokerClient {
  readonly #baseUrl: URL;
  readonly #cert: Buffer;
  readonly #key: Buffer;
  readonly #ca: Buffer;

  private constructor(options: ReleaseBrokerClientOptions, credentials: Buffer[]) {
    this.#baseUrl = new URL(options.baseUrl);
    if (this.#baseUrl.protocol !== "https:" || this.#baseUrl.username || this.#baseUrl.password) {
      throw new Error("Broker URL must use credential-free HTTPS");
    }
    [this.#cert, this.#key, this.#ca] = credentials as [Buffer, Buffer, Buffer];
  }

  static async create(options: ReleaseBrokerClientOptions): Promise<ReleaseBrokerClient> {
    const credentials = await Promise.all(
      [options.certPath, options.keyPath, options.caPath].map(async (path) => {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 1024 * 1024) {
          throw new Error("Invalid broker client credential");
        }
        return readFile(path);
      }),
    );
    return new ReleaseBrokerClient(options, credentials);
  }

  requestCapability(input: CapabilityRequest): Promise<CapabilityResponse> {
    return this.#post("/v1/capabilities", input).then((value) => parseCapabilityResponse(value, input.requestId));
  }

  merge(capability: string, requestId: string): Promise<MergeResponse> {
    return this.#post("/v1/merge", { capability, requestId }).then((value) => parseMergeResponse(value, requestId));
  }

  async mergeOnce(input: CapabilityRequest): Promise<MergeResponse> {
    const issued = await this.requestCapability(input);
    if (issued.requestId !== input.requestId || typeof issued.capability !== "string") {
      throw new Error("Ambiguous broker response");
    }
    return this.merge(issued.capability, input.requestId);
  }

  async #post(path: string, payload: unknown): Promise<unknown> {
    const body = Buffer.from(JSON.stringify(payload));
    const url = new URL(path, this.#baseUrl);
    return new Promise((resolve, reject) => {
      const request = httpsRequest({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        cert: this.#cert,
        key: this.#key,
        ca: this.#ca,
        minVersion: "TLSv1.3",
        rejectUnauthorized: true,
        timeout: 10_000,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 8192) response.destroy(new Error("Oversized broker response"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error("Broker denied request"));
            return;
          }
          if (response.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
            reject(new Error("Ambiguous broker response"));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("Ambiguous broker response"));
          }
        });
        response.on("error", reject);
      });
      request.on("timeout", () => request.destroy(new Error("Broker timeout")));
      request.on("error", reject);
      request.end(body);
    });
  }
}

function parseCapabilityResponse(value: unknown, requestId: string): CapabilityResponse {
  const input = exactObject(value, ["capability", "expiresAt", "requestId"]);
  if (
    typeof input.capability !== "string" ||
    !/^rb1\.[A-Za-z0-9_-]{43}$/.test(input.capability) ||
    input.requestId !== requestId ||
    typeof input.expiresAt !== "string" ||
    Number.isNaN(Date.parse(input.expiresAt))
  ) throw new Error("Ambiguous broker response");
  return input as unknown as CapabilityResponse;
}

function parseMergeResponse(value: unknown, requestId: string): MergeResponse {
  const input = exactObject(value, ["mergeCommitSha", "requestId", "status"]);
  if (
    input.status !== "merged" && input.status !== "already_merged" ||
    input.requestId !== requestId ||
    !isUuid(input.requestId) ||
    !isFullSha(input.mergeCommitSha)
  ) throw new Error("Ambiguous broker response");
  return input as unknown as MergeResponse;
}

function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Ambiguous broker response");
  }
  const input = value as Record<string, unknown>;
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Ambiguous broker response");
  }
  return input;
}
