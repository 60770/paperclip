FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

ARG WARDEN_SOURCE_MANIFEST_SHA256
ARG WARDEN_RENDERED_CONFIG_SHA256
RUN for digest in "${WARDEN_SOURCE_MANIFEST_SHA256}" "${WARDEN_RENDERED_CONFIG_SHA256}"; do \
      case "${digest}" in *[!0-9a-f]*|"") exit 64 ;; esac; \
      [ "${#digest}" -eq 64 ] || exit 64; \
    done
LABEL com.gotto.warden.source-manifest-sha256="${WARDEN_SOURCE_MANIFEST_SHA256}" \
      com.gotto.warden.rendered-config-sha256="${WARDEN_RENDERED_CONFIG_SHA256}"

ADD --checksum=sha256:0815a5f0403974bb9c34d456e71dc9c0222cb5455d393bc63c44b573da3d7fe0 https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86_64/ncurses-terminfo-base-6.5_p20250503-r0.apk /tmp/packages/ncurses-terminfo-base-6.5_p20250503-r0.apk
ADD --checksum=sha256:aeafdfca68147b014705b4e2564639ade6345198debb522f2c6c51d32e417651 https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86_64/libncursesw-6.5_p20250503-r0.apk /tmp/packages/libncursesw-6.5_p20250503-r0.apk
ADD --checksum=sha256:520fa586c689144928191bee13e2c85ff4e170ad87d1471ec48e3e97611673d8 https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86_64/readline-8.2.13-r1.apk /tmp/packages/readline-8.2.13-r1.apk
ADD --checksum=sha256:370aa3c457d13510125539e819498ebf17a486258e30517a47305d69bef34119 https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86_64/socat-1.8.1.3-r0.apk /tmp/packages/socat-1.8.1.3-r0.apk

RUN apk add --no-network --repositories-file /dev/null --allow-untrusted \
        /tmp/packages/ncurses-terminfo-base-6.5_p20250503-r0.apk \
        /tmp/packages/libncursesw-6.5_p20250503-r0.apk \
        /tmp/packages/readline-8.2.13-r1.apk \
        /tmp/packages/socat-1.8.1.3-r0.apk \
    && rm -rf /tmp/packages \
    && adduser -D -H -u 10002 forwarder

USER forwarder

ENTRYPOINT ["socat"]
