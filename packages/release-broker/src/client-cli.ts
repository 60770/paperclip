#!/usr/bin/env node
import { resolve } from "node:path";
import { ReleaseBrokerClient } from "./client.js";
import { parseCapabilityRequest } from "./validation.js";

async function main(): Promise<void> {
  for (const key of ["GITLAB_API_TOKEN", "GITLAB_TOKEN", "PAPERCLIP_API_KEY"]) {
    if (process.env[key]) throw new Error(`${key} is forbidden in the ReleaseBot client runtime`);
  }
  if (process.argv[2] !== "merge-once") {
    throw new Error("usage: paperclip-release-broker-client merge-once <issue-id> <mr-iid> <head-sha> <request-id>");
  }
  const credentialDirectory = process.env.CREDENTIALS_DIRECTORY;
  const baseUrl = process.env.RELEASE_BROKER_URL;
  if (!credentialDirectory || !baseUrl) throw new Error("Missing broker client configuration");
  const input = parseCapabilityRequest({
    issueId: process.argv[3],
    mrIid: Number(process.argv[4]),
    expectedHeadSha: process.argv[5],
    requestId: process.argv[6],
  });
  const client = await ReleaseBrokerClient.create({
    baseUrl,
    certPath: resolve(credentialDirectory, "client-cert"),
    keyPath: resolve(credentialDirectory, "client-key"),
    caPath: resolve(credentialDirectory, "broker-ca"),
  });
  const result = await client.mergeOnce(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(() => {
  process.stderr.write("release-broker client request failed\n");
  process.exitCode = 1;
});
