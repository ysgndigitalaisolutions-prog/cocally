# syntax=docker/dockerfile:1.7
# Build context is the repo root:  docker build -f apps/web/Dockerfile .
# NEXT_PUBLIC_* values are baked in at build time — pass them as --build-arg.
ARG NODE_VERSION=22
ARG PNPM_VERSION=10.28.2

FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/

FROM base AS build
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @cocally/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @cocally/shared build && pnpm --filter @cocally/web build

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
RUN apk add --no-cache curl
# Next.js standalone output places the server at apps/web/server.js with the repo as tracing root.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:3000/login || exit 1
CMD ["node", "apps/web/server.js"]
