---
title: 문서 체계 구축 · 최신화 설계
date: 2026-07-13
status: Approved
audience: 소유자(정본) + 공개 repo 기여자
supersedes: —
supersededBy: —
---

# 문서 체계 구축 · 최신화 설계

## 1. 배경 · 문제

Asahi는 라이브 프로덕션(Railway 클라우드 봇 + 로컬 워커 + Supabase Postgres 하이브리드)으로 빠르게 진화했으나, **문서는 그 진화를 따라오지 못했다.** 25개 에이전트로 문서 18건 + 공백 5축을 코드·테스트·git과 대조한 감사(2026-07-13) 결과:

### 1.1 살아있는 문서 드리프트
Postgres 이전(`ffae8a0`)·Railway 배포(`2c2cf23`) **직전 ~1시간에 마지막 편집**된 뒤 갱신되지 않아, 현재와 어긋난다.

| 문서 | 드리프트 | 구체적 문제 |
|---|---|---|
| `README.md` | major | "기억(SQLite + 마크다운)", 폴더 구조의 "SQLite DB (agent.db)" — 실제는 Supabase Postgres. Railway+워커 토폴로지·`worker/` 소스 누락. `현재 단계` 문장이 낡음 |
| `deploy/다른-PC-셋업.md` | major | `better-sqlite3` 네이티브 빌드 안내(§사전요구), `DATABASE_URL` 전제 없음, "기억은 PC별 SQLite 수동 이전"(§2·§데이터이전) — Supabase 중앙화 현실과 반대. `allow_dir` 저장 위치 설명도 낡음 |
| `deploy/PM2-명령어.md` | minor | 기계적 내용은 정확하나, "24/7는 이제 Railway, 이건 로컬 폴백 · 토큰 1개라 Railway 먼저 정지" 맥락 배너 없음 |
| `.env.example` | minor | `ANTHROPIC_MODEL`(기본 `claude-opus-4-8`, `config.ts:54`) 항목 누락 |
| `deploy/railway-셋업.md` | **fresh** | 모든 주장이 코드·git과 일치. 유일하게 완전 최신 |
| `agent/윈도우자동실행.txt` | minor·**미추적** | 로컬 PM2 자동시작 런북. Railway 현실과 충돌, `PM2-명령어.md`와 중복. git 미추적(로컬 전용) |

### 1.2 진짜 문제 — 부재(HIGH)
- **아키텍처 개요·토폴로지 부재**: 3-프로세스 하이브리드가 **코드에만** 존재. 유일한 산문 아키텍처(멀티유저 spec §3)는 폐기된 단일프로세스 SQLite 설계.
- **상태·로드맵·보안모델이 리포 밖에만 존재**: 정본이 Claude 외부 auto-memory(이 PC 로컬, 버전관리 안 됨)에만 있다. PC 고장·리포 클론 시 로드맵·보안 태세가 통째로 소실.
- **워커 실행 런북 부재**: 소유자 PC 작업의 현재 유일 경로인데 `worker` npm 스크립트·PM2 엔트리·실행 문서 전무.
- **SECURITY / TESTING 문서 부재**: 다층 방어와 "보안리뷰 #1–#4"를 코드가 인용하지만 그 원본 문서가 없음. pg-mem이 못 잡는 보안·동시성 보장(실 Supabase 스모크 필요)도 미문서화.

### 1.3 역사 문서 — 정확하나 상태 스탬프 없음
specs 5 · plans 6 · note 1(총 13건)은 전부 점-시점 기록으로 정확하다. 유일한 문제: 상태 스탬프가 없어 **이미 배포된 작업이 아직도 "설계 승인 대기 / 구현 대기 + 미체크 태스크 박스 200개+"로 읽혀** 재실행 위험을 만든다.

## 2. 확정된 결정

| # | 결정 | 선택 | 함의 |
|---|---|---|---|
| D1 | 문서 언어 | **한국어 유지** | 새 문서도 전부 한국어. 기존 문서·코드주석·페르소나와 일관 |
| D2 | 상태·보안모델 | **리포로 승격** | 외부 메모리 → `docs/status`·`docs/security`가 단일 진실원천 |
| D3 | 공개 SECURITY 수위 | **완화 서술** | 위협모델·능력계층은 공개, 악용 세부(정확한 사칭 경로)는 일반화 |
| D4 | 작업 범위 | **문서 + worker 스크립트 + CI 자동화** | 최대 범위. 코드(worker 배선)·CI(docs 린트)까지 포함 |

## 3. 목표 문서 분류(taxonomy)

```
E:/Asahi/
├─ README.md                    [살아있음] 첫 진입면 — 재작성
├─ CONTRIBUTING.md              [신규]    셋업→실행→테스트→아키텍처 경로 + TDD 관례
├─ SECURITY.md                  [신규]    공개용 완화 위협모델 (GitHub 표준 위치=루트)
├─ CHANGELOG.md                 [신규]    Keep a Changelog, 커밋에서 큐레이션
├─ .env.example                 [수정]    ANTHROPIC_MODEL 추가
│
├─ docs/
│  ├─ README.md                 문서 인덱스 (무엇이 어디에)
│  ├─ architecture/
│  │  ├─ overview.md            3-프로세스 하이브리드 토폴로지 + 다이어그램
│  │  ├─ data-flow.md           메시지 수명주기(ingest→turn→위임/직접→응답 + 크래시복구 불변식)
│  │  ├─ module-boundaries.md   디렉토리 책임·의존 방향·이벤트버스 4개 계약
│  │  └─ glossary.md            용어집 (conversation vs SDK session, ingest/turn 체인 등)
│  ├─ security/
│  │  ├─ capability-model.md    allowedToolsFor 계층·신원게이팅·경로게이팅·READ ONLY tx
│  │  └─ risk-register.md       알려진 한계(완화 서술) — DATABASE_URL 취급, WORKER_SECRET/RLS 미구현
│  ├─ status/
│  │  ├─ STATUS.md              현재 단계·라이브·미완 스모크   ← 외부 메모리 승격
│  │  └─ ROADMAP.md             2C 이후 로드맵            ← 외부 메모리 승격
│  ├─ decisions/
│  │  ├─ README.md              ADR 인덱스 + 형식
│  │  ├─ 0001-sqlite-to-postgres.md
│  │  ├─ 0002-railway-local-worker-hybrid.md
│  │  ├─ 0003-opus-4-8-default.md
│  │  ├─ 0004-readonly-tx-introspection.md
│  │  ├─ 0005-owner-only-delegation.md
│  │  └─ review-ledger.md       코드가 인용하는 '리뷰 #N'·'보안리뷰 #N' 원장
│  └─ design-archive/           ← 기존 docs/superpowers/ 이동 (git mv, 이력 보존)
│     ├─ README.md              인덱스 — 각 문서 상태·대응 커밋 매핑
│     └─ specs/ plans/ notes/   13건 + 상태 스탬프 + 폐기 배너
│
├─ deploy/
│  ├─ railway-셋업.md           유지 (최신)
│  ├─ 다른-PC-셋업.md            수정 (Postgres 현실)
│  ├─ PM2-명령어.md             폴백 배너 + 윈도우자동실행.txt 흡수
│  ├─ worker-셋업.md            [신규] 워커 실행·검증·소유자전용 제약
│  ├─ incident-runbook.md       [신규] 크래시복구 증상→원인→조치, Railway 롤백, Supabase 트러블슈팅
│  └─ smoke-test.md             [신규] 배포 후 기능별 체크리스트 (미완 항목 추적)
│
└─ .github/workflows/docs.yml   [신규] 링크체크 + 상태 front-matter 린트 + 회귀 가드
```

### 3.1 스펙 수명주기 관례 (중요)
`docs/superpowers/{specs,plans}`는 **진행 중(in-flight)** SDD 작업공간으로 유지한다(brainstorming→writing-plans 도구가 여기 쓴다). 작업이 **배포되면 `docs/design-archive/`로 이동**한다. 지금 13건은 전부 배포 완료라 통째로 아카이브로 옮긴다. 이 문서체계 스펙 자체도 완료되면 같은 규칙으로 아카이브된다.

## 4. 영역별 설계

### 4.1 살아있는 문서 즉시 수정 (출혈 정지)
- **`README.md`**: SQLite/agent.db → Postgres/Supabase(+DATABASE_URL). Railway 봇 + 로컬 워커 + Supabase 토폴로지 섹션 추가(`deploy/railway-셋업.md` 링크). `src/` 목록에 `worker.ts` 등 추가. `현재 단계` 문장은 값을 박지 말고 `docs/status/STATUS.md` 링크로 대체.
- **`deploy/다른-PC-셋업.md`**: §사전요구의 `better-sqlite3` 빌드 단계 삭제. `DATABASE_URL`(Session pooler)을 필수 사전요구로 추가. §2·§데이터이전을 "기억은 Supabase 중앙 — PC별 이전 불필요"로 재작성. §3 `allow_dir` 저장 설명은 유지(경로가 PC별인 건 여전히 사실). 말미 "자동 동기화 없음" 노트를 "Supabase로 이미 공유됨"으로 반전.
- **`deploy/PM2-명령어.md`**: 상단 배너 — "24/7 상시구동은 Railway(`railway-셋업.md`). 이 PM2 흐름은 로컬/폴백용. 토큰 1개라 Railway를 먼저 정지해야 함." 기계적 내용은 유지.
- **`.env.example`**: `ANTHROPIC_MODEL=`(선택, 기본 `claude-opus-4-8`) 추가. `CLAUDE_CODE_OAUTH_TOKEN`이 cloud에서 사실상 필수임을 주석에 명시.
- **정리**: 낡은 `data/store/agent.db`·`-wal`·`-shm`(디스크 잔재) 삭제. `.gitignore`에 `*.txt` 추가(재생성되는 `server.txt`/`localworker.txt` 실수 커밋 방지). `agent/윈도우자동실행.txt`는 내용을 `PM2-명령어.md`의 "부팅 자동시작" 섹션으로 흡수 후 삭제.

### 4.2 신규 살아있는 문서
- **`docs/architecture/overview.md`**: 3-프로세스 토폴로지 다이어그램(Railway 봇 · 로컬 워커 · Supabase). `worker_jobs` 위임 큐 + `worker_heartbeats` 조율. `deployTarget=cloud/local` 분기. 이벤트버스 위치.
- **`docs/architecture/data-flow.md`**: Discord `messageCreate` → `decideRoute` → bus → **ingest 체인**(durable insert, `processed=false`) → **turn 체인**(한도 예약 → 위임 또는 직접 `runTurn`) → 응답 이벤트 → 전송. 크래시복구 불변식과 위임-vs-로컬 분기를 명시.
- **`docs/architecture/module-boundaries.md`**: `adapters`/`core`/`events`/`store`/`worker`/`memory` 디렉토리 책임, 허용 의존 방향, 이벤트버스 4개 이벤트(`user_message`/`assistant_message`/`progress`/`system_notice`).
- **`docs/architecture/glossary.md`**: conversation vs SDK session, ingest 체인 vs turn 체인, 위임/heartbeat/online-cutoff, `deployTarget`, `ownWorkstation`, `rapportStage`, turns 예약, owner/allowed/blocked.
- **`docs/security/capability-model.md`**: `allowedToolsFor` 계층(owner-DM-local/cloud, ownWorkstation, 손님, 서버) 표, `isOwner`(신원) vs `role`(역할) 게이팅, 경로 게이팅(realpath·glob 리터럴 접두), READ ONLY SQL 가드. 보안-핵심 파일 목록(`pathPermission.ts`, `tools.ts` allowedToolsFor, `agent.ts` canUseTool, `sqlGuard.ts`)과 지키는 불변식·가드 테스트.
- **`docs/security/risk-register.md`** + 루트 **`SECURITY.md`**(완화 서술): 자산·행위자(손님, 관찰콘텐츠·이미지 경유 프롬프트 인젝션, 클라우드 컨테이너)·완화책→집행코드 매핑. 알려진 한계는 **일반화해** 서술 — "`DATABASE_URL`은 소유자 전용 비밀이며 유출 시 위임 신뢰경계가 무너진다. 손님용 워커는 `WORKER_SECRET` 검증·RLS 미구현으로 아직 미지원." 정확한 사칭 절차는 싣지 않는다.
- **`CONTRIBUTING.md`**: 사전요구(Node 22+, `DISCORD_OWNER_ID`·`CLAUDE_CODE_OAUTH_TOKEN` 발급법), 셋업→`npm test`→실행→아키텍처 경로, TDD 기대, 설계 문서 위치.
- **`deploy/worker-셋업.md`**: 로컬 워커 실행(`npm run worker` 또는 PM2)·검증(heartbeat→봇 위임 확인)·`WORKER_USER_ID=소유자ID` 제약·소유자 전용 정책.
- **`deploy/incident-runbook.md`**: 자기치유 동작의 증상→원인→조치(부팅 시 `recoverPending`, 60초 `deliverPendingJobResults` 스윕, `failStaleRunning`, 120초 "아직 처리 중이에요" 후 지연배달, resume-session-not-found→새 세션), 안전 재시작, Railway 롤백, Supabase 연결 결정트리(무료티어 자동정지·풀 고갈·자격증명 회전).
- **`deploy/smoke-test.md`**: 배포 후 기능별 체크리스트(유저별/전역 한도, 이미지 멀티모달, DB 조회, 워커 위임, 크래시복구, `/새세션`) + pg-mem이 못 잡는 보안 보장(READ ONLY 쓰기거부, 채널/인젝션이 특권도구를 못 부름). 미완 항목 추적.

### 4.3 외부 메모리 → 리포 승격 (+ 새니타이즈)
공개 repo이므로 **민감정보 제거·일반화**가 전제다.

| 외부 메모리 | → 리포 목적지 | 새니타이즈 |
|---|---|---|
| `project-status.md` | `docs/status/STATUS.md` + `ROADMAP.md` | Discord owner ID·앱 ID·`.env` 경로 제거 |
| `security-capability-model.md` | `docs/security/capability-model.md` + 루트 `SECURITY.md` | 악용 경로 일반화(D3 완화 서술) |
| `github-repo.md` | `README`/`CONTRIBUTING` 배포 섹션 | 공개 정보라 그대로 |

승격 후 외부 `MEMORY.md`의 해당 항목은 **"정본은 `docs/status/STATUS.md`"** 포인터로 축소한다(이중 관리 제거). 앞으로 상태는 리포에서 유지한다.

### 4.4 역사 문서 아카이브 정책
- `git mv docs/superpowers/{specs,plans,notes} docs/design-archive/`(이력 보존).
- 각 문서에 YAML front-matter 상태 스탬프 추가(§5 규약).
- SQLite/PM2 시대 문서(`2026-07-11-pc-ai-assistant-design`, `phase1`, `phase2a`) 상단에 **한 줄 폐기 배너**(→ 현재 현실·대응 ADR 링크). 본문은 손대지 않는다.
- `docs/design-archive/README.md` 인덱스: 각 문서 → 상태(Shipped/Superseded) → 대응 커밋/ADR 매핑.

### 4.5 결정 기록(ADR) + 변경 로그
- `docs/decisions/` ADR 5건: 각 결정의 맥락·선택·결과. 코드의 `리뷰 #N` 마커가 인용할 실제 문서를 제공. `review-ledger.md`로 적대적 리뷰 라운드(#1–#7 / 보안리뷰 #1–#4) 정리.
- `docs/decisions/README.md`: ADR 형식(간단한 MADR 스타일: 맥락/결정/결과/상태) 안내.
- `CHANGELOG.md`: Keep a Changelog 형식, 단계(Phase 1/2A/2B/…)별로 묶어 88개 커밋에서 큐레이션.

### 4.6 코드 · CI 배선 (D4)
- **worker 배선**(코드): `agent/package.json`에 `"worker": "tsx src/worker.ts"`·`"worker:start": "node dist/worker.js"` 추가. `deploy/ecosystem.config.cjs`에 두 번째 PM2 앱(`asahi-worker`, `script: dist/worker.js`) 추가. `deploy/worker-셋업.md`가 문서화.
- **CI**(`.github/workflows/docs.yml`):
  1. **Markdown 링크 체크**(내부 상대링크 깨짐 검출).
  2. **상태 front-matter 린트**: `docs/design-archive/**`의 각 문서에 `status:` 존재 검증(작은 스크립트).
  3. **회귀 가드**: 살아있는 문서(README·deploy·.env.example)에 `agent.db`/`better-sqlite3` 재등장 시 실패(드리프트 재발 방지).

## 5. front-matter 규약 (표준화)

모든 관리 대상 문서 상단에 YAML front-matter를 둔다. 이 스펙 문서 자체가 첫 사례다.

```yaml
---
title: <제목>
date: <YYYY-MM-DD>           # 작성/최종 개정일
status: Draft | Approved | Shipped | Superseded   # 역사 문서용
lastReviewed: <YYYY-MM-DD>  # 살아있는 문서용(현실 대조일)
supersededBy: <경로 또는 커밋>   # Superseded일 때
---
```

- **역사 문서**(design-archive)는 `status` + `shippedIn`(커밋) 위주.
- **살아있는 문서**는 `lastReviewed` 위주(현실과 마지막으로 대조한 날짜).

## 6. 실행 순서 (계획 단계에서 태스크로 상세화)

1. **출혈 정지**(§4.1): 살아있는 문서 수정 + 잔재 정리 + `.gitignore`.
2. **스캐폴딩 + 아카이브 이동**(§3·§4.4): `docs/` 하위 폴더 생성, `git mv` 아카이브, 상태 스탬프·배너·인덱스.
3. **메모리 승격 + 새니타이즈**(§4.3): STATUS/ROADMAP/security 리포로, 외부 MEMORY.md 포인터화.
4. **신규 살아있는 문서**(§4.2): architecture 4종 · security 2종 + 루트 SECURITY.md · CONTRIBUTING · deploy 런북 3종.
5. **결정 기록**(§4.5): ADR 5건 + review-ledger + CHANGELOG.
6. **코드·CI**(§4.6): worker 스크립트/PM2 엔트리 + `docs.yml`.
7. **인덱스·링크 연결**: `docs/README.md` + README 링크 정리, 전체 링크 점검.

## 7. 성공 기준 (acceptance)

- 살아있는 문서 어디에도 `SQLite`/`agent.db`/`better-sqlite3`가 현재 저장소로 서술되지 않는다(회귀 가드 통과).
- 리포만 클론한 사람이 문서만으로 셋업→테스트→봇 실행→워커 실행을 완수할 수 있다.
- 프로젝트 상태·로드맵·보안 능력모델이 리포 안에 존재하고, 외부 메모리는 리포를 가리킨다.
- 3-프로세스 아키텍처·데이터 흐름·능력계층이 코드 없이 문서로 이해 가능하다.
- 역사 문서 13건이 모두 `status:` 스탬프를 갖고, 배포 완료분이 "구현 대기"로 오독되지 않는다.
- 코드의 `리뷰 #N` 마커가 가리킬 ADR/원장이 리포에 존재한다.
- `npm run worker`가 존재하고 `deploy/worker-셋업.md`가 실행·검증을 안내한다.
- `docs.yml` CI가 통과하며 링크·front-matter·회귀를 검사한다.

## 8. 비목표 (out of scope)

- **`WORKER_SECRET` 검증·RLS 등 손님 워커 인증 구현** — 별도 보안 작업. 여기선 문서화만(위험 등록부).
- **소스 코드 리팩터링** — worker 스크립트/PM2 엔트리 외 코드 변경 없음.
- **문서 자동생성(TypeDoc 등)** — 이번 범위 아님.
- **영문 번역** — D1로 한국어 유지(핵심 문서 영문화는 후속 선택지).
- **스모크 테스트 실행** — 체크리스트 문서화까지. 실제 실행은 소유자 몫.

## 9. 위험 · 유의

- **민감정보 누출**: 승격 시 새니타이즈를 빠뜨리면 공개 repo에 owner ID·앱 ID가 노출된다. §4.3 새니타이즈는 필수 게이트 — 커밋 전 grep 확인.
- **이중 관리 재발**: 외부 메모리를 포인터화하지 않으면 상태가 두 곳에서 갈라진다. §4.3 마지막 단계 필수.
- **아카이브 이동 시 링크 깨짐**: `docs/superpowers/` 경로를 참조하던 문서·메모리 링크를 `git mv` 후 일괄 갱신해야 한다(§6 7단계 링크 점검).
- **역사 문서 원문 훼손**: 폐기 배너는 상단 한 줄 + front-matter만. 본문은 점-시점 기록으로 보존한다.
