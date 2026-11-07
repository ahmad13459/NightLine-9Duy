# ============================================================================
# NIGHTLINE · Railway Edition
# One container: panel + Xray-core + sing-box + mtg (MTProto proxy)
#
# NOTE ON THE BASE IMAGE
# sing-box ships glibc-linked Linux binaries (NEEDED: libc.so.6, libpthread,
# libdl). On Alpine/musl those fail with `not found` (exit 127), so the base
# image is Debian slim (glibc). xray and mtg are static and run anywhere.
# ============================================================================
FROM node:22-bookworm-slim

ARG XRAY_VERSION=26.10.31
ARG SINGBOX_VERSION=1.14.4
ARG MTG_VERSION=2.3.0
ARG TARGETARCH=amd64

# Optional prefix for GitHub downloads when github.com is slow/blocked, e.g.
#   --build-arg GH_MIRROR=https://gh-proxy.com/
# The prefix is glued in front of the full URL:
#   https://gh-proxy.com/https://github.com/XTLS/Xray-core/releases/download/...
ARG GH_MIRROR=

# NOTE: PORT and DATA_DIR are deliberately NOT set here. They are mandatory
# Railway service variables (PORT=8080, DATA_DIR=/data) and the boot guard in
# src/guard.js refuses to start without them and without a volume mounted on
# DATA_DIR — see README → «دو متغیر اجباری».
ENV NODE_ENV=production \
    NL_BIN_DIR=/app/bin \
    NL_TCP_PORT=8443 \
    XRAY_LOCATION_ASSET=/app/bin

# openssl is only needed once: to mint the self-signed certificate that
# AnyTLS / Trojan-TLS / ShadowTLS / Hysteria2 inbounds use.
RUN set -eux; \
    for attempt in 1 2 3; do \
      if apt-get update && apt-get install -y --no-install-recommends \
           ca-certificates curl unzip tar openssl tzdata; then break; fi; \
      echo "apt attempt ${attempt} failed, retrying…"; sleep $((attempt * 5)); \
    done; \
    rm -rf /var/lib/apt/lists/*

# ── cores ───────────────────────────────────────────────────────────────────
# Every download is retried (GitHub's CDN likes to answer 502/503/504) and, if
# GH_MIRROR is set, retried again through the mirror.
RUN set -eux; \
    mkdir -p /app/bin; \
    case "${TARGETARCH}" in \
      amd64) XRAY_ZIP="Xray-linux-64.zip"; SB_ARCH="amd64"; MTG_ARCH="amd64" ;; \
      arm64) XRAY_ZIP="Xray-linux-arm64-v8a.zip"; SB_ARCH="arm64"; MTG_ARCH="arm64" ;; \
      *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; \
    esac; \
    dl() { \
      url="$1"; out="$2"; \
      tries=""; \
      if [ -n "${GH_MIRROR}" ]; then tries="${GH_MIRROR} "; fi; \
      for mirror in ${tries} ""; do \
        for attempt in 1 2 3 4 5; do \
          rm -f "$out"; \
          if curl -fSL --retry 3 --retry-delay 2 --retry-all-errors \
                   --connect-timeout 20 --max-time 600 \
                   -o "$out" "${mirror}${url}"; then \
            if [ -s "$out" ]; then echo "downloaded ${url} (attempt ${attempt})"; return 0; fi; \
          fi; \
          echo "attempt ${attempt} failed for ${url}, retrying…"; sleep $((attempt * 3)); \
        done; \
      done; \
      echo "FATAL: could not download ${url}"; return 1; \
    }; \
    dl "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/${XRAY_ZIP}" /tmp/xray.zip; \
    unzip -q /tmp/xray.zip -d /app/bin; \
    rm -f /tmp/xray.zip; \
    dl "https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-linux-${SB_ARCH}.tar.gz" /tmp/sb.tar.gz; \
    tar -xzf /tmp/sb.tar.gz -C /tmp; \
    mv "/tmp/sing-box-${SINGBOX_VERSION}-linux-${SB_ARCH}/sing-box" /app/bin/sing-box; \
    rm -rf /tmp/sb.tar.gz "/tmp/sing-box-${SINGBOX_VERSION}-linux-${SB_ARCH}"; \
    chmod +x /app/bin/xray /app/bin/sing-box; \
    test -s /app/bin/xray; \
    test -s /app/bin/sing-box; \
    /app/bin/xray version; \
    /app/bin/sing-box version; \
    if dl "https://github.com/9seconds/mtg/releases/download/v${MTG_VERSION}/mtg-${MTG_VERSION}-linux-${MTG_ARCH}.tar.gz" /tmp/mtg.tar.gz; then \
      tar -xzf /tmp/mtg.tar.gz -C /tmp; \
      mv "/tmp/mtg-${MTG_VERSION}-linux-${MTG_ARCH}/mtg" /app/bin/mtg; \
      chmod +x /app/bin/mtg; \
      /app/bin/mtg --version; \
    else \
      echo "!! WARNING: mtg could not be downloaded — the panel builds fine,"; \
      echo "!! MTProto will simply show as unavailable. Re-deploy later or set"; \
      echo "!! --build-arg GH_MIRROR=... to fetch it through a mirror."; \
    fi; \
    rm -rf /tmp/mtg.tar.gz /tmp/mtg-*.tar.gz /tmp/mtg-${MTG_VERSION}-linux-${MTG_ARCH} /tmp/xray.zip


# ── iranian routing data ────────────────────────────────────────────────────
# geosite.dat / geoip.dat come from the Iran v2ray rules project (a superset of
# the stock lists: ir, ads, malware, phishing, cryptominers) and the sing-box
# rule-sets are stored next to them, so the SERVER enforces the block rules with
# no network access at runtime. Xray looks for its .dat files beside its binary.
# If every download fails the marker says so and the panel falls back to the
# names the stock lists know — the cores never fail to start.
RUN set -eux; \
    mkdir -p /app/bin/srs; ok=1; \
    fetch() { url="$1"; out="$2"; \
      for attempt in 1 2 3 4 5; do \
        if curl -fSL --retry 2 --retry-delay 2 --retry-all-errors \
                 --connect-timeout 20 --max-time 300 \
                 -o "$out.part" "$url"; then mv "$out.part" "$out"; return 0; fi; \
        echo "retry ${attempt} for ${url}"; sleep $((attempt * 3)); \
      done; rm -f "$out.part"; return 1; }; \
    for f in geosite.dat geoip.dat; do \
      fetch "https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/$f" "/app/bin/$f" || ok=0; \
    done; \
    for f in geosite-category-ir geoip-ir geosite-category-ads-all geosite-malware geosite-phishing geoip-malware; do \
      fetch "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/$f.srs" "/app/bin/srs/$f.srs" || ok=0; \
    done; \
    if [ "$ok" = "1" ]; then \
      printf '{"iran":true}\n' > /app/bin/.iran-rules.json; echo "iranian routing data: ok"; \
    else \
      printf '{"iran":false}\n' > /app/bin/.iran-rules.json; \
      echo "!! iranian routing data incomplete — falling back to the stock lists"; \
    fi; \
    ls -lh /app/bin /app/bin/srs

# ── app ─────────────────────────────────────────────────────────────────────
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /data

EXPOSE 8080
EXPOSE 8443

# The panel may answer on several ports (see PANEL_PORTS in src/env.js); try them all.
HEALTHCHECK --interval=45s --timeout=8s --start-period=40s --retries=4 \
  CMD node -e "const ps=[process.env.NL_PANEL_PORT,process.env.PORT,8080,3000].filter(Boolean).map(Number);(async()=>{for(const p of ps){try{const r=await fetch('http://127.0.0.1:'+p+'/health');if(r.ok)process.exit(0)}catch{}}process.exit(1)})()"

CMD ["node", "src/boot.js"]
