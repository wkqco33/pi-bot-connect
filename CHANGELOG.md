# Changelog

이 프로젝트의 주요 변경 사항을 기록한다.
형식은 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를,
버전 규칙은 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따른다.

**0.x 표기 동안에는 공개 표면 — 설정 스키마, 원격 명령 집합, `Transport` 계약 —
이 메이저 버전 없이 바뀔 수 있다.** README의 "지원 범위"를 참조.

## [Unreleased]

### Planned

- Telegram 전송 (롱폴링, 4096 bytes, HTML). 코어는 이미 전송 무관이므로 어댑터만 추가하면 된다
- Slack 전송 (Socket Mode, mrkdwn)
- 전송 conformance 테스트 키트 (`src/transports/transport-contract.test.ts`)
- 다이제스트에 TODO 포함 (세션 엔트리의 형태를 먼저 확인한 뒤 방어적으로 파싱)
- 엔벨로프 record/replay 하네스

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
- 프롬프트 인젝션 방어 (도구 정책/승인 게이트). 채팅을 다른 사람과 공유하는 순간 필요해진다 (G1)

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
