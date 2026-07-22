import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";
import { BrokerError } from "./errors.js";
import type { AttestationEvidence, AttestationProvider } from "./types.js";

interface ManifestFile {
  path: string;
  sha256: string;
  mode: string;
}

interface ReleaseManifest {
  schemaVersion: 1;
  generation: number;
  sourceCommit: string;
  builtAt: string;
  rollbackOf?: number;
  files: ManifestFile[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const MODE = /^(?:0444|0555)$/;

export class ReleaseAttestationVerifier implements AttestationProvider {
  readonly #payloadRoot: string;
  readonly #manifestPath: string;
  readonly #signaturePath: string;
  readonly #publicKeyPath: string;
  readonly #expectedGeneration: number;
  readonly #generationStatePath: string | undefined;

  constructor(options: {
    payloadRoot: string;
    manifestPath: string;
    signaturePath: string;
    publicKeyPath: string;
    expectedGeneration: number;
    generationStatePath?: string;
  }) {
    this.#payloadRoot = resolve(options.payloadRoot);
    this.#manifestPath = options.manifestPath;
    this.#signaturePath = options.signaturePath;
    this.#publicKeyPath = options.publicKeyPath;
    this.#expectedGeneration = options.expectedGeneration;
    this.#generationStatePath = options.generationStatePath;
  }

  async verify(): Promise<AttestationEvidence> {
    try {
      const [payloadStat, manifestStat, signatureStat, publicKeyStat] = await Promise.all([
        lstat(this.#payloadRoot),
        lstat(this.#manifestPath),
        lstat(this.#signaturePath),
        lstat(this.#publicKeyPath),
      ]);
      if (
        !payloadStat.isDirectory() || payloadStat.isSymbolicLink() ||
        !manifestStat.isFile() || manifestStat.isSymbolicLink() || (manifestStat.mode & 0o777) !== 0o444 ||
        !signatureStat.isFile() || signatureStat.isSymbolicLink() || (signatureStat.mode & 0o777) !== 0o444 ||
        !publicKeyStat.isFile() || publicKeyStat.isSymbolicLink() || (publicKeyStat.mode & 0o777) !== 0o444
      ) throw new Error("invalid attestation path");
      const [manifestBytes, signature, publicKeyBytes] = await Promise.all([
        readFile(this.#manifestPath),
        readFile(this.#signaturePath),
        readFile(this.#publicKeyPath),
      ]);
      const publicKey = createPublicKey(publicKeyBytes);
      if (!verifySignature(null, manifestBytes, publicKey, signature)) {
        throw new Error("invalid signature");
      }

      const manifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")));
      if (manifest.generation !== this.#expectedGeneration) throw new Error("generation mismatch");
      if (this.#generationStatePath) {
        const state = JSON.parse(await readFile(this.#generationStatePath, "utf8")) as unknown;
        if (
          state === null ||
          typeof state !== "object" ||
          Array.isArray(state) ||
          Object.keys(state).sort().join(",") !== "generation,manifestSha256" ||
          (state as Record<string, unknown>).generation !== manifest.generation ||
          (state as Record<string, unknown>).manifestSha256 !== createHash("sha256").update(manifestBytes).digest("hex")
        ) throw new Error("generation state mismatch");
      }
      await this.#verifyInventory(manifest.files);

      return {
        generation: manifest.generation,
        manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
        sourceCommit: manifest.sourceCommit,
      };
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError("attestation_failed", 503);
    }
  }

  async #verifyInventory(files: ManifestFile[]): Promise<void> {
    const actual = await listFiles(this.#payloadRoot);
    const expectedPaths = files.map((entry) => entry.path).sort();
    if (actual.length !== expectedPaths.length || actual.some((path, index) => path !== expectedPaths[index])) {
      throw new Error("inventory mismatch");
    }

    for (const entry of files) {
      const absolutePath = resolve(this.#payloadRoot, ...entry.path.split("/"));
      if (!isContained(this.#payloadRoot, absolutePath)) throw new Error("path escape");
      const stat = await lstat(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid file type");
      const actualMode = `0${(stat.mode & 0o777).toString(8)}`;
      if (actualMode !== entry.mode) throw new Error("mode mismatch");
      const digest = createHash("sha256").update(await readFile(absolutePath)).digest("hex");
      if (digest !== entry.sha256) throw new Error("hash mismatch");
    }
  }
}

export class StaticAttestationProvider implements AttestationProvider {
  readonly #evidence: AttestationEvidence;

  constructor(evidence: AttestationEvidence) {
    this.#evidence = evidence;
  }

  async verify(): Promise<AttestationEvidence> {
    return this.#evidence;
  }
}

function parseManifest(value: unknown): ReleaseManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid manifest");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  const allowed = ["builtAt", "files", "generation", "rollbackOf", "schemaVersion", "sourceCommit"];
  if (keys.some((key) => !allowed.includes(key)) || input.schemaVersion !== 1) throw new Error("invalid manifest");
  if (!Number.isSafeInteger(input.generation) || (input.generation as number) <= 0) throw new Error("invalid generation");
  if (typeof input.sourceCommit !== "string" || !SOURCE_COMMIT.test(input.sourceCommit)) throw new Error("invalid source");
  if (typeof input.builtAt !== "string" || Number.isNaN(Date.parse(input.builtAt))) throw new Error("invalid build time");
  if (input.rollbackOf !== undefined && (!Number.isSafeInteger(input.rollbackOf) || (input.rollbackOf as number) <= 0)) {
    throw new Error("invalid rollback");
  }
  if (typeof input.rollbackOf === "number" && input.rollbackOf >= (input.generation as number)) {
    throw new Error("invalid rollback");
  }
  if (!Array.isArray(input.files) || input.files.length === 0) throw new Error("invalid files");

  const files = input.files.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid file");
    const file = value as Record<string, unknown>;
    if (Object.keys(file).sort().join(",") !== "mode,path,sha256") throw new Error("invalid file");
    if (typeof file.path !== "string" || !validRelativePath(file.path)) throw new Error("invalid path");
    if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) throw new Error("invalid hash");
    if (typeof file.mode !== "string" || !MODE.test(file.mode)) throw new Error("invalid mode");
    return file as unknown as ManifestFile;
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("duplicate path");
  const sorted = [...files].sort((left, right) => left.path === right.path ? 0 : left.path < right.path ? -1 : 1);
  if (files.some((file, index) => file.path !== sorted[index]!.path)) throw new Error("unsorted files");
  return { ...input, files } as ReleaseManifest;
}

function validRelativePath(value: string): boolean {
  return value.length > 0 &&
    value.length <= 240 &&
    value === posix.normalize(value) &&
    !value.startsWith("/") &&
    !value.split("/").includes("..") &&
    !value.includes("\\") &&
    !value.includes("\0");
}

async function listFiles(root: string): Promise<string[]> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("invalid payload root");
  const output: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("symlink denied");
      const absolutePath = resolve(directory, entry.name);
      if (!isContained(root, absolutePath)) throw new Error("path escape");
      if (entry.isDirectory()) pending.push(absolutePath);
      else if (entry.isFile()) output.push(relative(root, absolutePath).split(sep).join("/"));
      else throw new Error("invalid file type");
    }
  }
  return output.sort();
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}
