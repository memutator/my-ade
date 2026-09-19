# D-ROLE — role + context 인터페이스와 하네스 구현

**읽는 시점:** IMP-07~IMP-09와 IMP-24/25의 구현 담당자, REV-03 검토자. 일반 worker에게는 선택된 구현의 결과만 주입한다.

## 1. 네 객체를 합치지 않는다

```text
RoleInterface (무엇이 성립해야 하는가)
  = RDD role + 책임에 필요한 context의 의미 계약
             ↓ 구현 작성자의 전문적 설계
RoleImplementation (어떻게 역할을 수행 가능하게 구성하는가)
  = 특정 하네스의 지침 / skill / subagent / tool / loading 구성품 세트
             ↓ 결정적인 build
ContextBundle (이번 구현 revision의 고정 byte와 manifest)
             ↓ 권한·작업·프로세스 조건 결합
LaunchPlan (이번 spawn을 실제 수행할 실행 계획)
```

RoleImplementation을 역할 설명의 복사본이나 CLI flags 목록으로 축소하지 않는다. 필요한 전문성, 책임에 맞는 해상도, 명령 도구, 하네스 로딩 방식을 함께 구현한다. 모든 구현에 skill·subagent·MCP가 반드시 있어야 하는 것도 아니다. 그 역할을 성립시키는 필요한 조합을 선택한다.

## 2. 도메인 객체

| 객체 | 필드 | 불변식 |
|---|---|---|
| RoleInterface | digest, modelVersion, roleId, requirements: RoleInterfaceRequirements, judgmentScope | role+context의 고정 의미 계약; 운영 policy/grant는 별개 |
| RoleInterfaceRequirements | responsibilityRefs: BoundaryId[], contextRequirements: ContextRequirement[] | `requirements_json` 정본. 배열만 저장하지 않음 |
| ContextRequirement | clauseId, contextId/criterionRef, requiredMeaning (의미 문장, 플래그 아님), deliveryClass: initial/conditional, readerPerspective: performer\|coordination | Context 객체 자체의 확장이 아니라 인터페이스의 requirement binding. 팀장 해상도는 coordination perspective clause |
| RoleImplementation | implementationId, revision, interfaceDigest, harnessProfileId, status, maintainerRoleId, componentGraph, coverageBindings, semanticDecision | published revision immutable; 구현 작성자가 의미 적합성을 판단 |
| ImplementationComponent | componentId, kind, contentBinding/config, consumes[], outputs[], activation, permissionRequirements | kind는 instruction/skill/subagent/tool-config/launch-config |
| CoverageBinding | clauseId, componentId, sectionKey, realization: verbatim/reexpressed, requiredLoadPhase | clause별 어떤 표현으로 구현했는지 명시. 링크 존재는 의미 충족의 기계 증명이 아님. 저작 단계 `initial`\|`conditional`은 compiler에서 `inline`\|`preload`\|`catalog`로 번역 |
| HarnessProfile | id, revision, executableIdentity, recipe: ProfileRecipe, capabilities, admissionState | draft/documented/verified/disabled; 설치 버전과 OS 범위 고정. ProfileRecipe(등록)와 LaunchRecipe(prepare 소비)는 다른 스키마 — S-INJECTION |
| ContextBundle | digest, implementationRevision, interfaceDigest, surfaceDigest, componentBlobRefs, requiredTextDigest, sourceObservations | immutable; timestamp/run/task/credential을 재사용 본문에 섞지 않음 |
| EffectiveContextReceipt | launchId, bundleDigest, attachedComponents, inheritedInputs, deliveryEvidence, missing/unknown[] | 의도된 bundle과 실제 로딩 관측을 구별 |
| WorkEnvelope | digest, kind: coordination/task, runId, memberId, taskRevision?, dispatchId?, currentRequirementText, inputBindings, peers, reportContract | 이번 작업 본문. 재사용 RDD context에 저장하지 않음 |

## 3. 구현을 누가 작성하는가

부모/역할 구성 담당자가 RDD interface를 읽고 역할 구현을 작성한다. 코드를 보고 쉽게 복원되는 설명은 쓰지 않는다. 이미 있는 전문 지침을 재사용하고, 다른 책임자가 필요한 추상화가 빠져 있으면 그 역할 문법의 현재 지침을 만든다. 구현 publication은 별도 권한이며 실행 worker가 자기 권한으로 공개할 수 없다.

상위 팀장 표현에는 하위 책임, 가치, 제약, 긴장을 남긴다. 하위 구현 구조·원본 프롬프트 전체는 주입하지 않는다. prompt assemble 담당에는 안정/변동 영역과 합의된 append-only 조건을 구체적으로 둔다. tool 담당에는 선택·사용 의미의 충분성과 불필요한 설명의 비용을 둔다. 동일한 tool 설명이 세 역할에 다른 판단 단위로 나타나는 것이 올바른 구현이다. 컴파일러가 원본을 단순 필터하거나 요약 길이만 줄이는 것으로 대신하지 않는다.

## 4. 구성품별 실행 의미

instruction은 초기 필수 본문이다. skill은 재사용 전문 지침/도구이며 conditional skill의 존재만으로 필수 의미를 전달했다고 보지 않는다. 필수 skill의 핵심은 initial instruction에 포함하거나, 시작 agent가 확정된 preload route로 전체 본문을 받게 한다. 이 둘 중 선택을 coverageBindings에 명시한다.

subagent는 해당 하네스 내부의 전문성 구현 수단일 수 있다. mahas가 별도로 배정한 Member와 같지 않다. 다른 boundary 역할을 독립 책임자로 세우려면 team.assign/worker.start를 사용한다. 같은 실행 credential을 상속받는 native helper의 호출은 그 Member의 권한과 결과 책임 아래 있으며 독립적으로 격리됐다고 표시하지 않는다. helper를 통해 추가 권한을 발급하지 않는다.

tool-config는 mahas CLI 접근과 필요 전문 도구를 구성한다. mahas API의 실제 권한은 C-ACCESS가 집행한다. 하네스 native tool 목록과 mahas action 목록은 별개이며 shell을 허용했다는 이유로 mahas 관리자 권한이 생기지 않는다. 필요하지 않은 도구/skill 이름 자체를 role surface에 넣지 않는다.

launch-config는 초기 입력·구성품 검색 경로·명시적 profile 설정이다. native model loop, turn stream, permission adapter를 공통 도메인에 넣지 않는다.

## 5. coverage와 부실화

필수 clause에 initial coverage가 없거나 required tool이 current grant에서 금지되면 `context.build`는 실패한다. 원문의 hash가 바뀌면 바로 의미 불일치로 단정하지 않고 stale 후보로 두되 새 실행은 승인된 구현 revision+확인된 snapshot을 사용한다. policy에 따라 stale 후보가 미검토인 필수 항목은 new launch를 block하고 기존 실행은 pin을 유지한다. 의미 갱신은 별도 역할 구현 작업이다.

모든 context를 부모에서 자식으로 자동 상속하거나, maintenanceBasis를 주입 목록으로 사용하지 않는다. clause가 reexpressed이면 그 구현 문구가 주입 대상이며 원본 긴 문서를 추가로 붙이지 않는다. 재표현 문구의 정본도 재사용 지침으로 관리하며 의미 근거는 별도 binding이다.
