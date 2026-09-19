# Launch 및 task lifecycle 후속 회귀 검증 — 2026-09-19

대상: `24c983f` 이후 후속 WIP. 정식 REV/VER 전체 수락을 대체하지 않는다.
Claude 검증은 사용자 지시로 제외했으며 pass로 집계하지 않는다.

## 종료 판정

**최소 task lifecycle 경로: PASS, 이번 후속 작업 종료.** 2026-09-19 종료 시
`npm run test:launch` 전체를 다시 실행해 PASS를 확인했다.
F-062/F-063/F-064와 workspace 준비 gate 결함은 아래 검증 경계에서 닫는다.
이는 준비된 task assignment → 실제 worker spawn → 초기 입력 → 인증 → join → accept →
실제 계산 → task.report → accepted 정산 → 프로세스 종료 → worker.stop → worker.release와
검증한 실패/재호출 안전성을 확인한다. LLM 활용 품질 평가나 제품 전체 수락은 아니다.
아래 범위 밖 항목은 알려진 제한/backlog이며 이번 완료 조건에 자동 편입하지 않는다.

## 재실행

`npm run test:launch`는 새 임시 디렉터리와 migrate된 SQLite DB에서 다음을 실행한다.
모델을 호출하지 않으며 기존 `/tmp/mahas-ver-11` fixture나 운영 데이터에 의존하지 않는다.

| 스크립트 | 검증 경계 |
|---|---|
| `access/f062-assignment-service.smoke.ts` | run-scoped prepare-only grant, 내부 service context.build, 다른 run 거부, member 직접 context.build 비노출 |
| `launch/workspace-gate.smoke.ts` | 준비 실패/불명확 결과를 성공으로 간주하지 않음, 잔여 claim 보존, 후속 실행 차단 |
| `launch/f064-recovery.smoke.ts` | 오류 주입 5건: 재시도 가능 materialize 실패, 확정 materialize 실패, 확정 spawn 거부, spawn 응답 유실, 구버전 실패 receipt 회수 |
| `launch/launch-host-integration.smoke.ts` | 실제 host/runtime/lease/workspace/OS 프로세스, stdin 원문 일치, 인증→join→accept→계산→report→정산→stop/release, start/accept/report replay 중복 방지 및 물리적 정리 |

경로 기준은 `packages/mahas-runtime/src/`이다.

실행 결과: 위 4개 스크립트 모두 PASS. 추가로 registry smoke 40 passed / 0 failed,
루트 `npm run typecheck`, runtime/host 각각 `tsc --noEmit -p <package>/tsconfig.json`,
변경 TypeScript 파일 `eslint --quiet`, `git diff --check` 통과.

## 작업 완료·정리의 구체적 증거

- 실제 자식 프로세스가 stdin에서 `Compute 17 + 25`를 읽고 계산한다.
  같은 worker 인증 연결로 `task.report`를 호출하며 결과가 DB에 `succeeded`,
  `Computed result: 42`로 저장된다. controller가 대신 결과를 보고하지 않는다.
- owner-declaration 정책으로 outcome 1건에 accepted settlement 1건이 저장되고,
  dispatch phase/authority가 settled, task의 current_dispatch_id는 NULL이다.
  같은 operation ID의 report 재호출은 동일 결과/event cursor이며 outcome을 추가하지 않는다.
- host에서 실제 프로세스 exit를 확인한 뒤 공개 worker.stop을 호출한다.
  execution liveness=exited, 살아 있는 execution credential 0개, member 바인딩 NULL을 확인한다.
- stop 후에도 실제 claim이 남아 있음을 확인하고 공개 worker.release에 그 revision을 전달한다.
  dirtyDecision=discard는 테스트가 소유한 임시 checkout에만 적용한다.
  claim 모두 released, workspace released, 실제 checkout 디렉터리 부재를 함께 확인한다.
  테스트 finally의 임시 root 삭제는 이 검증 뒤에 실행되며 성공 증거로 사용하지 않는다.
- composeRuntime이 요구하는 선행 controller epoch는 fixture에서 durable row로 제공한다.
  실제 lease/controller epoch/worker credential 검사를 비활성화하지 않는다.

## 변경 근거

- workspace.prepare 호출 자체의 성공과 내부 workspace/effect의 성공은 다르다.
  ready/confirmed 확인 없이 checkout 경로만으로 spawn하면 없는 cwd로 ENOENT가 발생한다.
- 재시도 가능한 pre-spawn 실패에서는 같은 execution/dispatch를 유지한다.
  확정 실패는 프로세스가 없다는 durable evidence가 있을 때만 member/dispatch/credential을
  회수하고, 그 receipt가 다시 실행을 살리지 못하도록 표시한다. 응답 유실은 회수하지 않는다.
- 초기 입력은 content-addressed envelope body를 실제로 읽고 실행별 join/accept pins를
  포함한다. 통합 worker는 controller가 별도로 넘긴 pins가 아니라 실제 stdin만 사용한다.
  `task/envelope.json`은 원래 envelope를 유지하고 bootstrap 정보는 `task/initial.txt`에 둔다.

## 증거의 한계와 남은 범위

- gate/복구 스크립트의 오류 주입은 host/materializer 대역을 사용한다.
  정상 통합은 실제 OS 프로세스를 사용하지만 프로세스는 결정적 Node worker이며 LLM이 아니다.
- assignment fixture를 직접 seed하므로 team.assign부터 시작하는 전체 사용자 흐름은 아니다.
- 통합은 task assignment + 명시적 argv role 파일/stdin initial 입력 경로다.
  모든 provider, native-preload/native resume, PTY/UI, crash/restart 조합을 검증한 것은 아니다.
- F-065(실패 plan의 동일 입력 replan identity)는 이번 변경에서 해결하지 않았다.
- 기존 finding 전체의 영향 리뷰 및 동일 revision의 REV/VER 정산은 전체 RELEASE 시
  별도 작업이며 이번 최소 task lifecycle 검증의 종료를 막지 않는다.
