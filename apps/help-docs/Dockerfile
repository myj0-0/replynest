FROM node:24.19.0-alpine AS build
WORKDIR /site
COPY apps/help-docs/package.json apps/help-docs/package-lock.json ./
COPY apps/help-docs/security ./security
RUN npm ci
COPY apps/help-docs/ ./
COPY apps/console/public/replynest-brand-cn.png ./static/img/replynest-brand-cn.png
COPY apps/console/public/replynest-mark.png ./static/img/replynest-mark.png
RUN npm run build

FROM caddy:2.10.2-alpine
COPY apps/help-docs/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /site/build /srv
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
