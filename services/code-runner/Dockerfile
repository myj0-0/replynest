FROM node:24.19.0-alpine
WORKDIR /runner
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY *.mjs ./
USER node
CMD ["node", "--max-old-space-size=48", "server.mjs"]
