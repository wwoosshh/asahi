---
title: 설계 아카이브 인덱스
lastReviewed: 2026-07-13
---

# 설계 아카이브 (design-archive)

이 디렉터리는 완료(Shipped)되었거나 이후 설계가 바뀐(Superseded) 과거 스펙·계획·노트를 **원문 그대로** 보존합니다. 각 문서의 최상단 YAML front-matter(`status`/`shippedIn`/`supersededBy`)가 현재 유효성을 알려줍니다.

> **문서 안의 미체크 태스크 박스(`- [ ]`)는 작성 당시 계획의 흔적일 뿐, 지금 다시 실행해야 할 항목이 아닙니다.** 이미 구현이 끝났거나(Shipped) 다른 방식으로 대체된(Superseded) 뒤 그대로 남아있는 표기입니다.

현재 아키텍처는 `docs/architecture/overview.md`, 현재 상태·로드맵은 `docs/status/STATUS.md`, 결정 기록(ADR)은 `docs/decisions/`를 참고하세요.

## Specs

| 문서 | status | shippedIn | 대응 현재 문서/ADR |
|---|---|---|---|
| [개인 AI 비서 "상주 에이전트" 설계 문서](./specs/2026-07-11-pc-ai-assistant-design.md) | Superseded | phase1 초기 | ADR 0001(Postgres 이전), ADR 0002(Railway+로컬 워커 하이브리드), `docs/architecture/overview.md` |
| [멀티유저 · 자기인지 데이터 기반 설계 v2](./specs/2026-07-11-multiuser-selfaware-db-design.md) | Superseded(부분 — 저장소·토폴로지만) | 2A/2B 병합 | ADR 0001(저장소), `docs/architecture/overview.md` |
| [Asahi 캐릭터/페르소나 시스템 설계](./specs/2026-07-12-asahi-persona-character-design.md) | Shipped | 15907fb | — |
| [디스코드 이미지 입력(멀티모달) 설계](./specs/2026-07-12-discord-image-input-design.md) | Shipped | 7215725 | — |
| [자기인지 — DB introspection 설계](./specs/2026-07-12-self-awareness-db-introspection-design.md) | Shipped | 039f91a | — |

## Plans

| 문서 | status | shippedIn | 대응 현재 문서/ADR |
|---|---|---|---|
| [1단계: 코어+SQLite+디스코드+PM2 구현 계획](./plans/2026-07-11-phase1-core-discord.md) | Superseded | phase1 | ADR 0001, ADR 0002, `docs/architecture/overview.md` |
| [2A 데이터 기반 구현 계획](./plans/2026-07-11-phase2a-data-foundation.md) | Superseded | 2A | ADR 0001(Postgres 이전), `docs/architecture/overview.md` |
| [2B 멀티유저·멀티채널 런타임 배선 구현 계획](./plans/2026-07-11-phase2b-multiuser-runtime.md) | Shipped | 2B | — |
| [Asahi 캐릭터/페르소나 시스템 구현 계획](./plans/2026-07-12-asahi-persona-character.md) | Shipped | 15907fb | — |
| [디스코드 이미지 입력(멀티모달) 구현 계획](./plans/2026-07-12-discord-image-input.md) | Shipped | 7215725 | — |
| [자기인지 — DB introspection 구현 계획](./plans/2026-07-12-self-awareness-db-introspection.md) | Shipped | 039f91a | — |

## Notes

| 문서 | status | shippedIn | 대응 현재 문서/ADR |
|---|---|---|---|
| [2B API 스파이크 결과](./notes/2b-api-spike.md) | Shipped | 2B | — |

## 진행중 문서(제외)

아래 2건은 아직 진행중인 SDD 작업물이라 이 아카이브로 옮기지 않았습니다. 완료되면 이후 별도 태스크에서 이동합니다.

- `docs/superpowers/specs/2026-07-13-documentation-system-design.md`
- `docs/superpowers/plans/2026-07-13-documentation-system.md`
