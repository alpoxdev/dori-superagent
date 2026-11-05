# dori-superagent container recipe — see docs/container.md before changing anything here.
# Ubuntu, not Alpine: bun and herdr need glibc.
FROM ubuntu:24.04

# Every downloaded binary (gh, node, bun, herdr) is sha256-verified; npm packages and
# the harness are pinned by version and commit. Bump deliberately and re-run the
# acceptance checks in docs/container.md.
# Builds for linux/amd64 and linux/arm64; TARGETARCH is set by the builder.
ARG TARGETARCH
ARG NODE_VERSION=24.21.0
ARG NODE_SHA256_AMD64=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
ARG NODE_SHA256_ARM64=724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5
ARG BUN_VERSION=1.4.4
ARG BUN_SHA256_AMD64=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
ARG BUN_SHA256_ARM64=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
ARG HERDR_VERSION=0.9.5
ARG HERDR_SHA256_AMD64=14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d
ARG HERDR_SHA256_ARM64=17d7536f2da50859523680ef279dffcac8e4a235f4e46fe8da6c2ec44141897c
ARG AGENT_MESSENGER_VERSION=2.40.0
ARG OMP_VERSION=18.16.0
ARG GH_VERSION=2.100.0
ARG GH_SHA256_AMD64=698c8d88cc19cc92bfe96bad58d10b2a5b274c52433d6dc57799c81f6139d5fc
ARG GH_SHA256_ARM64=33ccd2ad7ce639c927e1cb209e36555b0e1fbb89f7a38239c0568040ec758612
ARG DORI_REF=894e54c3158a65c7c026475b0bac3b0bfc13375f

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip jq ripgrep procps openssh-client \
    && rm -rf /var/lib/apt/lists/*

# gh, node, bun and herdr: pinned per-arch assets, each sha256-verified
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) NODE_ASSET=x64;    HERDR_ASSET=x86_64;  BUN_ASSET=x64;    GH_ASSET=amd64; \
             NODE_SHA256="${NODE_SHA256_AMD64}"; HERDR_SHA256="${HERDR_SHA256_AMD64}"; \
             BUN_SHA256="${BUN_SHA256_AMD64}";   GH_SHA256="${GH_SHA256_AMD64}" ;; \
      arm64) NODE_ASSET=arm64;   HERDR_ASSET=aarch64; BUN_ASSET=aarch64; GH_ASSET=arm64; \
             NODE_SHA256="${NODE_SHA256_ARM64}"; HERDR_SHA256="${HERDR_SHA256_ARM64}"; \
             BUN_SHA256="${BUN_SHA256_ARM64}";   GH_SHA256="${GH_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/gh.deb \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ASSET}.deb" \
    && echo "${GH_SHA256}  /tmp/gh.deb" | sha256sum -c - \
    && dpkg -i /tmp/gh.deb && rm /tmp/gh.deb && \
    curl -fsSL -o /tmp/node.tar.gz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ASSET}.tar.gz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
    && tar -xz -C /usr/local --strip-components=1 -f /tmp/node.tar.gz && rm /tmp/node.tar.gz && \
    curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ASSET}.zip" \
    && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -j -o /tmp/bun.zip "*/bun" -d /usr/local/bin && rm /tmp/bun.zip \
    && chmod +x /usr/local/bin/bun && ln -sf /usr/local/bin/bun /usr/local/bin/bunx && \
    curl -fsSL -o /usr/local/bin/herdr \
      "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-${HERDR_ASSET}" \
    && echo "${HERDR_SHA256}  /usr/local/bin/herdr" | sha256sum -c - \
    && chmod +x /usr/local/bin/herdr

# bun global packages install their launchers into $BUN_INSTALL/bin
ENV BUN_INSTALL=/usr/local

# agent-messenger and omp (needs bun 1.4.4 or newer), pinned npm packages via bun's global install
RUN bun install -g agent-messenger@${AGENT_MESSENGER_VERSION} @oh-my-pi/pi-coding-agent@${OMP_VERSION}

# the dori harness itself, pinned commit; the skill's scripts get their deps baked in
RUN git clone -q https://github.com/alpoxdev/dori-superagent.git /opt/dori-superagent \
    && git -C /opt/dori-superagent checkout -q "${DORI_REF}" \
    && rm -rf /opt/dori-superagent/.git \
    && bun install --cwd /opt/dori-superagent/skills/dori-mode/scripts \
    && printf '#!/bin/sh\nexec bun /opt/dori-superagent/src/cli.ts "$@"\n' > /usr/local/bin/dori \
    && chmod +x /usr/local/bin/dori

# run as a normal user; all state lives in the volumes named in compose.yaml
# the state dirs are pre-created with dori ownership so fresh named volumes inherit it
RUN useradd -m -s /bin/bash dori \
    && mkdir -p /home/dori/projects /home/dori/.dori /home/dori/.omp \
      /home/dori/.config/gh /home/dori/.config/agent-messenger \
    && chown -R dori:dori /home/dori

USER dori
WORKDIR /home/dori

# herdr's server hosts the panes; the entrypoint starts it (nohup, so it survives
# the exec into the container command)
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/entrypoint.sh"]
# stay up without a terminal attached; the TTY comes from `docker exec -it`
CMD ["sleep", "infinity"]
