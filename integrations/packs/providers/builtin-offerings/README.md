# Built-in provider offerings Pack

Vendor knowledge for the provider offerings mahas supports — migrated out of
the old `src/main/usage.ts` / `src/main/usageAuth.ts` probes. The runtime
never names a vendor; it resolves an offering through this Pack.

| file | role |
| --- | --- |
| `providers.json` | the per-offering catalog: credential file names and locations, file format, flow `kind`, loopback callback shape, and which CLI the credential belongs to |
| `auth.mjs` | the `mahas.integration.auth` implementation: runs each flow kind and returns material/claims for the runtime to commit as inventory |
| `quota.mjs` | the `mahas.integration.quota` implementation: probes each offering's usage endpoint with caller-supplied credential material |
| `locators.mjs` | finds and parses the credential files declared in `providers.json` (`PROVIDER_LOCATORS`, `locatorCandidates`, `readLocatorMaterial`) |
| `fixtures/` | conformance fixtures — schema-valid/invalid envelopes only, never live vendor responses |

## Offerings and flow kinds

| offering | kind | credential file (locator) | flow shape |
| --- | --- | --- | --- |
| `anthropic/claude` | `manual-code` | `~/.claude/.credentials.json` (`claude-credentials-json`) | browser authorize → user pastes the `code#state` pair; token exchange at `console.anthropic.com` |
| `openai/chatgpt` | `pkce` | `~/.codex/auth.json` (`codex-auth-json`) | provider-registered loopback `http://localhost:1455/auth/callback` |
| `xai/grok` | `pkce` | `~/.grok/auth.json` (`grok-auth-json`) | provider-registered loopback `http://127.0.0.1:56121/callback` |
| `google/cloud-code` | `pkce-dynamic` | `~/.gemini/oauth_creds.json` (`gemini-oauth-json`) | dynamic loopback port, path `/oauth2callback` |
| `github/copilot` | `device` | `$config/github-copilot/apps.json` (`github-apps-json`) | GitHub device-code grant (`Iv1.b507a08c87ecfe98`, scope `read:user`) |
| `cline/account` | `cline-device` | `~/.cline/data/settings/providers.json` (`cline-providers-json`) | Cline's WorkOS-backed device flow (`api.workos.com` + `api.cline.bot`) |
| `opencode/go` | `api-key` | opencode `auth.json` (`opencode-auth-json`) | user pastes a key; no browser |
| `zai/coding-plan` | `api-key` | `~/.zcode/v2` or `~/.zcode/cli` `config.json` (`zai-config-json`) | user pastes a key; no browser |
| `windsurf/account` | `api-key` | devin `credentials.toml` (`windsurf-credentials-toml`) | user pastes a key; no browser |

Flow-kind vocabulary (`kind` in `providers.json` / `AUTH_OFFERINGS`):

- `pkce` — browser authorize + PKCE, fixed provider-registered loopback
  redirect.
- `pkce-dynamic` — browser authorize + PKCE, loopback on an OS-assigned port
  (Google accepts any loopback port for installed apps).
- `manual-code` — browser authorize, the user pastes the displayed code back
  (Anthropic's `code#state` paste).
- `device` / `cline-device` — device-code grants: poll the token endpoint
  while the user approves in a browser.
- `api-key` — no flow; the user supplies a key directly.

## Contract limits that matter

- **Secrets never live in the Pack.** `quota.mjs` refuses a request without
  caller-scoped credential material (conformance case
  `quota-rejects-missing-credential-material`); the daemon deposits a secret
  as a single-use handle (`auth.secret.deposit`) and passes material in per
  call. The Pack reads existing vendor credential files only through
  `locators.mjs`, and writes nothing outside a credential-change.
- **Quota delta is not usage.** `supportDetails.quotaDeltaIsUsage: false` — a
  quota probe returns meter state, never a token-usage claim; the poll time
  is never claimed as usage time (the coverage interval stays null).
- **Conformance is schema-level.** The fixtures prove envelope validation and
  reject behavior. No real vendor endpoint, credential, or login has been
  exercised — a probe that stops matching a live vendor schema can still
  pass. Treat these as a regression net, not a compatibility claim.
