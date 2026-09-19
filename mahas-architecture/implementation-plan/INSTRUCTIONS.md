# 구현 담당자 공통 지시

## 문서의 소비 시점

이 폴더는 이번 mahas 개발의 일회성 작업 계획이다. RDD 재사용 context에 자동 등록하지 않는다. 팀장은 `dag.json`에서 선행 인계가 준비된 Task를 선택하고 **해당 instruction 본문**과 그 문서에 지정된 requiredReads·선행 artifact identity를 담당자의 첫 작업 입력으로 전달한다. 단순히 문서 폴더의 위치만 알려 주지 않는다.

mahas 자체가 아직 구현되기 전에는 현재 사용하는 하네스와 파일 읽기 도구로 같은 지시를 실행한다. 구현 대상인 mahas CLI가 이미 존재해야 계획을 수행할 수 있는 순환 의존을 만들지 않는다. 제품을 이용할 수 있게 된 뒤에는 이 데이터를 TaskSpec/WorkEnvelope로 등록할 수 있다.

담당자는 instruction을 받은 즉시 '지금 읽을 문서'의 REQ와 spec 절/테이블만 읽는다. 형제·부모 Task의 instruction이나 source/reference/examples 폴더를 탐색하지 않는다. 실제 코드 탐색은 자기 책임 경계와 계약 정본을 대상으로 한다. spec 전체를 무차별 context로 주입하지 않는다.

## 작업 방식

선행 인계의 exact commit/tree digest와 공개 contract를 사용한다. 경계 사이 API가 바뀌면 그 계약 소유자와 직접 협의하고 소비자 영향을 공유한다. 숨은 provider branch, 임시 권한 우회, UI-only fake state, 무조건 성공 receipt를 넣어 integration을 통과시키지 않는다. 국소 구현 방법은 담당자가 판단한다.

개발 과정의 컴파일·자체 확인은 담당자가 수행할 수 있다. 그러나 독립 코드 review, 보안 공격 시험, 장애 주입, 실제 하네스 호환 시험, 출시 수락은 이 구현 계획에 포함하지 않는다. 해당 작업은 review-plan과 verification-plan의 별도 역할·Task가 수행한다. 'implemented'는 'accepted'와 다르다.

## 공통 인계 계약

```text
ImplementationHandoff {
  taskId,
  codeRevision: commit 또는 immutable tree digest,
  ownedContracts: 계약 ID와 operation 목록,
  changedPaths,
  exportedEntrypoints,
  migrationIds,
  inputHandoffRevisions,
  unresolvedDecisions,
  knownLimitations
}
```

후속 담당자는 이 인계물과 자신의 계약을 읽는다. 제공자의 전체 내부 설계를 다시 설명한 문서를 요구하지 않는다. 내부 구현이 바뀌어도 외부 계약이 유지되면 후속 작업의 문서를 모두 재작성하지 않는다.

## 결함과 변경

review/verification에서 결함이 오면 원래 Task owner에게 수정 작업을 배정한다. 기존 DAG를 덮어쓸 필요 없이 동일 Task의 새로운 implementation revision과 영향 범위를 기록한다. contract 변경이면 소비자 구현과 관련 review/verification의 재실행을 팀장이 조율한다.
