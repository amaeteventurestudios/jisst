#!/usr/bin/env bash
# Runs on the server (sent by .github/workflows/deploy.yml). Puts Jisst next to whatever else the server runs:
#   - the chat server (Tuwunel, Matrix standard) on 127.0.0.1:$HS_PORT, with its own database in /var/lib/jisst/tuwunel;
#   - the Jisst gateway (sign-in, agents, reminders, feed, alerts) on 127.0.0.1:$GW_PORT;
#   - the app's files served by the shared Caddy web server through Jisst's own site file /etc/caddy/sites/jisst.caddy.
# Never touches /etc/caddy/Caddyfile or another project's site file. Secrets are made once on the server and never leave it.
set -euo pipefail
: "${JISST_DOMAIN:?set JISST_DOMAIN}"
read -r -a NAMES <<< "$(printf '%s' "$JISST_DOMAIN" | tr ',' ' ')"
MAIN="${NAMES[0]}"
APP=/opt/jisst NODE_DIR=/opt/jisst-node DATA=/var/lib/jisst ENVF=/etc/jisst.env TWCONF=/etc/jisst-tuwunel.toml
NODE_V=v22.11.0 HS_PORT=8318 GW_PORT=8300
# The end of every chat address (@ada:jisst.app). A different name is a different chat server, so it is fixed at launch.
SERVER_NAME_WANTED="${JISST_SERVER_NAME:-jisst.app}"
case "$(uname -m)" in aarch64|arm64) NARCH=arm64 ;; *) NARCH=x64 ;; esac

# ---- user, Node, chat server ----
id jisst >/dev/null 2>&1 || sudo useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin jisst
sudo mkdir -p "$DATA/gateway" "$DATA/tuwunel" && sudo chown -R jisst:jisst "$DATA" && sudo chmod 750 "$DATA"
if [ "$("$NODE_DIR/bin/node" --version 2>/dev/null)" != "$NODE_V" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-$NARCH.tar.xz" -o /tmp/node.tar.xz
  sudo rm -rf "$NODE_DIR" && sudo mkdir -p "$NODE_DIR" && sudo tar -xJf /tmp/node.tar.xz -C "$NODE_DIR" --strip-components=1 && rm -f /tmp/node.tar.xz
fi

# ---- code (swapped in whole, so a failed unpack leaves the running copy alone) ----
sudo rm -rf "$APP.new" && sudo mkdir -p "$APP.new" && sudo tar -xzf /tmp/jisst.tgz -C "$APP.new" && rm -f /tmp/jisst.tgz
sudo rm -rf "$APP.old"; [ -d "$APP" ] && sudo mv "$APP" "$APP.old"; sudo mv "$APP.new" "$APP"
sudo chown -R root:root "$APP" && sudo chmod 755 "$APP/bin/tuwunel"
"$APP/bin/tuwunel" --version 2>/dev/null | head -1 || true

# ---- settings: secrets are made once; the address lines follow the domain on every deploy ----
if ! sudo test -f "$ENVF"; then
  sudo install -m 640 -o root -g jisst /dev/null "$ENVF"
  sudo tee "$ENVF" >/dev/null <<ENV
# Jisst on this server. Made by server/install.sh; secrets stay here (never in the repo or in chat).
JISST_DATA=$DATA/gateway
JISST_PORT=$GW_PORT
JISST_HS_URL=http://127.0.0.1:$HS_PORT
JISST_SERVER_NAME=$SERVER_NAME_WANTED
JISST_KEY=$(openssl rand -hex 32)
JISST_REGISTRATION_TOKEN=$(openssl rand -hex 24)
NOVENIQE_URL=http://127.0.0.1:8200
NOVENIQE_CLIENT_ID=jisst
ENV
fi
setkv() { sudo sed -i "/^$1=/d" "$ENVF"; printf '%s=%s\n' "$1" "$2" | sudo tee -a "$ENVF" >/dev/null; }
getkv() { sudo grep "^$1=" "$ENVF" | head -1 | cut -d= -f2-; }
setkv JISST_PUBLIC_URL "https://$MAIN"
setkv JISST_FEED_URL "${JISST_FEED_URL:-https://palasora.com}"
SERVER_NAME=$(getkv JISST_SERVER_NAME)
# Before launch the name may still change (jisst.app or jisste.com): a new name starts the chat server over, empty.
# After launch (the repo variable JISST_LAUNCHED=yes leaves the marker file) it never changes again.
[ "${JISST_LAUNCHED:-}" = yes ] && sudo touch "$DATA/launched"
if [ -n "${JISST_SERVER_NAME:-}" ] && [ "$SERVER_NAME" != "$JISST_SERVER_NAME" ]; then
  if sudo test -f "$DATA/launched"; then echo "Note: Jisst has launched, so the chat server's name stays $SERVER_NAME (asked for $JISST_SERVER_NAME)."
  else
    echo "Chat server name: $SERVER_NAME -> $JISST_SERVER_NAME (before launch: starting the chat server over, empty)"
    sudo systemctl stop jisst-gateway jisst-chat 2>/dev/null || true
    sudo rm -rf "$DATA/tuwunel" "$DATA/gateway" && sudo mkdir -p "$DATA/tuwunel" "$DATA/gateway" && sudo chown -R jisst:jisst "$DATA"
    setkv JISST_SERVER_NAME "$JISST_SERVER_NAME"; SERVER_NAME="$JISST_SERVER_NAME"
  fi
fi
# Sign-in with a Noveniqe account: the secret Noveniqe Core made for Jisst (noveniqe repo, core/deploy/clients.json)
if sudo test -f /etc/novenique/clients/jisst.env; then
  setkv NOVENIQE_CLIENT_SECRET "$(sudo grep '^NOVENIQUE_CLIENT_SECRET=' /etc/novenique/clients/jisst.env | cut -d= -f2-)"
else echo 'Note: Noveniqe Core has no Jisst sign-in secret yet (merge the noveniqe pull request that adds the jisst client). Email sign-in stays off until then.'; fi

# ---- chat server settings (Tuwunel). Closed: no federation, accounts only through the gateway's token ----
sudo tee "$TWCONF" >/dev/null <<TOML
# Jisst's chat server. Made by server/install.sh on every deploy.
[global]
server_name = "$SERVER_NAME"
database_path = "$DATA/tuwunel"
address = ["127.0.0.1"]
port = $HS_PORT
allow_registration = true
registration_token = "$(getkv JISST_REGISTRATION_TOKEN)"
allow_guest_registration = false
allow_federation = false
trusted_servers = []
query_trusted_key_servers_first = false
new_user_displayname_suffix = ""
grant_admin_to_first_user = false
allow_encryption = true
allow_public_room_directory_without_auth = false
require_auth_for_profile_requests = true
max_request_size = 26214400
log_colors = false
TOML
sudo chown root:jisst "$TWCONF" && sudo chmod 640 "$TWCONF"

# ---- services ----
unit() {  # name, description, command, extra [Unit]/[Service] lines
  sudo tee "/etc/systemd/system/$1.service" >/dev/null <<UNIT
[Unit]
Description=$2
After=network-online.target $4
Wants=network-online.target
[Service]
User=jisst
Group=jisst
EnvironmentFile=$ENVF
Environment=TUWUNEL_CONFIG=$TWCONF NODE_ENV=production
WorkingDirectory=$DATA
ExecStart=$3
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=$DATA
[Install]
WantedBy=multi-user.target
UNIT
}
unit jisst-chat "Jisst chat server (Tuwunel, loopback only)" "$APP/bin/tuwunel" ""
unit jisst-gateway "Jisst gateway (sign-in, agents, alerts; loopback only)" "$NODE_DIR/bin/node $APP/gateway/server.mjs" "jisst-chat.service"
sudo systemctl daemon-reload
sudo systemctl enable jisst-chat jisst-gateway >/dev/null
sudo systemctl restart jisst-chat
for i in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$HS_PORT/_matrix/client/versions" 2>/dev/null && break; sleep 1; done
sudo systemctl restart jisst-gateway
sudo rm -rf "$APP.old"

# ---- the address: Jisst's own file in the shared Caddy ----
if [ ! -x /usr/local/bin/caddy ] || [ ! -d /etc/caddy/sites ]; then
  echo 'The shared Caddy web server is missing (the Agent Grand Prix deploy installs it). Jisst runs, but is not on the web yet.'; exit 1
fi
sudo tee /etc/caddy/sites/jisst.caddy >/dev/null <<CADDY
$(IFS=,; echo "${NAMES[*]}" | sed 's/,/, /g') {
	encode zstd gzip
	request_body /_matrix/* {
		max_size 25MB
	}
	handle /api/* {
		reverse_proxy 127.0.0.1:$GW_PORT
	}
	handle /_matrix/push/* {
		reverse_proxy 127.0.0.1:$GW_PORT
	}
	handle /_matrix/* {
		reverse_proxy 127.0.0.1:$HS_PORT
	}
	handle /.well-known/matrix/client {
		header Content-Type application/json
		header Access-Control-Allow-Origin *
		respond \`{"m.homeserver":{"base_url":"https://$MAIN"}}\`
	}
	handle {
		root * $APP/app
		@fresh path / /index.html /sw.js /manifest.webmanifest
		header @fresh Cache-Control "no-cache"
		header X-Content-Type-Options nosniff
		header Referrer-Policy same-origin
		try_files {path} /index.html
		file_server
	}
}
CADDY
sudo /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
sudo systemctl reload caddy

# ---- checks ----
for i in $(seq 1 30); do curl -fsS -o /dev/null "http://127.0.0.1:$GW_PORT/api/health" 2>/dev/null && break; sleep 1; done
for s in jisst-chat jisst-gateway caddy; do printf '%-14s %s\n' "$s" "$(systemctl is-active "$s")"; done
curl -fsS "http://127.0.0.1:$GW_PORT/api/health"; echo
