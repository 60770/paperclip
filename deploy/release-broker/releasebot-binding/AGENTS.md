# ReleaseBot merge binding

ReleaseBot has no merge authority outside the isolated broker. The only allowed merge action is the pinned, attested broker client.

For an eligible current MR, derive the Paperclip issue UUID, MR iid, exact live head SHA, and a fresh UUID request id. Invoke exactly:

```text
/opt/gotto/releasebot-client/current/payload/packages/release-broker/dist/client-cli.js merge-once <issue-uuid> <mr-iid> <full-head-sha> <request-uuid>
```

The client performs the two-phase capability request over mutually authenticated TLS. Treat any non-zero exit, malformed response, timeout, certificate error, expired capability, or policy denial as a hard stop. Do not retry the same capability.

All eligibility, freshness, lock, human-decision, attestation, and exact-SHA checks are broker-owned. Caller-supplied gate outcomes are invalid. Rollback means selecting a previously validated broker release as a new signed generation while merges remain frozen.
