#!/bin/sh
# PostgreSQL TLS entrypoint wrapper.
#
# Bind-mounted private keys keep their host ownership and 0600 permissions.
# The PostgreSQL server runs as the "postgres" user, which may not be able to
# read a key owned by the EC2 login user. This wrapper runs as root, copies the
# certificates to a container-local directory, fixes ownership, then hands off
# to the official PostgreSQL entrypoint.
#
# This file is only used when docker-compose.deploy.yml (or the standalone
# docker-compose.postgres-tls.yml) enables PostgreSQL TLS.

set -eu

CERT_DIR=/etc/mesh-certs
TLS_DIR=/var/lib/postgresql/tls

if [ ! -s "$CERT_DIR/server.crt" ] || [ ! -s "$CERT_DIR/server.key" ]; then
  echo "FATAL: PostgreSQL TLS certificate files are missing under $CERT_DIR." >&2
  echo "Run deploy/tls/gen-certs.sh on the EC2 host before starting the stack." >&2
  exit 1
fi

mkdir -p "$TLS_DIR"
cp "$CERT_DIR/server.crt" "$TLS_DIR/server.crt"
cp "$CERT_DIR/server.key" "$TLS_DIR/server.key"
chown postgres:postgres "$TLS_DIR/server.crt" "$TLS_DIR/server.key"
chmod 644 "$TLS_DIR/server.crt"
chmod 600 "$TLS_DIR/server.key"

exec /usr/local/bin/docker-entrypoint.sh "$@"
