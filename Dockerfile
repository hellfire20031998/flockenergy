FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY fixtures ./fixtures
COPY openapi.json ./
EXPOSE 3000
# Defaults to fixtures mode so the container runs with no credentials.
# Pass PORTAL_MODE=live plus PORTAL_EMAIL / PORTAL_PASSWORD to talk to the portal.
ENV PORTAL_MODE=fixtures
CMD ["node", "src/index.js"]
