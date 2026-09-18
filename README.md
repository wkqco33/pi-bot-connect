# pi-bot-connect

**pi 코딩 에이전트의 라이브 세션을 Discord / Slack / Telegram에 연결하는 pi 확장.**

알림 봇이 아니다. **핸드오프 브리지**다.

- 지금 하고 있는 일을 **공유**한다 — 브랜치, 변경 파일, TODO, 테스트 결과를 한 장의 작업 다이제스트로
- 메신저에서 **다음 작업을 이어간다** — 원격 메시지가 같은 라이브 세션에 주입된다
- 터미널로 돌아오면 그 작업이 **이미 세션에 반영되어 있다** — 세션을 뺏지 않는다

> 상태: **v0 (코어 완성)**. 전송 어댑터는 아직 없다. 코어·브리지·설정·pi 어댑터는 164개 테스트로 고정되어 있고, 봇 토큰 없이 `FakeTransport`로 전 구간을 검증할 수 있다.

---

## 왜 또 하나의 브리지인가

범용 메신저 브리지는 이미 여러 개 있다 ([PiRelay](https://github.com/zikolach/pirelay), [pi-messenger-bridge](https://pi.dev/packages/pi-messenger-bridge), [pi-gateway](https://github.com/gamalan/pi-gateway), [pi-telegram-plus](https://github.com/kdejaeger/pi-telegram-plus), [pi-slack-bridge](https://comsysto.github.io/pi-slack-bridge/), [pi-remote-agent](https://github.com/ni3do/pi-remote-agent)).

이 프로젝트는 그중 **비어 있는 세 지점**만 노린다.

| 차별점 | 기존 도구 |
| --- | --- |
| **연속성 있는 핸드오프** — 로컬 TUI를 살려둔 채 원격 턴을 같은 세션에 병합 | `pi-slack-bridge`는 tmux로 터미널을 *전환*하고, `pi-gateway`는 채팅별로 세션을 *분리*한다 |
| **작업 다이제스트** — 읽을 수 있는 공유 카드(브랜치/diff/TODO/테스트/마지막 요청) | 모두 턴 알림과 `/status` 한 줄까지 |
| **전송 무관 코어 + 어댑터 계약** — 새 메신저 = 어댑터 1개 + conformance 테스트 | 6개 모두 전송 로직이 내부에 하드코딩되어 있다 |

부수적으로 **런타임 봇 SDK를 쓰지 않는다** (`discord.js`/`grammy`/`@slack/bolt` 없음). 감사 범위와 공급망 리스크를 줄이기 위한 의도적 제약이다.

전체 분석: [`docs/feasibility.md`](docs/feasibility.md) (경쟁 매트릭스, 위험도, 범위 규율)

---

## 아키텍처

```text
pi 이벤트  ──►  Bridge  ──►  Transport (Discord / Slack / Telegram / fake)
pi API     ◄──  BridgeHost  ◄──  Envelope
```

- `src/core/` — **완전 순수**. pi도 네트워크도 모른다. 라우팅·페어링·리댁션·청킹·마크다운·다이제스트
- `src/bridge.ts` — 오케스트레이션. 송신 파이프라인(`리댁션 → 마크다운 → 청킹`)과 인증 판정
- `src/transports/` — 유일한 I/O 경계. `fake.ts`는 테스트 + 봇 토큰 없는 개발용
- `src/index.ts` — pi 어댑터 껍데기. 정책 없음

자세히: [`docs/architecture.md`](docs/architecture.md) (전송 계약, 불변식 I1~I12, conformance 체크리스트)

---

## 보안 모델

메신저는 **신뢰 경계 밖**이다. E2E 암호화는 없다. 이 도구는 본질적으로 원격 코드 실행 채널이므로 다음을 코드와 테스트로 강제한다.

- **페어링 코드는 메신저로 전송되지 않는다.** 로컬 터미널에만 표시되고, 사용자가 채팅에 입력한다
- **모든 송신 본문은 리댁션을 거친다** (API 키, 봇 토큰, `TOKEN=`/`SECRET=` 대입 등)
- **프롬프트 본문과 툴 인자는 로그에 남지 않는다.** 진행 상황에는 툴 *이름*만 전송한다
- **설정 파일은 비밀값을 담을 수 없다.** 환경변수 *이름*만 저장한다
- 채널에서는 봇을 명시적으로 호출할 때만 반응한다 (`requireAddressing`, 기본 켜짐)
- 알려진 미해결: 프롬프트 인젝션 방어 (도구 정책/승인 게이트는 v2)

---

## 개발

```bash
npm install
npm run check          # 타입체크 + 전체 테스트 (필수 게이트)
npm run test:watch     # TDD 사이클

# 실제 pi에 로드
pi -e ./src/index.ts
PI_BOT_CONNECT_DEBUG=1 pi -e ./src/index.ts
```

**다음 에이전트가 이 저장소에서 작업한다면 [`AGENTS.md`](AGENTS.md)를 먼저 읽어라.** TDD 절차, 계층 규칙, pi API 치트시트, 함정 목록이 있다.

---

## 로드맵

| 단계 | 내용 |
| --- | --- |
| **v0** ✅ | 순수 코어, 브리지, 설정 검증, pi 어댑터 셸 — 164 테스트 |
| **v1** | Telegram 어댑터(롱폴링) + 단일 인스턴스 락 + 핸드오프 명시화 |
| **v2** | 진행 상황 edit-in-place, 프롬프트 인젝션 방어, Discord, 다중 세션 브로커 |
| **v3** | Slack, 어댑터 conformance 키트 공개, record/replay 하네스 |

미해결 과제 목록: [`docs/architecture.md` §9](docs/architecture.md)

---

## 라이선스

MIT
