# AGENTS.md

이 문서는 **이 저장소에서 작업하는 모든 에이전트(사람 포함)를 위한 계약**이다.
여기 적힌 규칙은 취향이 아니라 테스트로 강제되는 제약이다. 어기면 테스트가 깨진다.

---

## 0. 프로젝트 한 줄 소개

`pi-bot-connect`는 **pi 코딩 에이전트의 라이브 세션을 Discord/Slack/Telegram에 연결**하는 pi 확장이다.
알림 봇이 아니라 **핸드오프 브리지**다: 현재 작업을 공유하고, 메신저에서 다음 작업을 이어가고, 터미널로 돌아오면 그 작업이 이미 세션에 반영되어 있다.

- 차별점/경쟁 분석: [`docs/feasibility.md`](docs/feasibility.md) — **작업 전에 읽어라**
- 아키텍처/계약/불변식: [`docs/architecture.md`](docs/architecture.md) — **코드 수정 전에 읽어라**

---

## 1. 절대 규칙 (Non-negotiables)

### R1. 테스트를 먼저 쓴다 (TDD)

Red → Green → Refactor 순서를 지킨다.

1. **Red**: 실패하는 테스트를 먼저 쓴다. 실행해서 **실제로 실패하는 것을 확인**한다.
2. **Green**: 테스트를 통과시키는 최소 구현만 쓴다.
3. **Refactor**: 통과 상태를 유지하며 정리한다.

금지:
- 구현을 먼저 쓰고 테스트를 나중에 맞추는 것
- 실패를 확인하지 않고 테스트를 작성하는 것 (오타로 항상 통과하는 테스트가 가장 위험하다)
- 스냅샷 테스트로 동작을 고정하는 것 (의도를 설명하지 못한다)

### R2. `npm run check`가 통과해야 작업이 끝난다

```bash
npm run check        # = tsc --noEmit && vitest run
```

- 타입 에러 0, 테스트 실패 0이 아니면 작업은 미완료다.
- "다음에 고치겠다"는 허용되지 않는다. 커밋하지 말고 되돌려라.

### R3. `src/core/`는 완전 순수하다

`src/core/*`에서 다음을 **import 할 수 없다**:

- `node:*` (fs, net, crypto, ...)
- `@earendil-works/pi-coding-agent`
- 어떤 전송 SDK도

코어에 필요한 외부 세계는 전부 **주입**한다. 시간은 `now`, 난수는 `random`, 로깅은 `Logger`.

```ts
// 올바름
export function decidePairing(params: { now: number; random: () => number; ... }): PairingDecision

// 금지
export function decidePairing(): PairingDecision {
  const now = Date.now();          // ❌ 시간이 숨어 있다
  const code = Math.random();      // ❌ 테스트가 불가능해진다
}
```

**코어에 `Date.now()`나 `Math.random()`이 한 곳이라도 있으면 그건 버그다.** 현재 0곳이다.

### R4. `src/index.ts`에 정책을 넣지 않는다

`src/index.ts`는 pi 이벤트를 브리지에 연결하는 **껍데기**다.

```ts
// 올바름: 위임
pi.on("tool_execution_start", async (event, ctx) => {
  sessionCtx = ctx;
  runningTool = event.toolName;
  if (!bridge || progressSent) return;
  progressSent = true;
  await bridge.publish("progress", `▶ ${event.toolName}`);
});
```

넣어도 되는 것: pi API 호출, 상태 보관, 위임.
넣으면 안 되는 것: `if`로 정책을 표현하는 모든 것(파싱, 인증, 포맷팅, 길이 계산).

**"이 `if`는 정책인가?"** → 그렇다면 코어로 옮기고 테스트를 쓴다.
`src/index.ts`는 커버리지에서 제외되어 있으므로, 여기 있는 로직은 **아무도 지켜주지 않는다**.

### R5. 보안 불변식을 깨지 않는다

`docs/architecture.md` §3의 I1~I12. 특히:

- **페어링 코드를 메신저로 보내지 마라.** 터미널에만 표시한다 (`pairingCodeNotice`만 코드를 렌더링한다)
- **프롬프트 본문을 로그에 남기지 마라.** 로그에는 `reason`, `transport`, `deliverAs` 같은 메타데이터만
- **송신 전 리댁션을 우회하지 마라.** `Bridge.send()`를 거치지 않고 `transport.send()`를 직접 호출하지 마라
- **툴 인자/출력을 원격으로 보내지 마라.** 툴 *이름*까지가 허용 범위다
- **비밀값을 설정 파일에 쓰지 마라.** 설정 파일에는 env 변수 *이름*만 들어간다

---

## 2. 명령어

```bash
npm run check          # 타입체크 + 전체 테스트 (필수 게이트)
npm run typecheck      # tsc --noEmit
npm run test           # vitest run
npm run test:watch     # TDD 사이클용
npm run test:coverage  # 커버리지

# 단일 파일만
npx vitest run src/core/chunk.test.ts
npx vitest run -t "prefers paragraph breaks"

# 실제 pi에 로드해서 수동 확인 (전송 구현 후)
pi -e ./src/index.ts
PI_BOT_CONNECT_DEBUG=1 pi -e ./src/index.ts   # 어댑터 로그 활성화
```

`pi -e`는 확장을 즉시 로드한다. 자동 탐색 위치(`.pi/extensions/`, `~/.pi/agent/extensions/`)에 두면 `/reload`로 핫리로드할 수 있다.

---

## 3. 파일 지도

```text
src/
├── index.ts                 [껍데기] pi 어댑터. 커버리지 제외. 정책 금지
├── bridge.ts                오케스트레이션. 전송↔코어↔세션 연결 + 송신 파이프라인
├── bridge.test.ts           26 테스트 — 전 구간 시나리오 (FakeTransport + FakeHost)
├── config.ts                설정 파일 검증 (신뢰할 수 없는 입력)
├── config.test.ts           18 테스트
├── core/                    ★ 완전 순수. 여기가 제품의 본체
│   ├── types.ts             Envelope, Transport, BridgeConfig, Logger
│   ├── router.ts            (envelope, state) → action[]. 모든 라우팅 결정
│   ├── commands.ts          원격 명령 파싱 + 실행 (문자열 반환, I/O 없음)
│   ├── pairing.ts           챌린지 생성/검증 + 렌더링 (코드 유출 방지)
│   ├── chunk.ts             UTF-8 안전 청킹
│   ├── markdown.ts          전송 flavor별 마크다운 변환
│   ├── redact.ts            비밀값 리댁션
│   ├── digest.ts            작업 다이제스트(공유 카드) 생성
│   ├── message.ts           pi 메시지에서 표시 텍스트 추출
│   └── logger.ts            JSON Lines 로거 + MemoryLogSink(테스트)
└── transports/
    ├── index.ts             전송 팩토리 레지스트리 (현재 비어 있음)
    └── fake.ts              인메모리 전송. 테스트 + 봇 토큰 없는 개발용
```

각 `core/*.ts`에는 같은 이름의 `.test.ts`가 있다. **새 모듈을 만들면 테스트도 같이 만든다.**

---

## 4. 작업 절차

### 4.1 새 기능 추가

```text
1. docs/architecture.md의 불변식(I1~I12) 중 영향받는 것을 확인한다
2. 실패하는 테스트를 쓴다 (어느 계층인지 먼저 정한다)
3. npx vitest run -t "<테스트 이름>" 으로 실제 실패를 확인한다
4. 최소 구현으로 통과시킨다
5. 리팩터링한다 (테스트는 계속 통과)
6. npm run check
7. 필요하면 docs/architecture.md의 모듈 맵/불변식/체크리스트를 갱신한다
```

### 4.2 어느 계층에 넣을지 판단하는 법

| 질문 | 예 → 계층 |
| --- | --- |
| 순수 계산/판단인가? | 청킹, 리댁션, 명령 파싱, 라우팅 → `core/` |
| 전송과 세션을 연결하는가? | 주입, 브로드캐스트, 상태 적용 → `bridge.ts` |
| 네트워크/파일/시계를 만지는가? | HTTP, 소켓, 설정 파일 읽기 → `transports/` 또는 `index.ts` |
| pi API를 호출하는가? | `sendUserMessage`, `ctx.ui`, `pi.on` → `index.ts` |

### 4.3 테스트 작성 규칙

- 테스트 이름은 **동작을 서술**한다: `"does not produce a degenerate chunk when a break appears very early"`
- `it("...")` 하나에 assertion 하나를 원칙으로 한다. 여러 개면 이름을 나눈다
- 경계값을 반드시 포함한다: 빈 입력, 최대값, 최소값, 초과값, 잘못된 타입
- **실패 케이스가 성공 케이스보다 중요하다.** 보안 관련 코드는 특히 그렇다
- `describe`는 대상/관심사로 묶는다: `describe("Bridge — pairing gate")`

### 4.4 테스트 헬퍼

```ts
// 결정적 난수: 원하는 숫자를 순서대로 공급
function digitSequence(...groups: string[]): () => number

// 전송: 인메모리. started/sent/edits를 관찰한다
const transport = new FakeTransport({ capabilities: { maxMessageLength: 40 } });
await transport.inject({ text: "hello", isDirect: true });

// 세션: pi 없이 브리지를 구동
const host = new FakeHost();   // clock, rng, idle, prompts[], notifications[], aborts를 제어
```

새 테스트는 이 두 헬퍼를 재사용한다. 실제 네트워크를 테스트에 넣지 않는다.

---

## 5. pi API 치트시트 (이 프로젝트가 실제로 쓰는 것만)

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
```

### 이벤트

| 이벤트 | 용도 | 주의 |
| --- | --- | --- |
| `session_start` | 브리지 생성 + 전송 시작 | **백그라운드 리소스는 여기서만 시작** |
| `session_shutdown` | 브리지 정지, 상태 초기화 | 멱등하게 |
| `before_agent_start` | `event.prompt` 캡처 (다이제스트용) | |
| `agent_start` | 턴 상태 초기화 | |
| `tool_execution_start` | 툴 이름 관찰, 진행 상황 1회 발행 | **인자 전송 금지** |
| `tool_execution_end` | 실행 툴 해제 | |
| `message_end` | 어시스턴트 최종 텍스트 캡처 | `role === "assistant"` 확인 |
| `agent_settled` | 최종 답변 브로드캐스트 | `agent_end`는 재시도/압축 전이라 부적합 |

### 메서드

| API | 용도 |
| --- | --- |
| `pi.sendUserMessage(text, { deliverAs })` | 원격 프롬프트 주입. **스트리밍 중 `deliverAs` 없으면 throw** |
| `pi.registerCommand(name, { description, handler })` | 로컬 `/connect` 명령 |
| `pi.getSessionName()` | 세션 이름 |
| `ctx.isIdle()` | 에이전트 유휴 여부 (라우팅의 busy 판정) |
| `ctx.abort()` | 원격 `abort` 명령 |
| `ctx.ui.notify(text, level)` | 로컬 알림 (페어링 코드 표시 포함) |
| `ctx.ui.setStatus(key, text)` | 푸터 상태 |
| `ctx.cwd` | 작업 디렉터리 |

`deliverAs` 규칙:
- `"steer"` — 현재 어시스턴트 턴의 툴 실행이 끝난 뒤, 다음 LLM 호출 전에 전달
- `"followUp"` — 툴 호출이 모두 끝날 때까지 대기 후 전달
- 생략 — 유휴할 때만 가능. 바쁘면 throw

---

## 6. 전송(어댑터) 추가 방법

`docs/architecture.md` §2(계약)와 §5(수용 체크리스트)를 먼저 읽는다.

```text
1. src/transports/<name>.ts 작성 — implements Transport
2. src/transports/index.ts의 FACTORIES에 팩토리 등록
   - create()는 미설정이면 null 반환, 설정이 잘못되면 throw
   - 자격증명은 env 변수에서 읽는다 (설정 파일에는 변수 이름만)
3. 실제 payload를 fixture로 저장한다 (토큰 마스킹)
4. 정규화 테스트 작성: isDirect, addressed, self-message 무시, 스레드 구분
5. conformance 체크리스트를 항목별로 통과시킨다
6. npm run check
7. README에 설정 방법(env 변수, 플랫폼 앱 설정 절차)을 추가한다
8. pi -e ./src/index.ts 로 수동 왕복 1회 확인
```

**하지 말 것**:
- 브리지나 코어에 전송별 분기 추가 (`if (transport === "telegram")`). 그건 capability로 표현해야 한다
- 리댁션/청킹/마크다운 변환을 어댑터에서 재구현
- 어댑터에서 `pi.*` 호출

---

## 7. 함정 (실제로 밟은 것들)

| 함정 | 증상 | 대응 |
| --- | --- | --- |
| 페어링 코드를 채팅으로 전송 | 인증이 무의미해짐 | 코드는 `pairingCodeNotice`로 터미널에만. 테스트 `I1` |
| 폴링 전송을 두 프로세스가 시작 | `getUpdates` 충돌, 메시지 유실 | 단일 인스턴스 락 필수 (G6) |
| 확장 팩토리에서 소켓/타이머 시작 | pi 시작이 멈추거나 좀비 프로세스 | `session_start`로 미룬다 |
| `agent_end`로 완료 알림 | 재시도/자동 압축 중에 알림이 나감 | `agent_settled` 사용 |
| 스트리밍 중 `deliverAs` 없이 주입 | throw | `isIdle()` 확인 + 레이스 가드 (`index.ts`) |
| 툴 인자를 진행 상황에 포함 | 토큰/파일 내용 유출 | 툴 이름만 전송 |
| 텍스트 검색으로 코드 수정 | 무관한 위치 오수정 | 편집은 정확한 문자열 일치, 검색은 시맨틱 도구 사용 |
| `exactOptionalPropertyTypes` 없이 선택 속성 | `{ threadId: undefined }`가 전송에 새어 들어감 | 스프레드로 조건부 구성: `...(x === undefined ? {} : { x })` |

---

## 8. 코드 스타일

- TypeScript strict + `noUncheckedIndexedAccess`. 배열 인덱싱 결과는 검사하거나 단언한다
- 파일 내 import는 **상대 경로 + `.js` 확장자** (`./core/types.js`) — ESM/`bundler` 해석
- 공개 함수는 export. 내부 헬퍼는 export하지 않는다 (`noUnusedLocals` 경고 방지)
- 함수는 하나의 책임. `switch` 대신 레코드 맵(`Record<Union, Fn>`)을 쓰면 exhaustiveness가 타입으로 보장된다
- 주석은 **왜**를 설명한다. 무엇을 하는지는 이름으로
- 이모지/과장된 표현 금지. 사용자에게 보이는 문자열은 간결한 영어 (원격 명령 응답 포함)
- 탭 들여쓰기, 큰따옴표

---

## 9. 커밋 / 리뷰

### 커밋 메시지

```text
<type>(<scope>): <동작 서술>

예:
test(core): add UTF-8 byte-budget chunking cases
feat(core): keep pairing codes out of messenger payloads
fix(bridge): route commands while the agent is busy
docs(agents): document the transport conformance checklist
```

`type`: `feat` | `fix` | `test` | `refactor` | `docs` | `chore`
`scope`: `core` | `bridge` | `config` | `transports` | `docs` | `pi-adapter`

### 리뷰 체크리스트

- [ ] 실패하는 테스트를 먼저 썼고, 실패를 실제로 확인했다
- [ ] `npm run check` 통과
- [ ] `core/`에 I/O나 숨은 시간/난수가 없다
- [ ] `index.ts`에 정책이 들어가지 않았다
- [ ] 보안 불변식(I1~I12)이 유지된다
- [ ] 새 동작마다 테스트가 있고, 테스트 이름이 동작을 서술한다
- [ ] 필요하면 `docs/`가 갱신되었다

---

## 10. 현재 상태

| 항목 | 상태 |
| --- | --- |
| 코어 (라우팅/페어링/리댁션/청킹/마크다운/다이제스트) | ✅ 완료, 테스트로 고정 |
| 브리지 오케스트레이션 | ✅ 완료 |
| 설정 검증 | ✅ 완료 |
| pi 어댑터 셸 + 로컬 `/connect` 명령 | ✅ 완료 (타입체크만) |
| 테스트 | 164 통과 / typecheck 0 에러 |
| Telegram 전송 | ❌ 미구현 (v1) |
| Discord / Slack 전송 | ❌ 미구현 (v2/v3) |
| 단일 인스턴스 락 | ❌ 미구현 (v1, G6) |
| 맥락 병합 | ❌ 설계 미확정 (G2) |
| 프롬프트 인젝션 방어 | ❌ 미구현 (G1) |

전체 로드맵과 미해결 과제: `docs/architecture.md` §9, `docs/feasibility.md` §6.

### 다음에 할 일 (권장 순서)

1. **Telegram 어댑터 + 단일 인스턴스 락** — 롱폴링, 4096 bytes, HTML. fixture 기반 정규화 테스트
2. **핸드오프 명시화** — `/connect handoff` / `/connect release`, 그리고 터미널 복귀 시 맥락 병합 방식 확정(G2)
3. **진행 상황 편집(edit-in-place)** — `capabilities.edit` + `editKey`
4. **conformance 테스트 키트** — `src/transports/transport-contract.test.ts` (2번째 어댑터가 생기면 즉시)
5. **리플레이 하네스** — 엔벨로프 record/replay (G5)

---

## 11. 판단이 필요할 때

- 제품 방향/차별점: `docs/feasibility.md`의 §4(차별점)와 §7(결정 필요 사항)
- 구조/계약: `docs/architecture.md`의 §2(계약), §3(불변식), §5(체크리스트)
- "이걸 어디에 넣지?" → §4.2 표
- "왜 이렇게 되어 있지?" → 대부분 문서와 테스트 주석에 이유가 있다. 없으면 그건 개선 대상이다

**애매하면 코어에 순수 함수로 넣고 테스트를 쓴다.** 이 저장소에서 가장 안전한 선택이다.
