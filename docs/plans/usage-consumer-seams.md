# Usage/session consumer seams (desktop ↔ daemon)

Status: **landed** — the daemon composition, collection scheduler, and the
desktop consumers below are all wired (see
[../architecture/domains/README.md](../architecture/domains/README.md)). This
document stays as the record of the exact desktop call surface the seam was
wired against.

Owner of the desktop files: the usage/workbench consumer task
(`src/renderer/src/features/{usage,sessions}/**`, `WidgetView.tsx`,
`src/main/{usage,usageAuth,ledger}.ts`, `src/main/runtime/{domainIpc,authClient}.ts`,
`src/preload/**`, `src/renderer/src/types.ts`).

## 1. What the desktop reads (ordinary registry, one authenticated session)

All calls go through `src/main/runtime/domainIpc.ts` → `runtimeHandle().client`
(the operator session). Nothing here scans a file, probes a provider or reads a
credential; a missing answer is reported as readiness/diagnostics instead.

| Desktop channel | Daemon operation | Payload | Result |
|---|---|---|---|
| `domain:usage.sources` | `catalog.snapshot` + `inventory.snapshot` | `{}` | snapshot `{items:[{revision,value}]}` |
| " | `metering.quota.current` (per connection) | `{connectionId}` | `QuotaCurrent{latest,lastSuccess,currentFailure}` |
| `domain:usage.ledger` | `usage.entry.list` | `{harnessId?,status?,afterId?,limit?}` | `UsageEntryQueryResult` (`items:[{entry,attribution}]`, coverage, watermarks, unidentified, nextCursor) |
| `domain:usage.summaries` | `metering.summary.query` | `{filter:{grain?,startUtc?,endUtc?,…dimensions}, limit?, cursor?}` | canonical `UsageSummaryEnvelope`: `items: UsageSummary[]`, `coverage`, `freshness`, `watermark`, `unidentified`, `aggregateGeneration`, `pending`, `page` |
| `domain:usage.statistics` | `metering.statistic.list` | `{metric?,dimensions?}` | canonical `UsageStatisticEnvelope`: `items: UsageStatistic[]`, `coverage`, `freshness`, `watermark`, `unidentified`, `page` |
| `domain:sessions.list` | `session.list` | `{harnessId?,installationId?,originMachineId?,parentSessionId?,rootsOnly?,afterId?,limit?}` | `SessionQueryResult{items,asOf,nextCursor?}` |
| `domain:sessions.detail` | `session.get` | `{sessionId}` | `SessionDetailResult{session,handles,attachments,childSessionIds,lastEventAt,lastEventKind,asOf}` |
| `domain:collection.sources` | `collection.source.list` | `{limit}` | `CollectionSourceQueryResult` |

These names live in `DOMAIN_QUERY_OPERATIONS` (`domainIpc.ts`); renaming one is a
one-line change there.

## 2. What the desktop mutates

| Desktop channel | Daemon operation | Payload | Result |
|---|---|---|---|
| `domain:collection.request` | `collection.source.list`, then `collection.request` per source (≤25) | `{sourceId, capability:'usage'\|'quota', reason}` | `CollectionRequest{id,status}` |
| `domain:usage.removeSource` | `inventory.observation.record` | `{id, subjectKind:'connection', subjectId, outcome:'removed', observedAt, sourceRef}` | recorded observation |

The desktop never sends a whole-account filter to `collection.request`: it lists
sources, filters by subject (`installation`/`connection`) when the caller named
one, and queues per source. If no source is registered yet the UI says so
(`requested:false` + detail) — a query never collects, and a refresh never
pretends collection happened.

**Needed from the assembler:** the initial source-discovery timer (sources only
exist after a discovery pass), and scheduler consumption of the request queue.

## 3. Provider sign-in — dedicated channel, never the receipt pipeline

Desktop client: `src/main/runtime/authClient.ts`. It must never be replaced by a
call on the ordinary runtime client: ordinary operation payloads/receipts are
persisted and operator-readable.

Framing (implemented desktop side):

- endpoint: `MAHAS_AUTH_ENDPOINT` or `<configDir>/mahasd-auth.sock`
  (`AUTH_SOCKET_FILENAME`); credentials from `resolveOperatorConnection`.
- transport: the shared `connectRpc` NDJSON session (`hello` with the operator
  credential → `{kind:'call', requestId, request}` → `{kind:'result',…}`).
- call: `request.operation` is the channel method; `request.payload` is the
  channel request body `{protocolVersion:'mahas.auth.channel/v1', method, scope?, input?}`
  so the server can hand it to `DedicatedAuthTransport.invoke()` unchanged.
- reply: `receipt.status==='committed'` carries the channel response in
  `receipt.result`; a server that already unwraps it (returning the flow view or
  the `{status,result}` envelope directly) is accepted too. Non-committed
  receipts map to a `ControlError`, `pending`/`unknown` stay retryable.
- methods used: `auth.flow.start {offeringId, connectionId?}`,
  `auth.secret.deposit {secret, scope}` → handle, `auth.flow.submitCode
  {flowId, handle}`, `auth.flow.submitSecret {flowId, handle}`,
  `auth.flow.poll|status|cancel {flowId}`, `auth.flow.list`, `auth.flow.refresh
  {credentialRef, offeringId, connectionId, expectedMaterialRevision}`.
- the deposit scope is `flow:<flowId>` (mirrors
  `DedicatedAuthTransport.scopeForFlow`); a handle is single-use.
- the secret travels one way only: it is passed to `auth.secret.deposit` and the
  desktop keeps/returns nothing but the handle.

Flow views are mapped to `DomainAuthFlow` (`state`, `effect`, `requiredInput`,
`credentialChange`, `identityClaims`, `error`, `conflict`) and the UI renders per
`requiredInput.kind`: `secret` → key form, `authorization-code` → paste form,
`device`/`device-poll` → code + polling (honouring `retryAt`),
`localhost-callback` → waiting.

**Needed from the assembler/auth worker:** serve the auth channel on
`mahasd-auth.sock` with the framing above, and make `auth.flow.start` resolve an
`offeringId` from the catalog into the provider Pack's driver.

### 3.1 Legacy credential roots must be passed explicitly

Desktop credential files registered before the inventory domain existed live in
`<userData>/usage-accounts` (`authClient.legacyUsageAccountsRoot()`):
`~/.config/mahas/usage-accounts` for an installed app,
`~/.config/mahas-dev/usage-accounts` for `npm run dev`.

The auth domain takes them as an option
(`inventory/auth/domain.ts` → `legacy: { home, configHome, dataHome, usageAccountsRoot }`),
so the desktop must hand the value over when it starts the daemon rather than
letting the daemon guess:

- **caller:** `initDesktopRuntime` resolves the root with
  `legacyUsageAccountsRoot()` (`src/main/runtime/authClient.ts`), passes it into
  `resolveServiceBootstrapPaths` and hands `LEGACY_USAGE_ACCOUNTS_ROOT_ENV` to
  `spawnControlPlane`, which puts it in the daemon's environment
  (`src/main/runtimeClient.ts`, `serviceBootstrap.ts`).
- **daemon side:** composition reads that env into the auth domain's
  `legacy.usageAccountsRoot` (`composition-domains.ts`).
- A profile with no such directory passes nothing (`null`), so the daemon starts
  with an empty legacy set rather than being pointed at a missing path.

### 3.2 Ordinary auth operations the desktop does NOT need

The daemon registers secret-free auth operations (`auth.status`,
`auth.intent.begin|record|complete|list`, `auth.flow.list|status|cancel|refresh`,
`auth.connection.inventory`, `auth.locator.import|adopt`, `auth.quota.collect`,
`auth.quota.current`). The desktop sign-in path deliberately uses the dedicated
channel instead — `auth.flow.start`/`submitCode`/`submitSecret` are not on the
ordinary surface, and a secret must never travel with a receipt. Those
operations are for the CLI/worker surfaces; nothing in this consumer is left
unresolved against them.

## 4. Open items owned elsewhere (desktop degrades honestly meanwhile)

- **Summaries/statistics are already projected** by the daemon
  (`aggregates/dto.ts`), so the desktop validates the published DTO instead of
  re-mapping rows: one canonical shape, and a row that does not match becomes a
  readiness diagnostic rather than a coercion.
- **Collection scheduler + discovery timer** (§2): without them `usage.summary`
  and `metering.statistic.*` have no rows, and the widgets show "no stored …".
- **Aggregate/statistic refresh** after collection commits, otherwise summaries
  stay `pending` (the UI shows the pending chip).
- **Credential-locator migration**: the desktop's legacy `usageAccounts`
  credential files under `<userData>/usage-accounts` should be imported through
  the auth worker's locator-import operation with those roots passed EXPLICITLY
  (never guessed by the daemon). Until it is exposed, those records stay visible
  as desktop-legacy cards and are not probed.
- **Resume support** is read per session (`session.get`/`session.handle.list`);
  the resume consumer (not this task) should use the same boundary instead of
  the desktop's `resumeSessions` state alone.
- **`registerDomainIpc()` wiring in `src/main/index.ts`** (assembler-owned):
  call it next to `registerRuntimeIpc()`. Until then the `domain:*` channels are
  not registered and the widgets show the store as unreachable.
