FROM node:20-alpine
WORKDIR /app
COPY services/system-monitor/package.json ./services/system-monitor/
COPY shared/contracts/package.json ./shared/contracts/
COPY shared/logger/package.json ./shared/logger/
COPY shared/metrics/package.json ./shared/metrics/
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --workspace=services/system-monitor --workspace=shared/contracts --workspace=shared/logger --workspace=shared/metrics
COPY shared/contracts/dist ./shared/contracts/dist
COPY shared/logger/dist ./shared/logger/dist
COPY shared/metrics/dist ./shared/metrics/dist
COPY services/system-monitor/dist ./services/system-monitor/dist
WORKDIR /app/services/system-monitor
CMD ["node", "dist/index.js"]
