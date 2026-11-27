ARG BUN_IMAGE=oven/bun:1.4.5-slim
ARG DOCKER_CLI_IMAGE=docker:29.5.2-cli

FROM ${BUN_IMAGE} AS base
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/onex

FROM base AS dependencies
WORKDIR /opt/onex/server
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts \
    && test -f node_modules/@duckdb/node-bindings-linux-arm64/duckdb.node \
    && test -f node_modules/@duckdb/node-bindings-linux-arm64/libduckdb.so

FROM base AS server
ARG ONEX_REVISION
LABEL org.opencontainers.image.revision=$ONEX_REVISION
ENV ONEX_COMMIT=$ONEX_REVISION
COPY --from=dependencies /opt/onex/server/node_modules ./server/node_modules
COPY server/src ./server/src
COPY server/web ./server/web
COPY server/migrations ./server/migrations
COPY server/package.json ./server/package.json
COPY deploy/compose/server-entrypoint.sh ./deploy/compose/server-entrypoint.sh
WORKDIR /opt/onex/server
ENTRYPOINT ["/bin/sh", "/opt/onex/deploy/compose/server-entrypoint.sh"]
CMD ["src/index.ts"]

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM base AS release-worker
RUN apt-get update \
    && apt-get install -y --no-install-recommends age util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY server/src/release-package.ts server/src/release-store.ts ./server/src/
COPY deploy/compose/compose.yaml deploy/compose/initialize.ts deploy/compose/release-worker.ts deploy/compose/relocate-native-desktop.ts ./deploy/compose/
ENTRYPOINT ["flock", "--no-fork", "-n", "/data/server/maintenance/.docker-rollout.lock", "bun", "--no-env-file", "/opt/onex/deploy/compose/release-worker.ts"]
