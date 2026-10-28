FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /opt/browser
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund playwright-core@1.64.1 \
 && apt-get purge --yes gstreamer1.0-plugins-bad libgstreamer-plugins-bad1.0-0 \
 && rm -rf /usr/lib/node_modules/npm /usr/lib/node_modules/yarn \
           /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/yarn \
 && rm -f /usr/bin/npm /usr/bin/npx /usr/bin/yarn /usr/bin/yarnpkg \
          /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY public-proxy.mjs server.mjs ./
# Build identity must not invalidate the dependency/security-cleanup layers.
ARG MERGERON_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/maxhugit/mergeron" \
      org.opencontainers.image.revision="${MERGERON_REVISION}"
USER pwuser
CMD ["node", "server.mjs"]
