# 통합 도메인·소스·문서 개편 — 현재 작업 기록

갱신일: 2026-09-20 (Asia/Seoul)

**상태 정정: 기능 통합 검증과 0.5.0 패키징은 완료했지만, 계획 A–G 전체 완료 판정은 철회한다. A–G 재대조에서 소스 리팩터링 외에도 CLI client 공통화, 증분 수집 수락 기준, Binding 관찰, 모델 alias 정정 전파, 호환 제거·문서 정합성의 잔여 항목을 확인했다. 상세 판정은 아래 단계별 감사 기록을 따른다. 패키지 실행 파일의 UI 34개 검사 통과는 구조 리팩터링 완료를 증명하지 않는다. 시스템 설치와 실제 provider 인증/API 검증은 미실행이며, 기존 작업 트리를 보존했으며, 사용자 요청에 따라 현재의 부분 완료 상태를 체크포인트로 저장한다.**

## 작업 지시와 워크트리

- 위치: `/home/pyosechang/projects/my-ade`, `main`, 기준 HEAD `f70a08c`.
- [milestone-plan.md](milestone-plan.md)의 A–G 전체가 범위다. 기존 tracked/untracked 변경을 보존했다. 전체 완료 선언 없이 현재 상태를 커밋·푸시하라는 후속 사용자 요청을 받았다.
- 최신 사용자 지시: `HANDOFF.md`를 읽고 마무리. 서브 에이전트는 **`devin/swe-2`, effort `max`**. rate-limit이 생기면 수를 점진적으로 줄이며 **`opencode-go/deepseek-v4.1-flash`, effort `max`**로 대체한다. 현재 대체 이력은 없다.
- 사용자가 병렬 인원 증가를 요청해 최대 6명에게 서로 다른 작업을 배정했다.
- `package.json`/lock은 이전 작업에서 이미 **0.5.0**으로 올렸고 [requirements/0.5.0.md](requirements/0.5.0.md)에 사용자 점검 항목을 작성했다. 첫 0.5.0 Debian/AppImage 배포 산출물을 생성했다. `dist/linux-unpacked`도 0.5.0이다. 이후 재패키징 시에는 새 버전으로 올려야 한다.
- 기본 규칙과 문서 진입점: [AGENTS.md](AGENTS.md), [도메인 지도](docs/architecture/domains/README.md), [검증 기록](docs/development/verification.md), [코드 지도](docs/development/code-map.md).

## A–G 재감사 결과

정본: [단계별 소스 대조](docs/development/milestone-audit.md). 2026-09-20에
parent가 A/F/G를, `devin/swe-2 effort:max` 읽기 전용 담당 3명이 B/C·E/D를
대조했고 parent가 주요 미완료 근거를 다시 확인했다. 감사 담당자는 모두 종료했다.

- A: 기본 계약·지원표·이관 지도는 있으나 공통 port/문서 정합성은 부분이다.
- B: 저장·배포·ready 기반은 있으나 CLI/desktop operator connection 해석 중복과 보존/GC 정책 연결·기록이 남는다.
- C: 원장까지 주경로는 있으나 OpenCode 전 key 재순회는 계획의 정상 증분 성능 기준과 차이가 있고, 삭제 row 관측 설명이 구현과 맞지 않는다.
- D: 인증·quota·hook 경로는 있으나 하네스 설정을 관찰해 Binding을 등록하는 production producer가 없다.
- E: 집계·통계는 있으나 유효기간이 정정된 모델 alias를 기존 귀속/집계에 전파하는 경로가 없다.
- F: 아래에서 확인한 구조 리팩터링을 포함해 부분 완료다.
- G: 전환 근거 대조·미사용 호환 제거·문서 정합성·수락 시나리오 대조가 남아 미완료다.

이 감사에서는 제품 코드를 변경하거나 실행 검사를 다시 하지 않았다. 0.5.0과 기존
검사 결과는 유효하지만 완성된 마일스톤의 증거로 확대하지 않는다.

## 소스 리팩터링 재대조 — 완료 판정 정정

사용자 지적 후 [단계 F](milestone-plan.md#단계-f--소비자-전환과-애플리케이션-구조-정리)를 실제 코드와 다시 대조했다.

- 확인한 분리: `shell/layout.ts`, `hydration.ts`, `effects.ts`; WidgetView의 feature/router 분리; FileTree의 파일 연산·tree 상태 분리; main의 platform IPC·state persistence 분리; Workbench 공통 DTO·view-model; maintenance 공통 codec.
- **F6 부분 완료:** terminal transport·링크·working/error 보조 로직은 분리했으나 `TerminalPane.tsx`의 mount effect에 xterm 수명과 PTY/agent 이벤트·세션 상태 처리가 함께 남아 있다. 해당 책임 경계를 마무리해야 한다.
- **F6 미완료:** usage/widget/tree 등 feature 스타일이 여전히 중앙 `styles.css`에 남아 있으며 `features/` 아래에는 별도 CSS가 없다. feature 소유 경계로 옮기는 계획이 남아 있다.
- **F10 부분 완료:** launch의 row/helper와 상태 전이·실패 분류는 분리했으나 `start-coordinator.ts` 안에 SQL 쓰기와 `workspace.prepare`/host 호출 등 실제 stage 효과 실행이 남아 있다. 단계 진행과 DB/effect adapter 분리를 마무리해야 한다.
- F5/F7의 저장 대상·debounce·hydration 전체 경계, F9의 공통 port/envelope 정리는 이번 짧은 재대조에서 전체 완료를 판정하지 않았다. 나머지 F/G 항목도 항목별 근거를 대조한 뒤 완료 처리해야 한다.

0.5.0 산출물과 기존 통과 기록은 유효하다. 이후 코드를 변경해 다시 패키징하면 새 버전이 필요하다. 서브 에이전트의 배정 작업 종료와 전체 계획 완료를 혼동하지 않는다.

## 이번 재개에서 해결한 통합 문제

### 사용량·세션 화면

- 공개 summary DTO가 null 그룹 축, 요청/실제 native model의 namespace/name, verified pool을 보존한다. UI는 정확한 rollup shape를 선택하여 중복 합산하지 않는다.
- 전체 합계는 목록과 별도로 `dimensionKeys: []` query로 읽는다. shape 제한은 SQL에서 paging 전에 적용한다. 제한된 하네스 목록을 전체 합계로 표시하지 않는다.
- Provider/Offering/요청 모델/실제 모델 분석과 검증된 pool의 관측 토큰 지분을 표시한다. 부분 목록은 표시하고, 그 상태에서 pool 바깥 잔여량을 완전한 값처럼 계산하지 않는다.
- summary/session/ledger 추가 페이지를 읽을 수 있고 집계 generation이 바뀌면 새로 읽는다. 제한된 세션 수와 비용을 전체 값으로 부르지 않는다.
- 저장 통계 3종(weekly-average, hourly-by-date, hour-of-day-distribution)을 표시한다. 미수집 기간의 값은 0이 아니라 unknown이다.
- canonical stored session과 live native ID의 join은 정확한 harness/native identity 및 namespace 또는 저장된 pane/tab 근거를 요구한다. cwd·접미사만으로 join하지 않는다. 실제 terminal target이 존재해야 한다.
- canonical detail을 bounded 조회하여 재개 가능 여부와 부모/자식 관계를 표시한다. 세션 클릭은 해당 workspace/pane/tab으로 이동하며 최소화된 대상도 복원한다.

### 인증·계정·quota

- 실제 daemon의 operator principal로 전용 인증 socket에 접속한다. 일반 receipt 경로에 raw secret을 넣지 않는다.
- 인증 채널에 durable workflow를 연결했다. API key/code/poll/callback 완료 후 credential·connection·identity claim·intent가 원자적으로 반영되어야 complete 결과를 돌려준다. 저장 실패는 재시도할 수 있고 반복 status/poll은 계정을 중복 생성하지 않는다.
- callback은 UI poll 없이도 저장을 마친다. shutdown은 진행 중 callback 작업을 기다린다. 명시적 패널 취소는 별도의 취소 동작이다.
- 새 관리 credential의 machine은 factory의 로컬 machine ID로 지정한다. `ownership: machine`과 `mahas-secret://` ref/provenance가 관리 저장소를 나타낸다.
- 등록된 Pack을 offering별로 선택하고, 진행 중 flow는 그 Pack revision으로 라우팅한다. 명시적 Pack pin과 모호성 거절을 유지한다. 복수 Pack 충돌·동시 시작 회귀 검사를 완료했다. Pack 간 flow ID 충돌은 start에서 거절해 기존 flow 소유권을 보존한다.
- 실제 desktop legacy usage-accounts root를 daemon에 전달하고 startup import를 활성화했다. import는 읽기 전용 locator credential과 connection을 등록하며 harness binding을 추정하지 않는다.
- passive import는 제거·adoption을 되돌리지 않는다. 외부 파일 metadata 변경만으로 동일 계정이라고 단정하지 않고 과거 credential/connection 이력을 분리한다. offering별 같은 경로의 분리 및 제거·adoption 이력 보존 회귀 검사를 완료했다.
- quota는 connection별 provider-api CollectionSource, 유일한 batch/observation, 정확한 Pack/credential revision evidence와 함께 원자적으로 저장한다. **coverage interval은 null**이며 polling 시간을 사용 시간으로 만들지 않는다.
- quota material/network IO는 DB queue 밖에서 실행한다. batch 범위를 회전하여 많은 계정도 굶지 않으며, 동시 tick은 합치고 종료 시 기다린다. 실패해도 마지막 성공값은 보존한다.
- quota probe는 poller가 선택한 `request.pack`을 그대로 사용하여 기록된 provenance와 실행 버전이 일치한다.
- 로그인 후 harness binding이 없는 connection도 화면에 표시한다. quota 새로고침은 `auth.quota.collect`를 신호한다.
- **파일 가져오기:** 선택한 파일과 offering은 `auth.locator.import`의 deferred prepare/commit으로 등록한다. 로컬 machine을 사용하고 Pack이 format을 결정한다. 실제 daemon에서 새 연결·재수입 멱등성·오류·제거 유지·비밀값 미저장을 검증했다. main/preload/renderer 연결과 packaged UI 검사까지 완료했다. 새 연결을 선택하며, 기존 legacy 표시의 중복을 숨기고 제거한 연결을 되살리지 않는다.

### 이벤트·재개·앱 수명·도구

- event ingest는 `committed: true`와 모든 요청 record key의 저장 ack를 확인한 뒤 attention으로 전달한다. chunk·부분 ack·overflow 경계를 검증했다.
- desktop state 저장은 직렬 atomic replace와 sync generation fence를 사용한다. 최종 shutdown resume record에 run/time 근거를 남기고, 종료 중 발생한 정확한 같은 run/pane/tab의 end만 제한된 시간 범위에서 재개 대상으로 취급한다. 명시적으로 종료한 세션은 다음 부팅에서 다시 제안하지 않는다.
- canonical resume refresh는 single-flight 및 UI 구독을 사용하고 실제 placement·세션별 cwd를 보존한다.
- E2E는 별도 HOME/XDG/config/events/icon cache 및 OS가 배정한 CDP port를 사용한다. `/proc` birth identity로 이 fixture가 만든 프로세스만 정리하고 종료 후 scratch를 삭제한다.
- 새 lifetime scenario는 minimize/restore/float의 동일 xterm DOM과 detach/reattach의 동일 PTY/agent를 확인한다.
- 서비스 bundle probe는 실제 ready 이벤트/CLI 버전을 요구한다. 빈 HOME/config/Pack root에서 실행하고 종료를 기다린다.
- 패키징 파일 목록은 `out/main`, `out/preload`, `out/renderer`, resources, package.json으로 제한했다. 서비스 bundle/Pack/PTY 모듈은 `extraResources`로 포함한다.
- 한 담당자의 emitting `tsc -b`가 source 옆에 생성한 비추적 `.js/.d.ts`는 정리했다. 이 파일이 TS를 가려 실제 Vite 오류를 일으켰다. **이후 검사는 root typecheck 또는 `--noEmit`만 사용한다.** 정당한 기존 declaration은 보존했다.

## 최종 검증과 배포 산출물

성공한 명령은 모두 exit 0을 확인했다. 전체 기록과 fixture별 범위는
[verification.md](docs/development/verification.md)에 있다.

| 검사 | 실제 결과와 로그 |
| --- | --- |
| `npm run test:domain:full` | **46 scripts pass**, `/tmp/mahas-domain-final-candidate.log` |
| 마지막 auth routing 회귀 검사 | **19 checks pass**, `/tmp/mahas-auth-routing-final.log` |
| root typecheck / lint | **pass**, `/tmp/mahas-final-types.log`, `/tmp/mahas-final-lint2.log` |
| 최종 docs / whitespace 검사 | **pass**, `/tmp/mahas-docs-release-final.log`; `git diff --check` exit 0 |
| boundary policy self-test | **17 pass**, `/tmp/mahas-boundary-final.log` |
| `npm run build:linux` | **pass**, `/tmp/mahas-release-0.5.0.log`; types, boundaries, docs, desktop/service bundle와 격리 boot 포함 |
| 실제 Electron→daemon→collector→preload→UI | **34 pass**, `/tmp/mahas-domain-ui-fileimport.log` |
| 0.5.0 패키지 실행 파일의 같은 UI 검사 | **34 pass**, `/tmp/mahas-packaged-ui-0.5.0.log`; 13개 fixture 프로세스 종료·scratch 정리 확인 |
| 배포 파일 검사 | **pass**, `/tmp/mahas-artifacts-0.5.0.log`; deb의 asar·서비스 3개·Pack manifest 9개가 검사한 unpacked tree와 동일 |
| 전체 기존 앱 E2E | **45/0**, `/tmp/mahas-resume-e2e-full.log`; 최종 auth/분석 UI 변경 전 shell snapshot |
| resume / lifetime 개별 E2E | **6/0**, `/tmp/mahas-resume-e2e-resume3.log`; **5/0**, `/tmp/mahas-resume-e2e-lifetime.log` |
| apt 설치 / 실제 provider 로그인·quota / 실제 사용자 로그 | **미실행**; synthetic 검증을 실제 vendor 호환성 확인으로 확대하지 않는다 |

산출물:

- `dist/mahas_0.5.0_amd64.deb` (100,070,840 bytes)
- `dist/mahas-0.5.0.AppImage` (130,213,138 bytes)
- `dist/linux-unpacked/mahas` — 실제 packaged UI 검사 대상
- 사용자 점검표: [requirements/0.5.0.md](requirements/0.5.0.md), 24개 항목
- 스크린샷: `/tmp/mahas-tokens-final-candidate.png`, `/tmp/mahas-tokens-packaged-0.5.0.png`

설치 명령:

```bash
sudo apt install --reinstall ./dist/mahas_0.5.0_amd64.deb
```

시스템 Node ≥24가 필요하다. Debian 설치 위치는 실제 패키지 기준
`/opt/Mahas`이며 `/usr/bin/mahas`가 이 실행 파일을 가리킨다.
소스·tools·docs·작업 트리는 asar에서 제외했고, production dependency와
런타임 resources는 포함했다. 소스 리팩터링의 잔여 범위는 위 정정 항목을 따른다.

## 현재 담당

모두 `devin/swe-2`, effort `max`로 실행했고, 최대 동시 6명이었다. 아래 담당자는 전원 인수인계 후 종료했다. rate-limit과 fallback 사용은 없었다.

| 담당 | ID | 범위 |
| --- | --- | --- |
| Newton (완료·종료) | `01a0bad6-9781-7243-9bb1-3fa572769704` | summary DTO/query, exact rollup, 분석 UI, 회귀 검사 |
| Dewey (완료·종료) | `01a0bad6-97c3-7512-8a0e-02b932d05e00` | offering별 인증/Pack/flow 라우팅 및 회귀 검사 |
| Ptolemy (완료·종료) | `01a0bad9-5d02-7b10-b159-d61092bb6c72` | 문서(verification/HANDOFF/requirements 제외) |
| Pascal (완료·종료) | `01a0bb1a-9bc1-7190-ba55-561196d602b9` | locator import 회귀 검사 및 service.ts import 구간 |
| Hume (완료·종료) | `01a0bb1a-9c1d-7e31-a659-234fb68c9f49` | 검사·runner·verification 문서 |
| Averroes (완료·종료) | `01a0bb23-2929-7ec2-a6ed-7729d19b9615` | 선택 파일의 canonical credential import |

Lagrange(`01a0bad6-9806-7ea0-8d5c-28a90d1915e7`)는 세션 join/UI 작업을 인계하고 종료했다. Parent는 통합 인증 workflow, quota provenance, TokensWidget, state/resume/event gate, 실제 UI/E2E, release와 파일 가져오기 runtime/main/preload를 담당해 완료했다.

## 계속 지킬 불변식

- Organization/Harness/Provider/Offering/Model identity는 독립적이다. 현재 Binding이나 이메일 일치를 과거 사용 귀속·pool 증거로 소급하지 않는다.
- unknown은 0이 아니고 observed token share는 quota 소진 지분이 아니다.
- mahasd는 control DB 단일 writer다. FS/network 효과를 transaction 밖에서 수행하고 필요한 사실/cursor/원장 commit은 원자적으로 처리한다.
- 저장된 원장·세션·진행 중 실행 pin은 원본 소실·Pack 갱신으로 삭제하거나 바꾸지 않는다.
- 외부/child 이벤트는 저장하되 사용자 알림과 구별한다. 세션 발견만으로 Task/Execution을 생성하지 않는다.
- stable pane portal, background mounted blocks, tab-record PTY lifetime, explicit split/stack, detach/move/minimize, preview tabs 및 pointer/webview 키 동작을 보존한다.
- 모든 fixture는 synthetic `/tmp` HOME/config/DB/Pack/credential을 사용한다. 실제 사용자 credential/provider API/세션 로그를 probe하지 않는다.
- 프로세스 정리는 정확한 소유·birth identity 근거를 사용한다. 포괄적인 `pkill node/electron`은 사용하지 않는다.
