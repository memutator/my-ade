# 실제 Codex PTY/TUI 스폰 검사 — 2026-09-19

대상: main `12fb00d`. 사용자 요청에 따라 테스트만 수행, 제품 코드 수정 없음.

실행: `node packages/mahas-runtime/src/launch/real-codex-pty.manual.ts`
일반 `test:launch`에는 넣지 않는 수동/opt-in 테스트다. 로컬 Codex 설치와 인증이
필요하며 실제 모델 turn이 시작될 수 있다. TUI 첫 화면 관측 후 바로 종료한다.
로컬 `codex --help`로 interactive 인자 및 read-only/never 옵션을 확인했다.

## 결과

- **실제 PTY/TUI 스폰 PASS:** composeRuntime → worker.prepare/start → execution-host →
  설치된 `codex` (exec 서브커맨드 없음), stdio=pty, 110×32.
- host_processes/host_terminals 행 생성 및 terminal attach의 화면 snapshot에서
  `OpenAI Codex (v0.155.1)`, `model: loading`, `Ask Codex to do anything` 확인.
- **managed launch FAIL:** `joinState=process_confirmed:failed`,
  `ERR_SQLITE_ERROR: FOREIGN KEY constraint failed`. 테스트 종료 코드는 1이다.
- start-coordinator의 stageProcessConfirmed가 host terminalId를 executions.terminal_id에
  기록한다. 이 컬럼은 control DB terminal_records를 참조하지만 이 단계에서 대응 행을
  만들지 않는다. pipes 테스트는 terminalId가 없어 이 경계를 검사하지 못했다.
- 모델이 초기 지시를 읽었거나 답변했다는 검증은 하지 않았다. 출력된 첫 TUI frame과
  실제 살아 있는 프로세스만 확인했으며 join/accept 성공도 주장하지 않는다.

최종 관측 실행: execution-2a805323-8fdd-459c-8585-12a2f5d05445, pid 1535717.
관측 화면:

```text
>_ OpenAI Codex (v0.155.1)
model: loading /model to change
directory: /tmp/…/checkout
› Ask Codex to do anything
? for shortcuts
```

테스트 finally에서 해당 격리 host의 프로세스만 stop하고 host/runtime/DB를 닫은 뒤
테스트 소유 임시 디렉터리를 제거했다. 사용자 저장소·설정은 변경하지 않는다.
초기 테스트 recipe의 중복 `-c`는 테스트 코드에서 수정 후 위 TUI를 관측했다.
