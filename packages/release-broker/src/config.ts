import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ServerOptions } from "node:https";
import { isUuid } from "./validation.js";

const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const GITLAB_PROJECT_ID = 92;
const GITLAB_ORIGIN = "https://gitlab.tidycode.it";
const MAIN_LOCK_ISSUE = "GOT-66";

export interface ServiceConfig {
  host: string;
  port: number;
  companyId: string;
  gitlabProjectId: number;
  releaseBotAgentId: string;
  mainLockIssue: string;
  allowedClientIdentities: ReadonlySet<string>;
  capabilityTtlMs: number;
  paperclipApiUrl: string;
  gitlabApiUrl: string;
  paperclipApiKey: string;
  gitlabToken: string;
  auditPath: string;
  releaseRoot: string;
  expectedGeneration: number;
  generationStatePath: string;
  attestationPublicKeyPath: string;
  tls: ServerOptions;
}

export async function loadServiceConfig(environment: NodeJS.ProcessEnv = process.env): Promise<ServiceConfig> {
  rejectSecretEnvironment(environment);
  const credentialDirectory = required(environment.CREDENTIALS_DIRECTORY, "CREDENTIALS_DIRECTORY");
  const releaseRoot = environment.BROKER_RELEASE_ROOT ?? "/opt/gotto/release-broker/current";
  const companyId = required(environment.BROKER_COMPANY_ID, "BROKER_COMPANY_ID");
  const releaseBotAgentId = required(environment.BROKER_RELEASE_BOT_AGENT_ID, "BROKER_RELEASE_BOT_AGENT_ID");
  if (!isUuid(companyId) || !isUuid(releaseBotAgentId)) throw new Error("Invalid broker identity configuration");

  const gitlabProjectId = positiveInteger(environment.BROKER_GITLAB_PROJECT_ID ?? "92", "BROKER_GITLAB_PROJECT_ID");
  if (gitlabProjectId !== GITLAB_PROJECT_ID) throw new Error("Invalid BROKER_GITLAB_PROJECT_ID");
  const mainLockIssue = environment.BROKER_MAIN_LOCK_ISSUE ?? MAIN_LOCK_ISSUE;
  if (mainLockIssue !== MAIN_LOCK_ISSUE) throw new Error("Invalid BROKER_MAIN_LOCK_ISSUE");
  const port = positiveInteger(environment.BROKER_PORT ?? "9443", "BROKER_PORT");
  if (port > 65535) throw new Error("Invalid BROKER_PORT");
  const capabilityTtlMs = positiveInteger(environment.BROKER_CAPABILITY_TTL_MS ?? "20000", "BROKER_CAPABILITY_TTL_MS");
  if (capabilityTtlMs < 1000 || capabilityTtlMs > 30000) throw new Error("Invalid capability TTL");

  const paperclipApiUrl = secureUrl(required(environment.BROKER_PAPERCLIP_API_URL, "BROKER_PAPERCLIP_API_URL"));
  const gitlabApiUrl = secureUrl(required(environment.BROKER_GITLAB_API_URL, "BROKER_GITLAB_API_URL"));
  if (new URL(gitlabApiUrl).origin !== GITLAB_ORIGIN) throw new Error("Invalid BROKER_GITLAB_API_URL");
  const identities = new Set(
    required(environment.BROKER_ALLOWED_CLIENT_FINGERPRINTS, "BROKER_ALLOWED_CLIENT_FINGERPRINTS")
      .split(",")
      .map((value) => value.trim().toLowerCase()),
  );
  if (identities.size === 0 || [...identities].some((value) => !FINGERPRINT.test(value))) {
    throw new Error("Invalid client certificate allowlist");
  }

  const expectedGeneration = positiveInteger(
    required(environment.BROKER_GATE_GENERATION, "BROKER_GATE_GENERATION"),
    "BROKER_GATE_GENERATION",
  );
  return {
    host: environment.BROKER_HOST ?? "0.0.0.0",
    port,
    companyId,
    gitlabProjectId,
    releaseBotAgentId,
    mainLockIssue,
    allowedClientIdentities: identities,
    capabilityTtlMs,
    paperclipApiUrl,
    gitlabApiUrl,
    paperclipApiKey: await readCredential(credentialDirectory, "paperclip-api-key"),
    gitlabToken: await readCredential(credentialDirectory, "gitlab-merge-token"),
    auditPath: environment.BROKER_AUDIT_PATH ?? "/var/log/gotto-release-broker/audit.jsonl",
    releaseRoot,
    expectedGeneration,
    generationStatePath: environment.BROKER_GENERATION_STATE ?? "/var/lib/gotto-release-broker-control/generation.json",
    attestationPublicKeyPath: environment.BROKER_ATTESTATION_PUBLIC_KEY ?? "/etc/gotto/release-broker/ed25519.pub",
    tls: {
      cert: await readCredentialBytes(credentialDirectory, "server-cert"),
      key: await readCredentialBytes(credentialDirectory, "server-key"),
      ca: await readCredentialBytes(credentialDirectory, "client-ca"),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
  };
}

function rejectSecretEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of ["GITLAB_API_TOKEN", "GITLAB_TOKEN", "PAPERCLIP_API_KEY"]) {
    if (environment[key]) throw new Error(`${key} must be supplied through systemd credentials`);
  }
}

async function readCredential(directory: string, name: string): Promise<string> {
  const value = (await readCredentialBytes(directory, name)).toString("utf8").trim();
  if (!value || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`Invalid credential: ${name}`);
  }
  return value;
}

async function readCredentialBytes(directory: string, name: string): Promise<Buffer> {
  const root = resolve(directory);
  const path = resolve(root, name);
  if (!path.startsWith(`${root}/`)) throw new Error("Invalid credential path");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 1024 * 1024) {
    throw new Error(`Invalid credential: ${name}`);
  }
  return readFile(path);
}

function required(value: string | undefined, name: string): string {
  if (!value || value.trim() !== value) throw new Error(`Missing or invalid ${name}`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name}`);
  return parsed;
}

function secureUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Broker upstream URLs must be credential-free HTTPS origins");
  }
  return url.toString();
}
