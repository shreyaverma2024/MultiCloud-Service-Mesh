#!/bin/sh
# Generate a free self-managed CA and server certificate for the AWS EC2
# deployment TLS proxy and PostgreSQL.
#
# Usage (run on the EC2 instance, from the repository root):
#
#   ./deploy/tls/gen-certs.sh <aws-public-host> <aws-public-ip>
#
# Example:
#
#   ./deploy/tls/gen-certs.sh ec2-1-2-3-4.compute.amazonaws.com 1.2.3.4
#
# The CA is reused when certs/ca.crt and certs/ca.key already exist, so you can
# regenerate only the server certificate when the EC2 public IP changes. Set
# NEW_CA=1 to replace the CA as well (then upload the new certs/ca.crt to
# Render again).
#
# Never commit or share certs/ca.key or certs/server.key. The public
# certificates (ca.crt and server.crt) are not secrets.

set -eu

usage() {
  echo "Usage: $0 <aws-public-host> <aws-public-ip>" >&2
  echo "Example: $0 ec2-1-2-3-4.compute.amazonaws.com 1.2.3.4" >&2
}

PUBLIC_HOST="${1:-}"
PUBLIC_IP="${2:-}"

if [ -z "$PUBLIC_HOST" ] || [ -z "$PUBLIC_IP" ]; then
  usage
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required. Install it with: sudo apt-get install -y openssl" >&2
  exit 1
fi

CERT_DIR="${CERT_DIR:-certs}"
mkdir -p "$CERT_DIR"

CA_CRT="$CERT_DIR/ca.crt"
CA_KEY="$CERT_DIR/ca.key"
SERVER_CRT="$CERT_DIR/server.crt"
SERVER_KEY="$CERT_DIR/server.key"
SERVER_CSR="$CERT_DIR/server.csr"

if [ ! -s "$CA_CRT" ] || [ ! -s "$CA_KEY" ] || [ "${NEW_CA:-0}" = "1" ]; then
  echo "Generating a new self-managed CA..."
  rm -f "$CERT_DIR/ca.srl"
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout "$CA_KEY" -out "$CA_CRT" \
    -subj "/CN=MultiCloud Service Mesh Internal CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  chmod 600 "$CA_KEY"
  chmod 644 "$CA_CRT"
else
  echo "Reusing existing CA: $CA_CRT"
fi

ALT_FILE="$(mktemp)"
trap 'rm -f "$ALT_FILE" "$SERVER_CSR"' EXIT

cat > "$ALT_FILE" <<EOF
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = postgres
DNS.2 = localhost
IP.1 = 127.0.0.1
IP.2 = $PUBLIC_IP
EOF

# If the public host is an IPv4 address, add it as an IP SAN. Otherwise add it
# as a DNS SAN. Avoid duplicate IP entries when the host and IP are the same.
case "$PUBLIC_HOST" in
  ''|*[!0-9.]*)
    printf 'DNS.3 = %s\n' "$PUBLIC_HOST" >> "$ALT_FILE"
    ;;
  *)
    if [ "$PUBLIC_HOST" != "$PUBLIC_IP" ]; then
      printf 'IP.3 = %s\n' "$PUBLIC_HOST" >> "$ALT_FILE"
    fi
    ;;
esac

echo "Generating the server certificate..."
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$SERVER_KEY" -out "$SERVER_CSR" \
  -subj "/CN=$PUBLIC_HOST"

openssl x509 -req -in "$SERVER_CSR" \
  -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
  -out "$SERVER_CRT" -days 397 -sha256 \
  -extfile "$ALT_FILE"

chmod 600 "$SERVER_KEY"
chmod 644 "$SERVER_CRT"

cat <<EOF

Generated:
  $CA_CRT       public CA certificate - upload this to Render as a Secret File
  $CA_KEY       PRIVATE - never share or commit
  $SERVER_CRT   server certificate (SANs: postgres, localhost, $PUBLIC_HOST, 127.0.0.1, $PUBLIC_IP)
  $SERVER_KEY   PRIVATE - never share or commit

Next steps:
  1. Keep $CA_KEY and $SERVER_KEY private. certs/ is git-ignored.
  2. In Render, add a Secret File named mesh-ca.crt with the contents of $CA_CRT.
  3. Set DB_SSL_CA_PATH=/etc/secrets/mesh-ca.crt and
     NODE_EXTRA_CA_CERTS=/etc/secrets/mesh-ca.crt on Render.
  4. Restart the AWS stack so Nginx and PostgreSQL load the certificates.

If the EC2 public host or IP changes, rerun this script with the new values.
The CA is reused, so Render does not need a new secret file. If you set
NEW_CA=1, you MUST upload the new $CA_CRT to Render again.
EOF
