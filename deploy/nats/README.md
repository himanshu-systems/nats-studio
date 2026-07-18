# NATS broker (Docker) for NATS Studio

A single-node NATS server with **JetStream** and **HTTP monitoring** enabled, for
developing and testing NATS Studio. The app's default connection profile targets
`nats://127.0.0.1:4222`, which maps to this container.

## Prerequisites

- Docker Desktop running. Port **4222** must be free — if a native `nats-server`
  is already listening there, stop it first (`taskkill /F /IM nats-server.exe`).

## Usage

Run from the repo root:

```bash
# Start (detached)
docker compose -f deploy/nats/docker-compose.yml up -d

# Health / status
docker compose -f deploy/nats/docker-compose.yml ps

# Follow logs
docker compose -f deploy/nats/docker-compose.yml logs -f

# Stop (keeps JetStream data)
docker compose -f deploy/nats/docker-compose.yml down

# Stop and wipe JetStream data (removes the named volume)
docker compose -f deploy/nats/docker-compose.yml down -v
```

## Ports

| Port | Purpose                                             |
| ---- | --------------------------------------------------- |
| 4222 | Client protocol — the app connects here             |
| 8222 | HTTP monitoring (`/healthz`, `/varz`, `/jsz`, …)    |
| 6222 | Cluster routing (reserved for future clustering)    |

## Quick checks

```bash
# Server health
curl -s http://127.0.0.1:8222/healthz            # {"status":"ok"}

# Core pub/sub round-trip (needs the `nats` CLI)
nats --server nats://127.0.0.1:4222 sub "demo.>" --count 1 &
nats --server nats://127.0.0.1:4222 pub demo.hello "hi"

# JetStream account report
nats --server nats://127.0.0.1:4222 account info
```

## Config

Server settings live in [`nats-server.conf`](./nats-server.conf) (limits,
JetStream store, monitoring). JetStream state persists in the Docker named
volume `nats-studio-jetstream` (mounted at `/data/jetstream`).
