# ITEMDEX service (API + web app) for servers.
#   docker build -t itemdex .
#   docker run -p 7777:7777 --env-file .env -e DATABASE_URL=postgres://... itemdex
# API only (web hosted elsewhere): add -e SERVE_UI=false -e CORS_ORIGINS=https://your-web.app

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --no-audit --no-fund -w @itemdex/shared -w @itemdex/server -w @itemdex/web --include-workspace-root
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build -w @itemdex/server && npm run build -w @itemdex/web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=7777 \
    WEB_DIST=/app/apps/web/dist OPENAPI_FILE=/app/docs/openapi.yaml
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --no-audit --no-fund -w @itemdex/server && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY docs/openapi.yaml docs/openapi.yaml
USER node
EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:7777/api/v1/health >/dev/null || exit 1
CMD ["node", "apps/server/dist/index.js"]
