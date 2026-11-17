# Builder stage: installs the pinned toolchain via the vendored Mise launcher,
# the locked dependencies, and downloads the image-matching model once.
FROM debian:13.7-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get -y --no-install-recommends install \
    curl git ca-certificates build-essential \
  && rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV MISE_DATA_DIR="/app/.mise"
ENV MISE_CONFIG_DIR="/app/.mise/config"
ENV MISE_CACHE_DIR="/app/.mise/cache"
ENV MISE_INSTALL_PATH="/usr/local/bin/mise"
ENV PATH="/app/.mise/shims:$PATH"

COPY .mise.toml ./
COPY package.json ./
# bun.lock must be present for the frozen install below; without it the image
# silently resolves fresh versions and drifts from the committed lockfile.
COPY bun.lock ./
COPY bin/mise ./bin/mise

RUN bin/mise install

# Install all dependencies, pinned to the lockfile
RUN bin/mise run ci:install

# The model download script and the config it reads
COPY tsconfig.bot.json ./
COPY src/bot ./src/bot
COPY scripts ./scripts

# Download the image model into /app/models at build time, so the running
# container needs no access to Hugging Face.
ENV MODEL_CACHE_DIR=/app/models
RUN bin/mise run model:download

# Production stage. It runs `bun run src/bot/bot.ts` instead of a compiled
# binary: `bun build --compile` cannot load the image model (transformers.js
# needs sharp and onnxruntime-node native addons that do not work once
# embedded in the binary; see docs/image-matching.md). So this stage carries the
# mise-installed Bun, the production node_modules and the TypeScript source.
FROM debian:13.7-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS production

WORKDIR /app

# ca-certificates for outbound HTTPS; procps for the pgrep healthcheck below
RUN apt-get update \
  && apt-get -y --no-install-recommends install \
    ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*

# The exact Bun version the builder installed from .mise.toml
COPY --from=builder /app/.mise/installs/bun/ /opt/bun-installs/
RUN set -e; \
  bun_bin="$(find /opt/bun-installs -type f -name bun -path '*/bin/bun' | head -n 1)"; \
  test -n "$bun_bin"; \
  install -m 0755 "$bun_bin" /usr/local/bin/bun; \
  rm -rf /opt/bun-installs; \
  bun --version

# Production dependencies only, pinned to the lockfile. --ignore-scripts skips
# native postinstall downloads (sharp is bypassed by the embedder).
COPY package.json bun.lock tsconfig.bot.json ./
RUN bun install --production --frozen-lockfile --ignore-scripts

COPY src/bot ./src/bot
COPY --from=builder /app/models ./models

ENV NODE_ENV=production
ENV MIGRATIONS_PATH=/app/src/bot/database/migrations
ENV MODEL_CACHE_DIR=/app/models
ENV DB_PATH=/app/data/cards.db

# Run as a non-root user; data/ (SQLite volume) and logs/ must be writable
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin bot \
  && mkdir -p /app/data /app/logs \
  && chown -R bot:bot /app/data /app/logs
USER bot

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD pgrep -f "[b]ot/bot\.ts" || exit 1

CMD ["bun", "run", "src/bot/bot.ts"]
