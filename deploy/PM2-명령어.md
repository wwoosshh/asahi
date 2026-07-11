# PM2 관리 명령어 (asahi-assistant)

- **프로세스 이름:** `asahi-assistant`
- **설정 파일:** `deploy/ecosystem.config.cjs` (script=`dist/index.js`, cwd=`agent/`, autorestart, max_restarts 50, restart_delay 5s)
- 명령은 PowerShell에서 실행. 최초 등록만 `agent/` 폴더 기준.

## 현재 상태 확인 (자주 씀)

```powershell
pm2 list                              # 전체 프로세스 상태 한눈에
pm2 status asahi-assistant            # 이 앱만 상태
pm2 logs asahi-assistant --lines 50   # 실시간 로그 (Ctrl+C 로 빠져나옴)
pm2 logs asahi-assistant --err        # 에러 로그만
pm2 monit                             # CPU/메모리 실시간 대시보드
pm2 info asahi-assistant              # 재시작 횟수·업타임·로그 경로 등 상세
```

## 코드 수정 후 재배포 ★ (소스 변경 반영은 이 흐름)

ecosystem이 `dist/index.js`를 돌리므로 **빌드가 먼저**. 소스만 고치고 restart하면 반영되지 않는다.

```powershell
cd E:\Asahi\agent
npm install                           # 의존성 바뀌었을 때만 (예: zod 추가)
npm run build                         # src → dist (필수)
pm2 restart asahi-assistant           # 새 dist 로 재기동
pm2 logs asahi-assistant --lines 20   # "[discord] 로그인 완료" 확인
```

> `.env`(토큰·소유자ID·한도)만 바꿨을 땐 빌드 없이 `pm2 restart asahi-assistant` 만. (dotenv가 런타임에 읽음)

## 시작 / 중지 / 삭제

```powershell
pm2 start ..\deploy\ecosystem.config.cjs   # 최초 등록·시작 (agent 폴더 기준)
pm2 stop asahi-assistant                    # 중지(등록은 유지)
pm2 restart asahi-assistant                 # 재시작
pm2 delete asahi-assistant                  # 프로세스 목록에서 제거
```

## 부팅 자동시작 관리

```powershell
pm2 save                              # 현재 실행 목록을 부팅 복원용으로 저장 ★
pm2 resurrect                         # 저장된 목록 수동 복원(문제 진단 시)
pm2-startup install                   # 윈도우 시작 등록
pm2-startup uninstall                 # 자동시작 해제
```

> **중요:** `start`/`delete`로 프로세스 목록을 바꾼 뒤에는 반드시 `pm2 save`를 다시 할 것. 안 하면 재부팅 시 예전 목록으로 복원된다. 단순 `restart`만 했다면 save 불필요.

## 로그 관리

```powershell
pm2 flush asahi-assistant             # 로그 파일 비우기(용량 관리)
pm2 reloadLogs                        # 로그 파일 핸들 재오픈
```

로그 파일 위치: `%USERPROFILE%\.pm2\logs\asahi-assistant-out.log` / `asahi-assistant-error.log`

## 상시구동(절전 방지) 확인 — 전원 연결 기준

```powershell
powercfg /query SCHEME_CURRENT SUB_SLEEP           # 현재 절전 설정 확인
powercfg /change standby-timeout-ac 0              # 대기모드 안 함
powercfg /change hibernate-timeout-ac 0            # 최대절전 안 함
powercfg /change monitor-timeout-ac 10             # 모니터만 10분 후 끔
```

## 문제 진단 팁

- **자꾸 재시작(restart 횟수 급증)** → `pm2 info asahi-assistant`에서 restart 카운트 확인 후 `pm2 logs asahi-assistant --err`로 원인 파악. `max_restarts: 50`이라 50회 넘게 죽으면 PM2가 포기하고 멈춘다(크래시 루프 방지). 원인 고치고 `pm2 restart asahi-assistant`.
- **로그인 안 됨** → `.env`의 `DISCORD_TOKEN` 확인. `.env`는 리포 루트(`E:\Asahi\.env`)에서 읽는다.
