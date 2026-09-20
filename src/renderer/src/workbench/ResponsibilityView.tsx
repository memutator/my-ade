// workbench/ResponsibilityView.tsx — 책임 탐색 (C-DISCOVERY).
//
// The 팀장's query/path/contract filters → responsibility.search. A candidate
// card puts 책임·기준·긴장 first; published implementations and current member
// occupancy are SEPARATE facts (an implementation is not a running member and
// vice versa), and nothing expands an implementation body (REQ-06 —
// coordination resolution only). Search rank is a reading order, never an
// assignee pick: the only forward action is "queue for assignment", and a
// queued card still needs preview + an explicit assign (REQ-04).
//
// Every field rendered here is a field of the shared DTO (contracts.ts),
// shaped by the projections in view-model.ts. The view holds no private copy
// of a wire shape, so a server field that changes name cannot be papered over
// by a look-alike.

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Compass, MapPin, Search, UserPlus, Users } from 'lucide-react'
import { useT } from '../i18n.ts'
import { opError, opErrorKind, type OpErrorKind } from './client.ts'
import {
  inspectResponsibility,
  listCollaborators,
  locateResponsibility,
  searchResponsibilities
} from './ops.ts'
import type { CandidateCard, SearchRequest } from './contracts.ts'
import {
  ambiguityGroupText,
  contractTensionText,
  implementationAvailabilityRow,
  matchReasonText,
  memberAvailabilityRow,
  relationshipRefText,
  unmatchedPathText,
  type AvailabilityRow,
  type CollaboratorsViewModel,
  type InspectViewModel,
  type LocateViewModel,
  type SearchViewModel
} from './view-model.ts'
import {
  useAssignQueue,
  useModelHead,
  useScopeCaller,
  useWorkbenchActions,
  useWorkbenchContext
} from './scope.ts'
import { isResultStale } from './store.ts'
import { ContextBar, Field, OpError, Pill, Section, TextLines } from './bits.tsx'

const lines = (s: string): string[] =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean)

function Availability({
  rows,
  empty
}: {
  rows: AvailabilityRow[]
  empty: string
}): React.JSX.Element {
  if (!rows.length) return <div className="wb-note">{empty}</div>
  return (
    <ul className="wb-lines">
      {rows.map((row) => (
        <li key={row.id}>
          {row.state && <Pill>{row.state}</Pill>} <span className="mono">{row.label}</span>
          {row.detail ? ` — ${row.detail}` : ''}
          {row.observedAt !== undefined && (
            <em className="wb-at"> · {new Date(row.observedAt).toLocaleTimeString()}</em>
          )}
          {row.blockers.map((b, i) => (
            <Pill key={i} tone="warn">
              {b}
            </Pill>
          ))}
        </li>
      ))}
    </ul>
  )
}

function Candidate({
  card,
  stale,
  queued,
  inspecting,
  onInspect,
  onQueue,
  onCollaborators
}: {
  card: CandidateCard
  stale: boolean
  queued: boolean
  inspecting: boolean
  onInspect: () => void
  onQueue: () => void
  onCollaborators: () => void
}): React.JSX.Element {
  const t = useT()
  const coverage = card.scopeCoverage
  return (
    <div className="wb-card">
      <div className="wb-card-h">
        <span className="wb-card-name">{card.boundary.name || card.boundary.id}</span>
        {stale && <Pill tone="warn">{t('wbStale')}</Pill>}
        <span className="wb-card-role">
          {card.role.name} · {card.role.horizontalRole}
        </span>
      </div>
      {/* 책임·기준 first — the coordination-resolution read (REQ-06) */}
      <div className="wb-resp">{card.boundary.responsibility}</div>
      {card.boundary.criteria.length > 0 && (
        <ul className="wb-lines tight">
          {card.boundary.criteria.map((c) => (
            <li key={c.id}>
              {c.criterion}
              {c.description ? ` — ${c.description}` : ''}
            </li>
          ))}
        </ul>
      )}
      {card.relationshipRefs.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbRelations')}</span>
          <TextLines items={card.relationshipRefs.map(relationshipRefText)} />
        </div>
      )}
      {card.matchReasons.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbMatchWhy')}</span>
          <TextLines items={card.matchReasons.map(matchReasonText)} />
        </div>
      )}
      {/* implementation availability vs current occupancy — different facts */}
      <div className="wb-sub">
        <span className="wb-sub-l">{t('wbImplAvail')}</span>
        <Availability
          rows={card.implementationAvailability.map(implementationAvailabilityRow)}
          empty="no published implementation for this role"
        />
      </div>
      <div className="wb-sub">
        <span className="wb-sub-l">{t('wbMemberAvail')}</span>
        <Availability
          rows={card.memberAvailability.map(memberAvailabilityRow)}
          empty="no member occupies this role right now — that is an observation, not a queue"
        />
      </div>
      <div className="wb-sub">
        <span className="wb-sub-l">{t('wbCoverage')}</span>
        {coverage.matchedPaths.length > 0 && (
          <TextLines items={coverage.matchedPaths.map((p) => `path ${p}`)} />
        )}
        {coverage.matchedContractIds.length > 0 && (
          <TextLines items={coverage.matchedContractIds.map((c) => `contract ${c}`)} />
        )}
        {!coverage.coversScope && <Pill tone="warn">outside the requested scope</Pill>}
        {coverage.matchedPaths.length === 0 && coverage.matchedContractIds.length === 0 && (
          <div className="wb-note">matched by text only — no structural scope filter applied</div>
        )}
      </div>
      <div className="wb-card-a">
        <button className="wb-btn" onClick={onInspect}>
          {inspecting ? t('close') : t('wbInspect')}
        </button>
        <button className="wb-btn" onClick={onCollaborators}>
          {t('wbCollab')}
        </button>
        {/* queueing ≠ assigning — REQ-04 explicit assignment only */}
        <button className="wb-btn accent" onClick={onQueue} disabled={queued}>
          {queued ? t('wbQueued') : t('wbQueue')}
        </button>
      </div>
    </div>
  )
}

function InspectDrawer({ boundaryId }: { boundaryId: string }): React.JSX.Element {
  const t = useT()
  const call = useScopeCaller()
  const { projectId, modelVersion } = useWorkbenchContext()
  const head = useModelHead()
  const resolvedModel = modelVersion || head?.modelVersion || ''
  const [res, setRes] = useState<InspectViewModel | null>(null)
  const [err, setErr] = useState<{ kind: OpErrorKind; msg: string } | null>(null)
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    // inspect takes a modelVersion, not "whatever model we saw last":
    // resolve it from the server-declared head when no pin is set
    if (!projectId || !resolvedModel) return
    let live = true
    inspectResponsibility(call, {
      projectId,
      modelVersion: resolvedModel,
      boundaryId,
      perspective: 'coordination'
    })
      .then((r) => live && setRes(r))
      .catch((e) => {
        if (!live) return
        setErr({ kind: opErrorKind(e), msg: opError(e).message })
      })
    return () => {
      live = false
    }
  }, [call, boundaryId, projectId, resolvedModel, epoch])

  if (!resolvedModel) return <div className="wb-note">query first — the model is not pinned</div>
  if (err)
    return (
      <OpError
        kind={err.kind}
        message={err.msg}
        onRetry={() => {
          setErr(null)
          setEpoch((n) => n + 1)
        }}
      />
    )
  if (!res) return <div className="wb-note">{t('loading')}</div>

  const view = res.coordinationView
  return (
    <div className="wb-drawer">
      <div className="wb-sub">
        <span className="wb-sub-l">authored coordination view</span>
        {view.status === 'authored' ? (
          <>
            <TextLines
              items={(view.clauses ?? []).map(
                (c) =>
                  `${c.requiredMeaning}${c.deliveryClass ? ` [${c.deliveryClass}]` : ''}${c.clauseId ? ` (${c.clauseId})` : ''}`
              )}
            />
            {view.sourceInterfaces && view.sourceInterfaces.length > 0 && (
              <TextLines items={view.sourceInterfaces.map((s) => `source ${s}`)} />
            )}
          </>
        ) : (
          // REQ-06: an absent authored view is reported as itself; the UI
          // never summarizes the boundary's implementation body on the fly
          <Pill tone="warn">
            {view.status === 'not-requested' ? 'not-requested' : t('wbMissingView')}
          </Pill>
        )}
      </div>
      <div className="wb-resp">{res.boundary.responsibility}</div>
      {res.boundary.criteria.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbCriteria')}</span>
          <TextLines
            items={res.boundary.criteria.map((c) =>
              c.description ? `${c.criterion} — ${c.description}` : c.criterion
            )}
          />
        </div>
      )}
      {res.children.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbChildren')}</span>
          {/* direct child responsibilities only — child context bodies stay out */}
          <TextLines items={res.children.map((b) => `${b.name || b.id} — ${b.responsibility}`)} />
        </div>
      )}
      {res.contractTensions.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbTensions')}</span>
          <TextLines items={res.contractTensions.map(contractTensionText)} />
        </div>
      )}
      {res.nonGoals.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbNonGoals')}</span>
          <TextLines items={res.nonGoals.map((g) => g.statement)} />
        </div>
      )}
      {res.roles.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbRoles')}</span>
          <TextLines
            items={res.roles.map((r) => `${r.name} · ${r.horizontalRole} — ${r.description}`)}
          />
        </div>
      )}
      {res.contextRefs.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">context refs</span>
          <TextLines items={res.contextRefs} />
        </div>
      )}
      <div className="wb-note">
        perspective {res.perspective} · model {res.modelVersion} · snapshot {res.snapshotRevision}
      </div>
    </div>
  )
}

export default function ResponsibilityView(): React.JSX.Element {
  const t = useT()
  const call = useScopeCaller()
  const { projectId, modelVersion, runId } = useWorkbenchContext()
  const head = useModelHead()
  const { noteHead, queueCandidate } = useWorkbenchActions()
  const assignQueue = useAssignQueue()
  const resolvedModel = modelVersion || head?.modelVersion || ''

  const [query, setQuery] = useState('')
  const [paths, setPaths] = useState('')
  const [contractIds, setContractIds] = useState('')
  const [hRoles, setHRoles] = useState('')
  const [scopeBoundaryId, setScopeBoundaryId] = useState('')
  const [limit, setLimit] = useState('')
  const [adv, setAdv] = useState(false)
  const [busy, setBusy] = useState(false)
  const [resp, setResp] = useState<SearchViewModel | null>(null)
  const [err, setErr] = useState<{ kind: OpErrorKind; msg: string } | null>(null)
  const [inspectId, setInspectId] = useState<string | null>(null)

  const [locatePaths, setLocatePaths] = useState('')
  const [located, setLocated] = useState<LocateViewModel | null>(null)
  const [locateErr, setLocateErr] = useState<{ kind: OpErrorKind; msg: string } | null>(null)

  const [collabRoleId, setCollabRoleId] = useState('')
  const [collabs, setCollabs] = useState<CollaboratorsViewModel | null>(null)
  const [collabErr, setCollabErr] = useState<{ kind: OpErrorKind; msg: string } | null>(null)

  const req = (cursor?: string): SearchRequest => {
    const limitValue = Number(limit)
    return {
      projectId,
      modelVersion: modelVersion || undefined,
      query: query || undefined,
      paths: lines(paths).length ? lines(paths) : undefined,
      contractIds: lines(contractIds).length ? lines(contractIds) : undefined,
      horizontalRoleNames: lines(hRoles).length ? lines(hRoles) : undefined,
      scopeBoundaryId: scopeBoundaryId || undefined,
      cursor,
      limit: Number.isFinite(limitValue) && limitValue > 0 ? limitValue : undefined
    }
  }

  const runSearch = (cursor?: string): void => {
    setBusy(true)
    setErr(null)
    searchResponsibilities(call, req(cursor))
      .then((r) => {
        setResp((prev) =>
          cursor && prev ? { ...r, candidates: [...prev.candidates, ...r.candidates] } : r
        )
        // the server says which snapshot is current — the head is never
        // derived from the id's shape or order
        noteHead({
          modelVersion: r.modelVersion,
          snapshotRevision: r.snapshotRevision,
          declaredBy: 'search',
          current: !r.staleModel
        })
      })
      .catch((e) => setErr({ kind: opErrorKind(e), msg: opError(e).message }))
      .finally(() => setBusy(false))
  }

  const runLocate = (): void => {
    setLocateErr(null)
    locateResponsibility(call, {
      projectId,
      modelVersion: modelVersion || undefined,
      paths: lines(locatePaths)
    })
      .then((r) => {
        setLocated(r)
        noteHead({
          modelVersion: r.modelVersion,
          snapshotRevision: r.snapshotRevision,
          declaredBy: 'locate',
          current: !r.staleModel
        })
      })
      .catch((e) => setLocateErr({ kind: opErrorKind(e), msg: opError(e).message }))
  }

  const runCollabs = (roleId: string): void => {
    setCollabRoleId(roleId)
    setCollabErr(null)
    if (!resolvedModel) {
      setCollabErr({ kind: 'error', msg: 'query first — the model is not pinned' })
      return
    }
    listCollaborators(call, {
      projectId,
      modelVersion: resolvedModel,
      roleId,
      runId: runId || undefined
    })
      // the collaborators result carries no staleness signal of its own —
      // it declares no head
      .then(setCollabs)
      .catch((e) => setCollabErr({ kind: opErrorKind(e), msg: opError(e).message }))
  }

  const respStale = resp ? isResultStale(resp.modelVersion, resp.staleModel, head) : false

  return (
    <div className="wb-view">
      <ContextBar />
      <Section title={t('widgetWorkbenchFind')}>
        <Field
          label={t('wbSearch')}
          value={query}
          onChange={setQuery}
          placeholder={t('wbQueryPh')}
          wide
        />
        <div className="wb-row">
          <button
            className="wb-btn accent"
            onClick={() => runSearch()}
            disabled={busy || !projectId}
          >
            <Search className="wb-ico" />
            {t('wbSearch')}
          </button>
          <button className="wb-btn" onClick={() => setAdv(!adv)}>
            {adv ? <ChevronDown className="wb-ico" /> : <ChevronRight className="wb-ico" />}
            {t('wbFilters')}
          </button>
          {respStale && (
            <Pill tone="warn">
              {t('wbStale')}
              {head ? ` · ${resp?.modelVersion} → ${head.modelVersion}` : ''}
            </Pill>
          )}
        </div>
        {adv && (
          <div className="wb-adv">
            <Field label={t('wbPaths')} value={paths} onChange={setPaths} mono wide />
            <Field label={t('wbContractIds')} value={contractIds} onChange={setContractIds} mono />
            <Field label={t('wbHRoles')} value={hRoles} onChange={setHRoles} mono />
            <Field
              label={t('wbScopeBoundary')}
              value={scopeBoundaryId}
              onChange={setScopeBoundaryId}
              mono
            />
            <Field label="limit" value={limit} onChange={setLimit} mono />
          </div>
        )}
        {err && <OpError kind={err.kind} message={err.msg} onRetry={() => runSearch()} />}
      </Section>

      {resp && (
        <Section
          title={`${t('wbCandidates')} · ${resp.candidates.length} · ${resp.status}`}
          right={
            <span className="wb-dim">
              model {resp.modelVersion} · snapshot {resp.snapshotRevision}
              {resp.nextCursor ? ' · more available' : ''}
            </span>
          }
        >
          {resp.candidates.length === 0 && <div className="wb-note">{t('wbNoResults')}</div>}
          {resp.unmatchedPaths.length > 0 && (
            <div className="wb-sub">
              <span className="wb-sub-l">{t('wbUnmatched')}</span>
              <TextLines items={resp.unmatchedPaths.map(unmatchedPathText)} />
            </div>
          )}
          {resp.ambiguityGroups.length > 0 && (
            <div className="wb-sub">
              <span className="wb-sub-l">{t('wbAmbiguous')}</span>
              <TextLines items={resp.ambiguityGroups.map(ambiguityGroupText)} />
            </div>
          )}
          {(resp.diagnostics.rolelessBoundaryIds.length > 0 ||
            resp.diagnostics.unmatchedContractIds.length > 0) && (
            <div className="wb-sub">
              <span className="wb-sub-l">diagnostics</span>
              <TextLines
                items={[
                  ...resp.diagnostics.rolelessBoundaryIds.map((id) => `roleless boundary ${id}`),
                  ...resp.diagnostics.unmatchedContractIds.map((id) => `unmatched contract ${id}`)
                ]}
              />
            </div>
          )}
          {resp.candidates.map((c) => (
            <div key={c.selectionToken}>
              <Candidate
                card={c}
                stale={respStale}
                queued={assignQueue.some((e) => e.card.selectionToken === c.selectionToken)}
                inspecting={inspectId === c.boundary.id}
                onInspect={() => setInspectId(inspectId === c.boundary.id ? null : c.boundary.id)}
                onQueue={() =>
                  queueCandidate(
                    c,
                    resp.modelVersion,
                    isResultStale(resp.modelVersion, resp.staleModel, head)
                  )
                }
                onCollaborators={() => runCollabs(c.role.id)}
              />
              {inspectId === c.boundary.id && <InspectDrawer boundaryId={c.boundary.id} />}
            </div>
          ))}
          {resp.nextCursor && (
            <button className="wb-btn" onClick={() => runSearch(resp.nextCursor)} disabled={busy}>
              {t('wbMore')}
            </button>
          )}
        </Section>
      )}

      <Section title={t('wbLocate')}>
        <Field
          label={t('wbPaths')}
          value={locatePaths}
          onChange={setLocatePaths}
          placeholder={t('wbPathsPh')}
          mono
          wide
        />
        <button
          className="wb-btn"
          onClick={runLocate}
          disabled={!projectId || !lines(locatePaths).length}
        >
          <MapPin className="wb-ico" />
          {t('wbLocateBtn')}
        </button>
        {locateErr && <OpError kind={locateErr.kind} message={locateErr.msg} />}
        {located?.items.map((item) => (
          <div key={item.path} className="wb-loc">
            <span className="mono wb-loc-p">{item.path}</span>
            {item.status === 'resolved' ? (
              <Pill tone="accent">
                {t('wbAssigned')}
                {item.boundaryId ? ` · ${item.boundaryId}` : ''}
              </Pill>
            ) : item.status === 'ambiguous' ? (
              <Pill tone="warn">{t('wbAmbiguous')}</Pill>
            ) : (
              <Pill tone="dim">{t('wbUnassigned')}</Pill>
            )}
            {item.matchedPath && <span className="wb-dim mono">matched {item.matchedPath}</span>}
            {item.claimants.length > 0 && (
              <TextLines
                items={item.claimants.map(
                  (c) => `${c.boundaryName} ${c.claim}${c.relation ? ` (${c.relation})` : ''}`
                )}
              />
            )}
            {item.roles?.map((ro) => (
              <span key={ro.id} className="wb-dim">
                {ro.name}
              </span>
            ))}
            {item.reason && <span className="wb-dim">{item.reason}</span>}
          </div>
        ))}
      </Section>

      <Section title={t('wbCollab')}>
        <div className="wb-row">
          <Field label="role id" value={collabRoleId} onChange={setCollabRoleId} mono wide />
          <button
            className="wb-btn"
            onClick={() => runCollabs(collabRoleId)}
            disabled={!collabRoleId || !resolvedModel}
          >
            <Users className="wb-ico" />
            {t('wbCollabBtn')}
          </button>
        </div>
        {collabErr && <OpError kind={collabErr.kind} message={collabErr.msg} />}
        {collabs && collabs.collaborators.length === 0 && (
          <div className="wb-note">no related roles for {collabs.roleId}</div>
        )}
        {collabs?.collaborators.map((c) => (
          <div key={c.roleId} className="wb-loc">
            <Compass className="wb-ico" />
            <span>{c.roleName || c.roleId}</span>
            <Pill>{c.boundaryId}</Pill>
            <TextLines
              items={c.relationReasons.map(
                (r) =>
                  `${r.kind}${r.contractId ? ` · ${r.contractId}` : ''}${r.direction ? ` (${r.direction})` : ''}`
              )}
            />
            {/* an empty member list is a real answer — no invented address */}
            {c.members.length > 0 ? (
              c.members.map((m) => (
                <Pill key={m.memberId} tone="accent">
                  {m.memberId} · {m.state}
                </Pill>
              ))
            ) : (
              <Pill tone="dim">{t('wbRoleOnly')}</Pill>
            )}
          </div>
        ))}
      </Section>

      <div className="wb-foot">
        <UserPlus className="wb-ico" />
        {t('wbFootFind')}
      </div>
    </div>
  )
}
