# Базовый образ можно заменить зеркалом, если Docker Hub недоступен:
#   NODE_IMAGE=mirror.gcr.io/library/node:22-alpine в .env
ARG NODE_IMAGE=node:22-alpine

# Сборка
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Запуск
FROM ${NODE_IMAGE}
# Часовые пояса Node берёт из встроенной ICU, пакет tzdata не нужен
ENV NODE_ENV=production \
    DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "dist/main.js"]
