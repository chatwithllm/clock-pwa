#!/bin/sh
# Basic-auth for the admin page (/admin.html) and the announcement PUT (write).
# Client GET polling of /announce.json stays open.
#   ADMIN_USER / ADMIN_PASS  — credentials (default admin / clock)
#   ADMIN_AUTH=off           — disable auth entirely
# nginx includes /etc/nginx/admin_auth.conf in the protected locations; we write
# it here (auth directives when enabled, empty when disabled) so it's optional.
AUTH_CONF=/etc/nginx/admin_auth.conf
HT=/etc/nginx/.htpasswd

if [ "$ADMIN_AUTH" = "off" ]; then
  : > "$AUTH_CONF"
  echo "clock: admin auth DISABLED (ADMIN_AUTH=off)"
  exit 0
fi

USER="${ADMIN_USER:-admin}"
PASS="${ADMIN_PASS:-clock}"
htpasswd -bc "$HT" "$USER" "$PASS" >/dev/null 2>&1
cat > "$AUTH_CONF" <<EOF
auth_basic "Clock Admin";
auth_basic_user_file $HT;
EOF
echo "clock: admin auth ON (user=$USER)"
case "$PASS" in
  clock|change-me)
    echo "clock: WARNING — weak default admin password '$PASS'; set ADMIN_PASS" ;;
esac
exit 0
