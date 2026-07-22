# Tester1 Warden execution environment

Dedicated Warden stack for the Paperclip `Tester1` agent.

## Auditability and rebuild attestation

This directory is the Git-tracked source of truth. The operational copy under
the company `shared/warden/tester1` tree contains only the same attested files
plus `.env` and runtime SSH material. Private keys and environment-local files
must never be committed here.

Every operational command starts with `verify-attestation.sh`, which requires:

- a clean Git worktree and a Git-tracked `attestation/source-manifest.sha256`;
- exact source digests and file modes in the canonical and live trees;
- no unexpected or symlinked files in the live build contexts;
- an exact hash of the Warden-rendered configuration;
- after rebuild, matching source/config labels on all four running images.

Refresh the manifest only after reviewing a canonical source change:

```bash
./refresh-attestation.sh --live-dir /absolute/path/to/shared/warden/tester1
git diff -- attestation/
```

After that change is committed, synchronize and rebuild from the same checkout:

```bash
./sync-live-source.sh --live-dir /absolute/path/to/shared/warden/tester1
./rebuild-attested.sh --live-dir /absolute/path/to/shared/warden/tester1
```

`sync-live-source.sh` never deletes unexpected live files. The subsequent gate
fails closed so an operator must inspect such drift. Use `run-attested.sh` for
non-rebuild operations and boundary verification:

```bash
./run-attested.sh --live-dir /absolute/path/to/shared/warden/tester1 -- \
  /opt/warden/bin/warden env ps
./run-attested.sh --live-dir /absolute/path/to/shared/warden/tester1 -- \
  ./verify-no-docker-boundary.sh
```

`test-attestation-gate.sh` mutates a verifier and the Warden config in isolated
fixtures, injects runtime-only SSH material into a source manifest, and proves
each change is rejected before Warden invocation or live-file writes.
`test-provision-secret-argv.sh` exercises new-environment and key-rotation
provisioning with sentinel credentials and proves neither value enters argv.

## Security boundary

- The runner has no host bind mounts, host Docker socket, Docker CLI, or
  container-control API. QA workloads cannot request privileged containers,
  devices, or host mounts from inside the runner.
- The runner root filesystem is read-only; `/workspace` is a dedicated,
  executable tmpfs so task-local harness shims can run. Paperclip runtime assets
  and credentials never persist to a Docker volume or the host filesystem and
  disappear when the runner is recreated.
- The runner initializes `/workspace` as an empty Git repository on every start,
  so headless Codex execution trusts the ephemeral workspace without persisting
  a host-level trust exception.
- The runner uses an internal-only Docker network and can reach external targets
  only through the allowlisting Squid proxy.
- Allowed proxy destinations are Codex/OpenAI endpoints and TaIA
  preproduction (`estetia.tidycode.it:443`).
- Production (`estetia.it`) is explicitly denied.
- Paperclip API calls use the adapter-managed callback bridge over the existing
  SSH command channel. The bridge injects the run-scoped host credential,
  enforces its route allowlist, and requires no direct control-plane egress from
  the runner or Squid allowlist for port 3100.
- The `codex-warden` entrypoint selects Codex `danger-full-access` for tool
  commands inside this externally isolated runner. This avoids a nested Linux
  namespace while retaining the outer read-only, capability-free, proxy-gated
  Warden boundary. The entrypoint rejects both the combined approval/sandbox
  bypass flag and caller-supplied sandbox overrides.
- Python 3 and pytest are immutable image dependencies. Login shells put
  `/workspace/.qa-harness/bin` first in `PATH`. Container execution is not a
  runner capability; workflows that genuinely need containers require a
  separately reviewed allowlisted broker or a rootless VM/microVM runtime.
- SSH is published only on host loopback at `127.0.0.1:2223`.
- An always-on, read-only `qa-tunnel` sidecar uses the host network only to
  create SSH reverse forwards from host loopback ports 8223/8224 to the runner's
  loopback. It has no workspace mount and no connection to the runner network;
  `sshd` permits remote listeners only on those two addresses and ports. The
  sidecar generates its key in container `tmpfs`, publishes only the public key
  to the runner, and removes both at shutdown.
- The image pins `@playwright/mcp@0.0.78` and Debian Chromium. Tester1's managed
  Codex configuration enables that exact executable as a required stdio MCP
  server. The server is
  exercised headless with `--isolated`, stdout-only output, service workers
  blocked, and without `--allow-unrestricted-file-access`.
- Chromium's nested setuid sandbox is not enabled: it conflicts with the
  container's stronger `no-new-privileges` boundary. The browser remains inside
  the non-root, read-only, capability-free Warden runner with no host mounts or
  host Docker socket and with proxy-enforced egress.

## Paperclip environment values

- Driver: `ssh`
- Host: `127.0.0.1`
- Port: `2223`
- Username: `runner`
- Remote workspace: `/workspace`
- Private key: Paperclip-managed secret referenced by
  `config.privateKeySecretRef`; no plaintext key is kept below `shared/`
- Known hosts: derive with `ssh-keyscan -p 2223 127.0.0.1`

Dedicated key split:

- The runner key is used for shell/automation commands and is
  authorized in `/.warden/runner/authorized_keys` with explicit key restrictions
  (`no-agent-forwarding`, `no-port-forwarding`, `no-X11-forwarding`, `no-pty`)
  and a fixed session command.
- The tunnel key exists only for one QA lifecycle in the sidecar `tmpfs`. Its
  runtime public key is authorized with a fixed tunnel command, remote-only
  forwarding, and `permitlisten` limited to `127.0.0.1:8223` and `:8224`.

The environment must be selected only as Tester1's `defaultEnvironmentId`; it
must not become an instance, company, or project default.

Playwright MCP is installed in the isolated image and enabled only in Tester1's
managed `CODEX_HOME`. Paperclip copies that home into the remote run, so no npm
download or host-global plugin installation is required.

## Tester1 adapter delta

After the rebuilt runner passes the boundary smoke, update Tester1 without
`replaceAdapterConfig`, preserving every existing field and setting only:

```json
{
  "adapterConfig": {
    "command": "/usr/local/bin/codex-warden",
    "dangerouslyBypassApprovalsAndSandbox": false
  }
}
```

Rollback is an agent-only configuration change; the rebuilt image can remain in
place while the wrapper is unused:

```json
{
  "adapterConfig": {
    "command": "codex",
    "dangerouslyBypassApprovalsAndSandbox": false
  }
}
```

The first controlled heartbeat must confirm `pwd` under `/workspace`,
`.qa-harness/bin` first in `PATH`, `python -m pytest --version`, absent Docker
CLI/socket/`DOCKER_HOST`, an unreachable Docker API on port 2375, an
authenticated Paperclip GET through the injected `PAPERCLIP_API_URL` without
printing `PAPERCLIP_API_KEY`, `playwright-mcp --version`, preproduction health,
and denied arbitrary and production egress. Its invocation metadata must contain
`command=/usr/local/bin/codex-warden` and must not contain
`--dangerously-bypass-approvals-and-sandbox`.

Instance-environment registration is deliberately restricted by Paperclip to a
board instance-admin. The helper requires a dedicated authenticated profile,
rejects literal `PAPERCLIP_BOARD_API_KEY`, and clears ambient
`PAPERCLIP_API_KEY` before each CLI call. It resolves the control-plane URL from
`PAPERCLIP_BOARD_API_URL`, then `PAPERCLIP_API_URL`, then the instance config's
`auth.publicBaseUrl`. A malformed value such as bare `localhost` is ignored in
favor of the instance config. Create the profile and run:

```bash
export PAPERCLIP_BOARD_API_URL="$(jq -r '.auth.publicBaseUrl' ../../../../../config.json)"
unset PAPERCLIP_API_KEY PAPERCLIP_RUN_ID
paperclipai connect \
  --persona board \
  --profile tester1-provision \
  --api-key-env-var-name PAPERCLIP_TESTER1_BOARD_KEY \
  --api-base "${PAPERCLIP_BOARD_API_URL}"
# Execute the PAPERCLIP_TESTER1_BOARD_KEY export printed by `connect`, then:
PAPERCLIP_BOARD_PROFILE=tester1-provision ./provision-paperclip.sh
```

The helper is idempotent. It validates the Warden containers and SSH host key,
creates or reuses the `Tester1 Warden` environment, requires a passing Paperclip
SSH probe, assigns it to Tester1, proves that no other agent uses that ID, and
runs the native `codex_local` adapter test inside the saved environment. A
successful run prints both `probe.ok=true` and `adapterTest.status=pass`.

For a runner-key rotation, generate the replacement outside `shared/`, rebuild
the runner with its public key, then rotate the existing Paperclip secret:

```bash
RUNNER_SSH_KEY_FILE=/dev/shm/tester1-runner/runner_ed25519 \
ROTATE_RUNNER_KEY=1 \
PAPERCLIP_BOARD_PROFILE=tester1-provision \
./provision-paperclip.sh
```

Delete the runtime file immediately after the probe and adapter test pass.

## Runner supply chain

The runner build uses immutable inputs:

- `node:24-bookworm-slim` is pinned to an OCI index digest in the Dockerfile;
- Debian and Debian Security resolve through the dated snapshots in
  `.warden/runner/debian.sources`, and every direct APT package pins a version;
- the exact Codex and Playwright MCP versions live in
  `.warden/runner/package.json`, while `package-lock.json` locks transitive
  packages and integrity hashes;
- the image installs npm dependencies only with `npm ci` and removes npm from
  the runtime filesystem after installation.

To update the toolchain:

1. Resolve the new official base digest with
   `docker buildx imagetools inspect docker.io/library/node:24-bookworm-slim`,
   review the upstream release, then update the Dockerfile digest.
2. Advance both timestamps in `debian.sources` to a verified snapshot and
   update the explicit APT versions from that same snapshot.
3. Change only exact dependency versions in `package.json`, then regenerate the
   lock with `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --save-exact <packages>`.
4. Run `./test-supply-chain-guard.sh`; it proves that mutable `FROM`, `npm
   install`, or an omitted lockfile fail closed.
5. Refresh and commit the attestation, synchronize the live tree, then rebuild
   with `./rebuild-attested.sh --live-dir <path>`. Run the boundary smoke and
   `run-attested.sh --live-dir <path> -- ./audit-runner-image.sh <artifact-directory>`.

`audit-runner-image.sh` resolves the runner image ID once and saves that ID to a
temporary Docker archive. Digest-pinned Syft and Trivy containers scan only the
same read-only archive: both run as UID/GID 65532 with networking disabled, a
read-only root filesystem, all capabilities dropped, and
`no-new-privileges`. Trivy's vulnerability DB is downloaded first by a separate
mount-free bootstrap container, then streamed into the network-disabled scan
container. No scanner receives the Docker socket.

The audit writes a CycloneDX SBOM, a full vulnerability report, the final local
image ID, the archive SHA-256, and a summary. It fails when the result contains
a fixable CRITICAL vulnerability; unfixed findings remain explicit in the
report for risk review. `test-supply-chain-guard.sh` includes a socket-reference
mutation and a fake-Docker execution regression that proves both scanners use
the archive-only boundary.

The canonical live-config command runs through the attestation wrapper so the
required source/config build labels are explicit and preserves Warden's final
newline:

```bash
./run-attested.sh --live-dir /absolute/path/to/shared/warden/tester1 -- \
  /bin/bash -c '/opt/warden/bin/warden env config | sha256sum'
```

Record the full digest from that raw stream in the audit handoff. Removing its
final LF produces a different digest and must not be reported as the live-config
hash. `attestation/rendered-config.sha256` is a separate, portable attestation
input: it replaces the live root path and both build-label digests with
deterministic sentinels before hashing.

Rollback: run `/opt/warden/bin/warden env down` and keep Tester1 without a
default environment. Do not restore the removed privileged daemon. Retain the
last accepted digest, SBOM, and scan report for comparison before rebuilding.

## Operations

Run Warden commands from this directory:

```bash
./rebuild-attested.sh --live-dir /absolute/path/to/shared/warden/tester1
./run-attested.sh --live-dir /absolute/path/to/shared/warden/tester1 -- /opt/warden/bin/warden env ps
./run-attested.sh --live-dir /absolute/path/to/shared/warden/tester1 -- /opt/warden/bin/warden env logs --tail=100
./run-attested.sh --live-dir /absolute/path/to/shared/warden/tester1 -- /opt/warden/bin/warden env down
```

Apply this hardening with `rebuild-attested.sh`, which uses
`warden env up --build --remove-orphans`, so the legacy daemon container is
deleted. If the rebuilt runner fails, roll back by taking
the complete Warden environment down and leaving Tester1 without a default
environment. Do not restore or restart the privileged daemon.

The base `env up` starts `qa-tunnel`. The fixed reverse listeners remain limited
to runner loopback ports 8223/8224; TaIA's Tester1 preview uses host and remote
port 8223 so the same URL is reachable from the control plane and the browser.

## Playwright boundary smoke

Rebuild the scoped Warden image, then run the deterministic smoke:

```bash
./rebuild-attested.sh --live-dir /absolute/path/to/shared/warden/tester1
./run-attested.sh --live-dir /absolute/path/to/shared/warden/tester1 -- ./verify-no-docker-boundary.sh
RUNNER_SSH_KEY_FILE=/dev/shm/tester1-runner/runner_ed25519 \
./run-attested.sh --live-dir /absolute/path/to/shared/warden/tester1 -- ./verify-playwright-boundary.sh
```

`verify-no-docker-boundary.sh` needs no runner private key and is safe to run
while Tester1 remains detached. It checks the live container policy, absent
Docker control plane, negative egress, and qa-tunnel forwarding boundary.

The verifier owns the fixture lifecycle. It binds temporary QA fixtures only on
host loopback ports 8223/8224, force-recreates the fixed reverse tunnel, copies
the MCP client into the tmpfs workspace, and removes it before exit. It leaves
`qa-tunnel` running for subsequent Paperclip runtime previews. The checks cover:

- successful browser navigation to both local QA ports;
- denied port forwarding for the runner key;
- denied shell, local forwarding, and non-8223/8224 listeners for the tunnel key;
- no private authentication key in the sidecar image or shared tree;
- rejected SSH reverse listeners on any port other than 8223/8224;
- blocked `file://` navigation;
- denied upload from outside `/workspace`;
- absent host paths, Docker CLI/socket/`DOCKER_HOST`, Docker daemon service, and
  unauthenticated API on port 2375;
- denied privileged, device, and host-bind container requests because no
  agent-facing container control plane exists;
- denied arbitrary direct and proxied egress, including a redirect that bypasses
  the MCP origin allowlist and is stopped by the Warden proxy;
- allowed TaIA preproduction health traffic and denied TaIA production traffic;
- no browser session, cookie, password, storage-state, or trace artifact left in
  `/workspace` or the runner home.

Expected lifecycle/permission output is a sequence of `PASS` lines followed by
inspection proof for every Warden container: non-privileged execution,
`cap_drop=ALL`, default seccomp, no devices, and `no-new-privileges`. The runner
also remains read-only and has no host bind mounts.
