# Static clock+weather PWA served by nginx. No build step — just the app files.
FROM nginx:1.27-alpine

# nginx site config (manifest mime, service-worker no-cache, gzip)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy ONLY the app files into the web root (not the Docker/readme files)
COPY index.html manifest.webmanifest sw.js config.json /usr/share/nginx/html/
COPY css   /usr/share/nginx/html/css
COPY js    /usr/share/nginx/html/js
COPY icons /usr/share/nginx/html/icons

EXPOSE 80
# nginx:alpine already runs `nginx -g 'daemon off;'` as CMD
