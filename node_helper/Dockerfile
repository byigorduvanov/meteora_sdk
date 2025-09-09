# syntax=docker/dockerfile:1

###########
# Builder #
###########
FROM node:20-alpine AS builder
WORKDIR /app

# Кешуємо залежності
COPY package*.json ./
RUN npm ci

# Копіюємо код і збираємо TS -> JS
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

###########
# Runtime #
###########
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# Лише прод-залежності
COPY package*.json ./
RUN npm ci --omit=dev

# Кладемо зібраний код
COPY --from=builder /app/dist ./dist

# Нерутовий користувач
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 nodeuser
USER nodeuser

# Сервіс слухає 4000 (можеш міняти через PORT)
EXPOSE 4000
CMD ["node", "dist/index.js"]
