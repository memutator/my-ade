# mahas 요구사항

문서 ID: REQ · 상태: 구현 전 규범 명세 · 대상: 제품 책임자, 팀장, 각 Task 담당자

## 사용 시점
팀장은 계획을 배정하기 전에 전체를 읽는다. 담당자는 자기 instruction에 적힌 REQ 항목만 읽는다. 본 요구사항은 이번 mahas 구현의 작업 명세이며, 실행될 모든 프로젝트의 재사용 context로 자동 등록하지 않는다.

## 목적
책임에 맞는 판단 환경을 재사용하고, 서로 다른 하네스의 담당자들이 동일한 협업 계약으로 일하며, 실행의 권한·전달·결과·불확실성을 보존한다. 이 문서는 이전 개정안의 SQLite 제외·축약된 실행 계층·단일 구현 계획을 대체한다.

### REQ-01 — 책임 기반 판단 분산

user와 팀장은 목표·책임 배정·META DAG·결합을 판단한다. 담당자는 자기 책임의 방법·품질·당사자 협의를 판단한다. 런타임은 업무 의미를 대신 결정하지 않는다.

### REQ-02 — 전체 모델의 SQLite 정본

RDD, 역할 구현, 권한, Run·Task·Dispatch, 실행·자원, 전달·정산을 mahas.sqlite에 저장한다. records.json/Git을 RDD의 별도 수정 정본으로 두지 않는다. 코드·전문 지침 본문은 원본 파일이고 DB는 anchor와 실행 때 관측한 immutable snapshot을 구별한다.

### REQ-03 — RDD 구조 불변식

boundary마다 단일 responsibility와 한 개 이상의 criterion-description이 있다. contains는 단일 부모 tree이고 contract는 경계 간 입출력 의존이다. role은 boundary와 horizontalRole을 참조한다. 기준은 자동 합격 임계값이 아니다.

### REQ-04 — 책임 탐색과 배정

팀장은 자연어 질의·코드 경로·계약·전문성·경계 범위로 책임과 역할을 찾고, 관계 이유·미배정 영역·구현 가능성·현재 배정 상태를 읽은 후 명시적으로 배정한다. 검색 결과를 자동 담당자 선정으로 바꾸지 않는다.

### REQ-05 — 인터페이스와 구현 분리

RoleInterface는 role + 필요한 context의 의미 계약이다. RoleImplementation은 특정 하네스에서 그 계약을 성립시키는 지침·skill·subagent·tool 구성품과 로딩 규칙이다. ContextBundle과 LaunchPlan은 그 구현의 빌드·실행 산출물이며 서로 대체하지 않는다.

### REQ-06 — 같은 내용의 역할별 해상도

팀장은 하위 구현 원문 없이 책임·가치·긴장을 조율할 표현을 받고, 담당자는 자기 작업에 필요한 구체 지침을 받는다. 선택만이 아니라 의미를 재표현하는 책임을 역할 구현 작성자에게 둔다. 빌더는 즉석 요약하지 않는다.

### REQ-07 — 실제 초기 전달

필수 지침 본문, 허용 명령, 이번 요구사항은 첫 모델 실행의 입력에 들어가야 한다. 파일 생성·환경변수에 경로 등록·conditional skill 발견 기대만으로 전달 완료를 선언하지 않는다.

### REQ-08 — 하네스 독립 협업

작업 인수·inbox·회신·결과 제출은 mahas API/CLI로 공통화한다. provider App Server, typed turn, native permission API를 참여 조건으로 요구하지 않는다. 하네스별 접점은 승인된 역할 구성품 설치와 시작/resume/wake recipe다.

### REQ-09 — 명령 비노출과 인가

허용되지 않은 명령을 지침/help/schema/completion/UI/MCP 목록에서 제외한다. raw RPC·알려진 명령 직접 호출도 서버가 현재 grant·실행·실제 대상 범위로 검사한다. 비노출을 인증 또는 OS sandbox로 부르지 않는다.

### REQ-10 — 최소 위임과 폐기

role ceiling, AssignmentGrant, ProvisioningGrant를 구별한다. 역할 이름·부모 경계·requiredActions는 권한을 만들지 않는다. 자기 역할 구현과 권한의 무단 변경, 강한 역할 스폰을 통한 우회를 금지한다.

### REQ-11 — 실행 identity와 수명

Member·Execution·ProcessIncarnation·Terminal·NativeConversation·Task·Dispatch·UI View는 별도 identity다. liveness는 live/unverifiable/exited이고 stored status·heartbeat·화면은 성공 또는 사망의 대체 증거가 아니다.

### REQ-12 — 제어면과 실행면

mahasd가 제어/SQLite 단일 writer이고 execution-host가 PTY·일반 프로세스를 소유한다. Desktop은 client다. UI 종료와 worker 종료를 분리하고 제어면 재시작 후 실행면의 동일 프로세스에 재부착할 수 있게 설계한다.

### REQ-13 — 명시적 스폰 단계

worker.prepare/start는 권한·모델 pin·입력·자원 claim·구성품 materialize·process 생성·초기 입력·join·task accept를 단계별 receipt로 기록한다. 부분 실패와 잔여 자원을 보존한다.

### REQ-14 — 중복과 unknown

모든 mutation은 operationId+fingerprint를 사용한다. 외부 effect 전 의도를 기록하고 ambiguous 응답은 unknown이다. 새 ID 자동 재시도, TTL만으로 writer 교체, timeout을 미실행으로 판정하지 않는다.

### REQ-15 — 실행 권한과 재부착

controller epoch·execution generation·host incarnation·process birth identity·spawn nonce를 검증한다. 재연결은 기존 실행 확인이지 신규 spawn/resume이 아니다. 과거 세대의 결과·ack·stop은 현재 대상을 바꾸지 못한다.

### REQ-16 — 작업 공간 소유

Workspace와 실제 checkout을 구별하고 canonical checkout에 write claim을 둔다. 살아 있거나 미확인인 writer의 claim을 TTL만으로 회수하지 않는다. 병렬 쓰기는 별도 worktree, 인계·정리·강제 폐기는 명시 연산이다.

### REQ-17 — Task와 실행 시도

Run에 버전된 META DAG와 TaskSpec을 둔다. Dispatch는 특정 task revision의 시도다. 선행 결과는 정확한 output/artifact revision으로 고정한다. Run은 자동 scheduler가 아니다.

### REQ-18 — 직접 통신과 전달

Member는 지속 mailbox 주소다. durable Message/Delivery, 읽기와 ack, reply+ack 원자성, consumer generation을 제공한다. PTY 입력이나 wake를 메시지 저장·수락·처리로 간주하지 않는다.

### REQ-19 — 계속 수행과 깨우기

작업 중 명시적 inbox 확인과 bounded wait를 제공한다. 자동 깨우기는 허용된 ContinuationGrant와 검증된 recipe의 좁은 범위에서만 한다. 불가능한 하네스는 수동 재개 필요를 표시하며 메시지는 보존한다.

### REQ-20 — 결과 선언과 수용

담당자의 report와 필요할 때 지정된 수용자의 decision을 분리한다. owner-declaration을 허용하여 모든 결과가 팀장 병목이 되지 않게 한다. Run의 결합 판정·실행 종료·자원 정리는 따로 한다.

### REQ-21 — 변경과 지침 유지

부모 책임·계약·수평 지침·역할 구현 변경에서 stale 후보를 계산한다. 판단과 갱신은 별도 책임자 작업이다. 실행 중 bundle은 고정하며 agent가 자신의 활성 지침을 몰래 갱신하지 않는다.

### REQ-22 — 정본과 context 최소화

코드·타입·테스트에서 쉽게 얻는 사실은 별도 지침으로 복제하지 않는다. 이력·ADR·이번 작업의 사연을 재사용 context에 축적하지 않는다. snapshot은 재현 증거이지 새 저작 정본이 아니다.

### REQ-23 — 관측과 클라이언트 동기화

프로세스·hook·agent 선언의 출처를 유지한다. snapshot+event cursor로 UI를 복구한다. pane 이동·detached renderer·구독 해제가 실행 정본이나 writer 권한을 바꾸지 않는다.

### REQ-24 — 권한 요청과 인간 개입

generic PTY의 permission prompt를 바이트 추측으로 자동 승인하지 않는다. Intervention에 증거·범위·상태를 기록하고 사용자에게 실제 terminal 연결을 제공한다. mahas 권한 부여와 하네스 내부 승인은 별개다.

### REQ-25 — 문서의 소비 시점

모든 구현 Task는 instruction, 사전 의존, 필요한 spec 절, 입력/인계물을 명시한다. source/reference/examples 폴더를 읽어야 핵심 구현을 추론하는 구조를 만들지 않는다.

### REQ-26 — 구현·리뷰·검증 분리

implementation-plan은 코드 구현과 인계를 다룬다. review-plan은 독립 코드/설계 검토, verification-plan은 실행 시험·장애 주입·실제 하네스 수락을 다룬다. 각각 Task와 DAG를 갖고 release는 세 결과를 결합한다.

### REQ-27 — 전환과 운영 복구

현재 UI/PTY 기능은 이관 경계에서 보존한다. 관측 레코드를 가짜 Task로 변환하지 않는다. DB 이관·backup·복구·protocol 불일치·정상 종료를 명세하고 과거 상태를 확인 없이 live로 만들지 않는다.

### REQ-28 — 지원 범위와 증거

v1은 단일 로컬 호스트의 PTY 및 일반 process 실행이다. 원격 SSH/paired host, provider turn API, 전체 transcript 복제, 완전 OS 격리, 자동 사업 판정은 비목표다. 실제 하네스 지원은 설치 버전별 검증 결과에 한정한다.

## 새로 확정한 설계 선택
`mahasd + 재부착 가능한 execution-host`를 목표 구조로 선택한다. 입력 보고서의 기존 앱 결합 PTY가 이미 이 동작을 제공한다고 주장하지 않는다. 구현 작업 IMP-17~IMP-23이 이 수명 경계를 새로 만든다. SQLite에 들어가는 것은 RDD 선언과 모든 제어 상태이며, 원본 코드와 재사용 문서의 저작 위치를 DB 본문으로 강제로 옮기지는 않는다.
