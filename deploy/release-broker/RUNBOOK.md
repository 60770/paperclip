# Isolated release broker runbook

This procedure is for a dedicated trust domain. Do not install the broker on a host where the Paperclip operator or any agent runtime can obtain root, administer containers, mount host filesystems, replace the service, or read service-manager credentials.

## Trust prerequisites

- A dedicated VM or host with a separately administered root identity.
- No login, SSH key, `sudo`, Docker, LXD, container socket, or hypervisor control for Paperclip and agent principals.
- Egress firewall allowlisting only the Paperclip API and GitLab API destinations. The unit denies all IP traffic until an approved `IPAddressAllow` drop-in is installed.
- A protected-CI Ed25519 signing key. The private key never reaches this host. Install only its public key at `/etc/gotto/release-broker/ed25519.pub` as root-owned `0444`.
- A dedicated Paperclip credential restricted to company-scoped read endpoints needed for issues, comments, activities, interactions, and agents.
- A dedicated GitLab project `92` service principal restricted to merging the protected `main` branch. No other local principal receives this credential.
- A mutually authenticated TLS server identity and an allowlisted ReleaseBot client certificate.

If any prerequisite is unproven, keep the service disabled and merges frozen.

## Build in protected CI

From a clean commit of the internal fork, build a monotonically increasing generation. The signing-key argument points at the protected CI secret file and is never printed or copied into the artifact.

```sh
scripts/release-gates/build-release-bundle.sh \
  --generation <N> \
  --output <artifact-directory> \
  --signing-key <protected-ci-key-file>
```

The artifact contains `payload/`, canonical `manifest.json`, and detached `manifest.json.sig`. Retain the full source commit, manifest digest, generation, and CI job identity in the release record.

## Host bootstrap

Run bootstrap commands only from the dedicated host administrator identity.

```sh
useradd --system --no-create-home --shell /usr/sbin/nologin gotto-merge-broker
install -o root -g root -m 0444 deploy/release-broker/gotto-release-broker.service /etc/systemd/system/gotto-release-broker.service
install -o root -g root -m 0444 deploy/release-broker/gotto-release-broker.tmpfiles /etc/tmpfiles.d/gotto-release-broker.conf
install -o root -g root -m 0555 deploy/release-broker/install-release-broker.sh /usr/local/sbin/install-release-broker
install -o root -g root -m 0555 deploy/release-broker/verify-release-bundle.py /usr/local/libexec/gotto-release-broker-verify
systemd-tmpfiles --create /etc/tmpfiles.d/gotto-release-broker.conf
```

Install the public signing key and a completed non-secret `broker.conf`. Install the network allowlist as a service drop-in only after firewall review. Keep `IPAddressDeny=any` in force.

Provision the five credential sources referenced by `LoadCredential=` through the host secret manager:

- `gitlab-merge-token`
- `paperclip-api-key`
- `server-cert`
- `server-key`
- `client-ca`

Do not place credential values in environment files, shell history, process arguments, the repository, Paperclip, issue comments, or logs. Root-owned source files are an input to systemd credential injection; the service receives private copies under its credential directory.

## Install and enable a generation

Transfer the signed artifact through the privileged administration channel into a new directory below `/var/lib/gotto-release-broker-incoming/`. The installer rejects every other source path, symlinks, signature drift, inventory drift, unexpected modes, and generation replay.

```sh
/usr/local/sbin/install-release-broker /var/lib/gotto-release-broker-incoming/<bundle-directory>
systemctl enable gotto-release-broker.service
systemctl status gotto-release-broker.service
```

The installer verifies before stopping the old service, then freezes merges, records the new monotonic generation, switches broker `current` atomically, and starts the new generation. Any failure after the freeze leaves the broker stopped or unable to attest; do not bypass it.

## ReleaseBot client and binding rollout

The client and pinned binding belong on the Paperclip control-plane host, not on the broker host. Do not perform this rollout while the Paperclip or agent principal retains `sudo`, Docker/LXD administration, a container socket, or any equivalent route to root. Under that condition the binding is replaceable and the rollout is invalid; leave release processing frozen.

After runtime-principal isolation is independently proven, install `install-releasebot-client.sh`, `verify-release-bundle.py`, `gotto-releasebot-client.tmpfiles`, and the same public signing key as root-owned files on the control-plane host. Transfer the same signed generation below `/var/lib/gotto-releasebot-client-incoming/`, then run:

```sh
/usr/local/sbin/install-releasebot-client /var/lib/gotto-releasebot-client-incoming/<bundle-directory>
```

This installs only the signed client bundle and `/opt/gotto/releasebot-binding/AGENTS.md`; it installs no GitLab credential. Inject the mTLS client certificate, client key, and broker CA into the ReleaseBot runtime with service-manager credentials named `client-cert`, `client-key`, and `broker-ca`. Configure only the non-secret broker URL. Pin the ReleaseBot instructions path to `/opt/gotto/releasebot-binding/AGENTS.md` and prove that every parent directory and file is root-owned and non-writable by the runtime principal.

## Verification and audit

```sh
systemctl show gotto-release-broker.service \
  -p NoNewPrivileges -p CapabilityBoundingSet -p AmbientCapabilities \
  -p ProtectSystem -p ProtectHome -p PrivateDevices -p PrivateTmp \
  -p RestrictNamespaces -p RestrictSUIDSGID -p MemoryDenyWriteExecute
/opt/gotto/release-broker/current/payload/scripts/release-gates/runtime/bin/release-gate verify
systemd-analyze security gotto-release-broker.service
journalctl -u gotto-release-broker.service --since today
```

Broker audit records are JSON lines in `/var/log/gotto-release-broker/audit.jsonl`. Ship them to the protected audit sink. Records contain request, issue, MR, SHA, generation, client identity, decision, reason, and redacted merge result; they contain no credentials, authorization headers, or capability values.

Run repository regressions for every generation:

```sh
pnpm --filter @paperclipai/release-broker typecheck
pnpm --filter @paperclipai/release-broker test
scripts/release-gates/test/test-release-broker-binding.sh
scripts/release-gates/test/test-release-broker-systemd.sh
```

## Negative checks from the agent principal

Execute these checks as the Paperclip/ReleaseBot runtime principal, never as the broker service user or host administrator. Every command must fail or report unavailable; do not attempt to display credential contents.

```sh
sudo -n true
docker info
lxc list
test -r /etc/gotto/release-broker/credentials/gitlab-merge-token
test -w /opt/gotto/releasebot-binding/AGENTS.md
test -w /opt/gotto/releasebot-binding
test -w /opt/gotto/release-broker/current
```

Also verify the runtime has no container socket, device access, host mount, capability, or alternative ReleaseBot instructions path. Confirm the pinned binding invokes only `client-cli.js merge-once` and that a direct GitLab attempt from the agent network identity receives `401` or `403` without changing MR state.

## Credential rotation

1. Freeze release processing and stop `gotto-release-broker.service`.
2. Create a new least-privilege credential in the provider and update the fixed systemd credential source through the host secret manager.
3. Start the service and verify attestation, mTLS, a deny-path capability request, and audit delivery.
4. Revoke the prior credential at the provider and verify it is unusable.
5. Remove the prior secret-manager version according to retention policy.

Never stage a previous credential in Paperclip or add a client-side fallback during rotation.

## Rollback and recovery

Rollback is a new protected-CI artifact with generation `N+1`, known-good source bytes, and `--rollback-of <broken-generation>`. Install it through the normal verifier and installer while merges remain frozen. Reinstalling an older generation directly is replay and must fail.

For signature, inventory, audit, filesystem, credential, network, or policy failures:

1. Stop the broker and keep release processing frozen.
2. Preserve journal and audit evidence without copying credentials.
3. Repair the trust-domain configuration or publish a newly signed generation.
4. Repeat all verification and negative checks before re-enabling consumption.

There is no rollback path that restores a GitLab credential, credential store, gate resolver, or direct merge operation to the Paperclip/agent runtime.
