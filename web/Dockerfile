# Контекст сборки — корень репозитория, а не web/.
# Веб-клиент разрешает '@shared' в ../shared: автоматы состояний и справочники
# общие с сервером (CLAUDE.md § 6). Поэтому в образе сохраняется та же
# структура каталогов, что и в репозитории: /app/web и /app/shared.

FROM node:22-alpine AS deps
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci || npm install


FROM deps AS dev
COPY shared /app/shared
COPY web /app/web
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]


FROM deps AS build
COPY shared /app/shared
COPY web /app/web
RUN npm run build


FROM nginx:alpine AS prod
COPY --from=build /app/web/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
