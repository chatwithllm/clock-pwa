#!/bin/sh
# Write the nginx snippet for /admin/alert-clear. When ALERT_API_TOKEN is set,
# proxy the admin clear action to the sidecar with the bearer token injected
# (so the admin page never handles the raw token). Otherwise disable it (503).
CONF=/etc/nginx/alert_clear.conf
if [ "$ADMIN_AUTH" = "off" ]; then
  # Admin auth disabled -> do NOT expose a token-injecting clear proxy to
  # unauthenticated callers. Disable the admin clear backstop (HA still clears
  # via the bearer API).
  printf 'return 503;\n' > "$CONF"
  echo "clock: ADMIN_AUTH=off — admin alert-clear disabled (use the bearer API)"
elif [ -n "$ALERT_API_TOKEN" ]; then
  cat > "$CONF" <<EOF
proxy_set_header Authorization "Bearer $ALERT_API_TOKEN";
proxy_set_header Content-Type application/json;
proxy_pass http://\$alert_up/api/alert/clear;
EOF
  echo "clock: admin alert-clear proxy enabled"
else
  printf 'return 503;\n' > "$CONF"
  echo "clock: ALERT_API_TOKEN unset — admin alert-clear disabled"
fi
