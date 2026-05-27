FROM node:20-alpine
WORKDIR /app
COPY services/api-gateway/package.json ./services/api-gateway/
COPY shared/contracts/package.json ./shared/contracts/
COPY shared/logger/package.json ./shared/logger/
COPY shared/metrics/package.json ./shared/metrics/
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --workspace=services/api-gateway --workspace=shared/contracts --workspace=shared/logger --workspace=shared/metrics
COPY shared/contracts/dist ./shared/contracts/dist
COPY shared/logger/dist ./shared/logger/dist
COPY shared/metrics/dist ./shared/metrics/dist
COPY services/api-gateway/dist ./services/api-gateway/dist
WORKDIR /app/services/api-gateway
CMD ["node", "dist/index.js"]
