# Production image: API server + built web app on one origin.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY packages/core/package.json packages/core/
COPY packages/ai/package.json packages/ai/
COPY packages/db/package.json packages/db/
COPY packages/integrations/package.json packages/integrations/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @secretary/web build && pnpm --filter @secretary/server build \
 && mkdir -p /out && cp -r apps/server/dist/. /out/ && cp -r apps/web/dist /out/web

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 SERVE_WEB_DIR=/app/web
WORKDIR /app
COPY --from=build /out /app
RUN useradd --system --uid 10001 secretary && chown -R secretary /app
USER secretary
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "main.mjs"]
