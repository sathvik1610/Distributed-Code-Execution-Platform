FROM node:20-alpine
WORKDIR /app
COPY services/execution-worker/package.json ./services/execution-worker/
COPY shared/contracts/package.json ./shared/contracts/
COPY shared/logger/package.json ./shared/logger/
COPY shared/metrics/package.json ./shared/metrics/
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --workspace=services/execution-worker --workspace=shared/contracts --workspace=shared/logger --workspace=shared/metrics
COPY shared/contracts/dist ./shared/contracts/dist
COPY shared/logger/dist ./shared/logger/dist
COPY shared/metrics/dist ./shared/metrics/dist
COPY services/execution-worker/dist ./services/execution-worker/dist
WORKDIR /app/services/execution-worker
CMD ["node", "dist/index.js"]
