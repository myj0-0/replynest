ARG CHATWOOT_BASE_IMAGE=chatwoot/chatwoot:v4.16.2-ce
FROM node:24.19.0-alpine AS overlay
COPY patches/chatwoot-v4.16.2-ce-saas-sso/files/ /overlay/
RUN find /overlay -type d -exec chmod 0755 {} + && \
    find /overlay -type f -exec chmod 0644 {} +

FROM ${CHATWOOT_BASE_IMAGE}
COPY --from=overlay /overlay/ /app/
COPY apps/console/public/replynest-brand-cn.png /app/public/replynest-brand-cn.png
COPY apps/console/public/replynest-mark.png /app/public/replynest-mark.png
RUN chmod 0644 /app/public/replynest-brand-cn.png /app/public/replynest-mark.png && \
    cp /app/public/replynest-mark.png /app/public/favicon-16x16.png && \
    cp /app/public/replynest-mark.png /app/public/favicon-32x32.png && \
    cp /app/public/replynest-mark.png /app/public/favicon-96x96.png && \
    cp /app/public/replynest-mark.png /app/public/android-icon-192x192.png && \
    cp /app/public/replynest-mark.png /app/public/apple-icon-180x180.png && \
    chmod 0644 /app/public/favicon-16x16.png /app/public/favicon-32x32.png \
      /app/public/favicon-96x96.png /app/public/android-icon-192x192.png /app/public/apple-icon-180x180.png
