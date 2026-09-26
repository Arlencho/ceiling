#!/bin/sh
# Cloud Run mounts the database URL from Secret Manager as DATABASE_URL.
# node-postgres reads the PG* variables and ignores DATABASE_URL, so the
# container translates it once at start. Values are never printed and never
# written to disk.
set -eu

if [ -n "${DATABASE_URL:-}" ]; then
  eval "$(node - <<'EOF'
const u = new URL(process.env.DATABASE_URL);
const esc = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const out = {
  PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password),
  PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
  PGHOST: u.searchParams.get('host') || decodeURIComponent(u.hostname),
  PGPORT: u.port || '5432',
};
for (const [k, v] of Object.entries(out)) process.stdout.write(`export ${k}=${esc(v)}\n`);
EOF
)"
fi

exec "$@"
