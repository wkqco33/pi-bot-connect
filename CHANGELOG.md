# Changelog

이 프로젝트의 주요 변경 사항을 기록한다.
형식은 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를,
버전 규칙은 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따른다.

**0.x 표기 동안에는 공개 표면 — 설정 스키마, 원격 명령 집합, `Transport` 계약 —
이 메이저 버전 없이 바뀔 수 있다.** README의 "지원 범위"를 참조.

## [Unreleased]

### Planned

- Slack 전송 (Socket Mode, mrkdwn, 4000자). conformance harness 1개 + 팩토리 등록이면 된다
- 단일 봇 + 다중 세션 브로커 (G3) — 세션↔대화 바인딩 정책 결정 필요
- 원격 턴을 로컬 TUI에 남기는 맥락 병합 (G2)

## [0.5.0] - 2026-09-18

### Added

- `/connect version` (`--version`/`-v` 별칭) — 설치된 확장 버전·Node 버전·설치 경로를 표시한다. `/connect status`와 `/connect doctor`에도 버전 줄이 들어간다. pi가 확장 버전 getter를 제공하지 않아 설치된 `package.json`을 런타임에 읽는다

## [0.4.0] - 2026-09-18

### Added

- `bridge.remoteToolPolicy` (`unrestricted` | `read-only` | `no-tools`). 메신저에서 시작된 턴의 도구 사용을 제한한다. 로컬 턴에는 적용되지 않는다 (G1의 도구 정책 부분)
- `bridge.broadcast` (`progress`, `replies`). 자동 진행 카드/최종 답변 브로드캐스트를 끌 수 있다. 명시적 `/connect digest`는 항상 전송된다
- 리댁션 규칙 확장: PEM 개인키 블록, JWT, Discord 봇 토큰, npm 토큰, Bearer가 아닌 인증 헤더
- HTTP 요청·첨부 다운로드에 요청별 타임아웃(`AbortSignal.timeout`)
- **Telegram 전송**. 롱폴링, 4096 UTF-8 bytes, HTML, 토픽 스레드, `lock.ts` 재사용. `PI_TELEGRAM_TOKEN`
- **전송 conformance 키트** (`src/transports/transport-contract.test.ts`). Fake·Discord·Telegram이 같은 계약을 통과한다
- `bridge.remoteToolApproval: "each"` — 정책이 허용한 원격 도구도 로컬 터미널에서 확인받는다 (G1 완료)
- `bridge.rateLimit` — 신원별 토큰 버킷으로 원격 프롬프트/명령 폭주를 제한한다. 초과 안내는 분당 1회
- 감사 로그 — 페어링·해제·원격 명령을 메타데이터(`transport`/`identity`/이름)로만 기록한다
- 다이제스트 TODO 소스 — 어시스턴트 체크리스트를 `core/todo.ts`가 파싱한다
- 리플레이 하네스 — `core/transcript.ts`(리댁션 + `raw` 제거) + `transports/replay.ts`

### Fixed

- **송신 실패가 턴/브로드캐스트를 중단시키지 않는다.** 한 메시지나 한 대화가 거부되어도 나머지는 계속 전송되고, 실패는 메타데이터로만 로그에 남는다
- **게이트웨이 재연결이 HELLO 없이 영구 대기하지 않는다.** 매 연결마다 READY 데드라인을 다시 걸고, 초과 시 다음 백오프로 넘어간다
- **RESUME 성공(`RESUMED`)이 ready로 복귀**하고 재연결 예산을 리셋한다. 이전에는 상태가 `reconnecting`에 머물렀다
- Discord REST가 5xx와 네트워크 오류를 백오프로 재시도한다. 4xx는 재시도하지 않는다
- 페어링 시도는 코드 길이와 정확히 일치하는 숫자열만 소모시킨다. 잡담에 섞인 숫자가 코드를 잠그지 않는다

## [0.3.0] - 2026-09-18

긴 응답을 마크다운 구조 단위로 나누고, 길이를 플랫폼이 실제로 세는 단위로 계산한다.
**실제 Discord 왕복은 이 릴리스에서 처음 확인되었다** (텍스트·이미지 프롬프트, 진행 카드, 긴 답변 분할).

### Changed

- 긴 응답을 크기(2000자)로만 자르던 것을 마크다운 구조 기준으로 바꿨다. 헤딩 경계에서 먼저 자르고, 헤딩이 그 본문에서 떨어져 나가는 일이 없어진다. 코드 펜스는 펜스 자체가 한도를 넘지 않는 한 분할되지 않는다
- Discord 길이를 실제 단위(UTF-16 code unit)로 센다. 이모지 하나가 2단위를 쓰므로 더 이상 2000을 넘길 수 없다 (`TransportCapabilities.lengthUnit`에 `utf16` 추가)
- CRLF로 끝나는 줄이 `\r`과 `\n` 사이에서 잘리지 않는다
- 섹션 경계를 지키는 대가로 메시지 수가 최대 2배까지 늘 수 있다. `maxChunks`(기본 8)와 `[truncated: …]` 안내는 그대로다

### Added

- `src/core/markdown-blocks.ts` — 펜스 인식 CommonMark 블록 파서와 섹션 패킹. `chunkText`는 전송 한도 보증 안전망으로 남는다(`measureLength` 추가)
- 한도보다 긴 코드 블록은 조각마다 여는/닫는 펜스를 다시 붙여 각 메시지가 유효한 코드 블록이 된다. 이 경우에만 `join(chunks) === source`가 성립하지 않는다(코드 내용은 그대로)

## [0.2.0] - 2026-09-18

진행 표시와 긴 응답 처리를 추가한 기능 릴리스. **실제 Discord API 왕복은 여전히 미검증**이고,
모든 테스트는 봇 토큰·네트워크 없이 가짜 소켓과 가짜 fetch로 수행된다.

### Added

- 긴 응답을 전송 한도(2000자) 단위로 나누어 전송한다. 이전에는 최종 답변을 1200자 요약으로 보냈다
- `bridge.maxChunks`(기본 8, 1~50). 초과분은 조용히 버리지 않고 `[truncated: N more message(s) were not sent]`로 알린다
- 진행 카드가 도구 호출 없는 추론 구간에도 `thinking…`을 표시한다 (턴당 카드 1개, edit-in-place)
- Discord typing 표시 (선택적 `Transport.typing()`, 채널당 8초 스로틀). 실패해도 턴을 막지 않는다

### Fixed

- 미인증 상태의 채널 잡담에 봇이 페어링 안내로 응답하던 문제. 이제 봇을 호출했거나 DM일 때만 챌린지를 발급한다 (I7)
- Discord에서 봇 메시지에 답장(reply)만 한 경우 주소 지정으로 인정되지 않던 문제
- 첨부의 선언된 media type만 믿던 문제. 이제 응답이 실제로 준 content type으로 정책을 재검사한다 (I25)
- `PI_DISCORD_TOKEN`을 export한 셸에서 배선 테스트가 실제 게이트웨이를 열어 실패하던 문제

## [0.1.1-rc.1] - 2026-09-18

릴리스 파이프라인 검증용 프리릴리스. 기능 변경은 없다.
npm **trusted publishing(OIDC)** 으로 발행되며 `next` dist-tag를 쓴다 —
`latest`는 0.1.0 그대로다.

### Changed

- `release.yml`이 프리릴리스(`0.1.1-rc.1`처럼 하이픈 포함)를 `next` 태그로,
  정식 버전을 `latest`로 발행한다

## [0.1.0] - 2026-09-18

첫 공개 버전. Discord에서 실제로 사용할 수 있다. **실제 Discord API와의 왕복은
아직 검증되지 않았고, 테스트는 봇 토큰·네트워크 없이 가짜 소켓과 가짜 fetch로
수행된다.**

### Added

- pi 확장: `/connect` 로컬 명령 (`status`, `doctor`, `pair`, `digest`, `pause`, `resume`, `disconnect`, `config`)
- Discord 전송: 게이트웨이 v10 직접 구현 (HELLO / IDENTIFY / RESUME / 하트비트 / 지수 백오프 재접속), `discord.js` 등 봇 SDK 의존성 없음
- 전송 무관 코어: 라우팅, 페어링, 리댁션, UTF-8 안전 청킹, 전송별 마크다운 변환, 작업 다이제스트
- 페어링: 터미널 전용 6자리 코드, 시도 횟수 제한, 만료. 코드는 메신저로 전송되지 않는다
- 양방향 프롬프트: 유휴 시 즉시 주입, 실행 중에는 `steer`/`followUp`
- 이미지 첨부 전달: 호스트와 전송이 둘 다 지원할 때만, 다운로드한 실제 바이트로 크기 재검사
- 진행 카드: 턴당 메시지 하나를 제자리 갱신 (스로틀 + 편집 실패 시 폴백)
- 작업 다이제스트: 브랜치, 변경 파일(churn 순), 테스트 결과, 마지막 요청
- 단일 인스턴스 락: 봇 자격증명당 프로세스 하나 (`O_EXCL` 획득, 생존/만료 회수, 토큰 검증 해제)
- 상태 영속화: 신뢰·대기 코드·브로드캐스트 대상을 세션별로 격리해 저장, 원자적 쓰기, `chmod 600`
- 설정 파일 검증: 알 수 없는 키는 경고, 잘못된 값은 경로와 함께 오류 보고. 비밀값은 담을 수 없고 환경변수 이름만 저장
- 보안 불변식을 테스트로 고정: 코드 유출 금지, 프롬프트 본문 로그 금지, 송신 전 리댁션, 자기/타 봇 메시지 무시, `diagnose()`에 토큰 미포함

### Notes

- 런타임 의존성 0개. `@earendil-works/pi-coding-agent`만 peer dependency
- 386개 테스트, `tsc --noEmit` 통과
