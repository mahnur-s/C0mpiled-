FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app
COPY package.json server.js ./
COPY server ./server
COPY scripts ./scripts
COPY public ./public

# The SQLite database lives on a Fly volume mounted at /data.
ENV DB_PATH=/data/haru.db PORT=8080
EXPOSE 8080
# Runs as root because Fly mounts volumes root-owned; the container holds nothing else.
CMD ["node", "server.js"]
