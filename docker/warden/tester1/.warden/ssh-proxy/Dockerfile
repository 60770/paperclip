FROM alpine:3.22

ARG WARDEN_SOURCE_MANIFEST_SHA256
ARG WARDEN_RENDERED_CONFIG_SHA256
RUN for digest in "${WARDEN_SOURCE_MANIFEST_SHA256}" "${WARDEN_RENDERED_CONFIG_SHA256}"; do \
      case "${digest}" in *[!0-9a-f]*|"") exit 64 ;; esac; \
      [ "${#digest}" -eq 64 ] || exit 64; \
    done
LABEL com.gotto.warden.source-manifest-sha256="${WARDEN_SOURCE_MANIFEST_SHA256}" \
      com.gotto.warden.rendered-config-sha256="${WARDEN_RENDERED_CONFIG_SHA256}"

RUN apk add --no-cache socat \
    && adduser -D -H -u 10002 forwarder

USER forwarder

ENTRYPOINT ["socat"]
