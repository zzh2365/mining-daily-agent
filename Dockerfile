FROM node:20-alpine AS deps
WORKDIR /app
# pdfjs-dist text extraction needs libstdc++ on Alpine.
RUN apk add --no-cache libstdc++
COPY package.json package-lock.json* ./
COPY servers ./servers
COPY agent ./agent
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache libstdc++
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN node scripts/make-fixture-pdf.mjs
CMD ["node", "scripts/validate-mcp.mjs"]
