# Workbench scope mount — interface record

Status: **landed**. `src/renderer/src/components/WidgetView.tsx` (usage-worker
owned) already renders the workbench surfaces through the wrapper, and the
legacy module-level workbench store is gone. This file records the boundary
between the two areas and the items that still belong to other boundaries.

## The mount (as landed)

```tsx
import WidgetWorkbench, { isWorkbenchWidget } from '../workbench/WidgetWorkbench'
// …
isWorkbenchWidget(tab.widget) ? (
  <WidgetWorkbench widget={tab.widget} projectId={projectId} />
) : ( /* usage / tokens / agents */ )
```

`modelVersion` and `runId` are deliberately NOT props: the 팀장 edits those pins
in the view's own context bar, and a hosting component must not pin them. The
wrapper exports the component and the kind guard from one module so the host
needs a single import.

## What the scope guarantees

- **One scope per mounted widget** (`workbench/store.ts` factory, opened by
  `workbench/scope.tsx`). Editing the project/model/run in one widget never
  touches another widget's queries — the old module singleton was written by
  whichever widget mounted last and read by every other one.
- **Incompatible context reset**: moving the project, the run or the model pin
  drops the other pins and resets the model head, so a pin from another
  project can never travel into a new one.
- **Queue per project/run** (`workbench/queues.ts`): the find widget and the
  assign widget of the same project/run share one queue; another project or
  another run sees nothing, and switching away and back restores that run's
  own queue.
- **No opaque-id ordering** (`store.ts` → `isResultStale`): the model head is
  whatever the _server_ most recently declared current (`run.get` names the
  run's pinned model; a discovery response with `staleModel === false` names
  the project's active model). A response that declares itself behind the head
  never moves it, and nothing ever compares two modelVersion strings.
- **Fixtures**: `node src/renderer/src/workbench/store.smoke.ts` — 20 checks
  over isolation, incompatible reset, head semantics, queue handoff and the
  request-payload grammar (synthetic data only).

## Inspector contract alignment — CLOSED

The four divergences between the shared DTOs and the registered handlers are
resolved in the contracts and the runtime, not papered over in the renderer.
The canonical shape is now the handler projection, and every consumer reads
one shape:

| operation          | canonical DTO (now)                                                                                                                                                                                                                      | handler                                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interface.get`    | `{interface, digest, contextRequirements, maintenanceRefs: InterfaceMaintenanceRef[], modelStatus}`                                                                                                                                      | `realization/interfaces.ts` returns the DTO type directly; `maintenanceRefs` is the model-derived ref (new `InterfaceMaintenanceRef` in `role.ts`), not an implementation `MaintenanceBinding`     |
| `surface.describe` | `{surfaceDigest, stale, operations: SurfaceOperationDescriptor[]}`                                                                                                                                                                       | `api/surface.ts` re-exports the shared descriptor/result; the CLI and the inspector read the descriptor list                                                                                       |
| `access.inspect`   | `{memberId?, grantId?, policy?, effectiveActions, grants: GrantInspectSummary[]}`                                                                                                                                                        | `access/operations.ts` returns the DTO; one subject per call and each grant row carries its own `status`/`expiresAt`/`revokedAt`/`scopeSummary`, so the parallel expiry/revocation arrays are gone |
| `worker.inspect`   | flat `{executionId, memberId, generation, hostId, launchPlanId, planDigest?, phase, liveness, terminalId, processEvidence, probe?, joined, taskAuthority, injectionReceipts, stageReceipt, residuals, failedStage?, nextAllowedActions}` | `launch/start-coordinator.ts` already returned this; the DTO now describes it (including the optional `probe` input)                                                                               |
| `context.inspect`  | `{executionId?, memberId?, launchPlanId?, bundleDigest, pins, planned, attached, inherited, missing, unknowns, sourceObservations?, manifestDigest?}`                                                                                    | `realization/effective-context.ts` `EffectiveContextReport`                                                                                                                                        |
| `worker.prepare`   | `{launchPlanId, digest, state, existing, pins, processSpec, plannedSurface, requiredComponents, reservations, blockers}`                                                                                                                 | `launch/planner.ts` `PrepareResult`                                                                                                                                                                |

The renderer `inspector-lanes.ts` maps these DTOs directly — no alias reading,
no fallback field names, no facade cast. The runtime `inspector/views.ts`
projections were updated to the same shapes, and
`packages/mahas-runtime/src/inspector/inspector-contract.smoke.ts` (37 checks,
synthetic data) asserts the DTO fields against the real `interface.get` handler
plus the projection functions, so a rename on either side fails there.

Two declaration notes left as-is because they are operation metadata, not
shapes: `interface.get` is registered `mutation: true` (it stores a
content-addressed snapshot), and `worker.inspect` honours `probe` — now part
of the DTO, sent by the workbench only when the 팀장 ticks the box.

Everything else the workbench consumes already matched:
`responsibility.{search,inspect,locate,collaborators}`, `role.implementations`,
`run.get`, `plan.prepare` (`unresolvedInputs: PendingInput[]`), `plan.commit`,
`assignment.preview`, `team.assign`.

## Docs follow-up (docs workstream, not edited here)

Two lines written while the workbench was mid-migration are now stale:

- `docs/architecture/contracts/README.md` → "DTO duplication is still real …
  the renderer Workbench types in `src/renderer/src/workbench/` are
  mid-migration": the workbench now re-exports the canonical operation DTOs
  (`workbench/contracts.ts` declares no wire shape of its own), so the
  workbench entry belongs on the "consumer switched" side.
- `docs/development/code-map.md` → "workbench views (mid-migration to common
  DTOs)": the pointer stays, the parenthetical no longer applies.

The durable rule the workbench now follows: reads pass through
`workbench/view-model.ts` (canonical DTO → view model), writes use the
contract request DTOs verbatim, and the registered-handler divergences listed
above are named in `view-model.ts` instead of being guessed.
