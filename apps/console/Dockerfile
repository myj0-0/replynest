FROM node:24.19.0-alpine AS dependencies
WORKDIR /workspace/apps/console
RUN corepack enable
COPY apps/console/package.json apps/console/pnpm-lock.yaml apps/console/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
ARG NEXT_PUBLIC_ICP_NUMBER=""
ARG NEXT_PUBLIC_PUBLIC_SECURITY_NUMBER=""
ARG NEXT_PUBLIC_PUBLIC_SECURITY_CODE=""
ENV NEXT_PUBLIC_ICP_NUMBER=$NEXT_PUBLIC_ICP_NUMBER
ENV NEXT_PUBLIC_PUBLIC_SECURITY_NUMBER=$NEXT_PUBLIC_PUBLIC_SECURITY_NUMBER
ENV NEXT_PUBLIC_PUBLIC_SECURITY_CODE=$NEXT_PUBLIC_PUBLIC_SECURITY_CODE
ARG CHATWOOT_PUBLIC_URL=http://localhost:3000
ENV CHATWOOT_PUBLIC_URL=$CHATWOOT_PUBLIC_URL
COPY apps/console ./
COPY packages/design-tokens /workspace/packages/design-tokens
RUN pnpm build --webpack

FROM node:24.19.0-alpine AS runner
ARG REPLYNEST_RELEASE_ID=dev
LABEL net.replynest.release-id=$REPLYNEST_RELEASE_ID
ENV NODE_ENV=production
ENV PORT=3200
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/console/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/console/.next/static ./apps/console/.next/static
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/console/public ./apps/console/public
USER nextjs
EXPOSE 3200
CMD ["node", "apps/console/server.js"]
