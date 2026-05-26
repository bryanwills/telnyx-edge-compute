FROM node:18-alpine

RUN apk --no-cache add curl

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev 2>/dev/null || npm install --production 2>/dev/null || true

COPY . .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "app.js"]
