FROM node:20-slim

# Dependencias de sistema para sharp
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar package.json VPS y instalar dependencias
COPY vps/package.json ./package.json
RUN npm install --omit=dev

# Copiar código fuente
COPY server.js ./
COPY database.js.orig ./database.js.orig
COPY vps/database.js ./database.js
COPY public/ ./public/
COPY receipt-parser.js ./receipt-parser.js

# Directorio de datos persistente
RUN mkdir -p /app/vps/data /app/uploads
VOLUME ["/app/vps/data", "/app/uploads"]

ENV PORT=3002
ENV NODE_ENV=production

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "require('http').get('http://localhost:3002/api/health', r => r.statusCode===200?process.exit(0):process.exit(1))"

CMD ["node", "server.js"]
