# 기반 seam 사전 점검 — IMP-01 (오케스트레이션 메모, 정식 REV 아님)

- **codeRevision:** `f318e3e` (IMP-01) + 작업트리 상태 @ 2026-09-18 20:15
- **specRevision:** `99eb5f5`
- **성격:** 모든 IMP/REV/VER의 뿌리인 IMP-01 seam의 조기 점검. REV-01~08은
  IMP-01을 입력으로 요구하지 않으므로 이것은 팀장 수준의 sanity check다.
  정식 review/verification 기록으로 집계하지 않는다.

## 점검 결과 — instruction §4 대조

| 요구 | 위치 | 판정 |
|---|---|---|
| §4.2 package 경계 의존 방향, renderer→runtime repo 차단 | `eslint.config.mjs` `no-restricted-imports` 블록 + renderer는 `import type`만 (`src/renderer/src/types.ts` L1) | ok — lint fail로 강제됨 |
| §4.3 일반 터미널 경로 유지 + managed execution은 runtime client 경유 | `exec:*` IPC (`src/main/runtimeClient.ts` L108–156) ↔ 기존 `pty:*` 무변경 | ok — feature boundary 명확 |
| §4.4 pane/tab → Execution/Terminal identity 바인딩 포트, 과거 세션 retro-claim 없음 | `TerminalTab.binding?: ExecutionBinding` + `exec:bindView`/`unbindView` | ok — binding은 control plane이 설정하는 별도 identity |
| §4.5 readiness/endpoint 인터페이스 + 종료 요청 포트 export, lease/수명은 IMP-17/23 주입 | `bootstrapRuntime`/`RuntimeHandle`/`sessionFactory` 주입점 + `requestRuntimeShutdown` | ok |
| §6 인계물: bootstrap.ts + runtime-client 포트 / execution-host entrypoint 껍질 / migration seam 파일 대응표 | `packages/README.md` "Migration seam" 표 — 기존 호출 위치→seam 매핑 존재 | ok |

## 실행 evidence (근거 수준: typecheck/lint, 제품 실행 아님)

- `npm run typecheck` — pass (node + web)
- `npm run lint` — pass (경계 규칙 포함)
- 미실행: execution-host socket 실제 통신, mahasd 부재 시 desktop UI 동작 —
  IMP-17+ 이후 VER 범위.

## 관측·후속 세션을 위한 메모

1. `unavailableClient`가 모든 op에 `CONTROL_UNAVAILABLE`(retryable)를 반환 —
   honest seam. IMP-17이 `sessionFactory`를 주입하면 `resolvedClient` 프록시가
   async 세션 협상 뒤 실제 client로 교체되는 구조 (bootstrap.ts L176–185).
2. `probeEndpoint`는 TCP endpoint의 `host:port` 파싱에 `lastIndexOf(':')` 사용 —
   IPv6 endpoint `[::1]:7777`은 오파싱됨. v1은 local unix socket만 (REQ-28)이라
   실질 위험 낮음 — IMP-17이 tcp를 실사용하면 확인.
3. `bootstrapRuntime`은 fire-and-forget `refresh()`를 부팅 시 호출 — socket이
   존재하면 'degraded'. 소켓 잔재(stale socket 파일만 있는 상태)와 실제 리스너를
   connect로 구분하므로 판정은 정직.
4. **`packages/SHARED-APIS.md`(untracked, 조정자 계약)** — IMP-03/10/11/12/17의
   고정 시그니처를 명시. 이 워크트리에서 구현 세션들이 진행 중인 근거. 리뷰 시
   이 파일의 시그니처가 실제 코드로 구현됐는지 대조 기준으로 사용.
5. `exec:*` IPC는 renderer가 임의 호출 가능 — operationId 유무만 검증. 인가는
   IMP-10/11 책임이므로 현 단계 문제 아님.

**결론:** IMP-01 seam은 instruction 대비 충실하고 후속 Task가 올라탈 기반이
성립한다. downstream 차단 결함 없음.
