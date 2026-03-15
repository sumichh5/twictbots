FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY config ./config

RUN mkdir -p /app/data /app/logs \
  && chown -R node:node /app

USER node:node

ENV NODE_ENV=production

CMD ["npm", "start"]
