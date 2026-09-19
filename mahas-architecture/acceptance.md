# mahas 수락 기준

문서 ID: ACC · 상태: 제품 구현/실행 수락 전

## 사용 시점과 판정 주체

팀장은 계획을 배정할 때 관련 AC ID를 연결한다. 구현자는 자기 Task의 요구사항과 spec으로 구현하고, 아래 정식 판정은 review-plan/verification-plan 담당자가 수행한다. 각 AC는 해당 구현 revision·설정·실행 evidence와 묶어 판단한다. 이 문서 작성 또는 문서 링크/DDL 파싱 성공은 제품 수락이 아니다.

## 최종 수락 조건

필수 AC가 동일 code/spec revision에서 충족되고 REV-08의 결합 검토와 VER-12의 증거 정리가 완료돼야 한다. 미실행/미지원은 pass가 아니다. 외부 비용·실제 하네스 실행은 허용된 계정·환경에서만 수행한다. 발견된 결함은 원래 IMP owner의 수정 revision으로 돌리고 영향받는 review/verification을 반복한다.

### AC-01 — 책임별 판단과 결합

요구사항: REQ-01 · 실행 증거: [VER-11](verification-plan/tasks/VER-11/instruction.md) · 검토: [REV-08](review-plan/tasks/REV-08/instruction.md)

**조건:** 서로 다른 역할과 상위 조율자가 배정된 Run.

**행동:** 당사자가 직접 협의·판단하고 팀장은 관계·긴장을 조율한다.

**수락:** runtime이 새 업무·대체 담당자·성공 기준을 임의 선택하지 않는다. 팀장이 모든 메시지를 중계하거나 모든 결과를 재승인할 필요가 없다.

### AC-02 — RDD 포함 SQLite 단일 정본

요구사항: REQ-02 · 실행 증거: [VER-01](verification-plan/tasks/VER-01/instruction.md) · 검토: [REV-01](review-plan/tasks/REV-01/instruction.md)

**조건:** 모델·구현·권한·작업이 API로 저장되고 records 파일이 없는 상태.

**행동:** mahasd를 재시작하고 모델/책임/실행 원장을 조회한다.

**수락:** SQLite에서 동일 version/관계가 복원된다. 파일 변경으로 active RDD가 묵시 변경되지 않는다.

### AC-03 — 책임 구조 불변식

요구사항: REQ-03 · 실행 증거: [VER-01](verification-plan/tasks/VER-01/instruction.md) · 검토: [REV-01](review-plan/tasks/REV-01/instruction.md)

**조건:** boundary·role·contract가 있는 published 모델.

**행동:** 복수 부모/순환/criterion 없음/깨진 참조와 적절한 split을 각각 prepare/commit한다.

**수락:** 잘못된 구조는 공개되지 않는다. 올바른 split 후 부모의 단일 책임·결합 책무와 자식 역할이 유지된다.

### AC-04 — 찾을 수 있는 책임과 명시 배정

요구사항: REQ-04 · 실행 증거: [VER-01](verification-plan/tasks/VER-01/instruction.md) · 검토: [REV-01](review-plan/tasks/REV-01/instruction.md)

**조건:** 팀장이 query/path/contract/전문성 입력과 접근 scope를 가진 상태.

**행동:** search/inspect/collaborators/implementations/preview/assign을 연결한다.

**수락:** 관계 이유·미배정·모호성·구현 가능성이 드러난다. stale token은 거부되고 검색만으로 worker가 생기지 않는다.

### AC-05 — 인터페이스의 실제 하네스 구현

요구사항: REQ-05 · 실행 증거: [VER-05](verification-plan/tasks/VER-05/instruction.md) · 검토: [REV-03](review-plan/tasks/REV-03/instruction.md)

**조건:** 동일 RoleInterface를 다른 구성품 세트로 구현한 두 RoleImplementation.

**행동:** 각 구현을 publish/build하고 하네스별 구성품을 설치한다.

**수락:** instruction/skill/subagent/tool의 coverage와 loading route가 정의된다. 단순 파일 번들이나 flags 목록만으로 역할 구현 완료라 하지 않는다.

### AC-06 — 같은 내용의 다른 해상도

요구사항: REQ-06 · 실행 증거: [VER-11](verification-plan/tasks/VER-11/instruction.md) · 검토: [REV-03](review-plan/tasks/REV-03/instruction.md)

**조건:** tool 설명을 다루는 팀장·prompt·tool 역할.

**행동:** 실제 initial context와 판단 근거를 관찰한다.

**수락:** 팀장은 설명 충분성·비용·안정성 관계를, 담당자는 자기 구체 제약을 판단할 수 있다. 상위 장문/하위 구현 전체를 읽어야만 일하는 상태가 아니다.

### AC-07 — 필수 본문의 실제 최초 전달

요구사항: REQ-07 · 실행 증거: [VER-05](verification-plan/tasks/VER-05/instruction.md) · 검토: [REV-03](review-plan/tasks/REV-03/instruction.md)

**조건:** 필수 instruction/skill과 이번 요구사항을 가진 LaunchPlan.

**행동:** missing/conditional-only/정상 route로 시작하고 actual argv/config/stdin과 join을 기록한다.

**수락:** 정상 경로에는 본문이 실제 첫 입력에 연결된다. 파일 생성·경로 env·skill description만으로 delivered가 되지 않는다.

### AC-08 — 하네스 독립 협업

요구사항: REQ-08 · 실행 증거: [VER-11](verification-plan/tasks/VER-11/instruction.md) · 검토: [REV-06](review-plan/tasks/REV-06/instruction.md)

**조건:** 두 검증된 CLI 하네스와 동일 mahas 협업 API.

**행동:** 각 하네스에서 accept/inbox/reply/report를 수행한다.

**수락:** App Server나 provider별 turn adapter 없이 같은 업무 의미가 성립한다. 지원하지 않는 wake/feature는 명시한다.

### AC-09 — 명령 비노출과 직접 호출 거부

요구사항: REQ-09 · 실행 증거: [VER-03](verification-plan/tasks/VER-03/instruction.md) · 검토: [REV-02](review-plan/tasks/REV-02/instruction.md)

**조건:** 일반 worker와 팀장이 다른 grants를 가진 상태.

**행동:** help/schema/completion/UI/MCP와 raw RPC를 비교한다.

**수락:** 비허용 명령은 정상 surface에 없고 알려진 이름으로 직접 호출해도 거부된다. 타 대상 snippet/count/receipt도 누설되지 않는다.

### AC-10 — 위임 한계와 폐기

요구사항: REQ-10 · 실행 증거: [VER-03](verification-plan/tasks/VER-03/instruction.md) · 검토: [REV-02](review-plan/tasks/REV-02/instruction.md)

**조건:** provisioning/assignment/continuation grant가 분리된 상태.

**행동:** 강한 role spawn·requiredActions 확대·parent 이동·revoke 경합을 시도한다.

**수락:** 실제 승인 범위를 넘지 않는다. revoke 이후 새 mutation은 거부되고 이미 시작했을 수 있는 effect는 보존된다.

### AC-11 — identity와 상태 분리

요구사항: REQ-11 · 실행 증거: [VER-07](verification-plan/tasks/VER-07/instruction.md) · 검토: [REV-05](review-plan/tasks/REV-05/instruction.md)

**조건:** 살아 있는 shell, idle agent, reported Task, 미정리 worktree를 각각 준비.

**행동:** probe/heartbeat/turn-complete/UI detach를 수행한다.

**수락:** Execution/Task/Terminal/Resource의 상태가 별개로 보이며 관측만으로 성공·사망을 발명하지 않는다.

### AC-12 — UI와 실행면 수명 분리

요구사항: REQ-12 · 실행 증거: [VER-07](verification-plan/tasks/VER-07/instruction.md) · 검토: [REV-05](review-plan/tasks/REV-05/instruction.md)

**조건:** mahasd와 execution-host가 현재 process를 소유.

**행동:** UI 종료/재접속, control crash/restart를 수행한다.

**수락:** UI close가 process를 죽이지 않는다. 같은 process를 증명해 reattach하고 control unavailable을 false success로 답하지 않는다.

### AC-13 — 스폰 단계와 잔여 자원

요구사항: REQ-13 · 실행 증거: [VER-06](verification-plan/tasks/VER-06/instruction.md) · 검토: [REV-05](review-plan/tasks/REV-05/instruction.md)

**조건:** 고정된 LaunchPlan이 준비된 상태.

**행동:** resource/materialize/spawn/initial/join/accept 사이에 실패를 주입한다.

**수락:** 각 stage와 residual이 남는다. process 시작이 join/task accept로 둔갑하지 않는다.

### AC-14 — 중복 억제와 unknown

요구사항: REQ-14 · 실행 증거: [VER-06](verification-plan/tasks/VER-06/instruction.md) · 검토: [REV-05](review-plan/tasks/REV-05/instruction.md)

**조건:** 같은 operation/effect key와 fault injection 환경.

**행동:** 응답 유실 후 동일/상이한 payload로 재호출한다.

**수락:** 동일 요청은 같은 receipt, 다른 payload는 conflict다. ambiguous effect는 unknown이고 새 ID로 자동 중복 실행하지 않는다.

### AC-15 — 소유권 증명과 재부착

요구사항: REQ-15 · 실행 증거: [VER-07](verification-plan/tasks/VER-07/instruction.md) · 검토: [REV-05](review-plan/tasks/REV-05/instruction.md)

**조건:** old/new controller·host·execution generation을 준비.

**행동:** lease 만료만, 실제 dead 증거, stale ack/report/stop을 각각 전달한다.

**수락:** TTL만으로 writer를 승계하지 않는다. stale generation은 거부되고 same process reattach는 새 실행이 아니다.

### AC-16 — 실제 checkout 소유와 인계

요구사항: REQ-16 · 실행 증거: [VER-08](verification-plan/tasks/VER-08/instruction.md) · 검토: [REV-05](review-plan/tasks/REV-05/instruction.md)

**조건:** 다른 Workspace가 같은 canonical checkout을 가리킴.

**행동:** 동시 writer, unknown stop, 명시 handoff/release를 수행한다.

**수락:** 중복 writer가 차단되고 unknown claim은 유지된다. dirty 파일·retained artifact는 자동 삭제되지 않는다.

### AC-17 — Task·Dispatch·입력 revision

요구사항: REQ-17 · 실행 증거: [VER-04](verification-plan/tasks/VER-04/instruction.md) · 검토: [REV-04](review-plan/tasks/REV-04/instruction.md)

**조건:** 합의→병렬→합류 Plan과 future output binding.

**행동:** Task revision을 변경하고 old/new 결과를 제출한다.

**수락:** Task/Dispatch/Plan이 구분되고 exact output을 고정한다. cycle은 거부되며 메시지 왕복은 DAG cycle로 취급하지 않는다.

### AC-18 — durable inbox와 처리 확인

요구사항: REQ-18 · 실행 증거: [VER-04](verification-plan/tasks/VER-04/instruction.md) · 검토: [REV-04](review-plan/tasks/REV-04/instruction.md)

**조건:** sender/recipient Member와 outstanding Delivery.

**행동:** send/read/replyAndAck 중 연결·프로세스를 끊는다.

**수락:** 저장/읽기/처리를 구별하고 ack 전 재조회된다. 회신과 원문 ack는 함께 반영된다. old consumer는 ack 못 한다.

### AC-19 — 계속 수행과 wake 한계

요구사항: REQ-19 · 실행 증거: [VER-11](verification-plan/tasks/VER-11/instruction.md) · 검토: [REV-04](review-plan/tasks/REV-04/instruction.md)

**조건:** safe wake 지원/미지원 profile와 continuation grant.

**행동:** inbox.wait timeout·wake 실패·새 delivery를 처리한다.

**수락:** 메시지는 보존되고 unsupported가 표시된다. 제한된 continuation이 새 업무/재시도 생성으로 확대되지 않는다.

### AC-20 — 명시 결과와 수용

요구사항: REQ-20 · 실행 증거: [VER-04](verification-plan/tasks/VER-04/instruction.md) · 검토: [REV-04](review-plan/tasks/REV-04/instruction.md)

**조건:** owner-declaration과 designated-acceptance Task.

**행동:** report/decision/revised outcome/Task close/resource release를 수행한다.

**수락:** 정확한 outcome revision에만 수용이 적용되고 turn 종료·process stop·cleanup은 별도다. Run 결합은 상위가 판단한다.

### AC-21 — 변경 영향과 별도 유지

요구사항: REQ-21 · 실행 증거: [VER-11](verification-plan/tasks/VER-11/instruction.md) · 검토: [REV-03](review-plan/tasks/REV-03/instruction.md)

**조건:** parent responsibility/contract/context/implementation이 참조됨.

**행동:** before/after 변경을 공개하고 영향 후보를 분류한다.

**수락:** 직접 자식·이전/새 consumer·horizontal 참조 후보가 드러난다. 실행 bundle은 고정되고 자기 지침 자동 변경이 없다.

### AC-22 — 코드 정본·최소 context

요구사항: REQ-22 · 실행 증거: [VER-05](verification-plan/tasks/VER-05/instruction.md) · 검토: [REV-03](review-plan/tasks/REV-03/instruction.md)

**조건:** 코드에서 얻는 사실, 재사용 지침, 과거 결정, 이번 요구사항이 섞인 입력.

**행동:** role 구현과 context 등록/빌드를 수행한다.

**수락:** 원본 anchor와 필요한 재표현만 유지한다. Task/ADR 이력이 재사용 지침에 누적되지 않고 snapshot은 저작 정본과 구별된다.

### AC-23 — 출처 있는 관측과 client 복구

요구사항: REQ-23 · 실행 증거: [VER-07](verification-plan/tasks/VER-07/instruction.md) · 검토: [REV-07](review-plan/tasks/REV-07/instruction.md)

**조건:** 두 client와 snapshot/event cursor가 존재.

**행동:** gap/restart/detach/permission event를 전달한다.

**수락:** snapshot 재조회로 복구되고 출처와 unconfirmed가 보존된다. renderer가 DB writer가 되거나 구독 해제가 실행 authority를 바꾸지 않는다.

### AC-24 — 인간 개입의 정확한 의미

요구사항: REQ-24 · 실행 증거: [VER-07](verification-plan/tasks/VER-07/instruction.md) · 검토: [REV-07](review-plan/tasks/REV-07/instruction.md)

**조건:** generic PTY가 permission 입력을 기다림.

**행동:** Intervention 생성·사용자 입력·늦은 resolve를 수행한다.

**수락:** 하네스 prompt를 추측 승인하지 않고 exact intervention/execution을 확인한다. mahas grant와 native permission을 구별한다.

### AC-25 — 문서 소비 시점과 Task 입력

요구사항: REQ-25 · 실행 증거: [VER-12](verification-plan/tasks/VER-12/instruction.md) · 검토: [REV-08](review-plan/tasks/REV-08/instruction.md)

**조건:** 각 Task instruction과 requiredReads가 제공됨.

**행동:** 담당자가 자기 Task에 필요한 문서를 확인한다.

**수락:** instruction에 시점·절·REQ·선행 입력·인계물이 있다. 별도 source/reference/examples 폴더를 알아서 찾아야 완성되지 않는다.

### AC-26 — 구현·리뷰·검증의 분리

요구사항: REQ-26 · 실행 증거: [VER-12](verification-plan/tasks/VER-12/instruction.md) · 검토: [REV-08](review-plan/tasks/REV-08/instruction.md)

**조건:** 세 폴더에 독립 Task와 DAG가 있음.

**행동:** 코드 handoff, review finding, 실행 evidence를 결합한다.

**수락:** 구현 Task 안에 독립 승인/장애 시험이 혼재하지 않고 각 output revision이 추적된다. 최종 수락은 세 결과를 결합한다.

### AC-27 — migration·backup·복구

요구사항: REQ-27 · 실행 증거: [VER-08](verification-plan/tasks/VER-08/instruction.md) · 검토: [REV-07](review-plan/tasks/REV-07/instruction.md)

**조건:** 기존 UI 상태와 새 DB/host/content가 존재.

**행동:** 이관·backup/restore·protocol/schema mismatch·정상 shutdown을 수행한다.

**수락:** 과거 관측을 가짜 Task로 만들지 않고 정본/파일/원장이 일관된다. restore는 과거 process 권한을 즉시 부활시키지 않는다.

### AC-28 — 지원 범위와 검증 수준

요구사항: REQ-28 · 실행 증거: [VER-12](verification-plan/tasks/VER-12/instruction.md) · 검토: [REV-06](review-plan/tasks/REV-06/instruction.md)

**조건:** documented/verified profile와 알려진 미지원 기능.

**행동:** 실제 하네스 수락과 제품 상태 표기를 확인한다.

**수락:** 지원 범위는 실행한 설치/OS/기능에 한정된다. 원격 실행·전체 transcript·완전 sandbox·자동 사업 판단을 암묵 지원으로 주장하지 않는다.
