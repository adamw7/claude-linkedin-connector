#!/usr/bin/env bash
# Runs the Docker image the way a deployment would (read-only, secret from a file, behind a Host check) and
# checks that it starts, reports healthy, serves OAuth metadata, refuses unauthenticated MCP requests and
# shuts down cleanly. Also checks that it refuses to start without SERVER_SECRET.
#
# Usage: scripts/smoke-test-image.sh <image>
set -euo pipefail

image="${1:?usage: $0 <image>}"
name="linkedin-connector-smoke-$$"
host="linkedin-mcp.example.com"
secrets="$(mktemp -d)"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$secrets"
}
trap cleanup EXIT

fail() {
  echo "::error::$1" >&2
  docker logs "$name" >&2 2>&1 || true
  exit 1
}

env_args=(
  -e LINKEDIN_CLIENT_ID=smoke-test-client
  -e LINKEDIN_CLIENT_SECRET=smoke-test-secret
  -e "PUBLIC_URL=https://$host"
  -e LINKEDIN_ALLOWED_MEMBERS=ada@example.com
  -e "ALLOWED_HOSTS=$host"
)

echo "Refuses to start a public server without SERVER_SECRET"
docker run -d --name "$name" "${env_args[@]}" "$image" >/dev/null
code="$(timeout 20 docker wait "$name" || true)"
[ "$code" = 1 ] || fail "expected exit code 1 without SERVER_SECRET, got ${code:-none (still running)}"
docker logs "$name" 2>&1 | grep -q 'SERVER_SECRET is required' || fail "no explanation without SERVER_SECRET"
docker rm -f "$name" >/dev/null

echo "Starts read-only with SERVER_SECRET_FILE"
head -c 32 /dev/urandom | base64 >"$secrets/server_secret"
chmod a+r "$secrets/server_secret"
docker run -d --name "$name" --read-only --health-interval=1s -p 127.0.0.1::3000 "${env_args[@]}" \
  -e SERVER_SECRET_FILE=/run/secrets/server_secret -v "$secrets/server_secret:/run/secrets/server_secret:ro" \
  "$image" >/dev/null
[ "$(docker inspect -f '{{.Config.User}}' "$name")" = 1000:1000 ] || fail "the image does not run as the unprivileged user 1000"

for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || fail "the container exited"
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy ] && break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy ] || fail "the container never became healthy"
docker logs "$name" 2>&1 | grep -q '"event":"listening"' || fail "no listening event in the logs"

port="$(docker port "$name" 3000/tcp | head -n 1 | sed 's/.*://')"
status() { curl -sS -o /dev/null -w '%{http_code}' -H "Host: $1" "http://127.0.0.1:$port$2"; }
echo "Serves the OAuth metadata, refuses unknown hosts and unauthenticated MCP requests"
curl -fsS -H "Host: $host" "http://127.0.0.1:$port/.well-known/oauth-authorization-server" | grep -q "\"issuer\":\"https://$host\"" ||
  fail "unexpected authorization server metadata"
[ "$(status "$host" /mcp)" = 401 ] || fail "/mcp did not ask for a token"
[ "$(status other.example /)" = 403 ] || fail "a request for another host was not refused"
[ "$(status "127.0.0.1:$port" /healthz)" = 200 ] || fail "/healthz is not served to probes that use an IP address"

echo "Shuts down cleanly on docker stop"
docker stop "$name" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$name")" = 0 ] || fail "exited with $(docker inspect -f '{{.State.ExitCode}}' "$name") on SIGTERM"
docker logs "$name" 2>&1 | grep -q '"event":"shutting_down"' || fail "no shutting_down event in the logs"

echo "Smoke test passed for $image"
