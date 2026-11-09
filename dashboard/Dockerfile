# Dashboard image: build the Vite bundle, then serve it through the small
# Express BFF that injects the Control Plane read token server-side.

FROM node:20-alpine AS build
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

RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY shared ./shared
COPY dashboard ./dashboard
COPY scripts ./scripts
RUN npm run build --workspace @mesh/dashboard

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./
COPY --from=build /app/shared ./shared
COPY --from=build /app/dashboard ./dashboard
COPY scripts ./scripts

USER node
EXPOSE 3000
CMD ["node", "dashboard/server.cjs"]
