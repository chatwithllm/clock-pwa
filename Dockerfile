# Static clock+weather PWA served by nginx. No build step — just the app files.
FROM nginx:1.27-alpine

# curl for the server-side weather fetcher (reliable HTTPS vs busybox wget)
RUN apk add --no-cache curl

# nginx site config (manifest mime, service-worker no-cache, gzip)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy ONLY the app files into the web root (not the Docker/readme files)
COPY index.html manifest.webmanifest sw.js config.json /usr/share/nginx/html/
COPY css   /usr/share/nginx/html/css
COPY js    /usr/share/nginx/html/js
COPY icons /usr/share/nginx/html/icons

# Startup scripts: write config.json from env, and start the server weather fetcher.
COPY docker-entrypoint.d/30-clock-config.sh  /docker-entrypoint.d/30-clock-config.sh
COPY docker-entrypoint.d/40-weather-fetch.sh /docker-entrypoint.d/40-weather-fetch.sh
RUN chmod +x /docker-entrypoint.d/30-clock-config.sh /docker-entrypoint.d/40-weather-fetch.sh

EXPOSE 80
# nginx:alpine already runs `nginx -g 'daemon off;'` as CMD
