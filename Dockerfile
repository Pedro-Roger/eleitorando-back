FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci && npx prisma generate

COPY . .

RUN mkdir -p uploads/candidates

EXPOSE 3333

CMD ["sh", "-c", "npx prisma migrate deploy && node prisma/seed-admin.js && node src/server.js"]
