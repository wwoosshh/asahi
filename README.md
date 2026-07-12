# Asahi — 개인 AI 비서 (상주 에이전트)

Claude Pro/Max 구독 + Claude Agent SDK 기반으로, PC에 상주하며 **기억이 이어지는** 개인 AI 비서.
디스코드로 대화하고, 세션이 바뀌거나 PC가 재부팅되어도 기억(SQLite + 마크다운)이 끊기지 않는다.

## 폴더 구조

```
Asahi/
├─ agent/     상주 에이전트 앱 (백엔드 데몬) — TypeScript / Node.js
│  ├─ src/       core · adapters · events · store · memory · config · index
│  └─ tests/     vitest 단위 테스트
├─ data/      런타임 데이터 (git 제외)
│  ├─ store/     SQLite DB (agent.db)
│  └─ memory/    비서의 장기 기억 (마크다운)
├─ deploy/    PM2 상시구동 설정 (ecosystem.config.cjs)
└─ docs/      설계 · 구현 계획 문서
```

- **루트**에는 폴더와 리포 메타파일(`.gitignore`, `README.md`)만 둔다.
- **코드(`agent/`)와 런타임 데이터(`data/`)를 물리적으로 분리** — DB를 Beekeeper로 열거나 백업할 때 코드와 섞이지 않는다.
- 각 단계(Phase)는 새 폴더로 나란히 확장한다 (예: Phase 4 웹 UI → 루트에 `web/`).

## 개발

```powershell
cd agent
npm install
npm test          # 단위 테스트 (vitest)
npm run dev       # 개발 실행 (루트의 .env 필요 — .env.example 참고)
```

## 상시 구동 (PM2)

```powershell
cd agent
npm run build
pm2 start ../deploy/ecosystem.config.cjs
```

PM2 운영 명령어는 [deploy/PM2-명령어.md](deploy/PM2-명령어.md) 참고.

## 다른 PC에서 운영

이 PC가 꺼져 있어도 다른 PC에서 봇을 띄울 수 있다. 절차와 주의사항(**봇은 한 번에 한 PC만**, 기억 `data/`는 각 PC 로컬이라 수동 이전, `.env`는 새 PC에서 준비)은 [deploy/다른-PC-셋업.md](deploy/다른-PC-셋업.md) 참고.

자세한 설계·로드맵은 [docs/](docs/) 참고. 현재 단계: **멀티유저 런타임(2A/2B) + 실시간 진행 UI + 소유자 원격 개발(Phase A: 허용 폴더 내 파일·셸)**.
