// workbench/ResponsibilityView.tsx — 책임 탐색 (C-DISCOVERY, IMP-31 §4.1–2).
//
// The 팀장's query/path/contract/전문성 filters → responsibility.search.
// CandidateCards put 책임·기준·긴장 first; implementation availability and
// current member state are SEPARATE sections, and nothing auto-expands an
// implementation body (REQ-06 — coordination resolution only). Search rank
// is a reading order, never an assignee pick: the only forward action is
// "queue for assignment", which still needs preview + explicit assign.

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Compass, MapPin, Search, UserPlus, Users } from 'lucide-react'
import { useT } from '../i18n.ts'
import { workbenchCaller, opError, opErrorKind, type OpErrorKind } from './client.ts'
import {
  inspectResponsibility,
  listCollaborators,
  locateResponsibility,
  searchResponsibilities
} from './ops.ts'
import type {
  CandidateCard,
  Collaborator,
  InspectResult,
  LocateResult,
  SearchRequest,
  SearchResponse
} from './contracts.ts'
import { isStale, useWorkbench } from './store.ts'
import { ContextBar, Field, ListLines, OpError, Pill, Section } from './bits.tsx'
import { entryText } from './wire.ts'

const lines = (s: string): string[] =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean)

function AvailList({ items }: { items: CandidateCard['memberAvailability'] }): React.JSX.Element {
  return (
    <ul className="wb-lines">
      {items.map((a, i) => (
        <li key={i}>
          {a.state && <Pill>{a.state}</Pill>} {entryText(a)}
          {a.observedAt !== undefined && (
            <em className="wb-at"> · {new Date(a.observedAt).toLocaleTimeString()}</em>
          )}
        </li>
      ))}
    </ul>
  )
}

function Candidate({
  card,
  stale,
  onInspect,
  onQueue,
  queued,
  onCollaborators
}: {
  card: CandidateCard
  stale: boolean
  queued: boolean
  onInspect: () => void
  onQueue: () => void
  onCollaborators: () => void
}): React.JSX.Element {
  const t = useT()
  const uncovered = card.scopeCoverage?.uncovered?.length ?? 0
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
          {card.boundary.criteria.map((c, i) => (
            <li key={c.id ?? i}>
              {c.criterion}
              {c.description ? ` — ${c.description}` : ''}
            </li>
          ))}
        </ul>
      )}
      {card.relationshipRefs.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbRelations')}</span>
          <ListLines items={card.relationshipRefs} />
        </div>
      )}
      {card.matchReasons.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbMatchWhy')}</span>
          <ListLines items={card.matchReasons} />
        </div>
      )}
      {/* implementation availability vs current member state — different
          facts, different sections, neither implies the other */}
      {card.implementationAvailability.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbImplAvail')}</span>
          <AvailList items={card.implementationAvailability} />
        </div>
      )}
      {card.memberAvailability.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbMemberAvail')}</span>
          <AvailList items={card.memberAvailability} />
        </div>
      )}
      {card.scopeCoverage && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbCoverage')}</span>
          {card.scopeCoverage.summary && (
            <div className="wb-note">{card.scopeCoverage.summary}</div>
          )}
          {uncovered > 0 && (
            <Pill tone="warn">
              {t('wbUncovered')} · {uncovered}
            </Pill>
          )}
        </div>
      )}
      <div className="wb-card-a">
        <button className="wb-btn" onClick={onInspect}>
          {t('wbInspect')}
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
  const { projectId, modelVersion } = useWorkbench()
  const [res, setRes] = useState<InspectResult | null>(null)
  const [err, setErr] = useState<{ kind: OpErrorKind; msg: string } | null>(null)
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    let live = true
    inspectResponsibility(workbenchCaller(), {
      projectId,
      modelVersion,
      boundaryId,
      perspective: 'coordination'
    })
      .then((r) => live && setRes(r))
      .catch((e) => {
        if (!live) return
        const oe = opError(e)
        setErr({ kind: opErrorKind(e), msg: oe.message })
      })
    return () => {
      live = false
    }
  }, [boundaryId, projectId, modelVersion, epoch])

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
  const viewStatus =
    res.viewStatus ??
    (view && typeof view === 'object' ? view.status : view == null ? 'missing' : 'present')
  const missingView = viewStatus === 'missing' || view == null
  const clauses =
    view && typeof view === 'object' && Array.isArray(view.clauses) ? view.clauses : []
  return (
    <div className="wb-drawer">
      {missingView ? (
        // REQ-06: no authored coordination view — say so; never summarize
        // the boundary's implementation body on the fly
        <Pill tone="warn">{t('wbMissingView')}</Pill>
      ) : typeof view === 'string' ? (
        <div className="wb-resp">{view}</div>
      ) : (
        <div className="wb-sub">
          <span className="wb-sub-l">{viewStatus}</span>
          <ul className="wb-lines tight">
            {clauses.map((c, i) => (
              <li key={c.clauseId ?? i}>
                {c.requiredMeaning || c.clauseId}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="wb-resp">{res.boundary?.responsibility ?? res.responsibility}</div>
      {(res.boundary?.criteria ?? res.criteria).length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbCriteria')}</span>
          <ul className="wb-lines tight">
            {(res.boundary?.criteria ?? res.criteria).map((c, i) => (
              <li key={c.id ?? i}>
                {c.criterion}
                {c.description ? ` — ${c.description}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {res.children.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbChildren')}</span>
          {/* direct child responsibilities only — child context bodies stay
              out (contract: 모든 자식 context 본문 제외) */}
          <ul className="wb-lines tight">
            {res.children.map((b) => (
              <li key={b.id}>
                {b.name || b.id}
                {b.responsibilityStatement ? ` — ${b.responsibilityStatement}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {res.contractTensions.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbTensions')}</span>
          <ListLines items={res.contractTensions} />
        </div>
      )}
      {res.nonGoals.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbNonGoals')}</span>
          <ul className="wb-lines tight">
            {res.nonGoals.map((g) => (
              <li key={g.id}>{g.statement}</li>
            ))}
          </ul>
        </div>
      )}
      {res.roles.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">{t('wbRoles')}</span>
          <ul className="wb-lines tight">
            {res.roles.map((r) => (
              <li key={r.id}>
                {r.name} · {r.horizontalRoleName} — {r.description}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default function ResponsibilityView({
  onQueued
}: {
  onQueued?: () => void
}): React.JSX.Element {
  const t = useT()
  const { projectId, modelVersion, latestModelVersion, runId, queueCandidate } = useWorkbench()
  const assignQueue = useWorkbench((s) => s.assignQueue)
  const [query, setQuery] = useState('')
  const [paths, setPaths] = useState('')
  const [contractIds, setContractIds] = useState('')
  const [hRoles, setHRoles] = useState('')
  const [scopeBoundaryId, setScopeBoundaryId] = useState('')
  const [adv, setAdv] = useState(false)
  const [busy, setBusy] = useState(false)
  const [resp, setResp] = useState<SearchResponse | null>(null)
  const [err, setErr] = useState<{ kind: OpErrorKind; msg: string } | null>(null)
  const [inspectId, setInspectId] = useState<string | null>(null)

  const [locatePaths, setLocatePaths] = useState('')
  const [located, setLocated] = useState<LocateResult[] | null>(null)
  const [locateErr, setLocateErr] = useState<{ kind: OpErrorKind; msg: string } | null>(null)

  const [collabRoleId, setCollabRoleId] = useState('')
  const [collabs, setCollabs] = useState<Collaborator[] | null>(null)
  const [collabErr, setCollabErr] = useState<{ kind: OpErrorKind; msg: string } | null>(null)

  const req = (cursor?: string): SearchRequest => ({
    projectId,
    modelVersion: modelVersion || undefined,
    query: query || undefined,
    paths: lines(paths).length ? lines(paths) : undefined,
    contractIds: lines(contractIds).length ? lines(contractIds) : undefined,
    horizontalRoleNames: lines(hRoles).length ? lines(hRoles) : undefined,
    scopeBoundaryId: scopeBoundaryId || undefined,
    cursor
  })

  const runSearch = (cursor?: string): void => {
    setBusy(true)
    setErr(null)
    searchResponsibilities(workbenchCaller(), req(cursor))
      .then((r) => {
        setResp((prev) =>
          cursor && prev ? { ...r, candidates: [...prev.candidates, ...r.candidates] } : r
        )
        useWorkbench.getState().noteModelVersion(r.modelVersion)
      })
      .catch((e) => {
        const oe = opError(e)
        setErr({ kind: opErrorKind(e), msg: oe.message })
      })
      .finally(() => setBusy(false))
  }

  const runLocate = (): void => {
    setLocateErr(null)
    locateResponsibility(workbenchCaller(), {
      projectId,
      modelVersion: modelVersion || undefined,
      paths: lines(locatePaths)
    })
      .then((r) => setLocated(r.results))
      .catch((e) => {
        const oe = opError(e)
        setLocateErr({ kind: opErrorKind(e), msg: oe.message })
      })
  }

  const runCollabs = (roleId: string): void => {
    setCollabRoleId(roleId)
    setCollabErr(null)
    listCollaborators(workbenchCaller(), {
      projectId,
      modelVersion,
      roleId,
      runId: runId || undefined
    })
      .then((r) => setCollabs(r.collaborators))
      .catch((e) => {
        const oe = opError(e)
        setCollabErr({ kind: opErrorKind(e), msg: oe.message })
      })
  }

  const respStale = isStale(resp?.modelVersion, latestModelVersion)

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
              {t('wbStale')} · {resp?.modelVersion} → {latestModelVersion}
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
          </div>
        )}
        {err && <OpError kind={err.kind} message={err.msg} onRetry={() => runSearch()} />}
      </Section>

      {resp && (
        <Section
          title={`${t('wbCandidates')} · ${(resp.items ?? resp.candidates).length}${resp.status ? ` · ${resp.status}` : ''}`}
          right={
            <span className="wb-dim">
              model {resp.modelVersion}
              {resp.nextCursor ? ` · cursor` : ''}
            </span>
          }
        >
          {resp.candidates.length === 0 && <div className="wb-note">{t('wbNoResults')}</div>}
          {resp.unmatchedPaths.length > 0 && (
            <div className="wb-sub">
              <span className="wb-sub-l">{t('wbUnmatched')}</span>
              <ListLines items={resp.unmatchedPaths} />
            </div>
          )}
          {resp.ambiguityGroups.length > 0 && (
            <div className="wb-sub">
              <span className="wb-sub-l">{t('wbAmbiguous')}</span>
              <ListLines items={resp.ambiguityGroups} />
            </div>
          )}
          {resp.candidates.map((c) => (
            <div key={c.selectionToken}>
              <Candidate
                card={c}
                stale={respStale}
                queued={assignQueue.some((e) => e.card.selectionToken === c.selectionToken)}
                onInspect={() => setInspectId(inspectId === c.boundary.id ? null : c.boundary.id)}
                onQueue={() => {
                  queueCandidate(c, resp.modelVersion)
                  onQueued?.()
                }}
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
        {located?.map((r) => (
          <div key={r.path} className="wb-loc">
            <span className="mono wb-loc-p">{r.path}</span>
            {r.status === 'assigned' ? (
              <Pill tone="accent">
                {t('wbAssigned')} · {r.boundaryName ?? r.boundaryId}
              </Pill>
            ) : r.status === 'ambiguous' ? (
              <Pill tone="warn">{t('wbAmbiguous')}</Pill>
            ) : (
              <Pill tone="dim">{t('wbUnassigned')}</Pill>
            )}
            {r.roles?.map((ro) => (
              <span key={ro.id} className="wb-dim">
                {ro.name}
              </span>
            ))}
            {r.candidates?.map((b) => (
              <span key={b.id} className="wb-dim">
                {b.name || b.id}
              </span>
            ))}
          </div>
        ))}
      </Section>

      <Section title={t('wbCollab')}>
        <div className="wb-row">
          <Field label="role id" value={collabRoleId} onChange={setCollabRoleId} mono wide />
          <button
            className="wb-btn"
            onClick={() => runCollabs(collabRoleId)}
            disabled={!collabRoleId || !modelVersion}
          >
            <Users className="wb-ico" />
            {t('wbCollabBtn')}
          </button>
        </div>
        {collabErr && <OpError kind={collabErr.kind} message={collabErr.msg} />}
        {collabs?.map((c, i) => (
          <div key={`${c.roleId}-${i}`} className="wb-loc">
            <Compass className="wb-ico" />
            <span>{c.roleName ?? c.roleId}</span>
            <Pill>{c.relationReason}</Pill>
            {c.contractId && <span className="wb-dim mono">{c.contractId}</span>}
            {c.direction && <span className="wb-dim">{c.direction}</span>}
            {/* role-only rows are real too — an unassigned relation has no
                member address and the UI must not invent one */}
            {c.memberId ? (
              <Pill tone="accent">
                {c.memberId}
                {c.memberState ? ` · ${c.memberState}` : ''}
              </Pill>
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
