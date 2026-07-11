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
npm run dev       # 개발 실행 (agent/.env 필요)
```

## 상시 구동 (PM2)

```powershell
cd agent
npm run build
pm2 start ../deploy/ecosystem.config.cjs
```

자세한 설계·로드맵은 [docs/](docs/) 참고. 현재 단계: **1단계 (코어 + SQLite/메모리 + 디스코드 봇 + PM2)**.
