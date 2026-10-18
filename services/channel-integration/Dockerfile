FROM node:24.19.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:24.19.0-alpine
ARG REPLYNEST_RELEASE_ID=dev
LABEL net.replynest.release-id=$REPLYNEST_RELEASE_ID
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache ffmpeg util-linux
RUN mkdir -p /app/data/knowledge /app/data/channel-secrets && chown -R node:node /app/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/gateway.js"]
