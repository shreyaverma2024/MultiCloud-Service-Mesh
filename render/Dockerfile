# One Render Free web service image.
#
# This image intentionally starts the supervisor. The supervisor then starts
# FOUR independent application/sidecar processes plus the ingress dispatcher
# inside this single container. This is process-level isolation only; it is not
# equivalent to running separate containers.

FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
COPY shared/package.json shared/package.json
COPY services/book-service/package.json services/book-service/package.json
COPY services/borrow-service/package.json services/borrow-service/package.json
COPY services/notification-service/package.json services/notification-service/package.json
COPY services/book-replica-service/package.json services/book-replica-service/package.json
COPY services/member-service/package.json services/member-service/package.json
COPY sidecars/book-primary-sidecar/package.json sidecars/book-primary-sidecar/package.json
COPY sidecars/book-replica-sidecar/package.json sidecars/book-replica-sidecar/package.json
COPY sidecars/borrow-sidecar/package.json sidecars/borrow-sidecar/package.json
COPY sidecars/notification-sidecar/package.json sidecars/notification-sidecar/package.json
COPY sidecars/member-sidecar/package.json sidecars/member-sidecar/package.json
COPY gateway/package.json gateway/package.json
COPY control-plane/package.json control-plane/package.json
COPY cache-api/package.json cache-api/package.json
COPY render/package.json render/package.json
COPY dashboard/package.json dashboard/package.json

RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY shared ./shared
COPY services/book-replica-service ./services/book-replica-service
COPY services/member-service ./services/member-service
COPY sidecars/book-replica-sidecar ./sidecars/book-replica-sidecar
COPY sidecars/member-sidecar ./sidecars/member-sidecar
COPY render ./render
COPY scripts ./scripts

USER node
EXPOSE 8081
CMD ["node", "render/supervisor.js"]
