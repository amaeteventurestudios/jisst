#!/usr/bin/env bash
# Runs on the server (sent by .github/workflows/deploy.yml). Puts Jisste next to whatever else the server runs:
#   - the chat server (Tuwunel, Matrix standard) on 127.0.0.1:$HS_PORT, with its own database in /var/lib/jisst/tuwunel;
#   - the Jisste gateway (sign-in, agents, reminders, feed, alerts) on 127.0.0.1:$GW_PORT;
#   - the call server (LiveKit, Apache 2.0) for voice and video calls and screen sharing: signalling on 127.0.0.1:7880 behind
#     Caddy at /livekit, media on 7881/tcp and 50000-60000/udp, and its own TURN relay on 3478/udp for strict networks;
#   - the translator (server/translate.py: Argos models on CTranslate2, all permissive) on 127.0.0.1:8305;
#   - only when the repo variable JISST_LOCAL_AI is yes: a free local model (Qwen3 1.7B, Apache 2.0) on llama.cpp (MIT) at
#     127.0.0.1:8306, so the helper agent can answer open questions without any AI bill;
#   - a nightly snapshot of the chat server's database at 03:15 UTC, which Noveniqe's nightly backup (03:30) copies;
#   - the app's files served by the shared Caddy web server through Jisste's own site file /etc/caddy/sites/jisst.caddy.
# Never touches /etc/caddy/Caddyfile or another project's site file. Secrets are made once on the server and never leave it.
set -euo pipefail
: "${JISST_DOMAIN:?set JISST_DOMAIN}"
read -r -a NAMES <<< "$(printf '%s' "$JISST_DOMAIN" | tr ',' ' ')"
MAIN="${NAMES[0]}"
APP=/opt/jisst NODE_DIR=/opt/jisst-node DATA=/var/lib/jisst ENVF=/etc/jisst.env TWCONF=/etc/jisst-tuwunel.toml LKCONF=/etc/jisst-livekit.yaml
NODE_V=v22.11.0 HS_PORT=8318 GW_PORT=8300 LK_PORT=7880
# The end of every chat address (@ada:jisste.com). A different name is a different chat server, so it is fixed at launch.
SERVER_NAME_WANTED="${JISST_SERVER_NAME:-jisste.com}"
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
sudo chown -R root:root "$APP" && sudo chmod 755 "$APP"/bin/*
"$APP/bin/tuwunel" --version 2>/dev/null | head -1 || true

# ---- settings: secrets are made once; the address lines follow the domain on every deploy ----
if ! sudo test -f "$ENVF"; then
  sudo install -m 640 -o root -g jisst /dev/null "$ENVF"
  sudo tee "$ENVF" >/dev/null <<ENV
# Jisste on this server. Made by server/install.sh; secrets stay here (never in the repo or in chat).
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
# The call server's key pair, made once (the gateway signs call tickets with it)
[ -n "$(getkv JISST_LIVEKIT_SECRET)" ] || { setkv JISST_LIVEKIT_KEY "jisst$(openssl rand -hex 6)"; setkv JISST_LIVEKIT_SECRET "$(openssl rand -hex 32)"; }
setkv JISST_LIVEKIT_URL "wss://$MAIN/livekit"
setkv JISST_TRANSLATE_URL "http://127.0.0.1:8305"
setkv JISST_LOCAL_AI_URL ""
# Visitor stats: Noveniqe's Umami (noveniqe repo ops/server/monitoring.sh) leaves where it lives and Jisste's site id here
if [ -f /etc/novenique/umami.public ]; then
  setkv JISST_STATS_URL "$(sed -n 's/^URL=//p' /etc/novenique/umami.public)"; setkv JISST_STATS_SITE "$(sed -n 's/^SITE_JISST=//p' /etc/novenique/umami.public)"
fi
setkv JISST_FEED_URL "${JISST_FEED_URL:-https://palasora.com}"
SERVER_NAME=$(getkv JISST_SERVER_NAME)
# Before launch the name may still change (jisste.com or jisste.com): a new name starts the chat server over, empty.
# After launch (the repo variable JISST_LAUNCHED=yes leaves the marker file) it never changes again.
[ "${JISST_LAUNCHED:-}" = yes ] && sudo touch "$DATA/launched"
if [ -n "${JISST_SERVER_NAME:-}" ] && [ "$SERVER_NAME" != "$JISST_SERVER_NAME" ]; then
  if sudo test -f "$DATA/launched"; then echo "Note: Jisste has launched, so the chat server's name stays $SERVER_NAME (asked for $JISST_SERVER_NAME)."
  else
    echo "Chat server name: $SERVER_NAME -> $JISST_SERVER_NAME (before launch: starting the chat server over, empty)"
    sudo systemctl stop jisst-gateway jisst-chat 2>/dev/null || true
    sudo rm -rf "$DATA/tuwunel" "$DATA/gateway" && sudo mkdir -p "$DATA/tuwunel" "$DATA/gateway" && sudo chown -R jisst:jisst "$DATA"
    setkv JISST_SERVER_NAME "$JISST_SERVER_NAME"; SERVER_NAME="$JISST_SERVER_NAME"
  fi
fi
# Sign-in with a Noveniqe account: the secret Noveniqe Core made for Jisste (noveniqe repo, core/deploy/clients.json)
if sudo test -f /etc/novenique/clients/jisst.env; then
  setkv NOVENIQE_CLIENT_SECRET "$(sudo grep '^NOVENIQUE_CLIENT_SECRET=' /etc/novenique/clients/jisst.env | cut -d= -f2-)"
else echo 'Note: Noveniqe Core has no Jisste sign-in secret yet (merge the noveniqe pull request that adds the jisst client). Email sign-in stays off until then.'; fi

# ---- chat server settings (Tuwunel). Closed: no federation, accounts only through the gateway's token ----
sudo tee "$TWCONF" >/dev/null <<TOML
# Jisste's chat server. Made by server/install.sh on every deploy.
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

# ---- call server settings (LiveKit). Signalling stays on loopback behind Caddy; sound and pictures go straight to it ----
sudo tee "$LKCONF" >/dev/null <<YAML
# Jisste's call server. Made by server/install.sh on every deploy.
port: $LK_PORT
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
$( [ -n "${JISST_PUBLIC_IP:-}" ] && printf '  node_ip: %s\n' "$JISST_PUBLIC_IP" )
turn:
  enabled: true
  udp_port: 3478
  domain: $MAIN
keys:
  $(getkv JISST_LIVEKIT_KEY): $(getkv JISST_LIVEKIT_SECRET)
room:
  empty_timeout: 300
  max_participants: 50
logging:
  level: info
YAML
sudo chown root:jisst "$LKCONF" && sudo chmod 640 "$LKCONF"

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
unit jisst-chat "Jisste chat server (Tuwunel, loopback only)" "$APP/bin/tuwunel" ""
unit jisst-gateway "Jisste gateway (sign-in, agents, alerts; loopback only)" "$NODE_DIR/bin/node $APP/gateway/server.mjs" "jisst-chat.service"
unit jisst-calls "Jisste call server (LiveKit)" "$APP/bin/livekit-server --config $LKCONF" ""
sudo sed -i 's/^\[Service\]$/[Service]\nLimitNOFILE=65536/' /etc/systemd/system/jisst-calls.service

# The nightly snapshot: the chat server pauses for a few seconds at 03:15 UTC so its database is copied whole. Noveniqe's
# nightly backup (03:30 UTC, noveniqe repo ops/backup/sources.json) then copies the snapshot, the gateway's data and the
# settings, keeps 14 nights, drills a restore every Sunday and keeps an encrypted copy off the server.
sudo tee /usr/local/sbin/jisst-snapshot >/dev/null <<'SNAP'
#!/usr/bin/env bash
set -euo pipefail
D=/var/lib/jisst
rm -rf "$D/snapshot.new" && mkdir -p "$D/snapshot.new"
systemctl stop jisst-chat
trap 'systemctl start jisst-chat' EXIT
cp -a "$D/tuwunel" "$D/snapshot.new/tuwunel"
systemctl start jisst-chat; trap - EXIT
cp -a "$D/gateway" "$D/snapshot.new/gateway"
date -u +%FT%TZ > "$D/snapshot.new/taken"
rm -rf "$D/snapshot.old"; [ -d "$D/snapshot" ] && mv "$D/snapshot" "$D/snapshot.old"; mv "$D/snapshot.new" "$D/snapshot"; rm -rf "$D/snapshot.old"
chown -R jisst:jisst "$D/snapshot" && chmod 750 "$D/snapshot"
echo "Jisste snapshot: $(du -sh "$D/snapshot" | cut -f1)"
SNAP
sudo chmod 750 /usr/local/sbin/jisst-snapshot
sudo tee /etc/systemd/system/jisst-snapshot.service >/dev/null <<UNIT
[Unit]
Description=Jisste nightly snapshot of the chat server's database
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/jisst-snapshot
Nice=10
IOSchedulingClass=idle
UNIT
sudo tee /etc/systemd/system/jisst-snapshot.timer >/dev/null <<UNIT
[Unit]
Description=Jisste nightly snapshot (schedule)
[Timer]
OnCalendar=*-*-* 03:15:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
UNIT
# The translator: its own Python environment and models (English <-> French, Spanish, Portuguese, Arabic, about 650 MB),
# fetched once; a failed download leaves the rest of Jisste running and tries again on the next deploy.
TR=/opt/jisst-translate
translator() {
  command -v python3 >/dev/null && python3 -c 'import venv' 2>/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv >/dev/null || return 1
  [ -x "$TR/venv/bin/python" ] || sudo python3 -m venv "$TR/venv" || return 1
  sudo "$TR/venv/bin/pip" install -q --disable-pip-version-check 'ctranslate2==4.*' 'sentencepiece==0.2.*' || return 1
  sudo mkdir -p "$DATA/translate" && sudo chown jisst:jisst "$DATA/translate"
  sudo -u jisst "$TR/venv/bin/python" "$APP/server/translate.py" --install "$DATA/translate" || return 1
}
translator || { echo "Note: the translator didn't finish installing; Translate stays off until the next deploy."; setkv JISST_TRANSLATE_URL ''; }
# The local model, off unless asked for. Built once from source for this processor (about 15 minutes the first time).
LLAMA_V=b11983 LLAMA=/opt/jisst-llama MODEL_URL=https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf
local_ai() {
  if [ "$(cat "$LLAMA/.version" 2>/dev/null)" != "$LLAMA_V" ]; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential cmake git >/dev/null || return 1
    sudo rm -rf "$LLAMA.src" && sudo git clone -q --depth 1 --branch "$LLAMA_V" https://github.com/ggml-org/llama.cpp.git "$LLAMA.src" || return 1
    (cd "$LLAMA.src" && sudo cmake -B build -DLLAMA_CURL=OFF -DGGML_NATIVE=ON -DCMAKE_BUILD_TYPE=Release >/dev/null && sudo cmake --build build --target llama-server -j "$(nproc)" >/dev/null) || return 1
    sudo mkdir -p "$LLAMA" && sudo cp "$LLAMA.src/build/bin/llama-server" "$LLAMA/" && sudo cp "$LLAMA.src/LICENSE" "$LLAMA/" && echo "$LLAMA_V" | sudo tee "$LLAMA/.version" >/dev/null || return 1
    sudo rm -rf "$LLAMA.src"
  fi
  [ -s "$LLAMA/model.gguf" ] || { sudo curl -fsSL "$MODEL_URL" -o "$LLAMA/model.gguf.part" && sudo mv "$LLAMA/model.gguf.part" "$LLAMA/model.gguf"; } || return 1
  unit jisst-ai "Jisste local model (llama.cpp, loopback only)" "$LLAMA/llama-server -m $LLAMA/model.gguf --host 127.0.0.1 --port 8306 -c 4096 -t 2 --parallel 1" ""
  sudo systemctl daemon-reload && sudo systemctl enable jisst-ai >/dev/null && sudo systemctl restart jisst-ai
  setkv JISST_LOCAL_AI_URL "http://127.0.0.1:8306"
}
if [ "${JISST_LOCAL_AI:-}" = yes ]; then local_ai || echo "Note: the local model didn't finish installing; the helper keeps its usual answers."
else sudo systemctl disable --now jisst-ai 2>/dev/null || true; fi
unit jisst-translate "Jisste translator (loopback only)" "$TR/venv/bin/python $APP/server/translate.py --serve $DATA/translate" ""
sudo systemctl daemon-reload
sudo systemctl enable jisst-chat jisst-gateway jisst-calls jisst-translate >/dev/null
sudo systemctl restart jisst-translate
sudo systemctl enable --now jisst-snapshot.timer >/dev/null
sudo systemctl restart jisst-calls
sudo systemctl restart jisst-chat
for i in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$HS_PORT/_matrix/client/versions" 2>/dev/null && break; sleep 1; done
sudo systemctl restart jisst-gateway
sudo rm -rf "$APP.old"

# ---- calls need these ports open in the server's own firewall (and in Oracle's security list, see docs/DEPLOY.md) ----
if command -v firewall-cmd >/dev/null && sudo firewall-cmd --state >/dev/null 2>&1; then
  sudo firewall-cmd --permanent --add-port=7881/tcp --add-port=3478/udp --add-port=50000-60000/udp >/dev/null && sudo firewall-cmd --reload >/dev/null
elif command -v iptables >/dev/null; then
  for R in "tcp 7881" "udp 3478" "udp 50000:60000"; do
    set -- $R
    sudo iptables -C INPUT -p "$1" --dport "$2" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p "$1" --dport "$2" -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null && sudo netfilter-persistent save >/dev/null 2>&1 || true
fi

# ---- the address: Jisste's own file in the shared Caddy ----
if [ ! -x /usr/local/bin/caddy ] || [ ! -d /etc/caddy/sites ]; then
  echo 'The shared Caddy web server is missing (the Agent Grand Prix deploy installs it). Jisste runs, but is not on the web yet.'; exit 1
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
	handle_path /livekit/* {
		reverse_proxy 127.0.0.1:$LK_PORT
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
for s in jisst-chat jisst-gateway jisst-calls jisst-translate caddy; do printf '%-14s %s\n' "$s" "$(systemctl is-active "$s")"; done
curl -fsS "http://127.0.0.1:$GW_PORT/api/health"; echo
