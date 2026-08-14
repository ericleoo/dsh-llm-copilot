# @deepseek-ai/dsh-llm-copilot

GitHub Copilot adapter for the DeepSeek Harness LLM seam. Select `provider:
copilot-oauth` (or set it as your default model) and your Copilot
subscription serves the agent — no separate API key required, just a one-time
GitHub OAuth device-flow login. The route is named `copilot-oauth` rather than
`github-copilot` so it can coexist with the built-in pi-ai `github-copilot`
route (which authenticates with a raw `COPILOT_GITHUB_TOKEN` instead of an
OAuth exchange).

The adapter speaks Copilot's OpenAI-compatible `/chat/completions` endpoint over
streaming SSE, translating the wire format into the harness `StreamChunk`
protocol exactly as `dsh-llm-deepseek` does for DeepSeek. Authentication is
two-tiered, matching how the GitHub Copilot VS Code extension and tools like
[`copilot-api-gateway`](https://github.com/abhi-singhs/copilot-api-gateway) and
[`opencode`](https://github.com/anomalyco/opencode) handle it:

1. **A long-lived GitHub OAuth access token** is obtained once via the OAuth
   device flow (`https://github.com/login/device`), then held in the harness
   credential seam like any provider key. Run `dsh-copilot-auth login` to get
   one; it writes the token to `~/.dsh/.credentials.yaml` under
   `GITHUB_COPILOT_TOKEN`.
2. **A short-lived Copilot API session token** is exchanged on demand from that
   OAuth token via
   `GET https://api.github.com/copilot_internal/v2/token`, cached in process
   with a five-minute refresh buffer, and sent as
   `Authorization: Bearer <session>`. On a `401` the cache is invalidated so the
   next call re-exchanges.

Copilot's edge gates authenticated traffic on VS Code editor identity headers
(`Editor-Version`, `Editor-Plugin-Version`, `Copilot-Integration-Id`), so the
adapter sends them on every request — a raw `Bearer <oauth>` header is
rejected, which is the whole reason for the exchange step.

> ⚠️ **Unofficial.** This is not affiliated with, endorsed by, or supported by
> GitHub/Microsoft. It reuses the public VS Code Copilot client id and sends the
> editor headers the official extension does; GitHub may change or revoke either.
> Routing a Copilot subscription through a non-IDE tool may consume Copilot quota
> faster than IDE chat and may affect your ToS standing. Use at your own risk.

## Install

```bash
dsh plugin --profile web add @deepseek-ai/dsh-llm-copilot
```

`dsh plugin` initializes the profile on first use, forwards to `pnpm` in the
profile directory, and — because the package declares a `dsh.bundle.patch` —
appends itself to the profile's bundle layer list automatically. The
`cordis.patch.yml` shipped in the package mounts the plugin into the core
composition (the same way the built-in `llm-deepseek` row in
`@deepseek-ai/dsh-base` does), registering the `copilot-oauth` provider route
dormant until credentials are present. Restart `dsh` (or the profile you
installed into) once to mount it; no restart is needed to rotate credentials.

## Authenticate

```bash
dsh-copilot-auth login
```

This opens `https://github.com/login/device`, prints the user code to enter,
polls the OAuth token endpoint, and writes the resulting GitHub OAuth access
token to `~/.dsh/.credentials.yaml` under `GITHUB_COPILOT_TOKEN`. The credentials
service watches that file, so the adapter picks up the token — and any later
rotation — immediately without a restart.

You can point at a different credential reference:

```bash
dsh-copilot-auth login --ref MY_COPILOT_OAUTH_TOKEN
dsh-copilot-auth status            # proves the stored token still exchanges
dsh-copilot-auth logout
```

A `GITHUB_COPILOT_TOKEN` exported in your launching environment also satisfies
the adapter directly (the inherited environment is the trusted layer that the
credentials seam consults first).

## Use

Select the provider in any setting that accepts a model/provider selection —
the default model profile, a session, a subagent, or a tool call:

```yaml
provider: copilot-oauth
model: claude-3-5-sonnet   # or claude-3-7-sonnet, gpt-4o, o1-preview, ...
```

Set it as the agent-wide default by overriding the composition's
`agent-default-model` row:

```yaml
- id: agent-default-model
  config:
    provider: copilot-oauth
    model: claude-3-5-sonnet
```

### Models

With `discoverModels: true` (the default), the adapter probes Copilot's
`/models` endpoint — authenticated with the live OAuth token — to publish the
exact model set your subscription can call, with advertised capabilities
(context window, tooling, reasoning levels). When that catalog is unreachable,
it falls back to a static hand-authored list (GPT-4o, GPT-4o-mini, GPT-4-Turbo,
GPT-4, o1-preview, o1-mini, Claude 3.5/3.7 Sonnet). An explicit `models` list
in the profile replaces that fallback wholesale. Catalog entries are advisory:
an unlisted model id still passes through to Copilot unchanged, exactly as the
DeepSeek adapter behaves.

### Reasoning

Copilot exposes per-model reasoning levels via its `/models` catalog (e.g.
`low`/`medium`/`high`/`xhigh`/`max`, with `none` for gpt-5.x). The adapter
publishes each model's exact levels to the selector — `off` is always offered
(omitting the parameter on chat, `none` on responses) — and passes the selected
effort through as `reasoning_effort` on chat and `reasoning.effort` on
`/responses`. Models that only serve the `/responses` endpoint (the gpt-5.x
family) are routed there automatically from the live `/models` catalog;
reasoning summaries on this subscription arrive encrypted (`client_byok`), so
no reasoning *text* is streamed for those models even though the effort is
honored and reasoning tokens appear in usage.

## Config

The composition entry (overridable per profile or via `~/.dsh/settings.yaml`):

```yaml
- id: llm-copilot
  name: '@deepseek-ai/dsh-llm-copilot'
  config:
    apiKeyEnv: GITHUB_COPILOT_TOKEN   # credential ref holding the GitHub OAuth token
    baseURL: https://api.githubcopilot.com
    maxTokens: 16384                   # default per-request output cap
    defaultContextWindow: 200000       # catalog capacity for unlisted pass-through ids
    discoverModels: true               # probe /models; fall back to the static catalog
    streamIdleTimeoutMs: 300000        # max idle SSE interval before the call is aborted
    retryPolicy:                       # omisssion ⇒ bounded normal defaults
      mode: always
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
    models:                           # optional override of the static fallback catalog
      - id: claude-3-5-sonnet
        name: Claude 3.5 Sonnet
        contextWindow: 200000
        maxTokens: 16384
```

## How the auth maps onto the harness seams

* **Credentials** (`ctx.credentials`): the GitHub OAuth token is a normal
  credential reference, resolved per request — the adapter never hardcodes it,
  and a rotation reaches the next call without a restart.
* **Settings** (`ctx.settings` / `installSettingsSection`): `baseURL`,
  `apiKeyEnv`, the model catalog, and the retry policy live in the
  `llm-copilot` settings namespace, hot-reloadable from `~/.dsh/settings.yaml`
  or the Web Models page.
* **Token exchange** (`CopilotTokenManager`): the long-lived OAuth token is
  turned into the short-lived session bearer inside the adapter, with an
  in-memory cache and proactive refresh (5-minute buffer) so there is no
  per-request round trip; `401`s invalidate the cache.
* **Discovery** (`ctx.llm.registerModelDiscovery`): a one-shot authenticated
  probe of `/models` feeds the selector, degrading to the static catalog on any
  failure so a transient outage can't blank the model picker.

## Known limitations

- Image input is not supported by this adapter — a message block containing an
  image is rejected up front rather than silently stripped (Copilot's edge
  accepts it on some routes, but the harness adapter marks the path text-only).
- `tool_choice` is not mapped — it is not part of the core vocabulary (MVP cut,
  shared with the other direct-fetch adapters).
- The OAuth device-flow login is a separate `dsh-copilot-auth` CLI rather than
  an in-agent tool call; embedding an interactive browser-flow inside an agent
  turn is deliberately out of scope for a transport adapter.
- The editor identity headers impersonate the VS Code Copilot client; GitHub
  may rotate the client id or reject a given version string at any time.
