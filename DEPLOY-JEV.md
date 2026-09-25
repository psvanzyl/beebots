# beebots on the homelab (Coolify) — self-hosted Jev

This fork adds one thing to upstream beebots: decisions come from a **self-hosted
Jev-mode model** instead of `api.typesafe.ai`. Everything else is upstream.

```
browser ──https──> Traefik (Coolify proxy, CT310) ──> web (Caddy :80)
                                                        │  /api  /events  /setup/*
                                                        v
                                                      engine (:8080)  ── lan ──> jev-shim (:8787)
                                                        │                              │
                                                    bees-data                       llama.cpp
                                                                                (gpu-02 CT117 :8087)
```

## Why a shim

beebots calls Jev through `@typesafe-ai/sdk`, which reads its base URL from the
`TYPESAFE_BASE_URL` environment variable. `jev-shim/` implements the SDK's
`POST /v1/systemone` contract and answers each question by reading probability
mass off a local llama.cpp forced-choice endpoint (the Jev-mode pattern: a
forced choice between named options, one token, `n_probs`).

- `choice` questions → probability mass per label, argmax wins, confidence =
  mass on the winner.
- `score` questions → expected value over the rubric levels, plus the legend the
  SDK expects.
- `noul` questions → probability of "yes".
- A one-option menu is a forced move: returned without a model call.
- **Fail-closed**: an upstream error returns 5xx, so the engine's Jev client
  treats it as a failure and the risk layer holds rather than trading blind.

## Deploy (Coolify)

Application from git repository, build pack **Docker Compose**, compose file
`/docker-compose.coolify.yml`, domain `beebots.laserraptorai.duckdns.org` on the
`web` service. No host ports are published — Traefik owns 80/443.

Paper trading is pinned in the compose file: `DRY_RUN=true`, `MODE=dry`.

## Local development

```sh
pnpm install
node jev-shim/server.cjs &                     # decision endpoint on :8787
TYPESAFE_BASE_URL=http://127.0.0.1:8787 \
TYPESAFE_API_KEY=local-jev-shim \
JEV_MODEL=local-qwen3-8b-jev \
JEV_USD_PER_MTOK=0 \
pnpm dev                                        # paper engine on :8080
```

`pnpm test` (204 tests) and `pnpm e2e:fake-jev` run without any model at all.
