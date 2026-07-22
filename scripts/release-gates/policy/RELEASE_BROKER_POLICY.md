# Attested release broker policy

This bundle is the only release-authority runtime for the internal fork. Its protected-CI signature binds one generation to the exact inventory used by the broker and its operator gates.

## Capability contract

- `POST /v1/capabilities` accepts only `issueId`, `mrIid`, `expectedHeadSha`, and `requestId`.
- Capabilities are random opaque values. The broker stores only SHA-256 digests.
- TTL is at most 30 seconds. A capability is single-use and bound to company, client certificate, issue, project `92`, MR iid, exact head SHA, target `main`, request id, and bundle generation.
- A repeated request id, expired capability, client mismatch, or second consumption is denied and audited.

## Complete mediation

Issuance resolves Paperclip issue status and ownership, canonical MR line, live agent roles, review and QA freshness, GitLab MR/pipeline state, main lock, human-decision ancestry, and the signed bundle inventory. The caller cannot provide any preflight result.

Consumption atomically claims the capability and repeats all policy reads. Immediately before the sole merge request it repeats main lock, human gate, live MR state, exact SHA, pipeline source, mergeability, and generation. Any missing, malformed, unclassified, stale, or contradictory value fails closed.

The only merge operation is emitted by `packages/release-broker/dist/http-clients.js`, with `sha`, `squash=true`, and `should_remove_source_branch=true`. The GitLab merge credential is loaded by the broker service manager and is never present in the Paperclip runtime.

## Attested inventory mapping

- Human-decision semantics: `scripts/release-gates/runtime/bin/release-human-gate-preflight.sh` and `packages/release-broker/dist/policy.js`.
- Main-lock semantics: `scripts/release-gates/runtime/bin/release-main-lock-resolver.sh`, `scripts/release-gates/runtime/lib/release_main_lock_resolver.py`, and `packages/release-broker/dist/policy.js`.
- Review/QA token targeting and freshness: `packages/release-broker/dist/policy.js`.
- TTL, digest-only storage, request binding, single-use, and replay denial: `packages/release-broker/dist/capability-store.js`.
- Runtime signature, inventory, mode, hash, and generation checks: `packages/release-broker/dist/attestation.js` and `scripts/release-gates/runtime/bin/release-gate`.

Rollback always installs a newly signed, monotonically higher generation containing previously known-good bytes. Direct generation replay is invalid. When verification or rollback fails, merge consumption stays disabled; no legacy path is restored.
