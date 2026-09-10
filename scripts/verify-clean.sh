#!/usr/bin/env bash
# Verify committed source in an isolated checkout, network and disposable DB volume.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
revision=$(git rev-parse HEAD)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
evidence="$root/docs/evidence/clean-$stamp"
mkdir -p "$evidence" "$root/tmp"
checkout=$(mktemp -d "$root/tmp/clean-checkout.XXXXXX")
project="walletcheck-$$"
if docker compose version >/dev/null 2>&1; then
  compose() { docker compose --project-directory "$checkout" -f "$checkout/compose.yaml" -p "$project" "$@"; }
else
  compose() { docker-compose --project-directory "$checkout" -f "$checkout/compose.yaml" -p "$project" "$@"; }
fi
cleanup() {
  result=$?
  trap - EXIT
  compose logs --no-color > "$evidence/compose.log" 2>&1 || true
  compose down --volumes --remove-orphans > "$evidence/cleanup.log" 2>&1 || true
  if ! rm -rf "$checkout"; then result=1; fi
  printf '{"finishedAt":"%s","revision":"%s","exitCode":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$revision" "$result" > "$evidence/result.json"
  printf 'Verification evidence: %s\n' "$evidence"
  exit "$result"
}
trap cleanup EXIT
export SOURCE_REVISION="$revision"
export API_PORT=0
# Archive only committed, tracked files: no .env, node_modules or local build output.
git archive HEAD | tar -x -C "$checkout"
docker version > "$evidence/docker-version.txt"
compose up --build --detach --wait --wait-timeout 180 2>&1 | tee "$evidence/compose-build.txt"
compose exec -T postgres createdb -U wallet wallet_test
# Install, lint, typecheck, test and build using the same LTS major as the image.
docker run --rm --network "${project}_default" \
  --user "$(id -u):$(id -g)" --env npm_config_cache=/tmp/npm-cache \
  --mount "type=bind,source=$checkout,target=/workspace" --workdir /workspace \
  --env TEST_DATABASE_URL=postgresql://wallet:wallet@postgres:5432/wallet_test \
  node:24-alpine sh -c 'node --version && npm ci && npm run lint && npm run typecheck && npm test && npm run build' \
  2>&1 | tee "$evidence/quality.txt"
compose exec -T api node -e 'if(process.getuid()===0)process.exit(1); if(require("fs").existsSync("node_modules/typescript"))process.exit(2); console.log(JSON.stringify({uid:process.getuid(),node:process.version,developmentDependencies:false,revision:process.env.SOURCE_REVISION}))' > "$evidence/runtime.json"
docker run --rm --network "${project}_default" \
  --user "$(id -u):$(id -g)" --env npm_config_cache=/tmp/npm-cache \
  --mount "type=bind,source=$checkout,target=/workspace" --workdir /workspace \
  node:24-alpine npm run burst -- http://api:3000 --out docs/evidence/compose-burst.json \
  2>&1 | tee "$evidence/burst-output.txt"
cp "$checkout/docs/evidence/compose-burst.json" "$evidence/burst.json"
compose exec -T api node -e 'fetch("http://127.0.0.1:3000/metrics").then(r=>r.text()).then(t=>process.stdout.write(t))' > "$evidence/metrics.prom"
compose exec -T api node -e 'fetch("http://127.0.0.1:3000/logs").then(r=>r.text()).then(t=>process.stdout.write(t))' > "$evidence/public-logs.json"
compose exec -T postgres psql -U wallet -d wallet -Atc "SELECT json_build_object('wallets',(SELECT count(*) FROM wallets),'transfers',(SELECT count(*) FROM transfers),'completed',(SELECT count(*) FROM transfers WHERE status='completed'),'declined',(SELECT count(*) FROM transfers WHERE status='declined'),'total_paise',(SELECT sum(balance_paise)::text FROM wallets),'minimum_paise',(SELECT min(balance_paise)::text FROM wallets),'pending',(SELECT count(*) FROM transfers WHERE status='pending'),'migrations',(SELECT count(*) FROM schema_migrations));" > "$evidence/database-counts.json"
node - "$evidence" <<'JS'
const fs = require('fs');
const dir = process.argv[2];
const row = JSON.parse(fs.readFileSync(`${dir}/database-counts.json`));
if(row.wallets !== 6 || row.transfers !== 351 || row.completed !== 275 || row.declined !== 76 || row.total_paise !== '40025' || row.minimum_paise !== '1' || row.pending !== 0 || row.migrations !== 3) throw new Error('Unexpected clean database results');
JS
