FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/server.js"]
