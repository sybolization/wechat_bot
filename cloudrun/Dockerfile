FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-fund --no-audit --registry=https://registry.npmmirror.com
COPY server.js identity.js net.js envload.js ./
COPY core ./core
COPY channels ./channels
COPY webui ./webui
COPY .env ./
COPY docs ./docs
ENV PORT=80 NODE_ENV=production
EXPOSE 80
CMD ["node", "server.js"]
