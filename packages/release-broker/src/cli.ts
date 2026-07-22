#!/usr/bin/env node
import { resolve } from "node:path";
import { ReleaseAttestationVerifier } from "./attestation.js";
import { JsonlAuditSink } from "./audit.js";
import { ReleaseBroker } from "./broker.js";
import { CapabilityStore, systemClock } from "./capability-store.js";
import { loadServiceConfig } from "./config.js";
import { GitLabApiClient, PaperclipApiClient } from "./http-clients.js";
import { createBrokerServer } from "./http-server.js";
import { ReleasePolicy } from "./policy.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command !== "serve") throw new Error("usage: paperclip-release-broker serve");
  const config = await loadServiceConfig();
  const attestation = new ReleaseAttestationVerifier({
    payloadRoot: resolve(config.releaseRoot, "payload"),
    manifestPath: resolve(config.releaseRoot, "manifest.json"),
    signaturePath: resolve(config.releaseRoot, "manifest.json.sig"),
    publicKeyPath: config.attestationPublicKeyPath,
    expectedGeneration: config.expectedGeneration,
    generationStatePath: config.generationStatePath,
  });
  await attestation.verify();

  const paperclip = new PaperclipApiClient(config.paperclipApiUrl, config.paperclipApiKey);
  const gitlab = new GitLabApiClient(config.gitlabApiUrl, config.gitlabProjectId, config.gitlabToken);
  const policy = new ReleasePolicy(paperclip, gitlab, attestation, {
    companyId: config.companyId,
    gitlabProjectId: config.gitlabProjectId,
    releaseBotAgentId: config.releaseBotAgentId,
    mainLockIssue: config.mainLockIssue,
    allowedPipelineSources: new Set(["push", "merge_request_event"]),
  });
  const broker = new ReleaseBroker({
    config: {
      companyId: config.companyId,
      gitlabProjectId: config.gitlabProjectId,
      allowedClientIdentities: config.allowedClientIdentities,
    },
    store: new CapabilityStore(systemClock, config.capabilityTtlMs),
    policy,
    gitlab,
    audit: new JsonlAuditSink(config.auditPath),
  });
  const server = createBrokerServer(config.tls, broker);
  server.listen(config.port, config.host);

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch(() => {
  process.stderr.write("release-broker startup failed\n");
  process.exitCode = 1;
});
