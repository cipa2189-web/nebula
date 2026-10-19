FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

ENV PORT=3000
EXPOSE 3000

# данные (data.json) пишутся рядом с server.js — примонтируйте volume для персистентности
CMD ["node", "server.js"]
