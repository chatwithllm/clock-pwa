# Static clock+weather PWA served by nginx. No build step — just the app files.
FROM nginx:1.27-alpine

# curl for the server-side weather fetcher (reliable HTTPS vs busybox wget);
# apache2-utils for htpasswd (admin basic-auth)
RUN apk add --no-cache curl apache2-utils

# nginx site config (manifest mime, service-worker no-cache, gzip)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy ONLY the app files into the web root (not the Docker/readme files)
COPY index.html admin.html manifest.webmanifest sw.js config.json /usr/share/nginx/html/

# Broadcast helper: `docker exec clock-pwa /usr/local/bin/announce.sh "message"`
COPY announce.sh /usr/local/bin/announce.sh
RUN chmod +x /usr/local/bin/announce.sh

# Writable data dir so the admin page can PUT announce.json (WebDAV) and the
# helper can write it. nginx workers run as the `nginx` user → own /data.
COPY announce.json /data/announce.json
COPY profiles.json /data/profiles.json
RUN mkdir -p /data/tmp /data/uploads && chown -R nginx:nginx /data && chmod -R u+rwX /data
COPY css   /usr/share/nginx/html/css
COPY js    /usr/share/nginx/html/js
COPY icons /usr/share/nginx/html/icons

# Startup scripts: admin basic-auth, config.json from env, server weather fetcher.
COPY docker-entrypoint.d/10-admin-auth.sh    /docker-entrypoint.d/10-admin-auth.sh
COPY docker-entrypoint.d/30-clock-config.sh  /docker-entrypoint.d/30-clock-config.sh
COPY docker-entrypoint.d/40-weather-fetch.sh /docker-entrypoint.d/40-weather-fetch.sh
RUN chmod +x /docker-entrypoint.d/10-admin-auth.sh /docker-entrypoint.d/30-clock-config.sh /docker-entrypoint.d/40-weather-fetch.sh
# Ensure the auth include exists even before the entrypoint runs (nginx -t safety).
RUN : > /etc/nginx/admin_auth.conf

EXPOSE 80
# nginx:alpine already runs `nginx -g 'daemon off;'` as CMD
