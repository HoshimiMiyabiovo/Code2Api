# Changelog

本文件记录 Code2Api 的重要变更。版本号遵循 SemVer，格式参考 Keep a Changelog。

## [Unreleased]

### 新增

- 请求内自动重试（429 回避）：对限流、5xx、超时、网络错误、空首包按指数退避 + 抖动重试；优先采用上游 `Retry-After`；所有渠道冷却时等待最早恢复而不是立即 503；流式仅在首包前重试；客户端取消会中断等待。
- 面板新增“重试与限流回避”设置，可实时修改并热加载；配置项位于 `routing.retry`。
- 新渠道类型 `zcode`：把本机 ZCode CLI 以 `app-server`（stdio NDJSON「ZCode Protocol」）方式拉起为任务级渠道。worker 池（会话亲和/空闲回收/重启预算）、会话绑定与台账增量去重（独立 `zc_*` 表）、`part.delta` 文本/推理增量归一化、`turn.completed` 用量透传、权限请求进面板「待处理提问」。凭据复用桌面端共享登录态（`~/.zcode/v2/credentials.json`），无自动模型发现（`models` 必填，upstream 为 `providerId/modelId`）。
- 新渠道类型 `qoder`：把 Qoder CLI 以 daemon（`--sdk`，stdio NDJSON）方式拉起为任务级渠道。默认复用 IDE 内嵌执行端（`Qoder.exe` + `ELECTRON_RUN_AS_NODE=1` 跑自带 `qoder-worker-runtime.obf.mjs`，与 IDE 拉起方式一致），也可指向独立 `qodercli`。`daemon.initialize`（协议版本 2）握手就绪探针、`daemon.open_session` 多会话、`stream_event`/`streamlined_text`/`assistant` 兜底归一化、`result` 用量透传（snake_case 兼容）、`can_use_tool` 反向请求进面板「待处理提问」（`bypass_permissions` 自动放行）、`daemon.list_sessions` 存在性检查 + 台账重放、oneshot `daemon.close_session` 收尾、空闲期 `keep_alive` 心跳。凭据（IDE 登录态复用 vs `QODER_PERSONAL_ACCESS_TOKEN`）与 upstream 真实取值待真实冒烟校准；无自动模型发现（`models` 必填）。
- opencode/codearts 渠道新增 `/event` 原始帧 debug 日志：每次事件流连接打印前 N 帧（`event_debug_frames`，默认 20，0=关闭），日志单行、脱敏（token/password/authorization 等键替换为 `***`）并截断；解析失败、缺 `type`、提取不到 sessionID、无订阅者等丢弃路径会带帧号与原因打印（debug 级别，`CODE2API_LOG_LEVEL=debug` 开启）。事件流结束时始终输出「收到 N 帧 / 丢弃 M 帧」汇总。
- opencode/codearts 渠道新增首包看门狗（面板可配）：`stream_heartbeat_ms`（默认 10s，0=关闭）在上游静默时向客户端发 SSE 注释帧，避免客户端空闲超时先掐断；`first_byte_timeout_ms`（默认 120s，0=关闭）内未收到任何代表模型开始处理的上游事件（用户消息回显不算），中断任务并返回明确超时错误，不再静默等到客户端取消。

### 修复

- CodeArts 渠道流式对话一直无输出、最终被客户端取消：IDE 内核（v126.11.1 实测）的 SSE 负载是 `{type, properties}`，与原版/kilo 的 `{type, data}` 不同；网关此前只读 `data`，导致 `message.part.updated` / `session.idle` 全部被静默丢弃，上游实际已生成完整回复，客户端却干等到超时。事件解析现在统一把 `properties` 归一化为 `data`，fake CodeArts server 也改为真实负载格式并补流式回归。
- 事件归一化进一步兼容真实形态：支持 `{directory, payload:{type, properties}}` 信封（最多剥 3 层）、`{type, data}` / `{type, properties}` 混合、`data` 与 `properties` 同时存在；sessionID 现在会从顶层、`data/properties`、`info`、`part`、`message`、`session`、`request`、`form`、`params` 等多处递归提取（深度 4），避免因为换一层包装就整条流静默。补 envelope fake 回归与归一化/脱敏单元测试。
- 提问挂起期间客户端空闲超时掐断连接导致“没法过几小时再回答”：审批/提问挂起时 opencode/zcode 渠道现在周期性发 SSE 心跳注释帧（`: keepalive`，客户端语义忽略但字节不断，间隔 = max(3s, min(15s, 提问上限/8))），`question_timeout_ms` 默认从 10 分钟放宽到 2 小时（config.yaml 里的显式值需手动调整或用新默认重建渠道）。挂起结束/任务终态时心跳停止。
- kilo 渠道审批应答 404（`PermissionNotFoundError`）：任务失败/中断/超时后 kilo 会丢弃未决审批与提问，但网关的挂起项此前只在任务成功路径清理，用户对着死请求点“继续”就拿到裸 502。现在终态路径统一清理挂起项；应答遇到 404 时清除陈旧挂起并返回 410「该审批/提问请求已失效（对应任务已结束或服务端已丢弃），请重新发起对话」。
- kilo 渠道审批/提问应答 400（`Missing key at ["reply"]`）：kilo fork 的 permission reply body 键是 `{ reply }`（SDK 实测枚举 once/always/reject 与原版一致），原版 opencode 是 `{ decision }`；form 在 kilo 下不存在，等价物是 question 路由（`/api/session/:id/question/:requestID/reply`，body 为 `{ answers: [...] }`）。网关按 flavor 分支发送；fake opencode server 按风味严格校验应答 body 并新增 question 路由。
- kilo 渠道对话挂死不执行：kilo fork 的 v1 `POST /api/session/:id/prompt` 只把输入入队（实测仅发 `session.next.prompted` 事件、不调度 agent loop），网关必须改走 v2 `POST /session/:id/message`（parts 形式）触发执行。kilo 的事件流与原版不同（`message.part.updated` 以 part 累积全文推送、`message.updated` 带消息级用量，无 `session.text.delta`/`session.step.ended`），网关按风味差分映射为文本/推理增量并回填用量；synthetic 占位 part 忽略；part 更新对 user 消息同样会发（包含整段注入的系统提示词），按 messageID→role 过滤只透传 assistant 消息，修复“用户提示词被当模型输出流回”的泄漏。fake opencode server 新增 v2 路由与事件流镜像（含 user part 泄漏回归断言）。
- kilo 渠道推理档位探测不到：kilo fork 的 `/api/model` 恒返回空 variants 数组（与原版 opencode 不同），档位实际经会话级 `model.variant` 生效（实测任意 effort 值回显、缺省 `"default"` 即非思考）。网关现在对 kilo 将客户端 `reasoning_effort` 直接映射为会话 variant（小写透传），发现时把 kilo 模型的 `reasoning` 能力标记为 true（否则带 effort 的请求会被能力过滤拦下）。fake opencode server 镜像 kilo 的 variant 回显行为并新增回归测试。
- kilo 渠道会话桥接 400（`Missing key at ["prompt"]`）：kilo fork 的 `/api/session/:id/prompt` 请求体是 `{ prompt }`（SDK 参数表实测：id/prompt/delivery/resume），原版 opencode 是 `{ text, delivery }`；网关按 flavor 分支发送，kilo 不传 `delivery`（追加 prompt 由其内置 prompt-queue 排队）。fake opencode server 按风味严格校验 prompt 请求体，防回归。
- 密钥冷却不再滚雪球：上游明确给出 `Retry-After` 时直接按上游窗口冷却（仍受 `cooldowns.max_ms` 封顶），不再与本地指数退避取 max——修复单 key 渠道在上游限流窗口仅数十秒时本地冷却被连续失败指数放大到分钟级、且 `Retry-After` 永远无法收缩冷却的问题。指数封顶从 `2^5` 收紧为 `2^3`（最多 8 倍基数）。
- 所有渠道冷却耗尽返回 503 时，错误信息附带诊断（本轮重试等待轮数/时长、上游尝试次数），请求台账不再显示误导性的 `attempts: 0`（此前等待循环里真实发生并失败的上游尝试被记账丢失）。
- zcode 渠道 `session/requestRuntimePreferences` 应答改为 `{nativeSearchEnhancementsEnabled: false}`：CLI v0.17.1 对该应答做 strict zod 校验（必填 boolean、拒绝未知键），旧的 `{presentationSurface: 'terminal'}` 会让 `session/create` 永远失败（`ensureReady` ZodError）。fake server 补上同款严格握手作为回归测试。
- zcode worker `waitReady` 不再把「进程退出」产生的拒绝误判为「协议存活→就绪」，启动期崩溃现在会带退出原因直接失败。
- zcode worker 的 stderr 尾部（logTail）透出到 admin API 与面板渠道行悬浮提示，便于排障。

### 说明

- 独立 CLI（app-server 模式）的 Provider Registry 与桌面端内嵌实例不同：桌面端注入自己的凭据库，独立 CLI 只读共享 `~/.zcode/v2/credentials.json`，缺少账号 identity 凭据时所有 `account:*` provider 均 `entitled:false`，任何 `session/create` 模型校验都会失败。需要 CLI 自身完成一次 `zcode login`（浏览器授权写入共享登录态）后账号 provider 才会注册。

## [0.1.0] - 2026-11-20

首个可用版本。

### 新增

- 协议入口：`/v1/chat/completions`（流式/非流式、工具调用）、`/v1/models`、`/v1/messages`（流式/工具、thinking 开关）、`/v1/messages/count_tokens`、`/v1/responses`（流式/非流式、工具调用、`previous_response_id`）。
- 渠道类型：mock、openai-compatible、opencode（CLI 任务级）。
- key 池：轮询、按 401/402/429/5xx/网络错误分级冷却、故障转移、最大尝试次数、全局并发闸、客户端密钥。
- 模型目录：上游 `/models` 与 opencode `/api/model` 自动同步；手工模型优先；别名/通配、黑名单、推理能力推断、上下文窗口回填。
- opencode 桥接：自动拉起或连接已有 serve、worker 池（会话亲和/空闲回收/RSS 预算）、会话账本与增量去重、事件归一化、form/permission 挂起恢复、面板待处理提问。
- 工作区：渠道默认 `workspace`；新增请求头 `x-code2api-workspace` 与 `workspace_roots` 白名单（绝对路径、已存在、真实路径校验）；新会话创建时绑定工作区，已绑定会话换目录返回 400；面板可配置根目录。
- 运行时治理：主动探活、通用额度探针、保活、请求与用量/费用统计、SQLite 持久化、数据库导出（`VACUUM INTO`）。
- 管理面板：渠道/密钥/模型增删改与热加载、模型目录、请求日志、统计、提问处理。
- 运维：`start.cmd`（单实例守卫、缺配置自动生成、先 build 后启动）；`config.example.yaml`；fake/mock 自动化测试。

### 变更

- 渠道表的模型列改为「N 个模型」可展开，避免长模型列表把表格行撑高。
- opencode 模型发现只接受 `type === 'chat'`，过滤旧版配置遗留的空壳免费模型。
- 面板静态资源按请求读取，修改 `public/` 无需重启。

### 说明

- 历史数据默认永久保留：面板时间范围仅影响查询，不删除数据。
- 自动化测试不调用真实上游，不消耗渠道额度。
