FROM node:22-bookworm-slim

WORKDIR /app

# Native modules and repo bootstrap need system build tools plus git/ssh utilities.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    openssh-client \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg62-turbo-dev \
    libgif-dev \
    librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm ci

COPY admin-ui ./admin-ui
COPY src ./src
COPY tsconfig.json ./
COPY .env.example ./
COPY .env.deploy.example ./
COPY cloudflared-agent-blue.yml ./
RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

ENV NODE_ENV=production
ENV APP_DATA_DIR=/app/data
ENV ADMIN_PORT=3100
ENV SLACK_PORT=3000

RUN mkdir -p /app/data

CMD ["node", "dist/index.js"]
