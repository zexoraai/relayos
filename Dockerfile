# syntax=docker/dockerfile:1.6

# ===== Stage 1: build the Preact/Vite client =====
FROM node:20-bookworm-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY client/ ./
# vite.config.ts has `outDir: '../public/dist'` so the build lands at /app/public/dist
RUN mkdir -p /app/public && npm run build

# ===== Stage 2: build the TypeScript server =====
FROM node:20-bookworm-slim AS server-build
WORKDIR /app

# Native deps for bcrypt
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY knexfile.ts ./
COPY src/ ./src/
RUN npm run build

# ===== Stage 3: runtime =====
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Tini for proper signal handling
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Production deps only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Server build output
COPY --from=server-build /app/dist ./dist
COPY knexfile.js ./
# Prompts (data-extraction, intent-router, caretaker-llm, etc.) are loaded
# from the filesystem at runtime via promptRegistry. They MUST be in the image
# or every AI stage will throw "No prompts found for agent: ...".
COPY prompts/ ./prompts/
# Static legacy assets first…
COPY public/ ./public/
# …then overlay the client build into public/dist (express serves /new from here)
COPY --from=client-build /app/public/dist ./public/dist

# Storage dir for attachments
RUN mkdir -p /app/storage/attachments

# Entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3001
ENV API_PORT=3001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/docker-entrypoint.sh"]
