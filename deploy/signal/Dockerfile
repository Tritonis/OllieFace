FROM node:22-slim
WORKDIR /app
COPY deploy/signal/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY tools/signal-server.mjs tools/
ENV PORT=8080
EXPOSE 8080
CMD ["node", "tools/signal-server.mjs"]
