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
예외는 `src/index.test.ts`(배선 테스트 36개)다. 이 테스트는 팩토리를 가짜 `ExtensionAPI`로 구동해 **이벤트 이름·명령 등록·설정 오류 전파**를 검증한다. 로직을 검증하려는 테스트를 여기 추가하려 한다면, 그 로직을 먼저 코어로 옮겨라.

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

### 환경변수

| 변수 | 용도 |
| --- | --- |
| `PI_BOT_CONNECT_DEBUG` | `1`/`true`이면 어댑터 로그(console) 활성화 |
| `PI_BOT_CONNECT_CONFIG` | 설정 파일 경로를 **강제**한다. 전역/프로젝트 탐색을 건너뛴다. 테스트·CI에서 개발자의 실제 설정에 의존하지 않기 위한 용도 |
| `PI_BOT_CONNECT_STATE` | 상태 파일 경로를 **강제**한다. 락 디렉터리는 이 파일의 상위 디렉터리를 따른다 |
| `PI_DISCORD_TOKEN` | Discord 봇 토큰. 설정의 `tokenEnv`로 이름 변경 가능. **값은 설정 파일에 쓰지 않는다** |
| `PI_TELEGRAM_TOKEN` (예정) | Telegram 봇 토큰 |

`src/index.test.ts`는 항상 `PI_BOT_CONNECT_CONFIG`와 `PI_BOT_CONNECT_STATE`로 임시 파일을 가리킨다. 테스트에서 `loadBridgeConfig`를 직접 쓰지 말고 이 방식을 따르라. Discord 전송 테스트는 토큰 환경변수를 직접 지우고 복원한다 (`src/transports/index.test.ts` 참조).

---

## 3. 파일 지도

```text
src/
├── index.ts                 [껍데기] pi 어댑터. 커버리지 제외. 정책 금지
├── index.test.ts            배선 테스트 36개 — 가짜 ExtensionAPI로 팩토리를 구동
├── bridge.ts                오케스트레이션. 전송↔코어↔세션 연결 + 송신 파이프라인
├── bridge.test.ts           52 테스트 — 전 구간 시나리오 (FakeTransport + FakeHost)
├── config.ts                설정 파일 검증 (신뢰할 수 없는 입력)
├── LICENSE / CHANGELOG.md / .editorconfig   배포 메타데이터
├── .github/workflows/ci.yml  check(22.19·24) + 태그 기반 publish (액션은 SHA 고정)
├── file-store.ts            상태 영속화(원자적 쓰기, chmod 600). 세션별 격리
├── file-store.test.ts       22 테스트 (실제 임시 디렉터리 사용)
├── lock.ts                  단일 인스턴스 락. O_EXCL + 생존/만료 회수 + 토큰 검증 해제
├── lock.test.ts             17 테스트
├── core/                    ★ 완전 순수. 여기가 제품의 본체
│   ├── types.ts             Envelope, Transport, BridgeConfig, Logger
│   ├── router.ts            (envelope, state) → action[]. 모든 라우팅 결정
│   ├── commands.ts          원격 명령 파싱 + 실행 (문자열 반환, I/O 없음)
│   ├── pairing.ts           챌린지 생성/검증 + 렌더링 (코드 유출 방지)
│   ├── notices.ts           브리지가 스스로 보내는 사용자용 문자열
│   ├── chunk.ts             UTF-8 안전 청킹
│   ├── markdown.ts          전송 flavor별 마크다운 변환
│   ├── redact.ts            비밀값 리댁션
│   ├── digest.ts            작업 다이제스트(공유 카드) 생성
│   ├── message.ts           pi 메시지에서 표시 텍스트/툴 출력 추출
│   ├── work.ts              git numstat/브랜치 + 테스트 러너 요약 파서
│   ├── text.ts              멘션 제거, 접두사 매칭, 이스케이프
│   └── logger.ts            JSON Lines 로거 + MemoryLogSink(테스트)
└── transports/
    ├── index.ts             전송 팩토리 레지스트리 (coverage 제외)
    ├── index.test.ts        팩토리 배선 테스트
    ├── fake.ts              인메모리 전송. 테스트 + 봇 토큰 없는 개발용
    └── discord/
        ├── normalize.ts     ★ 순수. Discord payload → Envelope
        ├── normalize.test.ts
        ├── gateway.ts       HELLO/IDENTIFY/RESUME/하트비트/재접속 상태머신
        ├── gateway.test.ts  가짜 소켓 + 가짜 스케줄러
        ├── rest.ts          fetch 4종 + 레이트리밋 재시도
        ├── index.ts         전송 본체: 신원 확인 → 락 → 게이트웨이
        ├── index.test.ts
        └── doubles.ts       공유 테스트 더블 (coverage 제외)
```

**Discord 전송이 참조 구현이다.** 새 전송을 추가할 때 구조를 그대로 따라라: 순수 정규화 모듈 + 주입 가능한 I/O + 얇은 조합.

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

Discord 계열은 `src/transports/discord/doubles.ts`를 쓴다:

```ts
const rest = new FakeRest();            // /users/@me, /gateway/bot, create/edit
const sockets: FakeSocket[] = [];       // gateway가 연 소켓을 순서대로 수집
const scheduler = new FakeScheduler();  // 하트비트/재접속 타이머를 수동으로 발화
const transport = new DiscordTransport({ token, lockDir, logger, rest,
  createSocket: socketFactory(sockets), scheduler });
```

**주의**: 전송 `start()`는 락 때문에 **실제 파일 I/O**를 한다. `setImmediate` 한 번으로 소켓을 기대하면 전체 스위트 실행 시 실패한다. `waitForSocket`처럼 **실시간 데드라인**으로 폴링하라 (`src/transports/discord/index.test.ts` 참조).

스토어를 쓰는 테스트는 `afterEach`에서 **반드시 `flush()`** 하라. 쓰기가 뒤에서 일어나므로 임시 디렉터리 삭제와 경합한다 (`src/file-store.test.ts` 참조).

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
1. src/transports/<name>/ 디렉터리를 만든다 (Discord 구조를 따른다)
   - normalize.ts: payload → Envelope. 순수. 네트워크/시계/토큰 없음
   - gateway/폴링: I/O. 소켓과 타이머를 주입받는다
   - rest.ts: HTTP. fetch를 주입받는다
   - index.ts: 신원 확인 → 락 → 수신 → send(). 가능하면 diagnose()도
2. src/transports/index.ts의 FACTORIES에 팩토리 등록
   - 미설정이면 null 반환, `enabled: true`인데 자격증명이 없으면 throw
   - 자격증명은 env 변수에서 읽는다 (설정 파일에는 변수 이름만)
3. 실제 payload를 fixture로 저장한다 (토큰 마스킹)
4. 정규화 테스트 작성: isDirect, addressed, 자기 메시지 무시, 다른 봇 무시, 스레드 구분
5. conformance 체크리스트(docs/architecture.md §5)를 항목별로 통과시킨다
6. npm run check — 그리고 **전체 스위트를 3회 이상 반복**해 타이밍 플레이크를 확인한다
7. README에 설정 방법(env 변수, 플랫폼 앱 설정 절차)을 추가한다
8. pi -e ./src/index.ts 로 수동 왕복 1회 확인
```

계층 분리가 곧 테스트 가능성이다. Discord 전송은 다음을 주입받기 때문에 봇 토큰·네트워크 없이 전 구간이 검증된다: `rest`(REST API), `createSocket`(WebSocket), `scheduler`(타이머), `fetchImpl`(첨부 다운로드).

### 첨부를 지원하려면

`capabilities.attachments`는 "운반할 수 있다"는 선언일 뿐이다. 실제 전달에는 세 가지가 필요하다:

1. `Transport.fetchAttachment(attachment): Promise<FetchedAttachment>` 구현 — 자체 크기 상한을 적용하고, 선언된 크기가 아니라 **다운로드한 바이트**로 검사한다
2. 호스트가 `acceptsAttachments: true` (pi 어댑터는 `ImageContent`를 넣을 수 있으므로 true)
3. `config.attachments` 정책(`allowedMediaTypes`, `maxCount`, `maxBytes`)

둘 중 하나라도 빠지면 라우터가 `unsupported`로 거부한다. **프롬프트를 지어내면 안 된다.**

**하지 말 것**:
- 브리지나 코어에 전송별 분기 추가 (`if (transport === "telegram")`). 그건 capability로 표현해야 한다
- 리댁션/청킹/마크다운 변환을 어댑터에서 재구현
- 어댑터에서 `pi.*` 호출

---

## 7. 함정 (실제로 밟은 것들)

| 함정 | 증상 | 대응 |
| --- | --- | --- |
| 페어링 코드를 채팅으로 전송 | 인증이 무의미해짐 | 코드는 `pairingCodeNotice`로 터미널에만. 테스트 `I1` |
| 같은 봇으로 두 프로세스가 연결 (Discord) | 나중 게이트웨이가 앞 것을 끊어 메시지가 오락가락 | 봇 ID 기준 단일 인스턴스 락 (`lock.ts`) |
| **Message Content Intent 미활성** | 봇이 메시지를 받지만 `content`가 빈 문자열 | Developer Portal → Bot → Privileged Gateway Intents. `diagnose()`와 README에 명시 |
| 자기/다른 봇 메시지를 그대로 주입 | 무한 루프. 두 봇이 서로에게 응답 | `normalize`에서 `author.bot`/`webhook_id`/자기 id를 skip. `last skip`을 `diagnose()`에 노출 |
| 확장 팩토리에서 소켓/타이머 시작 | pi 시작이 멈추거나 좀비 프로세스 | `session_start`로 미룬다 |
| 전송 시작 중 락을 남기고 실패 | 이후 모든 세션이 "다른 프로세스가 락을 보유"로 막힘 | `start()` 실패 경로에서 반드시 `lock.release()`. 테스트로 고정됨 |
| 게이트웨이 READY를 무한 대기 | 시작이 영원히 매달림 | `readyTimeoutMs`(기본 20초) 후 fail |
| `agent_end`로 완료 알림 | 재시도/자동 압축 중에 알림이 나감 | `agent_settled` 사용 |
| 스트리밍 중 `deliverAs` 없이 주입 | throw | `isIdle()` 확인 + 레이스 가드 (`index.ts`) |
| 툴 인자를 진행 상황에 포함 | 토큰/파일 내용 유출 | 툴 이름만 전송 |
| 이미지가 없는데 "이미지를 봐라"고 주입 | 모델이 존재하지 않는 첨부를 설명하려 함 | 호스트가 `acceptsAttachments: false`면 라우터가 `unsupported`로 거부 |
| 테스트에서 `setImmediate` 한 번으로 비동기 완료를 기대 | 단독 실행은 통과, 전체 스위트는 실패 (libuv 스레드풀 경합) | 실시간 데드라인 폴링. §4.4 참조 |
| 텍스트 검색으로 코드 수정 | 무관한 위치 오수정 | 편집은 정확한 문자열 일치로, 검색은 `rg`로. (pi-lens를 제거해서 의미 기반 심볼 검색 도구는 없다) |
| `exactOptionalPropertyTypes` 없이 선택 속성 | `{ threadId: undefined }`가 전송에 새어 들어감 | 스프레드로 조건부 구성: `...(x === undefined ? {} : { x })` |
| **pi 문서 예제와 실제 타입 불일치** | 이미지를 `{type:"image",source:{type:"base64",mediaType,data}}`로 넣으면 컴파일 실패 | 실제 `ImageContent`는 **평평하다**: `{ type: "image", data, mimeType }`. `docs/extensions.md` 예제는 오래되었다. **컴파일러를 믿어라** |
| 첨부를 호스트만 보고 허용 | 전송이 바이트를 못 주는데 프롬프트만 전달되어 이미지 없는 텍스트가 됨 | 두 조건을 AND: `host.acceptsAttachments && transport.fetchAttachment !== undefined` (`Bridge.attachmentPolicy`) |
| 첨부 크기를 선언값만 믿음 | `content-length`는 힌트다. 실제로 더 큰 파일이 올 수 있다 | 다운로드 후 base64 길이로 다시 검사 (`bridge.ts`, `discord/index.ts`) |
| 스트리밍 중 진행 상황을 매 툴마다 새 메시지로 | 채팅 도배, 레이트리밋 | `publishProgress`가 스로틀 + `editKey`로 같은 카드 갱신. 턴마다 `beginTurn()` |
| 테스트 러너 출력을 추측으로 파싱 | 버전이 바뀌면 조용히 틀린다 | `core/work.ts`의 패턴을 fixture로 고정하고, 못 찾으면 exit status로 폴백 |
| **발행 직후 레지스트리 조회가 404/누락** | 발행이 실패한 줄 알고 되돌리려 함 | npm 전파에 몇 분 걸린다. **진짜는 워크플로 로그**다: `Publishing to … with tag …`, `Signed provenance statement`, `+ pkg@version`을 확인하고 `npm dist-tag ls`로 재확인하라 |
| 이미 발행된 버전에 태그를 붙여 재발행 시도 | npm이 거부한다. provenance는 다시 쓸 수 없다 | `release.yml`이 발행 전에 레지스트리를 확인해 이미 있으면 publish를 건너뛰고 GitHub Release만 만든다 |

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
| pi 어댑터 셸 + 로컬 `/connect` 명령 | ✅ 완료 (배선 테스트 36개) |
| 상태 영속화 (세션별 격리) | ✅ 완료 |
| 단일 인스턴스 락 | ✅ 완료 |
| `/connect doctor` | ✅ 완료 |
| **Discord 전송** | ✅ 완료 (봇 SDK 없이 게이트웨이 직접 구현) |
| 테스트 | 416 통과 / typecheck 0 에러 / 3회 연속 안정 |
| **첨부(이미지) 전달** | ✅ 완료 (양쪽 capability 확인 + 다운로드 후 크기 재검사) |
| **진행 상황 edit-in-place** | ✅ 완료 (턴당 카드 1개, 스로틀, 편집 실패 시 폴백) |
| **추론 진행 카드 + typing** | ✅ 완료 (툴 없는 구간은 `thinking…`, 선택적 `typing()`은 베스트 에포트) |
| **긴 응답 분할** | ✅ 완료 (전송 한도 단위로 분할, `maxChunks` 상한 + 잘림 안내) |
| **다이제스트 데이터 소스** | ✅ 완료 (브랜치 / 변경 파일 / 테스트 결과) |
| Telegram · Slack 전송 | ❌ 미구현 |
| TODO를 다이제스트에 포함 | ❌ 미구현 — 어떤 TODO 확장의 형태를 읽을지 결정 필요 |
| 프롬프트 인젝션 방어 | ❌ 미구현 (G1) |
| npm 배포 | ✅ 0.1.0 공개. 다음 릴리스는 `package.json`의 `0.1.1`을 태그하면 CI가 provenance와 함께 발행 |
| CI / 릴리스 파이프라인 | ✅ `master` push + PR에서 CI, `v*` 태그에서 OIDC 발행. `0.1.1-rc.1`로 검증 완료 |
| **실제 Discord 왕복** | ❌ 미검증 — 폐쇄망으로 보류. 첫 실사용이 진짜 통합 테스트 |

전체 로드맵과 미해결 과제: `docs/architecture.md` §9, `docs/feasibility.md` §6.

### 다음에 할 일 (권장 순서)

1. **프롬프트 인젝션 방어** (G1) — 유일하게 남은 보안 공백. 채팅을 다른 사람과 공유하기 **전에** 필요하다. 원격 턴에서만 도구 집합을 제한하는 opt-in 방식이 가장 작은 변경이다
2. **conformance 테스트 키트** — `src/transports/transport-contract.test.ts`. Telegram 착수 시점
3. **Telegram 전송** — 롱폴링, 4096 bytes, HTML. `lock.ts` 재사용
4. **TODO 데이터 소스** — 세션 엔트리에서 읽되, 형태를 먼저 확인하고 방어적으로 파싱
5. **리플레이 하네스** (G5) — 엔벨로프 record/replay

---

## 11. 릴리스

### 배포 레이아웃

```text
package.json      pi 매니페스트(`./src/index.ts`) + files 화이트리스트
LICENSE           MIT (npm이 항상 포함)
CHANGELOG.md      Keep a Changelog. npm은 자동 포함하지 않으므로 files에 명시해야 한다
.editorconfig     포맷 규약 (탭, LF, final newline)
.github/workflows/ci.yml       push/PR → check(Node 22.19·24) + pack:verify
.github/workflows/release.yml  태그 push → 태그/버전 검증 → npm publish --provenance
scripts/verify-pack.mjs        배포 게이트. tarball 내용 검증 (배포본에 포함되지 않는다)
src/              배포 대상. TS를 그대로 올린다 — pi가 jiti로 로드하므로 빌드 단계가 없다
docs/             분석·아키텍처 문서
```

**런타임 의존성은 0개다.** `@earendil-works/pi-coding-agent`만 peer dependency고
빌드 산출물이 없다. 이 상태를 유지해라 — 의존성이 늘면 감사 범위가 늘어난다.
`dependencies`에 무언가 추가해야 한다면 AGENTS.md §0의 정체성과 충돌하는지 먼저 따져라.

### 버전 규칙

- `0.y.z` 동안 공개 표면(설정 스키마·원격 명령 집합·`Transport` 계약)은 MINOR에서 바뀔 수 있다. README와 CHANGELOG에 이 사실을 유지한다
- `Transport`에 **필수** 멤버를 추가하는 것은 breaking이다. 선택 멤버 추가는 아니다
- 설정 파일에 키를 추가하는 것은 additive이며 항상 기본값을 제공한다
- **프리릴리스는 `next` dist-tag로 발행된다** (`0.1.1-rc.1`처럼 하이픈이 있으면). `latest`를 덮지 않는다
- 이미 발행된 버전은 재발행할 수 없고 provenance도 다시 쓸 수 없다. 버전을 올려서 내라

### 절차

```text
1. npm run check — 전체 통과 확인
2. npm run pack:verify — tarball이 기대한 파일만 담는지 확인
3. CHANGELOG.md의 [Unreleased]를 새 버전 섹션으로 옮기고 날짜를 적는다
4. package.json의 version을 올린다 (CHANGELOG와 일치)
5. 커밋: chore(release): 0.2.0
6. 태그: git tag -a v0.2.0 -m v0.2.0 && git push origin master --follow-tags
   → release.yml이 검사한 뒤 npm publish --provenance 를 수행한다
```

`chore(release): <version>` 커밋과 `v<version>` 태그를 반드시 짝지어라.
release 워크플로의 첫 job이 **태그와 `package.json` version이 다르면 실패**한다.

로컬에서 급히 발행해야 할 때는 `npm publish`가 가능하지만 **provenance가 붙지 않는다.**
공급망 서명을 원하면 CI 경로를 쓴다. `prepublishOnly`가 `npm run check`를 실행하므로
깨진 트리가 발행되는 일은 없다.

### CI / CD

| 워크플로 | 트리거 | 하는 일 |
| --- | --- | --- |
| `ci.yml` | `master`·`main` push, PR | Node 22.19와 24에서 `npm run check`, 그리고 `npm run pack:verify` |
| `release.yml` | `v*` 태그 push | 태그↔version↔`private` 검증 → `npm run check` → `pack:verify` → 레지스트리에 이미 있는지 확인 → (없으면) `npm publish --provenance` → GitHub Release |

`release.yml`은 **멱등하다.** 이미 npm에 있는 버전을 태그하면 발행을 건너뜀고
GitHub Release만 만든다. 이미 발행된 버전은 재발행이 거부되고 provenance도 다시 쓸 수 없다.
(그래서 손으로 발행한 버전에 나중에 태그를 붙이는 것이 안전하다.) GitHub Release 생성은
이미 있으면 건너뛴다.

**provenance는 CI 발행에만 붙는다.** 로컬 `npm publish`는 레지스트리 서명만 생긴다.
서명된 출처가 필요하면 발행 전에 워크플로가 통과되어야 한다 — `npm audit signatures`로
설치 트리를 감사할 수 있다.

**기본 브랜치는 `master`다.** `main`도 함께 트리거에 넣어 둔 건 이름을 바꿀 때 CI가 조용히 꺼지지 않게 하기 위함이다.

발행 인증은 두 가지를 모두 지원한다 (`Configure npm authentication` 스텝):

| 방식 | 준비 |
| --- | --- |
| **npm access token** | 저장소 secret `NPM_TOKEN`에 npm 토큰을 넣는다. 가장 간단하고 오늘 바로 동작한다 |
| **trusted publishing (OIDC)** | 토큰이 없다. npmjs.com의 패키지 설정에서 Trusted Publisher로 이 저장소와 **workflow 파일명 `release.yml`, environment `npm`**을 등록한다. npm >= 11.5.1이 필요해 워크플로가 자동으로 올린다 |

장기 토큰이 없으므로 **trusted publishing이 더 낫다.** 다만 패키지가 npm에 존재한 뒤에만 설정할 수 있어서, 첫 발행은 토큰이나 로컬 `npm publish`로 해야 한다.

**현재 이 저장소는 trusted publishing으로 동작한다** (secret 없음 → OIDC 경로). `0.1.1-rc.1`로 검증했고 다음이 확인되었다:

```
Publishing to https://registry.npmjs.org/ with tag next and public access
publish Signed provenance statement with source and build information from GitHub Actions
publish Provenance statement published to transparency log: logIndex=…
+ pi-bot-connect@0.1.1-rc.1
```

소비자 측 검증(`npm audit signatures`)도 통과하고, attestation에 `repo`·`workflow path`·`ref`가 기록된다.
**environment 이름은 반드시 npmjs.com 설정과 일치해야 한다.** OIDC subject에 포함되므로
불일치하면 발행이 거부된다 (`environment: npm`이면 npmjs.com도 `npm`).

공급망 보호 조치 (바꾸지 말 것):

- 액션은 **커밋 SHA로 고정**한다. `@v4` 같은 태그는 움직일 수 있다
- **npm 캐시를 어디에도 쓰지 않는다.** 캐시 오염이 발행 경로로 들어오는 걸 막는다
- `persist-credentials: false` — checkout이 토큰을 `.git/config`에 남기지 않게 한다
- 발행은 태그에서만. 브랜치 push로는 발행되지 않는다

### 발행 전 체크리스트

- [ ] `npm run pack:verify`가 통과한다 (필수 파일 존재 + 개발 전용 파일 부재 + `pi` 매니페스트 경로 유효성)
- [ ] 발행한 뒤 **레지스트리에서 받은 tarball을 로컬 검증본과 대조**했다. `npm pack <name>@<version>`으로 받아 파일 목록을 비교한다
- [ ] tarball을 실제로 설치해 로드되는지 확인했다: `npm run pack` → 임시 디렉터리에서 `pi install npm:<name>@<version> -l` → `pi --list-models --offline`이 0으로 끝난다
- [ ] 발행 후 `git tag -a v<version> -m v<version>` 으로 **같은 버전에 태그를 붙였다** (GitHub Release가 생기고, 다음 릴리스의 기준점이 된다)
- [ ] `git ls-files | grep -iE 'token|secret|\.env'`가 **가짜 테스트 fixture 외에는** 비어 있다
- [ ] CHANGELOG에 `Added`/`Changed`/`Fixed`/`Security` 중 해당 항목이 있다
- [ ] README의 “지원 범위”가 실제 `engines`·peer 범위와 일치한다

---

## 12. 판단이 필요할 때

- 제품 방향/차별점: `docs/feasibility.md`의 §4(차별점)와 §7(결정 필요 사항)
- 구조/계약: `docs/architecture.md`의 §2(계약), §3(불변식), §5(체크리스트)
- "이걸 어디에 넣지?" → §4.2 표
- "왜 이렇게 되어 있지?" → 대부분 문서와 테스트 주석에 이유가 있다. 없으면 그건 개선 대상이다

**애매하면 코어에 순수 함수로 넣고 테스트를 쓴다.** 이 저장소에서 가장 안전한 선택이다.
