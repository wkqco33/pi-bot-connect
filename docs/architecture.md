# 아키텍처

## 1. 한 장 요약

```text
┌──────────────────────── src/index.ts (pi 어댑터, I/O 껍데기) ─────────────────────────┐
│  pi events ──► BridgeHost 구현 ──► Bridge                                             │
│  pi API   ◄── sendUserMessage / abort / notify ◄── Bridge                             │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                        │
┌──────────────── src/bridge.ts (오케스트레이션, 순수 + 주입된 I/O) ───────────────────┐
│  onEnvelope ──► route() ──► applyAction() ──► send()/publish()                        │
│                 (core/router)   (commands, pairing)  (redact→markdown→chunk)          │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                        │
┌──────────────── src/core/* (완전 순수: pi도 네트워크도 모른다) ──────────────────────┐
│  types · router · commands · pairing · chunk · markdown · redact · digest · message    │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                        │
┌──────────────── src/transports/* (유일한 I/O 경계) ─────────────────────────────────┐
│  discord (구현) · fake (테스트) · telegram(TODO) · slack(TODO)                          │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

**의존 방향은 항상 위→아래다.** `core`가 `bridge`를, `bridge`가 `index.ts`를 import 하면 설계 위반이다.

---

## 2. 전송 계약 (Adapter Contract)

메신저를 추가한다는 것은 `Transport` 하나를 구현한다는 뜻이다. 그 외에는 아무것도 바꾸지 않는다.

```ts
interface Transport {
  readonly id: string;                          // "telegram" | "discord" | ...
  readonly capabilities: TransportCapabilities;  // 길이/마크다운/스레드/편집 가능 여부
  start(handler: EnvelopeHandler): Promise<void>; // 수신 시작. handler로 Envelope 전달
  stop(): Promise<void>;                         // 멱등하게 정리
  send(message: OutboundMessage): Promise<SendReceipt>;
}
```

### 2.1 코어가 전송에 보장하는 것

전송 어댑터는 다음을 **직접 구현하지 않는다**. 브리지가 대신 처리한다.

- 본문 리댁션 (`redactSecrets`)
- 마크다운 변환 (전송의 `capabilities.markdown`에 맞춰)
- 길이 제한 청킹 (`capabilities.maxMessageLength`, `lengthUnit`)
- 인증/페어링 판정
- 명령 파싱/실행
- 일시정지 상태 존중

즉 어댑터의 `send()`는 "바이트를 플랫폼에 넘긴다"만 하면 된다.

### 2.2 전송이 코어에 보장해야 하는 것

1. **`Envelope` 외의 필드를 만들지 않는다.** 플랫폼 고유 payload는 `raw`에만 넣는다.
2. **`isDirect`를 정확히 채운다.** DM/채널 구분이 addressing 정책의 유일한 근거다.
3. **`addressed`를 정확히 채운다.** 봇 멘션/답장 여부. 채널에서 오작동을 막는 핵심이다.
4. **자격증명은 환경변수에서 읽는다.** 설정 파일에는 env 변수 *이름*만 저장한다.
5. **`start()`는 백그라운드 리소스를 만들고, `stop()`은 그것을 정리한다.** `stop()`은 두 번 불려도 안전해야 한다.
6. **재연결/백오프는 어댑터 책임이다.** 코어는 재시도를 하지 않는다.
7. **첨부를 지원하려면 `fetchAttachment`를 구현해야 한다.** `capabilities.attachments: true`는 운반 가능 선언일 뿐이고, 실제 전달 여부는 브리지가 두 capability를 AND해서 결정한다. `mediaType`은 **선언값이 아니라 응답이 실제로 준 content type**을 보고해야 한다.
8. **conformance 테스트를 통과한다** (아래 5장).
9. **진행 표시를 지원하려면 `typing()`을 구현한다.** 선택 멤버다. 브리지는 실패를 삼키고(베스트 에포트), 어댑터 스스로 호출 빈도를 제한해야 한다. `typing()`이 없으면 아무 일도 일어나지 않아야 한다.

### 2.3 capability 예시

| 전송 | maxMessageLength | lengthUnit | markdown | threads | edit |
| --- | --- | --- | --- | --- | --- |
| fake | 4000 | chars | markdown | false | false |
| discord | 2000 | chars | markdown | false | true |
| telegram | 4096 | bytes | html | false | true |
| slack | 4000 | chars | mrkdwn | true | true |

Discord는 스레드에서 `channel_id`가 스레드 자체의 id이므로 `conversationId`가 자동으로 분리된다. 별도 `threadId` 추적이 필요 없어 `threads: false`로 두었다(부모 채널과의 관계를 다루지 않는다는 뜻). `attachments: true`는 전송이 첨부를 **운반할 수 있다**는 뜻이며, 호스트가 그것을 모델에 전달할 수 있는지와는 별개다.

---

## 3. 코어 불변식 (Invariants)

변경 시 반드시 테스트를 함께 수정해야 하는 규칙들이다.

| # | 불변식 | 강제하는 테스트 |
| --- | --- | --- |
| I1 | 페어링 코드는 메신저로 절대 나가지 않는다. 로컬 터미널에만 표시된다. | `core/pairing.test.ts`, `bridge.test.ts` |
| I2 | 프롬프트 본문은 로그에 남지 않는다. | `bridge.test.ts` |
| I3 | 모든 송신 본문은 리댁션을 거친다. | `redact.test.ts`, `bridge.test.ts` |
| I4 | 청킹은 UTF-8 경계(서로게이트 쌍)를 깨지 않는다. | `chunk.test.ts` |
| I5 | 청크를 합치면 원문과 정확히 일치한다(손실·중복 없음). | `chunk.test.ts` |
| I6 | 인증되지 않은 사용자의 메시지는 절대 프롬프트로 승격되지 않는다. | `router.test.ts`, `bridge.test.ts` |
| I7 | 미인증 상태에서 채널 잡담은 무시된다(무응답). | `router.test.ts`, `bridge.test.ts` |
| I8 | 명령은 에이전트가 바쁠 때도 처리된다. 프롬프트만 대기열로 간다. | `router.test.ts`, `bridge.test.ts` |
| I9 | 일시정지된 대화에는 프롬프트도 브로드캐스트도 전달되지 않는다. | `bridge.test.ts` |
| I10 | 설정 파일은 비밀값을 담을 수 없다(env 변수 이름만). | `config.test.ts` |
| I11 | 툴 인자/출력은 원격으로 전송되지 않는다(툴 이름만). | `index.ts` 설계 + 리뷰 |
| I12 | 신뢰 단위는 `transport:userId`다. 맨 userId로는 신뢰하지 않는다. | `bridge.test.ts` |
| I13 | 호스트와 전송이 **둘 다** 첨부를 지원할 때만 전달한다. 아니면 프롬프트를 지어내지 않고 거부한다. | `router.test.ts`, `bridge.test.ts` |
| I14 | 봇 자신과 다른 봇·웹훅의 메시지는 무시한다(무한 루프 방지). | `normalize.test.ts`, `discord/index.test.ts` |
| I15 | 봇 자격증명당 프로세스는 하나다. 시작 실패 시 락을 남기지 않는다. | `lock.test.ts`, `discord/index.test.ts` |
| I16 | 전송이 시작에 실패해도 세션은 죽지 않는다. 이유는 `doctor`에 노출된다. | `bridge.test.ts`, `index.test.ts` |
| I17 | 신뢰·일시정지·브로드캐스트 대상은 세션별로 격리된다. | `file-store.test.ts`, `index.test.ts` |
| I18 | `diagnose()`는 토큰을 포함하지 않는다. | `discord/index.test.ts`, `lock.test.ts` |
| I19 | 첨부 크기는 선언값이 아니라 다운로드한 바이트로 검사한다. | `bridge.test.ts`, `discord/index.test.ts` |
| I20 | 진행 상황은 턴당 메시지 하나를 갱신한다. 툴 호출마다 새 메시지를 보내지 않는다. | `bridge.test.ts` |
| I21 | 편집이 거부되면 새 메시지로 폴백하며, 카드 핸들은 재사용되지 않는다. | `bridge.test.ts` |
| I22 | 한 번의 송신 본문은 `maxChunks`개를 넘지 않는다. 초과분은 조용히 버리지 않고 잘렸다고 알린다. | `chunk.test.ts`, `bridge.test.ts` |
| I23 | 툴 이벤트가 없는 추론 구간에도 "thinking…" 카드가 표시된다. | `progress.test.ts`, `bridge.test.ts` |
| I24 | `typing()` 실패는 턴을 실패시키지 않는다. 없거나 거부되면 그냥 진행한다. | `bridge.test.ts`, `discord/index.test.ts` |
| I25 | 첨부의 media type은 선언값이 아니라 실제로 받은 바이트의 content type으로 재검사한다. | `bridge.test.ts`, `discord/index.test.ts` |

---

## 4. 테스트 전략

### 4.1 계층별 테스트

| 계층 | 방식 | 현재 |
| --- | --- | --- |
| `core/*` | 순수 함수 단위 테스트. 결정적 rng/clock 주입 | 182 테스트 |
| `bridge.ts` | `FakeTransport` + `FakeHost`로 전 구간 시나리오 | 54 테스트 |
| `config.ts` | 신뢰할 수 없는 JSON 검증 테이블 테스트 | 30 테스트 |
| `index.ts` | 타입체크 + 배선 테스트(가짜 `ExtensionAPI`로 팩토리 구동). **커버리지 제외** | 36 테스트 |
| `transports/*` | 계약 conformance + 플랫폼별 payload fixture | 86 테스트 |

### 4.2 결정성 확보 방법

시간과 난수를 전부 주입한다. 코어에는 `Date.now()`나 `Math.random()`이 단 한 곳도 없다.

```ts
// 코어
route({ ..., now: input.now, random: input.random });

// 테스트
const decision = decidePairing({ ..., now: 10, random: digitSequence("987654") });
```

### 4.3 커버리지 제외 대상과 이유

- `src/index.ts` — pi API 호출만 하는 껍데기. 로직이 들어가면 그 로직을 코어로 옮겨야 한다.
- `src/transports/index.ts` — 현재 빈 레지스트리.

`vitest.config.ts`의 `coverage.exclude`에 명시되어 있다. **제외 목록에 파일을 추가하려면 그 파일에서 로직을 코어로 옮기는 것이 먼저다.**

### 4.4 왜 `FakeTransport`가 제품에 포함되는가

`src/transports/fake.ts`는 테스트 전용이 아니라 **개발 도구**다.

- 봇 토큰 없이 전 구간 동작 확인
- 신규 어댑터 개발 시 기준 구현(reference implementation)
- record/replay 하네스의 기반 (v2 로드맵)

따라서 `src/`에 두고 타입체크 대상에 포함한다.

---

## 5. 전송 어댑터 수용 체크리스트 (Conformance)

새 어댑터는 다음을 모두 만족해야 머지 가능하다. (v1에서 `src/transports/transport-contract.test.ts`로 자동화한다)

#### 계약
- [ ] `id`가 소문자 단일 토큰이다
- [ ] `capabilities`가 실제 플랫폼 한계와 일치한다 (상한을 실제보다 크게 잡으면 메시지가 잘린다)
- [ ] `start()` 전에 `send()`를 호출하면 명확한 에러를 던진다
- [ ] `stop()`을 두 번 호출해도 안전하다
- [ ] `stop()` 이후 수신 핸들러가 더 이상 호출되지 않는다

#### Envelope 정규화
- [ ] 자기 자신이 보낸 메시지를 무시한다 (봇 루프 방지)
- [ ] `isDirect`가 DM/채널을 정확히 구분한다
- [ ] `addressed`가 멘션/답장을 반영한다
- [ ] `conversationId`가 스레드까지 구분한다 (스레드별 라우팅이 필요할 때)
- [ ] `timestamp`가 플랫폼 시간 기준으로 채워진다
- [ ] 첨부는 `ref`만 넘기고 본문을 즉시 다운로드하지 않는다

#### 전송
- [ ] `OutboundMessage.editKey`가 있으면 새 메시지 대신 편집한다 (capability가 `edit: true`일 때)
- [ ] `threadId`를 지원하면 반영하고, 아니면 무시한다 (에러 금지)

#### 보안/운영
- [ ] 자격증명은 env 변수에서만 읽는다
- [ ] 토큰/원문 payload를 로그에 남기지 않는다
- [ ] 레이트리밋/재연결에 백오프가 있다
- [ ] 단일 인스턴스 락을 존중한다 (폴링/게이트웨이형 전송). 시작 실패 시 락을 반드시 해제한다
- [ ] 자기 자신과 다른 봇의 메시지를 무시한다 (`author.bot`, `webhook_id`)
- [ ] 자격증명 검증을 먼저 한다. 잘못된 토큰은 소켓/폴링을 열기 전에 실패한다
- [ ] `diagnose()`가 있고 토큰을 포함하지 않는다
- [ ] `send()`가 시작 전이면 명확히 throw한다
- [ ] 게이트웨이/폴링 연결에 READY 타임아웃이 있다 (무한 대기 금지)
- [ ] 첨부를 지원하면 `fetchAttachment`가 자체 크기 상한을 적용하고, 선언 크기가 아니라 실제 바이트로 검사한다
- [ ] `fetchAttachment`의 `mediaType`은 응답 헤더에서 읽고, 없으면 선언값으로 폴백한다
- [ ] `typing()`을 구현했다면 스스로 호출 빈도를 제한하고, 실패해도 전송을 막지 않는다

---

## 6. 원격 명령 추가 절차

1. `src/core/commands.ts`의 `REMOTE_COMMANDS`에 스펙 추가
   - `name`, `summary`, `usage?`, `run(args, ctx)`
   - 부작용은 **문자열이 아니라 `effect`로 반환**한다 (`pause|resume|abort|disconnect`)
2. 별칭이 필요하면 `ALIASES`에 추가
3. `commands.test.ts`에 테스트 추가 (도움말 노출 + effect + 인자 없음)
4. 브리지에서 새로운 effect를 처리해야 하면 `bridge.ts`의 `runCommand`에 분기 추가 + `bridge.test.ts`에 시나리오

**규칙**: 명령은 I/O를 하지 않는다. `RemoteCommandResult`를 반환하고, 실제 동작은 브리지가 한다.

---

## 7. 설정 파일 스키마

경로 (프로젝트가 전역을 덮어쓴다):

```text
~/.pi/agent/bot-connect.json      # 전역
<project>/.pi/bot-connect.json    # 프로젝트
```

`PI_BOT_CONNECT_CONFIG=<path>`가 설정되면 위 탐색을 **건너뛰고** 그 파일만 읽는다. 테스트/CI용이며, 개발자의 전역 설정이 테스트에 새어 들어오는 것을 막는다.

```jsonc
{
  "bridge": {
    "localCommand": "connect",        // 로컬 슬래시 명령 이름
    "remotePrefixes": ["/", "connect ", "bot "],
    "botUsername": "piBot",           // @멘션 addressing용
    "busyDelivery": "followUp",       // "steer" | "followUp"
    "pairingTtlMs": 300000,           // 10000 ~ 86400000
    "pairingDigits": 6,               // 4 ~ 10
    "pairingMaxAttempts": 3,          // 1 ~ 10
    "allowUsers": ["telegram:42"],    // transport:userId 사전 신뢰
    "requirePairing": true,
    "requireAddressing": true,        // 채널에서는 봇 호출 시에만 반응
    "digest": { "maxLength": 1500 },   // 100 ~ 10000
    // 첨부 전달 정책. allowedMediaTypes에 없는 종류는 명시적으로 거부된다.
    "attachments": {
      "allowedMediaTypes": ["image/png", "image/jpeg", "image/gif", "image/webp"],
      "maxCount": 4,                 // 1 ~ 10
      "maxBytes": 8388608            // 1024 ~ 52428800
    },
    "progressMinIntervalMs": 1000,     // 0 ~ 60000. 턴 안에서 진행 카드 갱신 최소 간격
    "maxChunks": 8                     // 1 ~ 50. 한 번의 송신이 만들 수 있는 최대 메시지 수. 초과분은 잘렸다고 알린다
  },
  "transports": {
    // 전송별 설정. 비밀값 금지, env 변수 이름만.
    "discord": {
      // 생략 가능. 기본값은 PI_DISCORD_TOKEN.
      "tokenEnv": "PI_DISCORD_TOKEN",
      // false면 토큰이 없어도 조용히 건너뜀. true면 설정 오류로 보고됨.
      "enabled": true,
      // 락 만료(ms). 다른 호스트의 락은 이 시간이 지나야 회수된다.
      "lockStaleMs": 900000
    },
    "telegram": { "tokenEnv": "PI_TELEGRAM_TOKEN" }
  }
}
```

검증 결과는 오류(거부)와 경고(무시)로 나뉘며, 둘 다 로컬에 표시된다 (`config.test.ts` 참조).

---

## 8. 보안 모델

| 자산 | 보호 방식 |
| --- | --- |
| 봇 토큰 | 환경변수만. 설정 파일에는 변수 *이름*만. 로그 금지 |
| 세션 제어 권한 | `allowUsers` 사전 신뢰 또는 터미널 전용 코드 페어링 |
| 코드 유출 | 코드는 메신저로 전송되지 않는다. TTL + 시도 횟수 제한 |
| 대화 내용 | 송신 전 리댁션. 툴 인자/출력은 전송하지 않음 |
| 채널 오작동 | `requireAddressing` 기본 true. 미인증 메시지는 무응답 |
| 프롬프트 인젝션 | (미해결) 메신저 텍스트는 신뢰할 수 없는 입력으로 취급해야 한다 — §9 참조 |

**신뢰 경계**: 메신저는 신뢰 경계 밖이다. E2E 암호화 없음. 이 사실을 README와 `docs/`에 유지한다.

---

## 9. 알려진 미해결 과제

| # | 과제 | 설명 |
| --- | --- | --- |
| G1 | 프롬프트 인젝션 | 메신저로 들어온 텍스트가 로컬 파일을 읽어 밖으로 보내도록 지시할 수 있다. 도구 정책/승인 게이트가 필요 (v2) |
| G2 | 맥락 병합의 정의 | 원격 턴을 로컬 TUI에 어떻게 "보이게" 할지. `pi.appendEntry` + `registerEntryRenderer` 후보 |
| G3 | 다중 세션 | 단일 봇 + 다중 세션 라우팅은 브로커가 필요 (v2) |
| G4 | ~~진행 상황 편집~~ | ✅ 완료 — `Bridge.publishProgress`가 턴당 카드 1개를 스로틀·편집하고, 실패 시 새 메시지로 폴백 |
| G5 | 리플레이 하네스 | 엔벨로프 record/replay로 회귀 테스트 |
| G6 | ~~단일 인스턴스 락~~ | ✅ 완료 — `src/lock.ts`. O_EXCL 획득, 생존/만료 회수, 토큰 검증 해제 |
| G7 | 세션 복원 | ✅ 완료 — `FileBridgeStore`가 세션 id로 스코프해 `pi --continue`에서 신뢰가 유지된다 |
| G8 | ~~첨부(이미지) 전달~~ | ✅ 완료 — `Transport.fetchAttachment` + `bridge.attachmentPolicy`가 두 capability를 AND |
| G9 | ~~다이제스트 데이터 소스~~ | ✅ 완료 — 브랜치/변경 파일/테스트 결과. TODO는 형태 미확정으로 보류 |
| G10 | Slack 타이핑/리액션 | 플랫폼 제약. 어댑터별 fallback 필요 |

---

## 10. 성능/운영 노트

- **브로드캐스트는 대화 목록 순회**다. 대화가 많아지면 동시 전송 제한(concurrency cap)이 필요하다 (v2).
- **진행 상황은 턴당 1회로 합쳐서** 보낸다. 툴 호출마다 보내면 레이트리밋에 걸린다 (`index.ts` 참조).
- **툴 이름만 전송**한다. 인자/출력은 절대 보내지 않는다.
- **`sendUserMessage`는 스트리밍 중 `deliverAs` 없이 호출하면 throw**한다. 어댑터에 레이스 가드를 두었다.
