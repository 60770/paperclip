FROM debian:bookworm-slim

ARG WARDEN_SOURCE_MANIFEST_SHA256
ARG WARDEN_RENDERED_CONFIG_SHA256
RUN for digest in "${WARDEN_SOURCE_MANIFEST_SHA256}" "${WARDEN_RENDERED_CONFIG_SHA256}"; do \
      case "${digest}" in *[!0-9a-f]*|"") exit 64 ;; esac; \
      [ "${#digest}" -eq 64 ]; \
    done
LABEL com.gotto.warden.source-manifest-sha256="${WARDEN_SOURCE_MANIFEST_SHA256}" \
      com.gotto.warden.rendered-config-sha256="${WARDEN_RENDERED_CONFIG_SHA256}"

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        squid \
        squidclient \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o proxy -g proxy -m 0750 /var/log/squid /run/squid

COPY squid.conf /etc/squid/squid.conf

USER proxy

EXPOSE 3128

ENTRYPOINT ["/usr/sbin/squid", "-NYCd", "1", "-f", "/etc/squid/squid.conf"]
