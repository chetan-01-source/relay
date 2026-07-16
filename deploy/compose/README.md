# Local infrastructure (Docker Compose)

One compose file, two profiles.

| Profile | Services                                  | Used by                                        |
| ------- | ----------------------------------------- | ---------------------------------------------- |
| `core`  | postgres (pgvector), valkey, logto, minio | `make up`, CI integration jobs, self-host base |
| `dev`   | core + mockllm                            | `make dev` inner loop                          |

## Usage

```bash
cp .env.example .env          # then fill values (never commit .env)
docker compose --profile core up -d --wait
docker compose ps             # all services healthy (logto ~60s on first boot: DB seed)
docker compose --profile core down
```

## Ports

| Service  | Port        | Notes                                                    |
| -------- | ----------- | -------------------------------------------------------- |
| postgres | 5432        | db `relay` (+ `logto`); roles `relay_app`, `relay_admin` |
| valkey   | 6379        | cache/limits; no persistence (cache semantics)           |
| logto    | 3001 / 3002 | OIDC endpoint / admin console                            |
| minio    | 9000 / 9001 | S3 API / web console                                     |
| mockllm  | 8080        | dev profile only                                         |

## Notes

- `initdb/01-init.sh` runs **once** on first Postgres boot (empty volume): creates the `logto` DB, the `relay_app`/`relay_admin` roles, and enables `pgvector`. To re-run it, `docker compose down -v` to drop the volume first.
- `.env` is gitignored; only `.env.example` is committed. Generate `RELAY_MASTER_KEY` with `openssl rand -base64 32`.
