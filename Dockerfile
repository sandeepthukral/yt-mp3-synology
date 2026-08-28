# x86_64 — runs on Synology DS220+ (Intel Celeron J4025)
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl unzip \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && curl -fsSL https://deno.land/install.sh | sh \
  && cp /root/.deno/bin/deno /usr/local/bin/deno \
  && chmod 755 /usr/local/bin/deno \
  && deno --version \
  && apt-get purge -y curl unzip \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* /root/.deno

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV PORT=3030
EXPOSE 3030
# refresh yt-dlp on every container start, then run the server
CMD ["sh", "-c", "yt-dlp -U || true; node dist/server.js"]
