# syntax=docker/dockerfile:1

# Build context: deploy/frontend, with the frontend source as named
# context "app" (docker-compose additional_contexts).

FROM node:22-slim AS build

WORKDIR /src
COPY --from=app package.json package-lock.json ./
RUN npm ci

# Same-origin API: nginx proxies /api to the backend container.
ENV VITE_API_URL=/api

COPY --from=app . .
RUN npm run build

FROM nginx:1.27-alpine

COPY --from=build /src/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
