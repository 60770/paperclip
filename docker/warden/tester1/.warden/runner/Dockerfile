FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG WARDEN_SOURCE_MANIFEST_SHA256
ARG WARDEN_RENDERED_CONFIG_SHA256
RUN for digest in "${WARDEN_SOURCE_MANIFEST_SHA256}" "${WARDEN_RENDERED_CONFIG_SHA256}"; do \
      case "${digest}" in *[!0-9a-f]*|"") exit 64 ;; esac; \
      [ "${#digest}" -eq 64 ]; \
    done
LABEL com.gotto.warden.source-manifest-sha256="${WARDEN_SOURCE_MANIFEST_SHA256}" \
      com.gotto.warden.rendered-config-sha256="${WARDEN_RENDERED_CONFIG_SHA256}"

COPY debian.sources /etc/apt/sources.list.d/debian.sources
COPY package.json package-lock.json /opt/runner-tools/

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates=20230311+deb12u1 \
        chromium=150.0.7871.124-1~deb12u1 \
        curl=7.88.1-10+deb12u15 \
        fonts-liberation=1:1.07.4-11 \
        git=1:2.39.5-0+deb12u3 \
        jq=1.6-2.1+deb12u2 \
        openssh-server=1:9.2p1-2+deb12u10 \
        procps=2:4.0.2-3 \
        python-is-python3=3.11.2-1+deb12u1 \
        python3=3.11.2-1+b1 \
        python3-pytest=7.2.1-2 \
        rsync=3.2.7-1+deb12u6 \
    && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci \
        --prefix /opt/runner-tools \
        --omit=dev \
        --no-audit \
        --no-fund \
    && useradd --create-home --uid 10001 --shell /bin/bash runner \
    && install -d -o runner -g runner -m 0700 /home/runner/.ssh \
    && install -d -o runner -g runner -m 0750 /workspace \
    && rm -rf /var/lib/apt/lists/* /root/.npm

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --chown=runner:runner authorized_keys /home/runner/.ssh/authorized_keys
COPY codex-warden /usr/local/bin/codex-warden
COPY --chown=runner:runner runner-shell.sh /home/runner/runner-shell.sh
COPY --chown=runner:runner tunnel-shell.sh /home/runner/tunnel-shell.sh
COPY tunnel-authorized-key.sh /usr/local/bin/tunnel-authorized-key
COPY qa-harness-profile.sh /etc/profile.d/qa-harness-path.sh
COPY --chown=runner:runner ssh_host_ed25519_key /home/runner/.ssh/ssh_host_ed25519_key
COPY --chown=runner:runner ssh_host_ed25519_key.pub /home/runner/.ssh/ssh_host_ed25519_key.pub
COPY sshd_config /etc/ssh/sshd_config
COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh

RUN chmod 0600 /home/runner/.ssh/authorized_keys \
    && chmod 0600 /home/runner/.ssh/ssh_host_ed25519_key \
    && chmod 0644 /home/runner/.ssh/ssh_host_ed25519_key.pub \
    && chmod 0555 /usr/local/bin/codex-warden \
    && chmod 0555 /home/runner/runner-shell.sh \
    && chmod 0555 /home/runner/tunnel-shell.sh \
    && chmod 0555 /usr/local/bin/tunnel-authorized-key \
    && chmod 0444 /etc/profile.d/qa-harness-path.sh \
    && chmod 0555 /home/runner/entrypoint.sh

ENV PATH=/workspace/.qa-harness/bin:/opt/runner-tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin

USER runner
WORKDIR /workspace

EXPOSE 2222

ENTRYPOINT ["/home/runner/entrypoint.sh"]
