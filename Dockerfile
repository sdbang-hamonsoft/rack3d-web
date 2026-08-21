# Stage 1: Build static React SPA
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package json files first for caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the project files and build
COPY . .
RUN npm run build

# Stage 2: Serve with lightweight Nginx
FROM nginx:alpine

# Nginx 설정은 deploy/nginx/ 에 파일로 둔다(인라인 echo 금지 — 리뷰·수정이 어렵다).
# security-headers.conf 가 보안 응답 헤더의 SSOT다.
COPY deploy/nginx/security-headers.conf /etc/nginx/snippets/rack3d-security-headers.conf
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf

# Copy build artifacts from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
