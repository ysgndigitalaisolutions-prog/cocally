# syntax=docker/dockerfile:1.7
# Build context is the repo root:  docker build -f apps/api/Dockerfile .
ARG NODE_VERSION=22
ARG PNPM_VERSION=10.28.2

FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
# argon2 builds from source when no prebuilt binary matches the platform.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @cocally/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @cocally/shared build && pnpm --filter @cocally/api build

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @cocally/api...

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN mkdir -p /app/recordings-data && chown -R node:node /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD curl -fsS http://127.0.0.1:4000/api/v1/ops/ready || exit 1
CMD ["node", "apps/api/dist/main.js"]
