FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

ARG WARDEN_SOURCE_MANIFEST_SHA256
ARG WARDEN_RENDERED_CONFIG_SHA256
RUN for digest in "${WARDEN_SOURCE_MANIFEST_SHA256}" "${WARDEN_RENDERED_CONFIG_SHA256}"; do \
      case "${digest}" in *[!0-9a-f]*|"") exit 64 ;; esac; \
      [ "${#digest}" -eq 64 ] || exit 64; \
    done
LABEL com.gotto.warden.source-manifest-sha256="${WARDEN_SOURCE_MANIFEST_SHA256}" \
      com.gotto.warden.rendered-config-sha256="${WARDEN_RENDERED_CONFIG_SHA256}"

COPY debian.sources /etc/apt/sources.list.d/debian.sources

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates=20230311+deb12u1 \
        squid=5.7-2+deb12u5 \
        squidclient=5.7-2+deb12u5 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o proxy -g proxy -m 0750 /var/log/squid /run/squid

COPY squid.conf /etc/squid/squid.conf

USER proxy

EXPOSE 3128

ENTRYPOINT ["/usr/sbin/squid", "-NYCd", "1", "-f", "/etc/squid/squid.conf"]
