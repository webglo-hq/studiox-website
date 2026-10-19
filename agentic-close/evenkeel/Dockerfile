# syntax=docker/dockerfile:1.7
# Evenkeel container image.
#   docker build -t evenkeel .
#   docker run --rm -p 127.0.0.1:4610:4610 -v evenkeel-data:/data evenkeel
# Without DATABASE_URL the server uses embedded PGlite under /data; with it (see compose.yaml)
# it uses PostgreSQL 16. On first start it seeds the fictional Kitewell Labs demo and prints
# generated demo passwords to the log (also saved to /data/demo-credentials.json, mode 0600).

ARG NODE_VERSION=22.22.0

# ---- build: install everything, build the web app and the zero-install demo
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:web && npm run build:demo

# ---- runtime: production dependencies only, unprivileged user
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4610 \
    EVENKEEL_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY tsconfig.json ./
COPY db ./db
COPY skills ./skills
COPY scripts ./scripts
COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4610
# First start seeds the scenario, so allow a generous start period.
HEALTHCHECK --interval=30s --timeout=5s --start-period=240s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4610)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "src/server/main.ts"]
