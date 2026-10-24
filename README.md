# KMINGO 판매 루틴

**한 병의 다음 한 끼.** 고객의 질문과 실제 반응을 읽고 다음 판매 행동을 고르는 반복 루틴입니다. 실행할 때마다 이전 상태를 읽고 새 증거가 들어온 항목만 바꿉니다. 브라우저 화면은 선택 사항입니다.

## 심사위원 빠른 검토

- [실제 루프 실행 결과](RUN-REPORT.md): 2026년 10월 24일 17:40 KST에 실행한 3회차 기록과 우선 후보 3개의 다음 행동.
- [10개 기회·원문 출처·초기 판매 문구](seed.json), [반복 운영 지침](ROUTINE.md), [자동 코드 검증](https://github.com/brucedata/kmingo-loop/actions).
- 현재는 API 키 없이 실행하는 규칙 모드입니다. 실제 고객 피드백·발송·주문은 0이며, AI API 호출과 정기 실행 예약은 연결하지 않았습니다.

아래 명령으로 직접 재현할 수 있습니다. 기록된 초기 우선순위는 사전 조사 결과이며, 새 웹 기회를 자동 검색하거나 매번 순위를 다시 매기는 기능은 아닙니다.

## 바로 실행

Node.js 24 이상이 필요합니다. 외부 패키지 설치 없이 실행합니다.

~~~sh
npm run loop
npm run status
~~~

첫 실행은 공개 질문 6개와 협업 후보 4곳으로부터 다음 행동을 만듭니다. 새 피드백 없이 다시 실행하면 기존 제안을 유지합니다.

## 반복하는 일

**기존 기록 → 새 질문·피드백 → 다음 행동 → 검토 → 변경 이유 저장 → 다음 회차**

1. 출처와 기존 판단을 읽습니다.
2. 직접 받은 피드백을 기록합니다.
3. 루프를 실행합니다.
4. 대상별 이전/이후 제안과 이유를 검토합니다.
5. 실제 다음 반응이 생기면 같은 과정을 반복합니다.

실행 상태와 변경 이력은 data/state.json에 남습니다. 자동 시간 예약은 설정하지 않았습니다.

## 실제 피드백 입력

실제로 받은 피드백을 UTF-8 JSON 파일로 작성합니다. 파일 위치를 input/feedback.json으로 정한 경우 다음 명령을 실행합니다.

~~~sh
npm run feedback -- --file input/feedback.json
npm run loop
~~~

파일 형식:

~~~json
{
  "leadId": "Q01",
  "text": "실제로 받은 피드백 원문으로 바꾸세요",
  "sourceKind": "peer",
  "facts": {}
}
~~~

형식 예시를 실제 반응으로 저장하지 마세요. sourceKind는 customer(직접 고객 응답), partner(직접 파트너 응답), peer(동료 검토), public(공개 자료) 중 실제 출처를 선택합니다. 확인된 사실만 facts에 넣습니다.

지원하는 사실은 jarStatus(unknown/full/low/none), purchaseIntent(unknown/yes/no), country, objection(none/time/price/heat/ingredients), stopContact(true/false)입니다.

동료·공개 의견은 제안 검토에 반영하지만 해당 고객의 보유량·국가·구매 의사를 바꾸지 않습니다.

## 새 기회 추가와 내보내기

~~~sh
npm run add -- --file input/new-lead.json
npm run export -- --output exports/state.json
~~~

새 후보 JSON에는 name, type(consumer/partner), sourceUrl, evidence가 필요합니다. 같은 출처는 중복 추가하지 않습니다. 내보내기에는 저장소 안의 새 JSON 경로를 지정합니다.

## AI와 함께 운영

[ROUTINE.md](ROUTINE.md)를 Codex 또는 Clone에 읽히면 기존 기록을 검토하고 다음 실험을 준비하는 운영 지침으로 사용할 수 있습니다.

- 기본 규칙 모드는 별도 API 키 없이 동작합니다.
- npm run loop -- --ai는 OpenAI Responses API로 다음 행동에 맞는 문구와 질문을 생성합니다. 모델이 고객 사실·성과 지표·연락 중단 상태를 바꾸지는 않습니다.

현재 제공본은 **규칙 모드 검증 완료, 실제 OpenAI 호출 미검증**입니다. 키의 로컬 저장이 완료되지 않았고 추가 생성은 보류했습니다. API 키가 없거나 호출이 실패하면 AI 성공으로 표시하지 않습니다.

API 설정은 Git에서 제외되는 .env.local에서 읽습니다. 키를 코드·브라우저·GitHub에 넣지 마세요. 설정 항목은 .env.example, API 계약은 [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)와 [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)를 참고합니다.

## 선택 사항인 화면

~~~sh
npm run ui
~~~

http://127.0.0.1:4317 에서 같은 기록을 조회·입력할 수 있습니다. 화면은 단일 사용자 로컬 도구이며, 인터넷 공개 서비스나 별도 판매 앱을 배포한 것은 아닙니다.

CLI와 화면에서 동시에 쓰기 작업을 실행하지 마세요. 한 경로의 저장·실행이 끝난 뒤 다른 경로를 사용합니다.

## 지표와 출처

처음 들어 있는 것은 공개 자료 10개입니다. 초기 발송·직접 응답·주문은 모두 0입니다.

- 과거 게시물 댓글은 우리 제안에 대한 응답으로 세지 않습니다.
- 직접 고객 응답, 파트너 응답, 동료 검토를 구분합니다.
- 클릭·문의·구매 의사를 주문으로 계산하지 않습니다.
- 이 루틴은 이메일·댓글·DM을 발송하거나 결제를 처리하지 않습니다.
- 제품 라벨·맵기·재고·배송 조건이 미확인인 경우 그대로 남깁니다.
- Q03은 검색 보관본을 읽었고 직접 페이지 재열기는 실패했습니다.
- 클래스 운영자의 공개 프로그램은 협업 의향을 뜻하지 않습니다.

각 원문 링크와 검증 범위는 seed.json에 있습니다. 실행 데이터·입력 피드백·내보내기·비밀키는 Git에서 제외합니다.

## 검증

~~~sh
npm test
npm run check
~~~

새 증거 없는 재실행, 출처별 사실·지표 분리, 연락 중단 유지, API 오류 시 상태 보존, HTTP 입력 검증과 CLI를 검증합니다.

