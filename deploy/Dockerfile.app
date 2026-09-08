FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
COPY scripts/install-system-packages.sh /usr/local/bin/rp-install-packages
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked sh /usr/local/bin/rp-install-packages python3 make g++
RUN npm install --global pnpm@11.23.0
ENV npm_config_nodedir=/usr/local
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/rp-core/package.json packages/rp-core/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/tools/package.json apps/tools/package.json
COPY scripts/prepare-native.mjs scripts/prepare-native.mjs
RUN pnpm install --frozen-lockfile
COPY apps/server/src apps/server/src
COPY apps/web apps/web
COPY packages packages
COPY scripts/build-server.mjs scripts/build-server.mjs
COPY scripts/dev-support.ts scripts/dev-support.ts
COPY tsconfig.json vite.config.ts ./
COPY LICENSE THIRD_PARTY_NOTICES.md ./
RUN node scripts/build-server.mjs && pnpm exec vite build && pnpm --filter @pi-roleplay/server deploy --prod /out/app

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
COPY scripts/install-system-packages.sh /usr/local/bin/rp-install-packages
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked sh /usr/local/bin/rp-install-packages ca-certificates tini
RUN useradd --uid 10001 --user-group --create-home rp && mkdir -p /data /run/rp && chown 10001:10001 /data /run/rp
WORKDIR /opt/rp
COPY --from=build --chown=10001:10001 /out/app ./
COPY --from=build --chown=10001:10001 /build/apps/web/dist ./web
COPY --chown=10001:10001 skills/builtin ./skills/builtin
COPY scripts/deploy-data.mjs ./deploy-data.mjs
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY docs/dependency-licenses.json ./dependency-licenses.json
ENV NODE_ENV=production RP_HOST=0.0.0.0 RP_PORT=3091 RP_DATA_DIR=/data RP_WEB_DIR=/opt/rp/web RP_BUILTIN_SKILLS_DIR=/opt/rp/skills/builtin RP_CUSTOM_SKILLS_DIR=/skills/custom RP_CONTROL_SOCKET=/run/rp/admin.sock
USER 10001:10001
EXPOSE 3091
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
