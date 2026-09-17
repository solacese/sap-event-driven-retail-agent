# ---------------------------------------------------------------------------
# Discount Bot demo image. Builds the frontend, runs the gateway via tsx.
# ---------------------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build:web

FROM node:20-slim AS run
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
EXPOSE 8080
# tsx runs the TypeScript server directly; no separate compile step needed.
CMD ["npx", "tsx", "src/server/index.ts"]
