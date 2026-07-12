# 다른 PC에서 Asahi 운영하기

이 PC가 꺼져 있어도 다른 PC에서 봇을 띄울 수 있게 하는 절차. 코드는 GitHub(`wwoosshh/asahi`)에 있고, **비밀값(.env)과 기억(data/)은 git에 올라가지 않으므로** 새 PC에서 따로 준비한다.

## 사전 요구
- **Node.js 22 이상**, **git**
- (Windows) `better-sqlite3`가 네이티브 모듈이라, npm install 시 prebuilt 바이너리를 받지 못하면 빌드 도구가 필요할 수 있다: Visual Studio Build Tools(“Desktop development with C++”) 또는 `npm i -g windows-build-tools`. 대개는 prebuilt로 자동 해결된다.

## 최초 셋업 (새 PC에서 한 번)

```powershell
git clone https://github.com/wwoosshh/asahi.git
cd asahi\agent
npm install
npm run build
```

### .env 준비 (리포 루트에 둔다: `asahi\.env`)
`.env.example`을 복사해 값을 채운다.
```powershell
cd ..
copy .env.example .env
notepad .env
```
- `DISCORD_TOKEN` — 이 PC와 **같은 봇**의 토큰 (Discord Developer Portal)
- `DISCORD_OWNER_ID` — 소유자(본인) 디스코드 숫자 ID
- `CLAUDE_CODE_OAUTH_TOKEN` — `claude setup-token`으로 발급한 구독 토큰
- 나머지(한도·경로 등)는 비워두면 기본값

### 실행
```powershell
cd agent
pm2 start ..\deploy\ecosystem.config.cjs
pm2 logs asahi-assistant --lines 20   # "[discord] 로그인 완료" 확인
```
(부팅 자동시작·PM2 명령어는 `deploy/PM2-명령어.md` 참고)

## ⚠️ 반드시 지킬 것

### 1. 봇은 한 번에 한 PC에서만
디스코드 봇 토큰은 하나다. **두 PC에서 동시에 실행하면 게이트웨이 세션이 충돌**한다. 다른 PC에서 띄우기 전에 현재 PC의 봇을 반드시 멈춘다:
```powershell
pm2 stop asahi-assistant     # 기존 PC에서
```
그 다음 다른 PC에서 `pm2 start`. 즉 “현재 PC 미작동 → 다른 PC 가동”은 되지만 **동시 가동은 금지**.

### 2. 기억(data/)은 각 PC 로컬 — 자동으로 이어지지 않음
`data/`(SQLite DB `agent.db` + 개인 기억)는 개인정보라 GitHub에 올리지 않는다(.gitignore). 따라서 **새 PC는 빈 기억으로 시작**한다. 기억을 이어가려면 `data/` 폴더를 옮겨야 한다(아래 “데이터 이전”).

### 3. 허용 폴더(Phase A)는 그 PC 경로 기준
`allow_dir`로 등록한 폴더는 `data/`의 DB에 저장된다. 새 PC에선 경로가 다르므로 그 PC에서 다시 `allow_dir` 해야 한다.

## 코드 업데이트 (양쪽 PC 공통)
이 PC에서 작업 후:
```powershell
git add -A && git commit -m "..."   # 커밋
git push
```
다른 PC에서 받기:
```powershell
git pull
cd agent && npm install   # package.json 바뀌었을 때만
npm run build
pm2 restart asahi-assistant
```

## 데이터 이전 (기억을 그대로 옮기고 싶을 때)
봇을 멈춘 뒤 `data/` 폴더 전체를 새 PC의 같은 위치(리포 루트 아래 `data/`)로 복사한다. WAL 파일(`agent.db-wal`, `agent.db-shm`)도 함께 복사하거나, 복사 전 `pm2 stop`으로 안전하게 종료해 체크포인트되게 한다.

> 상시 자동 동기화(양 PC가 같은 기억 공유)는 별도 설계가 필요하다 — private 스토리지 동기화나 원격 DB. 현재는 코드만 공유하고 기억은 수동 이전한다.
