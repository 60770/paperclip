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
ADD --checksum=sha256:e2df23c675224c58983636b66ad418affc426406c0cf506056c20ec404685fc6 https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86_64/libedit-20250104.3.1-r1.apk /tmp/packages/libedit-20250104.3.1-r1.apk
ADD --checksum=sha256:fc987a5cc9edea62c5b6caa57ba5c9444952939ab93ae5dbb75ed2c0f15f4fa7 https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86_64/openssh-keygen-10.0_p1-r10.apk /tmp/packages/openssh-keygen-10.0_p1-r10.apk
ADD --checksum=sha256:1c7fe78682f1730546585f0aab360996f31ddacc38897fc3023dce81aa00e93c https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86_64/openssh-client-common-10.0_p1-r10.apk /tmp/packages/openssh-client-common-10.0_p1-r10.apk
ADD --checksum=sha256:ea33240684ec7db3a485136d4e3c2101e78b9150ae4a94652bb5efed67f9d01a https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86_64/openssh-client-default-10.0_p1-r10.apk /tmp/packages/openssh-client-default-10.0_p1-r10.apk

RUN apk add --no-network --repositories-file /dev/null --allow-untrusted \
        /tmp/packages/ncurses-terminfo-base-6.5_p20250503-r0.apk \
        /tmp/packages/libncursesw-6.5_p20250503-r0.apk \
        /tmp/packages/libedit-20250104.3.1-r1.apk \
        /tmp/packages/openssh-keygen-10.0_p1-r10.apk \
        /tmp/packages/openssh-client-common-10.0_p1-r10.apk \
        /tmp/packages/openssh-client-default-10.0_p1-r10.apk \
    && rm -rf /tmp/packages \
    && adduser -D -H -u 10003 tunnel \
    && install -d -o tunnel -g tunnel -m 0700 /home/tunnel/.ssh \
    && install -d -o tunnel -g tunnel -m 0755 /run/qa-tunnel-public

COPY --chown=tunnel:tunnel entrypoint.sh /home/tunnel/entrypoint.sh

RUN chmod 0555 /home/tunnel/entrypoint.sh

USER tunnel

ENTRYPOINT ["/home/tunnel/entrypoint.sh"]
