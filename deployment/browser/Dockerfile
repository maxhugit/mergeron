FROM mcr.microsoft.com/playwright:v1.64.1-noble
ARG MERGERON_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/maxhugit/mergeron" \
      org.opencontainers.image.revision="${MERGERON_REVISION}"
WORKDIR /opt/browser
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund playwright-core@1.64.1
COPY public-proxy.mjs server.mjs ./
USER pwuser
CMD ["node", "server.mjs"]
