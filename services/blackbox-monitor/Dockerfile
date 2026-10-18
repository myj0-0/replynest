FROM node:24.19.0-alpine

WORKDIR /app
COPY services/blackbox-monitor/package.json ./package.json
COPY services/blackbox-monitor/src ./src
COPY apps/console/public/replynest-brand-cn.png ./assets/replynest-brand-cn.png
COPY apps/console/public/replynest-mark.png ./assets/replynest-mark.png

RUN mkdir -p /data && chown -R node:node /data /app
USER node

CMD ["node", "src/monitor.mjs"]
