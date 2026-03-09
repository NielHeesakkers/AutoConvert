FROM node:20-bookworm-slim

# Install HandBrakeCLI, msmtp, python3 and Dutch locale
RUN apt-get update && apt-get install -y --no-install-recommends \
    handbrake-cli \
    msmtp \
    python3 \
    locales \
    ca-certificates \
  && sed -i '/nl_NL.UTF-8/s/^# //' /etc/locale.gen \
  && locale-gen \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy application
COPY server.js ./
COPY public/ ./public/
COPY scripts/ ./scripts/
RUN chmod +x scripts/daily_mkv_convert.sh

# Create volumes
RUN mkdir -p /app/config /app/logs /media/movies /media/series

ENV DOCKER=true
ENV NODE_ENV=production
ENV TZ=Europe/Amsterdam

EXPOSE 3742

CMD ["node", "server.js"]
