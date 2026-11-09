# Shared image for the AWS-side services, sidecars, gateway, Control Plane,
# Cache API and the local split-mode Render containers.
#
# The same image is used with a different command per container. Keeping one
# image avoids duplicating the workspace install and keeps local builds fast.

FROM node:20-alpine AS deps
WORKDIR /app

# Copy only the manifests first so dependency installation is cached.
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
COPY services ./services
COPY sidecars ./sidecars
COPY gateway ./gateway
COPY control-plane ./control-plane
COPY cache-api ./cache-api
COPY render ./render
COPY scripts ./scripts

USER node
EXPOSE 8080
CMD ["node", "gateway/index.js"]
