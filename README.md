# pi-bot-connect

**pi 코딩 에이전트의 라이브 세션을 Discord에 연결하는 pi 확장.** (Telegram/Slack은 같은 코어 위에 추가 예정)

알림 봇이 아니다. **핸드오프 브리지**다.

- 지금 하고 있는 일을 **공유**한다 — 브랜치, 변경 파일, TODO, 테스트 결과를 한 장의 작업 다이제스트로
- 메신저에서 **다음 작업을 이어간다** — 원격 메시지가 같은 라이브 세션에 주입된다
- 터미널로 돌아오면 그 작업이 **이미 세션에 반영되어 있다** — 세션을 뺏지 않는다

> 상태: **Discord 사용 가능**. 코어·브리지·영속화·락·Discord 게이트웨이가 312개 테스트로 고정되어 있다. 봇 SDK(`discord.js` 등) 없이 구현했다.

---

## Discord 설정

### 1. 봇 만들기

[Developer Portal](https://discord.com/developers/applications) → **New Application** → **Bot**

여기서 두 가지를 반드시 한다.

| 항목 | 위치 | 이유 |
| --- | --- | --- |
| **토큰 복사** | Bot → Reset Token | 봇 인증 |
| **Message Content Intent 켜기** | Bot → Privileged Gateway Intents | **끄면 메시지 본문이 빈 문자열로 도착한다.** 가장 흔한 실패 원인 |

### 2. 봇 초대

**OAuth2 → URL Generator**에서 scope `bot`, 권한은 `Send Messages` + `Read Message History`를 선택하고 생성된 URL로 서버에 초대한다.

> DM으로 쓰더라도 **사용자와 봇이 같은 서버에 있어야** DM을 보낼 수 있다.

### 3. 토큰을 환경변수로

```bash
export PI_DISCORD_TOKEN="your-bot-token"
```

토큰은 **절대 설정 파일에 쓰지 않는다.** 설정 파일에는 환경변수 *이름*만 들어간다.

### 4. 설정 파일

`<project>/.pi/bot-connect.json`:

```json
{
  "transports": {
    "discord": { "enabled": true }
  }
}
```

`enabled: true`로 두면 토큰이 없을 때 조용히 실패하지 않고 설정 오류를 알려준다. (전역 설정은 `~/.pi/agent/bot-connect.json`)

기본으로 `PI_DISCORD_TOKEN`을 읽는다. 다른 이름을 쓰려면 `{ "discord": { "tokenEnv": "MY_TOKEN" } }`.

### 5. 시작하고 페어링

```bash
pi        # 또는 pi -e ./src/index.ts 로 개발 중인 버전 로드
```

1. Discord에서 봇에게 **DM**을 보낸다 (또는 서버에서 `@봇이름` 멘션)
2. **터미널에 6자리 코드가 뜬다** — 코드는 메신저로 전송되지 않는다. 로컬 터미널에만 표시된다
3. 그 코드를 DM에 입력한다
4. 이후 DM은 그대로 pi 세션의 프롬프트가 된다. `@봇이름` 멘션도 동작한다

### 6. 확인

```text
/connect status     # 전송 상태, 페어링 수, 대화 수
/connect doctor     # 토큰/게이트웨이/락/스코프 진단
/connect digest     # 현재 작업 요약을 채팅으로 전송
/connect pair       # 대기 중인 페어링 코드 다시 보기
```

---

## 로컬 명령

| 명령 | 설명 |
| --- | --- |
| `/connect status` | 전송·페어링·대화·일시정지 상태 |
| `/connect doctor` | 전송별 상태, 세션 키, 상태 파일, 확인 체크리스트 |
| `/connect pair` | 대기 중인 페어링 코드와 만료 시간 |
| `/connect digest` | 작업 다이제스트를 페어링된 채팅으로 전송 |
| `/connect pause` / `resume` | 모든 대화에 대한 프롬프트 전달 중지/재개 |
| `/connect disconnect` | 페어링 해제 |
| `/connect config` | 해석된 설정 출력 (비밀값 없음) |

## 원격 명령 (Discord)

`/help` `/status` `/pause` `/resume` `/abort` `/whoami` `/disconnect` — 또는 `connect status`, `bot status` 처럼 워드 접두사도 인식한다.

명령이 아닌 텍스트는 전부 pi 프롬프트로 전달된다. 채널에서는 봇을 멘션하거나 접두사를 붙여야 반응한다(잡담 무시).

---

## 동작 방식

```text
Discord 게이트웨이 ──► normalize ──► Envelope ──► Bridge ──► pi.sendUserMessage
                                                   │
Discord REST      ◄── chunk+markdown+redact ◄──────┘
```

- `src/core/` — **완전 순수**. pi도 네트워크도 모른다. 라우팅·페어링·리댁션·청킹·마크다운·다이제스트
- `src/bridge.ts` — 오케스트레이션. 송신 파이프라인과 인증 판정
- `src/file-store.ts` — 신뢰 상태 영속화 (`/reload`·재시작에도 페어링 유지, 세션별 격리)
- `src/lock.ts` — 봇 자격증명당 단일 인스턴스 락
- `src/transports/discord/` — normalize(순수) / gateway(주입 가능한 소켓) / rest / 전송 본체

자세히: [`docs/architecture.md`](docs/architecture.md)

---

## 보안 모델

메신저는 **신뢰 경계 밖**이다. 본질적으로 원격 코드 실행 채널이므로 다음을 코드와 테스트로 강제한다.

- **페어링 코드는 메신저로 전송되지 않는다.** 로컬 터미널에만 표시되고 사용자가 채팅에 입력한다
- **모든 송신 본문은 리댁션을 거친다** (API 키, 봇 토큰, `TOKEN=`/`SECRET=` 대입 등)
- **프롬프트 본문과 툴 인자는 로그에 남지 않는다.** 진행 상황에는 툴 *이름*만 전송한다
- **설정 파일과 상태 파일은 비밀값을 담을 수 없다.** 환경변수 *이름*만
- 상태 파일은 `chmod 600`, 락 파일도 `chmod 600`
- 채널에서는 봇을 명시적으로 호출할 때만 반응한다 (기본 켜짐)
- **봇 자신과 다른 봇의 메시지는 무시한다** (무한 루프 방지)
- 첨부(이미지)는 **아직 전달하지 않는다**. 모델에게 "이미지를 봐라"라고 거짓말하지 않고 명시적으로 거부한다
- 알려진 미해결: 프롬프트 인젝션 방어 (도구 정책/승인 게이트)

### Discord 게이트웨이와 동시 실행

Discord는 봇 토큰당 게이트웨이 세션을 하나만 허용한다. 같은 봇으로 pi를 두 개 띄우면 나중 것이 앞 것을 끊는다. 그래서 **봇 ID 기준 단일 인스턴스 락**을 건다. 두 번째 프로세스는 명확한 오류와 함께 시작을 거부한다.

`/connect doctor`의 `lock held` / `lock not held`로 확인할 수 있다.

---

## 개발

```bash
npm install
npm run check          # 타입체크 + 전체 테스트 (필수 게이트)
npm run test:watch     # TDD 사이클

pi -e ./src/index.ts
PI_BOT_CONNECT_DEBUG=1 pi -e ./src/index.ts
```

**다른 에이전트가 이 저장소에서 작업한다면 [`AGENTS.md`](AGENTS.md)를 먼저 읽어라.** TDD 절차, 계층 규칙, 보안 불변식, 함정 목록이 있다.

환경변수:

| 변수 | 용도 |
| --- | --- |
| `PI_DISCORD_TOKEN` | Discord 봇 토큰 (설정으로 이름 변경 가능) |
| `PI_BOT_CONNECT_DEBUG` | `1`이면 어댑터 로그 활성화 |
| `PI_BOT_CONNECT_CONFIG` | 설정 파일 경로 강제 (테스트/CI용) |
| `PI_BOT_CONNECT_STATE` | 상태 파일 경로 강제 (테스트/CI용) |

---

## 로드맵

| 단계 | 내용 |
| --- | --- |
| **v0** ✅ | 순수 코어, 브리지, 설정 검증, 영속화, 락, pi 어댑터 |
| **v1** ✅ | Discord 게이트웨이 전송 + 단일 인스턴스 락 + `/connect doctor` |
| **v2** | 이미지 전달, 진행 상황 edit-in-place, 다이제스트에 git diff/TODO 채우기, 프롬프트 인젝션 방어 |
| **v3** | Telegram·Slack 전송, 다중 세션 브로커, record/replay 하네스 |

---

## 라이선스

MIT
