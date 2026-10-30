# ==========================================
# Build-deps base (shared by builder + prod-deps to avoid duplicate apt layers)
# ==========================================
FROM node:26-trixie-slim AS build-deps-base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
	python3 \
	make \
	g++ \
	&& rm -rf /var/lib/apt/lists/*

# ==========================================
# Build Stage
# ==========================================
FROM build-deps-base AS builder

COPY package*.json ./
COPY .npmrc ./
COPY tools/npm-stub ./tools/npm-stub

ENV NODE_OPTIONS="--max-old-space-size=4096"

RUN npm ci

COPY src ./src
COPY static ./static
COPY data ./data
COPY messages ./messages
COPY project.inlang ./project.inlang
COPY scripts/fix-tv-subtitle-paths.js ./scripts/fix-tv-subtitle-paths.js
COPY server.js tsconfig.json vite.config.ts ./

ARG APP_VERSION=dev

# Build-only placeholder: SvelteKit's build evaluates server module top-level
# code (route analysis) with NODE_ENV=production, and the runtime auth secret
# fails closed without one. The real secret is injected at runtime only, so
# this value never reaches a running server (multi-stage build).
RUN BETTER_AUTH_SECRET=build-placeholder-not-used-at-runtime npm run build

# ==========================================
# Production Dependencies Stage
# ==========================================
FROM build-deps-base AS prod-deps

COPY package*.json ./
COPY .npmrc ./

# Install only runtime dependencies.
# Keep optional deps, some runtime packages (e.g. impit) ship
# platform-native bindings through optionalDependencies.
# The doc/docs pruning must not touch */dist/* trees: the yaml package ships
# actual code in dist/doc/ (its document AST), required at runtime via
# camoufox — deleting it crashes the server on require.
RUN npm ci --omit=dev --no-audit --no-fund \
	&& find node_modules -type f -name '*.map' -delete \
	&& find node_modules -type d \
		\( -name test -o -name tests -o -name __tests__ -o -name examples -o -name example \
		-o \( \( -name doc -o -name docs \) ! -path '*/dist/*' \) \) \
		-prune -exec rm -rf '{}' + \
	&& find node_modules -name 'lightningcss-linux-x64-musl' -prune -exec rm -rf '{}' + \
	&& find node_modules -type d -empty -delete

# ==========================================
# Runtime Stage
# ==========================================
FROM node:26-trixie-slim AS runner
WORKDIR /app

ARG APP_VERSION=dev
ARG APP_SOURCE=https://github.com/Cinephage/Cinephage
ARG VCS_REF=unknown
ARG BUILD_CREATED=unknown
ENV APP_VERSION=${APP_VERSION}
ENV APP_COMMIT=${VCS_REF}
RUN printf '%s\n' "$APP_VERSION" > /app/version.txt

LABEL org.opencontainers.image.title='Cinephage' \
	org.opencontainers.image.description='Self-hosted media management application' \
	org.opencontainers.image.source="${APP_SOURCE}" \
	org.opencontainers.image.revision="${VCS_REF}" \
	org.opencontainers.image.created="${BUILD_CREATED}" \
	org.opencontainers.image.version="${APP_VERSION}"

RUN apt-get update && apt-get install -y --no-install-recommends \
	ffmpeg \
	gosu \
	libgtk-3-0 \
	libx11-xcb1 \
	libasound2 \
	xvfb \
	curl \
	ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Install alass (Automatic Language-Agnostic Subtitle Synchronization)
RUN curl -fsSL https://github.com/kaegi/alass/releases/download/v2.0.0/alass-linux64 \
	-o /usr/local/bin/alass-cli \
	&& chmod +x /usr/local/bin/alass-cli

# Runtime does not need npm tooling; remove to shrink attack surface and CVE footprint.
RUN rm -rf /usr/local/lib/node_modules/npm \
	&& rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Pre-create config directories; ownership is fixed at runtime by entrypoint
RUN mkdir -p /config/data /config/cache

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/scripts ./scripts
# Only the bundled read-only assets the entrypoint syncs. Copying all of
# /app/data would ship a developer checkout's database, logs and backups if
# the .dockerignore re-includes ever drift. Channel logos are fetched into
# the config volume at runtime, so they are deliberately not bundled.
COPY --from=builder /app/data/indexers ./bundled-data/indexers
COPY --from=builder /app/data/external-lists ./bundled-data/external-lists
# Camoufox shadow-unlock addon (loaded at runtime for Cloudflare Turnstile solving)
COPY --from=builder /app/src/lib/server/captcha/browser/addon ./camoufox-addon
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/cinephage-entrypoint
COPY --chmod=755 docker-script-runner.sh /usr/local/bin/cinephage-script
RUN ln -sf /usr/local/bin/cinephage-script /usr/local/bin/cine-run

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=2048" \
    HOST=0.0.0.0 \
    PORT=3000 \
    BODY_SIZE_LIMIT=10M \
    FFPROBE_PATH=/usr/bin/ffprobe \
    ALASS_PATH=/usr/local/bin/alass-cli \
    DATA_DIR=/config/data \
    INDEXER_DEFINITIONS_PATH=/config/data/indexers/definitions \
    EXTERNAL_LISTS_PRESETS_PATH=/config/data/external-lists/presets

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10m --retries=3 \
  CMD node -e "const port=process.env.PORT||3000;fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(9000)}).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/cinephage-entrypoint"]
CMD ["node", "server.js"]
