#!/usr/bin/env bash
# Runs on a GitHub runner (ARM, like the server): packs the app, the gateway, the chat server and the call server, copies
# them to the server and runs server/install.sh there. Used by this repo's deploy workflow and by the noveniqe repo's
# "Jisste (deploy)" workflow, which already holds the server's secrets. Run it from the root of a jisst checkout.
#   HOST, USER, KEY        the server's address, login name and whole private key (the SERVER_* secrets)
#   DOMAIN                 the app's names, main one first (a free jisste.<ip>.sslip.io name is always added)
#   SITE                   optional: the website's name (the site/ folder), e.g. jisste.noveniqe.com
#   SERVER_NAME, FEED, LAUNCHED, LOCAL_AI, OWNERS   optional, see .github/workflows/deploy.yml
#   SHA                    optional: the commit being deployed, kept on the server so a later run can skip an unchanged one
set -euo pipefail
TUWUNEL_IMAGE="${TUWUNEL_IMAGE:-jevolk/tuwunel:v1.9.4}"            # the chat server (Apache 2.0), from its official image
LIVEKIT_IMAGE="${LIVEKIT_IMAGE:-livekit/livekit-server:v1.13.9}"    # the call server (Apache 2.0), from its official image

if [ -z "${HOST:-}" ] || [ -z "${KEY:-}" ]; then echo '::error::Add the SERVER_HOST, SERVER_USER and SERVER_SSH_KEY secrets first.'; exit 1; fi
HOST=$(printf '%s' "$HOST" | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+' | tail -1)
USER=$(printf '%s' "${USER:-}" | grep -oE '[a-z_][a-z0-9_-]*' | tail -1 || true); USER="${USER:-ubuntu}"
K="${RUNNER_TEMP:-/tmp}/jisst_key"
install -m 600 /dev/null "$K" && printf '%s\n' "$KEY" | tr -d '\r' | sed -n '/-----BEGIN/,/-----END/p' > "$K"
[ -s "$K" ] || { echo '::error::SERVER_SSH_KEY should hold the whole key file, from the -----BEGIN line to the -----END line.'; exit 1; }
trap 'rm -f "$K"' EXIT
OPTS="-i $K -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=30"

# the names: the ones asked for, plus the free sslip.io name that always reaches the server
SPARE="jisste.$(printf '%s' "$HOST" | tr . -).sslip.io"
DOMAIN=$(printf '%s' "${DOMAIN:-}" | tr ',' ' ' | xargs)
case " $DOMAIN " in *" $SPARE "*) ;; *) DOMAIN="$DOMAIN $SPARE" ;; esac
DOMAIN=$(echo $DOMAIN)

# pack
rm -rf pack && mkdir -p pack/bin
cp -r app gateway server site package.json pack/
for img in "$TUWUNEL_IMAGE:/usr/bin/tuwunel:tuwunel" "$LIVEKIT_IMAGE:/livekit-server:livekit-server"; do
  ref="${img%%:/*}"; rest="${img#*:/}"; src="/${rest%%:*}"; dst="${rest##*:}"
  id=$(docker create --platform linux/arm64 "$ref"); docker cp "$id:$src" "pack/bin/$dst"; docker rm "$id" >/dev/null
done
file pack/bin/tuwunel pack/bin/livekit-server
tar czf jisst.tgz -C pack . && rm -rf pack
ls -lh jisst.tgz

# copy and install
clean() { printf '%s' "$1" | tr -cd 'A-Za-z0-9.:/_-'; }
scp $OPTS jisst.tgz "$USER@$HOST:/tmp/"
ssh $OPTS "$USER@$HOST" "JISST_PUBLIC_IP='$(clean "$HOST")' JISST_DOMAIN='$DOMAIN' JISST_SITE_DOMAIN='$(clean "${SITE:-}")' JISST_SERVER_NAME='$(clean "${SERVER_NAME:-}")' JISST_FEED_URL='$(clean "${FEED:-}")' JISST_LAUNCHED='$(clean "${LAUNCHED:-}")' JISST_LOCAL_AI='$(clean "${LOCAL_AI:-}")' JISST_OWNERS='$(printf '%s' "${OWNERS:-}" | tr -cd 'A-Za-z0-9@:._ -')' bash -s" < server/install.sh
[ -n "${SHA:-}" ] && ssh $OPTS "$USER@$HOST" "printf '%s\n' '$(clean "$SHA")' | sudo tee /opt/jisst/DEPLOYED >/dev/null"
rm -f jisst.tgz
[ -n "${GITHUB_ENV:-}" ] && echo "SITES=$DOMAIN" >> "$GITHUB_ENV"
echo "::notice::Jisste answers at: $(printf 'https://%s ' $DOMAIN)"
