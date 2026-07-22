#!/usr/bin/env node
import { ReleaseAttestationVerifier } from "./attestation.js";

async function main(): Promise<void> {
  if (process.argv.length !== 9 || process.argv[2] !== "verify") {
    throw new Error("usage: attestation-cli verify <payload> <manifest> <signature> <public-key> <generation> <generation-state>");
  }
  const generation = Number(process.argv[7]);
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("invalid generation");
  const evidence = await new ReleaseAttestationVerifier({
    payloadRoot: process.argv[3]!,
    manifestPath: process.argv[4]!,
    signaturePath: process.argv[5]!,
    publicKeyPath: process.argv[6]!,
    expectedGeneration: generation,
    generationStatePath: process.argv[8]!,
  }).verify();
  process.stdout.write(`ATTESTATION_OK generation=${evidence.generation} manifest=${evidence.manifestSha256}\n`);
}

main().catch(() => {
  process.stderr.write("ATTESTATION_ERROR reason=verification_failed\n");
  process.exitCode = 21;
});
