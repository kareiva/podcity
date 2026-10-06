FROM docker.io/library/node:24 AS builder

WORKDIR /app

COPY . .

RUN npm install
RUN npm run build

FROM docker.io/library/nginx:latest

COPY --from=builder /app/dist/ /usr/share/nginx/html/
