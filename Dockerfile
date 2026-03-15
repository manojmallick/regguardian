# Stage 1: install all deps
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# Stage 2: production — clean minimal image
FROM node:20-alpine AS runner
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/src ./src
COPY --from=builder /app/frontend ./frontend

ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]
