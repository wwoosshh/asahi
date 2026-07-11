# 2B API 스파이크 결과 (확정)

설치 버전 기준으로 2B 계획의 코드가 사용할 실제 API를 확정한다.

## @anthropic-ai/claude-agent-sdk@0.3.207 — 인프로세스 MCP 도구 + 권한

- **도구 정의**: `tool(name: string, description: string, inputSchema: ZodRawShape, handler: (args, extra) => Promise<CallToolResult>, extras?)`
  - `CallToolResult` = MCP 표준(`{ content: [{ type: "text", text }] }` 형태). 텍스트 반환.
- **서버 생성**: `createSdkMcpServer({ name: string, version?: string, instructions?: string, tools: SdkMcpToolDefinition[] })` → `McpSdkServerConfigWithInstance`.
- **등록**: `query({ options: { mcpServers: { [name]: server } } })` (`mcpServers?: Record<string, McpServerConfig>`).
- **호출 이름**: 모델에는 `mcp__<serverName>__<toolName>` 형태로 노출 → `allowedTools`에 이 이름을 넣어 허용.
- **턴별 게이팅 2가지**:
  - `allowedTools?: string[]` — 허용 목록(내장 Read/Write… + `mcp__asahi__remember` 등).
  - `canUseTool?: (toolName, input, opts) => Promise<PermissionResult>` — 동적 허용/거부 콜백. role·is_private로 특권/PC 도구 거부에 사용 가능.
- 결론: **턴마다** `allowedTools`(정적)로 도구셋을 좁히고, 필요 시 `canUseTool`로 이중 방어. role·isPrivate는 도구 handler·canUseTool 클로저로 주입.

## discord.js v14.26 — 스레드

- **스레드 생성**: `message.startThread(options: StartThreadOptions): Promise<PublicThreadChannel>` (`{ name, autoArchiveDuration }`). 권한 부족/불가 시 예외 → try/catch로 폴백(인플레이스 답장) + logs.
- **스레드 판별**: `channel.isThread(): this is AnyThreadChannel`. thread면 `channel.id`가 대화 매핑 열쇠.
- **채널 최근 메시지**: `channel.messages.fetch({ limit })` (Task 3에서 허용 사용자 발화만 필터).
- **멘션 판별**: `message.mentions.has(client.user)` (Task 3에서 확인·사용).
- 필요 권한(초대 시): CreatePublicThreads, SendMessagesInThreads (Task 3 구현 시 PermissionFlagsBits로 확인).

## 결론

2B 계획의 아키텍처(인프로세스 MCP 도구로 remember/recall/manage_access, 턴별 allowedTools로 능력계층, @멘션→startThread)가 실제 API로 전부 성립. Task 2~6은 이 시그니처대로 진행.
