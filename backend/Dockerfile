FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production
# API and worker share one image; docker-compose picks the command.
CMD ["npx", "tsx", "src/api/index.ts"]
