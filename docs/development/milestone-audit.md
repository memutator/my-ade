# A–G 단계별 소스 대조

2026-09-20 사용자 지적 후 실시한 정적 대조다. 이전의 전체 완료 판정을 전제로 삼지 않는다.
이 감사에서는 제품 코드를 수정하거나 테스트를 다시 실행하지 않았다. 기존 실행 결과는
[verification.md](verification.md)에 있으며, 테스트 통과와 계획 항목 완료는 별개다.

판정: **구현 확인**은 해당 경로를 소스에서 확인했다는 뜻이며 모든 환경의 실행 보증이 아니다.
**부분**은 구체적 잔여 작업을 확인한 경우, **미확인**은 이번 대조에서 충분한 근거를 확보하지 못한 경우다.
기준은 [milestone-plan.md](../../milestone-plan.md) §5와 §9다.

## 단계별 결론

| 단계 | 결론 | 남은 핵심 |
| --- | --- | --- |
| A | 기본 산출물 있음, 정합성 부분 | 공통 port 복제 및 현행/역사/완료 문서 구분 정리 |
| B | 기반 구현, 공통화 부분 | CLI/desktop operator connection 해석 중복, 보존/GC 정책 연결·기록 |
| C | 핵심 경로 구현, 증분 수락 기준 부분 | OpenCode 전 key 재순회, row 삭제 관측에 대한 구현·설명 불일치 |
| D | 부분 | 근거 기반 Binding 관찰 producer 없음, capability 변경/실패 진단 일부 미확인 |
| E | 부분 | 유효기간을 정정한 모델 alias → 기존 attribution/aggregate 갱신 미연결 |
| F | 부분 | terminal/launch/persistence 책임 경계, feature CSS, 공통 port |
| G | 미완료 | 전환 대조, 미사용 호환 제거, 문서 정합성, 전체 수락 시나리오 근거 대조 |

전체 마일스톤 완료를 다시 선언할 근거가 없다. 코드가 없는 항목과 검증하지 않은 항목을
구분하며, 미확인을 미구현으로 단정하지 않는다. 자동 daemon 재기동처럼 계획에 명시되지
않은 추가 기능을 이 감사만으로 새 필수 작업으로 만들지 않는다.

## A — 계약·소유권·이관 기준

| 항목 | 판정 | 근거와 잔여 범위 |
| --- | --- | --- |
| A1 identity·공개 연산·query envelope | 구현 확인 | `mahas-contracts/src/catalog/index.ts`, `metering/index.ts:505`의 독립 identity와 coverage/freshness/watermark/unidentified 계약; domain operations·composition에 대응 구현이 있다. |
| A2 인터페이스 분류와 공통 계약 | 부분 | Workbench·hook 공통 DTO 및 legacy preload DTO 단일 정의는 확인. `maintenance/impact-service.ts:51`, `client/types.ts:28` 등에 Txn/handler/spec의 별도 복제 선언이 남는다(F9와 연결). |
| A3 capability 지원 목록 | 작성 확인 | `docs/integrations/capabilities.md`와 각 Pack manifest가 구현·조건부·미지원 범위를 구분한다. 실행 경로의 실제 일치 여부는 D에서 별도 판정한다. |
| A4 migration map·제거 조건 | 작성 확인 | `docs/plans/integration-migration-map.md`에 필드/소스별 목적지와 제거 조건이 있다. 실제 전환 완료 여부는 G와 별개다. |
| A5 문서 상태·정본 위치 | 부분 | user/architecture/integrations/development 구조는 존재하나 plans/decisions 등에 전체 완료를 단정한 문구가 남아 있어 이 감사로 정정한다. |

## B — 저장·서비스 소비 기반

| 항목 | 판정 | 근거와 잔여 범위 |
| --- | --- | --- |
| B1 catalog/inventory repository·ops·migration | 구현 확인 | catalog/inventory schema가 중앙 v1→v3 chain에 포함되고 seedBuiltinCatalog/ensureLocalMachine/설치 관측이 composition에 연결된다(`composition-domains.ts:72,132`). |
| B2 저장·backup/restore/GC | 저장·복구 구현, GC 정책 연결 부분 | 새 테이블이 중앙 migration과 전체 DB backup/restore에 포함된다. GC의 pin 대상도 확장되며 원장 row를 삭제 대상으로 삼지 않는다. 다만 `operations/gc.ts`의 planGc/runGc는 runtime 등록·호출이 없고, quota/event 상세 보존 정책의 완료 근거가 부족하다. 자동 삭제 기능을 새로 추가해야 한다는 뜻은 아니다. |
| B3 공통 인증 client | 부분 | desktop typed/generic op는 같은 authenticated client를 사용하고 CLI도 공통 RPC transport를 재사용한다. 그러나 CLI `connection.ts:108`과 `mahas-client/connection.ts:23`의 operator credential/connection 해석 경로는 별도로 남아 있다. worker/operator 역할 차이를 보존하며 공통 부분을 정리해야 한다. |
| B4 실행·Node·로그·ready·재접속 | 구현 확인·복구 범위 제한 | packaged service paths와 Node≥24 탐색, 로그, authenticated runtime.status/writableReady 판정, RPC session 재접속은 있다. 초기 bootstrap 이후 죽은 daemon을 자동 재기동하는 watchdog은 없다. 이는 확인한 복구 범위 제한이며, 계획이 자동 재기동까지 요구하는지는 별도 수락 기준으로 정해야 한다. |
| B5 desktop credential locator | 구현 확인 | desktop userData/usage-accounts 경로를 명시적 env로 전달하며 daemon이 Electron 경로를 추측하지 않는다. |
| B6 package typecheck·boundary | 구현·기존 실행 확인 | 모든 package program/entrypoint를 검사하고 resolved import policy를 적용한다. 이번 감사에서 다시 테스트하지 않았고 기존 pass는 verification 기록을 따른다. |


## C — Pack → 수집 → 원장

| 항목 | 판정 | 근거와 잔여 범위 |
| --- | --- | --- |
| C1 manifest/revision/schema/timeout/cancel | 구현 확인 | `integration/registry.ts:336` registration/digest/immutability, `runner.ts:121,209,345` schema·identity echo·timeout/AbortSignal/output cap, conformance semantic checks. |
| C2 공통 capability 실행 기반 | 구현 확인 | identify→discover-sources→collect가 scheduler의 동일 envelope/invoke 경로를 사용한다(`scheduler.ts:165`). |
| C3 Codex 증분 JSONL | 구현 확인 | source dev/ino/birth generation과 newline 확정 byte cursor, bounded readChunk, session/counter identity가 있다. collector는 감소 시 새 epoch를 표시하지만 core는 disjoint reset 근거가 없으면 unresolved로 보류한다. |
| C4 session/observation/collection 저장 | 구현 확인 | session/handle/attachment/alias/facet 및 source/cursor/batch/coverage/request 테이블과 commit normalization이 있다. |
| C5 atomic commit·CAS·replay | 구현 확인 | `commit.ts:240`의 단일 tx, batch replay, checkpoint CAS, reading/ledger/cursor 동시 commit; 실패/취소는 cursor를 전진시키지 않는다. |
| C6 원장·미귀속·저장 조회 | 구현 확인 | counted/duplicate/unresolved/superseded 상태, unidentified/freshness query envelope가 있고 조회가 원본 파일을 읽지 않는다. |
| C7 Claude/OpenCode 확장 | 부분 | Claude의 요청별 delta와 OpenCode mutable SQL row의 content revision 정정은 구현됨. OpenCode는 신뢰 가능한 update watermark 없이 모든 key를 bounded page로 매 sweep 재순회한다(`opencode/collector.mjs:8,293`). 제한된 1회 작업량은 보장하지만 계획 §9의 정상 증분 수집 시 기존 모든 record를 재해석하지 않는 기준과는 차이가 있다. |

추가 불일치: OpenCode collector 주석은 완료 sweep 뒤 runtime이 삭제 row를 비교한다고
설명하지만 해당 row 단위 비교 경로는 없다. scheduler의 `markMissing`은 원본 전체의
소실만 처리한다. 기존 사용 이력을 보존하는 것은 올바르며, 행 삭제 관측/coverage와
보존 정책을 일치시키고 지원 범위를 정정해야 한다.


## D — 인증·quota·기존 통합 이관

| 항목 | 판정 | 근거와 잔여 범위 |
| --- | --- | --- |
| D1 credential/connection/identity/Binding | 부분 | credential refresh CAS·계정 교체·connection 이력은 `inventory/repository.ts:378,422`, auth locator import에 구현됨. 그러나 `inventory.binding.put`은 registration/fixture 외 production 호출자가 없고 harness 설정을 관찰해 Binding을 만드는 producer가 없다. 로그인/import에서 Binding을 추정하지 않는 동작은 올바르며, 근거를 수집하는 별도 경로가 필요한 것이다. |
| D2 auth Pack·플랫폼 분리 | 구현 확인 | provider Pack의 auth coordinator, runtime의 per-offering driver·전용 socket, daemon-owned quota loop가 연결되어 있다. 실제 vendor 인증은 미검증이다. |
| D3 quota 이관·저장 | 구현 확인 | desktop fetcher는 stored projection이며 provider Pack의 9 offering probe와 connection별 최신/마지막 성공/실패 관측·pool claim 저장 경로가 있다. |
| D4 나머지 scanner 이관 | 이관 확인·증분성 추가 대조 | 7 collector Pack과 daemon scheduler 경로는 있다. Pack으로 파일을 이동한 사실만으로 각 collector의 bounded/incremental 기준을 충족했다고 판단하지 않는다(C 참고). |
| D5 identify/hooks/launch/resume/wake/maintenance | data 경로 이관 확인·등록 Pack 확장성 미확인 | 기존 runtime은 harness-runtime Pack의 JSON 선언을 공통 loader로 소비한다. 실행 entrypoint보다 builtin data 경로를 사용하는 live 소비자가 있어, 임의의 등록 Pack을 동일하게 선택하는지와 version pin 일치 여부는 별도 확인이 필요하다. |
| D6 durable hook ingest | 구현 확인 | `hook-ingest.ts`, `hook-stream.ts`, `agentEventIngest.ts`의 atomic commit/cursor와 all-record ack gate가 있고 알림 제외는 별도 정책이다. |
| D7 capability Check/Issue | 부분 | conformance op와 collection 실패는 Check/Issue를 기록한다(`composition-domains.ts:146`). installation revision 변경은 저장하지만 그 변경으로 검사를 연결하는 경로와 모든 capability 실행 실패의 Issue 연결은 확인하지 못했다. 새 revision은 unchecked로 두며 버전 변화만으로 파손을 판정하지 않는다. |
| D8 Pack 작성 skill | 구현 확인 | `.codex/skills/pack-authoring/SKILL.md`와 참조 문서가 계약 확인→조사→fixture/구현→검사→immutable revision 절차를 제공한다. 이 감사에서 skill을 실행한 것은 아니다. |


## E — 귀속·집계·시간 통계

| 항목 | 판정 | 근거와 잔여 범위 |
| --- | --- | --- |
| E1 항목별 귀속·모델·증거 | 구현 확인 | `commit.ts:563,592,671`에서 적용시점의 alias와 요청/실제 ModelRef·connection/Offering 근거를 처리하고 attribution revision을 저장한다. 관측되지 않은 requested model은 미확인으로 남긴다. |
| E2 counter/dedup/포함 관계 | 구현 확인 | 최초 누적 baseline은 all-time/time unknown, 감소·근거 없는 epoch 전환은 unresolved, included-by/corroborating은 duplicate; counter recompute intent가 있다(`counters.ts:155,220`). |
| E3 정정·change feed | 구현 확인 | 원장/귀속 revision 변경과 change feed가 같은 tx에서 저장된다. 집계는 기존 contribution을 빼고 새 contribution을 넣는다(`aggregates/service.ts:495,675`). |
| E4 저장 summary 축 | 구현 확인 | 정해진 dimensionSets와 generation별 summary 저장이 있으며 무조건적인 차원 Cartesian product를 만들지 않는다. |
| E5 시간 bucket·미배분 | 구현 확인 | 사용시각과 관측시각을 구분하며 point/interval/unknown, hour/day/week 및 경계를 넘는 interval의 미배분량을 보존한다. |
| E6 최근 완결 4주 평균 | 구현 확인 | 월요일·사용자 시간대·완결 4주와 관측 0/미수집 unknown/유효기간 분모가 구현되어 있다. |
| E7 시간대 통계 | 구현 확인 | hourly-by-date/hour-of-day-distribution과 선택 등록 가능한 hourly average가 있고 관측 occurrence를 분모로 사용한다. |
| E8 지연·정정·alias·rolling·rebuild | 부분 | late arrival/원장 정정, 매 scheduler refresh의 rolling 통계, bounded generation rebuild·atomic publish는 구현됨. **alias 정정 전파는 미연결**: `catalog/operations.ts:156`은 resolution과 event를 저장하지만 적용 기간에 해당하는 기존 usage attribution을 다시 산출하거나 ledger change를 만드는 소비자가 없다. `aggregates/ledger-source.ts:175`는 ledger change와 pool-claim digest만 추적한다. |

Alias 수정은 모든 과거 기록을 현재 매핑으로 바꾸라는 뜻이 아니다. 명시적으로 정정된
유효 기간과 근거에 해당하는 기존 항목을 bounded 재귀속하고, 원장 변경 경로를 통해
집계에 반영해야 한다. 현재 내부 reviseUsageAttribution 함수는 있으나 이 연결이 없다.


## F — 소비자·구조 리팩터링

| 항목 | 판정 | 근거와 잔여 범위 |
| --- | --- | --- |
| F1 도메인 소비자 전환 | 부분 | usage/session UI와 resume의 domain 경로는 연결되어 있다. `attention.ts:109` 등은 desktop `agentSessions`를 읽으며 resume/agent map의 쓰기도 계속된다. 이것이 정당한 UI placement인지 남은 domain 중복인지 필드별 종료 기준을 확정해야 한다. |
| F2 DTO 중복 정리 | 주요 대상 구현 확인 | Workbench는 shared operations 재노출, hook은 shared type, legacy usage/ledger는 preload의 한 정의를 main/renderer가 재사용한다. transport DTO와 domain object는 의미가 달라 동일 타입으로 강제 병합하지 않는다. |
| F3 Workbench 계약·mapper | 구현 확인 | `workbench/contracts.ts`, `view-model.ts`, shared `operations/` DTO 및 inspector contract smoke. |
| F4 Workbench scope | 구현 확인 | `scope.tsx`, `WidgetWorkbench.tsx`, project/run queue와 current-head 비교. 여러 mount가 단일 context를 덮어쓰던 경로를 분리했다. |
| F5 shell state/effect/hydration | 부분 | layout·OS effect·pane 정규화는 분리했으나 `store.ts:125`의 hydrate 안에 resume migration/pruning이 남는다. |
| F6 feature 분리 | 부분 | Widget router와 FileTree operations/state, terminal transport/link/pulse/error 분리는 확인. `TerminalPane.tsx:102`의 큰 mount effect는 xterm 수명과 세션 이벤트를 함께 소유하고, feature CSS는 중앙 `styles.css`에 남는다. |
| F7 persistence 경계 | 부분 | main의 직렬 atomic writer와 IPC는 분리했으나 snapshot 필드 선택·debounce·종료 flush는 `App.tsx:90`, load는 `main.tsx`, hydration은 store/shell에 흩어져 있다. |
| F8 shell/managed transport | 구분 구현·전체 UI 미확인 | `features/terminal/transport.ts`는 shell PTY만 사용하고 managed bridge는 `runtimeClient.ts`의 exec 경로다. managed terminal UI의 모든 attach/detach 소비 경로는 별도 검증이 필요하다. |
| F9 공통 port/envelope | 부분 | canonical registry/handler-ports는 있으나 maintenance/client 등에서 TxnContext·OperationSpec·Handler의 구조 복제가 남는다. hash/JSON 통합은 바이트 규약 대조 없이 완료 처리하지 않는다. |
| F10 runtime 책임 분리 | 부분 | maintenance codec, launch row/transition helper는 분리됨. `start-coordinator.ts`의 SQL 쓰기·workspace.prepare·host 호출은 여전히 coordinator 안에 있다. |

## G — 전환 완료·호환 제거·문서 정합성

| 항목 | 판정 | 근거와 잔여 범위 |
| --- | --- | --- |
| G1 source/capability별 전환 marker | 부분 | 실행 세션 backfill progress table과 desktop import provenance는 있다. renderer `resume.ts:178`의 importMarker는 메모리이며 공개 import-state helper의 소비자가 없다. 전체 source/capability의 전환 대조·완료 근거표는 없다. |
| G2 중복 writer·미사용 호환 제거 | 부분 | desktop scanner와 provider fetcher는 제거됐다. `window.mahas.usage.*`를 사용하는 현재 제품/도구/패키지 call site는 검색에서 없지만 main `usage.ts`, `usageAuth.ts`와 preload의 구형 IPC가 계속 등록되어 있다. 사용처·지원 계약을 확인해 정리해야 한다. |
| G3 신규/업그레이드/rollback | 부분 검증 | synthetic DB fresh/v1 upgrade/backup/rollback와 packaged 실행은 검사했다. 설치 후 기존 실제 프로필 upgrade는 검사하지 않았다. 안전한 fixture 기반 전체 이전 버전 프로필 전환 수락 검사도 별도 대조가 필요하다. |
| G4 문서 정합성 | 부분 | 링크 검사는 통과했으나 plans/decisions의 전체 완료 선언, 현재 코드와 어긋난 상태 설명이 발견됐다. 링크 유효성은 내용 정합성의 증거가 아니다. |
| G5 수락 시나리오·패키징 | 부분 | 0.5.0 패키징과 기록된 테스트는 유효하다. §9 각 시나리오에 대한 최종 근거 대조가 없고 F의 확인된 잔여 작업이 있으므로 전체 완료가 아니다. |

## 검증 범위

기존의 46개 domain script, 마지막 auth 19 checks, built/packaged UI 각 34 checks,
타입·린트·경계·문서·패키징 성공은 [검증 기록](verification.md)을 따른다.
이는 실제 vendor API 호환성, native file-picker 조작, 시스템 설치, 모든 이전 프로필 업그레이드의 증거가 아니다.
