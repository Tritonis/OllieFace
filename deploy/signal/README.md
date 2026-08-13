# Signal server deploy (Fly.io)

Packages `tools/signal-server.mjs` (unchanged) as a Fly.io app. The server
reads `PORT` from the environment, serves `GET /healthz`, and expects TLS
termination upstream — Fly's edge does that, so the app only ever speaks
plain HTTP internally.

## One-time setup

1. Install `flyctl`: https://fly.io/docs/flyctl/install/
2. Authenticate:

   ```
   flyctl auth login
   ```

## Launch and deploy

Run these from `deploy/signal/` (the build context resolves to the repo
root via `fly.toml`'s `context = "../.."`, so the Dockerfile's `COPY
tools/signal-server.mjs` still finds the real file):

```
flyctl launch --no-deploy --copy-config
flyctl deploy
```

`flyctl launch` will ask to confirm (or override) the app name and region
from `fly.toml` — `primary_region = "ord"` is a placeholder; pick the region
closest to your players. `--copy-config` keeps the committed `fly.toml`
instead of generating a new one.

## Resulting URL

The app is reachable at:

```
wss://<app>.fly.dev
```

where `<app>` is the app name chosen during `flyctl launch` (defaults to
`telluric-signal`).

## Smoke check

```
curl https://<app>.fly.dev/healthz
```

Expect an HTTP 200 response. This is the same endpoint Fly's own health
check in `fly.toml` polls every 30s before routing traffic to a machine.
