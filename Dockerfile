FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
RUN mkdir -m 700 /state && chown node:node /state
USER node
ENV HOST=0.0.0.0 PORT=3210 COPILOT_DB_PATH=/data/session-store.db LOCAL_DATA_DIR=/state LOCAL_AI_URL=http://host.docker.internal:11434
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:3210/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
