# @deepseek-ai/dsh-llm-copilot

GitHub Copilot adapter for the DeepSeek Harness LLM seam. Select `provider:
copilot-oauth` (or set it as your default model) and your Copilot
subscription serves the agent — no separate API key required, just a one-time
GitHub OAuth device-flow login. The route is named `copilot-oauth` rather than
`github-copilot` so it can coexist with the built-in pi-ai `github-copilot`
route (which authenticates with a raw `COPILOT_GITHUB_TOKEN` instead of an
OAuth exchange).

The adapter speaks Copilot's OpenAI-compatible `/chat/completions` endpoint
over streaming SSE — and the `/responses` endpoint for models whose catalog
entry routes there (the gpt-5.x family) — translating the wire format into the
harness `StreamChunk` protocol exactly as `dsh-llm-deepseek` does for
DeepSeek. Authentication is two-tiered, matching how the GitHub Copilot VS
Code extension and tools like
[`copilot-api-gateway`](https://github.com/abhi-singhs/copilot-api-gateway)
and [`opencode`](https://github.com/anomalyco/opencode) handle it:

1. **A long-lived GitHub OAuth access token** is obtained once via the OAuth
   device flow (`https://github.com/login/device`), then held in the harness
   credential seam like any provider key. Run `dsh-copilot-auth login` to get
   one; it writes the token to `$DSH_HOME/.credentials.yaml` (owner-only,
   mode 0600) under `GITHUB_COPILOT_TOKEN`.
2. **A short-lived Copilot API session token** is exchanged on demand from
   that OAuth token via
   `GET https://api.github.com/copilot_internal/v2/token`, cached in process
   with a five-minute refresh buffer, and sent as
   `Authorization: Bearer <session>`. On a `401` the cache is invalidated so
   the next call re-exchanges.

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

This fork is **not published to the npm registry**, so installing by bare
package name does not resolve:

```bash
dsh plugin --profile web add @deepseek-ai/dsh-llm-copilot   # ❌ E404
```

Install from the repository URL instead:

```bash
dsh plugin --profile web add git+https://github.com/ericleoo/dsh-llm-copilot.git
```

`dsh plugin` initializes the profile on first use, forwards the remaining
arguments to `pnpm` in the profile directory, and — because the package
declares a `dsh.bundle.patch` — appends itself to the profile's bundle layer
list automatically. The `cordis.patch.yml` shipped in the package mounts the
plugin into the core composition (the same way the built-in `llm-deepseek`
row in `@deepseek-ai/dsh-base` does), registering the `copilot-oauth`
provider route dormant until credentials are present. Restart `dsh` (or the
profile you installed into) once to mount it; no restart is needed to rotate
credentials.

### Local checkout (alternative)

You can also keep the plugin as a git checkout and install it from there —
run the add from inside the checkout:

```bash
dsh plugin --profile web add .
```

This works whether the package is installed from the registry, from git, or
linked from a local checkout; `dsh plugin` anchors relative path specs to the
directory you invoke it from.

## Authenticate

```bash
dsh-copilot-auth login
```

This runs the RFC 8628 device flow: it prints the verification URL and code
(or auto-opens the browser when run on a TTY), polls the GitHub token
endpoint until you authorize, and writes the resulting GitHub OAuth access
token to `$DSH_HOME/.credentials.yaml` (creating the file owner-only if
needed) under `GITHUB_COPILOT_TOKEN`. The credentials service watches that
file, so the adapter picks up the token — and any later rotation —
immediately without a restart.

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
model: claude-3-5-sonnet   # or claude-3-7-sonnet, gpt-4o, gpt-5.4-mini, ...
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
(context window, tooling, reasoning levels, and which endpoint each model
serves). A best-effort probe runs at boot (silent on failure), and the model
selector triggers another when it asks; when the catalog is unreachable the
adapter falls back to a static hand-authored list covering the current
Claude, GPT, and Gemini families (gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-4,
claude-3.5/3.7 sonnet, claude-haiku-4.5, claude-sonnet-4.6/5,
claude-opus-4.6/4.8/5, gemini-3.5/3.6 flash, gpt-5-mini, and the gpt-5.x
`/responses` family: gpt-5.3-codex, gpt-5.4-mini, gpt-5.5, gpt-5.6-*). An
explicit `models` list in the profile replaces that fallback wholesale.
Catalog entries are advisory: an unlisted model id still passes through to
Copilot unchanged, exactly as the DeepSeek adapter behaves.

### Reasoning

Copilot exposes per-model reasoning levels via its `/models` catalog (`low`,
`medium`, `high`, `xhigh`, `max`). Disabled reasoning is spelled `none` on
the gpt-5.x `/responses` models (`off` on the others), and both fold into the
harness `off`; Gemini's `minimal` level has no harness equivalent and is
dropped. `off` is always offered — it maps to omitting the parameter on chat
and `none` on `/responses` — and the adapter defaults to `medium` when a model
offers it, else `off`. The selected effort passes through as
`reasoning_effort` on chat and `reasoning.effort` on `/responses`. Models
whose catalog entry routes to `/responses` are sent there automatically. On
that endpoint the adapter requests a `detailed` reasoning summary: the full
chain-of-thought arrives BYOK-encrypted on this subscription, but the readable
summary streams as a thinking block, and the effort is honored server-side
with reasoning tokens appearing in usage.

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
    retryPolicy:                       # omission ⇒ bounded normal defaults
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

Notes:

- `baseURL` is honored from `$COPILOT_BASE_URL` when set in the trusted
  launch layers, otherwise defaults to the public
  `https://api.githubcopilot.com` host.
- `retryPolicy` accepts `mode: always` (retry every model-request failure
  until success, cancellation, or disposal) or `mode: normal` (bounded:
  `maxRetries` and `retryableCodes`); both share the `backoff` block above.
  Omission resolves to the normal defaults.
- `models` entries accept `id` (required), `name`, `description`,
  `contextWindow`, `maxTokens`, `api` (`chat` or `responses`), and
  `reasoningEfforts`; ids must be unique and the values positive.

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
* **Discovery** (`ctx.llm.registerModelDiscovery`): a best-effort boot probe
  plus a one-shot authenticated probe of `/models` feeds the selector,
  degrading to the static catalog on any failure so a transient outage can't
  blank the model picker.

## Known limitations

- Image input is not supported — the adapter is text-only, so a message block
  containing an image is rejected up front rather than silently stripped
  (Copilot's edge accepts it on some routes, but the harness adapter marks the
  path text-only).
- `tool_choice` is not mapped — it is not part of the core vocabulary (MVP
  cut, shared with the other direct-fetch adapters).
- The OAuth device-flow login is a separate `dsh-copilot-auth` CLI rather than
  an in-agent tool call; embedding an interactive browser-flow inside an agent
  turn is deliberately out of scope for a transport adapter.
- The editor identity headers impersonate the VS Code Copilot client; GitHub
  may rotate the client id or reject a given version string at any time.
