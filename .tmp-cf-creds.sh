export CF_EMAIL='acharya.priyank7@gmail.com'
export CF_KEY='cfk_esjOYlFzUIpx9k3qtC4v7FLz9LKdlqtxjY74JcgBcb7e1690'
export CF_ACCOUNT='bb1b8e2ec0c43f9a49cc3c30b4aad52e'
cfapi() { curl -s -m 40 -H "X-Auth-Email: $CF_EMAIL" -H "X-Auth-Key: $CF_KEY" "$@"; }
export CLOUDFLARE_EMAIL="$CF_EMAIL"
export CLOUDFLARE_API_KEY="$CF_KEY"
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT"
