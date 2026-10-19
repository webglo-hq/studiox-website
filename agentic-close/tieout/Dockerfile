# Tieout production image: built web app + bundled Node server, production dependencies only.
# Not exercised in the build environment (no container runtime there); see docs/ASSESSMENT.md.
FROM node:22.20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run gen:check && npm run build

FROM node:22.20-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 SEED_DEMO=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force && mkdir -p .data && chown node:node .data
COPY --from=build /app/dist/web ./dist/web
COPY --from=build /app/dist/server ./dist/server
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/node.js"]
