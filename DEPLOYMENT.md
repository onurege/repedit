# Deployment — small Ubuntu VPS

BUSINESS DISTRICT runs as three processes: **Caddy** (TLS + static client +
reverse proxy) → **Node** game server (HTTP API + WebSocket) → **PostgreSQL**.
This fits comfortably on a small VPS (1–2 vCPU, 1–2 GB RAM).

```
Internet ──▶ Caddy :443 ──┬──▶ /api/*, /ws ──▶ Node server :2567 ──▶ PostgreSQL
                          └──▶ /            ──▶ client/dist (static SPA)
```

## Prerequisites

- A domain pointed at the VPS (A record).
- Docker + Docker Compose plugin installed.

## Steps

```bash
git clone <repo> business-district && cd business-district

# 1. Configure secrets
cp .env.example .env
#   Edit .env and set at minimum:
#     POSTGRES_PASSWORD=<a strong password>
#   (DATABASE_URL for the server is derived automatically in the prod compose file.)

# 2. Point Caddy at your domain
#   Edit deploy/Caddyfile: replace play.example.com with your domain.

# 3. Build + launch (client build, migrations, seed run automatically)
docker compose -f docker-compose.prod.yml up -d --build

# 4. Verify
curl -s https://<your-domain>/api/health      # -> {"ok":true,"db":true}
```

Migrations run on every server start and are idempotent, so redeploys are safe.
`NODE_ENV=production` disables all in-game developer tools (add money / inventory,
time warp, business reset) — they cannot be invoked in production.

## Configuration (environment)

| Variable | Purpose |
|---|---|
| `POSTGRES_PASSWORD` | **Required** in production. Database password. |
| `DATABASE_URL` | Server's Postgres connection string (set by the prod compose file). |
| `PORT` | Server port (default 2567). |
| `NODE_ENV` | `production` disables dev tools. |
| `CORS_ORIGIN` | Optional comma-separated browser-origin allowlist. Unset = allow all (fine behind a single-origin proxy). |
| `VITE_SERVER_URL` | Client build-time API URL. Leave empty for the single-origin Caddy setup (client uses its own origin). |

## Updating

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build --force-recreate
```

`--force-recreate` is required. The `server` and `client-build` services run
the plain `node:22-alpine` image with the repo bind-mounted, so `--build`
rebuilds nothing and Compose leaves an already-running `server` container in
place — its long-lived `tsx` process keeps the *old* code in memory even
though `git pull` updated the files on disk. `--force-recreate` restarts the
container so the server picks up the new code. (Symptom of skipping it: the
client shows new content but the server rejects actions that depend on new
code — e.g. after the V2.6 release, "no free lots" and failure to open
businesses in the new district.)

Verify the running server loaded the current code, e.g. after V2.6:

```bash
docker compose -f docker-compose.prod.yml exec server \
  node -e "import('@district/shared').then(m=>console.log('lots',m.LOTS.length))"
# V2.6 => lots 43   (18 Old Town + 24 Green Valley + 1 wholesale)
```

## Database backup & restore

Simple, reliable `pg_dump` is sufficient for launch. Compressed logical backup:

```bash
# Backup (run from the repo dir on the VPS)
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U district -d business_district -Fc > backup-$(date +%F).dump

# Restore into a fresh database
docker compose -f docker-compose.prod.yml exec -T db \
  pg_restore -U district -d business_district --clean --if-exists < backup-YYYY-MM-DD.dump
```

Automate a daily backup with cron on the host:

```cron
0 4 * * *  cd /path/to/business-district && docker compose -f docker-compose.prod.yml exec -T db pg_dump -U district -d business_district -Fc > /var/backups/bd-$(date +\%F).dump
```

Keep backups off-box (e.g. `rclone`/`scp` to object storage) and prune old ones.

## Health monitoring

`GET /api/health` returns `{"ok":true,"db":true}` (HTTP 200) when the server is
up and the database is reachable, or HTTP 503 otherwise. Point an uptime monitor
at `https://<domain>/api/health`. It exposes no sensitive information.

## Notes

- The server is a single authoritative Node process holding world state in
  memory and persisting to PostgreSQL — do not run multiple replicas.
- State is flushed on shutdown (SIGTERM/SIGINT); `docker compose down` is clean.
- No Redis, queues, or other infrastructure are required at this scale.
