import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReleaseAttestationVerifier } from "./attestation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ReleaseAttestationVerifier", () => {
  it("verifies Ed25519 signature, closed inventory, mode and hash", async () => {
    const fixture = await createFixture();
    await expect(fixture.verifier.verify()).resolves.toMatchObject({
      generation: 7,
      sourceCommit: "a".repeat(40),
    });
  });

  it.each(["hash", "inventory", "mode", "signature", "generation"] as const)(
    "fails closed on %s drift",
    async (fault) => {
      const fixture = await createFixture(fault === "generation" ? 8 : 7);
      if (fault === "hash") {
        await chmod(fixture.payloadFile, 0o755);
        await writeFile(fixture.payloadFile, "mutated");
        await chmod(fixture.payloadFile, 0o555);
      }
      if (fault === "inventory") await writeFile(join(fixture.payloadRoot, "extra"), "extra");
      if (fault === "mode") await chmod(fixture.payloadFile, 0o755);
      if (fault === "signature") {
        await chmod(fixture.signaturePath, 0o644);
        await writeFile(fixture.signaturePath, Buffer.alloc(64));
        await chmod(fixture.signaturePath, 0o444);
      }
      await expect(fixture.verifier.verify()).rejects.toMatchObject({ code: "attestation_failed" });
    },
  );

  it("rejects symlinks in the payload inventory", async () => {
    const fixture = await createFixture();
    await symlink(fixture.payloadFile, join(fixture.payloadRoot, "link"));
    await expect(fixture.verifier.verify()).rejects.toMatchObject({ code: "attestation_failed" });
  });
});

async function createFixture(expectedGeneration = 7) {
  const root = await mkdtemp(join(tmpdir(), "release-attestation-"));
  temporaryDirectories.push(root);
  const payloadRoot = join(root, "payload");
  const payloadFile = join(payloadRoot, "bin", "release-broker");
  const runbookFile = join(payloadRoot, "RUNBOOK.md");
  await mkdir(join(payloadRoot, "bin"), { recursive: true });
  await writeFile(payloadFile, "broker");
  await writeFile(runbookFile, "runbook");
  await chmod(payloadFile, 0o555);
  await chmod(runbookFile, 0o444);

  const { createHash } = await import("node:crypto");
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    generation: 7,
    sourceCommit: "a".repeat(40),
    builtAt: "2026-07-22T12:00:00.000Z",
    files: [
      {
        path: "RUNBOOK.md",
        sha256: createHash("sha256").update("runbook").digest("hex"),
        mode: "0444",
      },
      {
        path: "bin/release-broker",
        sha256: createHash("sha256").update("broker").digest("hex"),
        mode: "0555",
      },
    ],
  })}\n`);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const manifestPath = join(root, "manifest.json");
  const signaturePath = join(root, "manifest.json.sig");
  const publicKeyPath = join(root, "ed25519.pub");
  await writeFile(manifestPath, manifest);
  await writeFile(signaturePath, sign(null, manifest, privateKey));
  await writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));
  await Promise.all([
    chmod(manifestPath, 0o444),
    chmod(signaturePath, 0o444),
    chmod(publicKeyPath, 0o444),
  ]);

  return {
    payloadRoot,
    payloadFile,
    signaturePath,
    verifier: new ReleaseAttestationVerifier({
      payloadRoot,
      manifestPath,
      signaturePath,
      publicKeyPath,
      expectedGeneration,
    }),
  };
}
