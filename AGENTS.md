# AGENTS.md

> 面向在本仓库工作的 AI Agent 的硬性规则。项目设计与变更历史见 `docs/可行性分析.md`、`CHANGELOG.md`。

## 0. 第一原则：不准用真实请求做测试（防封号）

- 任何时候都不要为了“验证一下”去调用真实上游或消耗真实渠道额度；真实请求可能导致账号被封。
- 默认验证方式只有：
  - `npm test`（`test/` 下的 fake opencode / zcode server / mock 渠道）
  - 本地面板与 admin API 的只读检查
  - 前端 DOM / 布局检查
- 新增协议、路由或修复必须补 fake 测试，不要拿真实模型复现问题。
- 只有用户明确同意时才允许真实冒烟；先说明会消耗额度，请求次数最小化，并在结果中注明。
- fake 测试通过但怀疑真实链路时，先报告证据缺口并询问用户，不要自己连续发真实请求。

## 1. 其他硬性禁令

- 不提交、不打印、不写入文档/测试/记忆任何真实密钥或管理口令；`config/config.yaml` 已被 gitignore。
- 不自动删除任何历史数据；清理必须由用户明确要求，并先导出/备份（`/admin/api/export`）。
- 不自动 commit / push；用户偏好攒批提交，`git init` 后默认只暂存。
- 不修改用户的 git config；提交身份由用户提供。
- 不擅自修改外部配置（如 `~/.config/opencode/opencode.jsonc`）。

## 2. 改代码的正确流程

- 先读代码和当前运行状态，再修改。
- `npm run typecheck && npm test && npm run build`。
- 重启前先确认 8787 的 PID / 创建时间；本机可能同时有其他 Agent 或会话在改代码、重启网关。不要盲目再起实例，保留外部改动。
- 运行中的网关使用 `dist`；只改 `src` 不 build 不会生效。
- `public/` 静态资源按请求读取，改完刷新浏览器即可，不需要重启。

## 3. 配置与界面

- 渠道 / 密钥 / 模型的增删改走面板或 admin API，保存后热加载；不要要求用户手改 YAML。
- 表单要有枚举下拉、回显已保存值；长列表折叠为“N 个”可展开；配置必须能在 GUI 修改。
- 真实配置 `config/config.yaml` 不入库；示例只放占位符，密钥优先 `key_env`。

## 4. 本项目特有约束

- opencode `/api/model` 中缺 `type`、`name === modelID`、`cost` 为空的条目是配置残影，必须过滤（实际请求会返回 `Model is unavailable`）。
- 请求头 `x-code2api-workspace` 只接受 `workspace_roots` 白名单内已存在的绝对路径；会话首次创建时绑定工作区，已绑定会话换目录返回 400（opencode 的 `move` 会发 idle 事件）。
- codearts 风味桥接 CodeArts IDE 内核（旧版 opencode API，路由无 `/api` 前缀）：`/event` 可能是 `{type, properties}`，也可能套 `{directory, payload:{type, properties}}` 信封；sessionID 可能嵌在 `data/properties/info/part/message/session`。归一化在 `src/providers/opencode-worker.ts`，改协议先补 `test/codearts.test.ts` 的 fake 回归。排障时设 `CODE2API_LOG_LEVEL=debug`，前 N 帧（`event_debug_frames`，已脱敏）与丢弃原因会直接打印；首包预算/静默心跳用 `first_byte_timeout_ms` / `stream_heartbeat_ms`（面板可改）。
- 模型同步只进内存、不回写 YAML；手工 `models` 优先；上下文窗口从 `limit.context` / `limit.output` 发现并回填。`model_prefixes`（openai-compatible 与 opencode 渠道）可按 upstream glob 给自动发现的对外名加前缀（如 `opencode-go/*: Go/` 把订阅模型同步为 `Go/<modelID>`），upstream 与手工 models 不受影响。
- 历史数据永久保留；面板的时间范围只是查询窗口。
- zcode 渠道桥接 ZCode CLI 的 `app-server`（stdio NDJSON「ZCode Protocol」，v0.17.1 实测）：无自动模型发现，`models` 必填且 upstream 为 `providerId/modelId`；CLI 凭据复用桌面端共享登录态（`~/.zcode/v2/credentials.json`），未登录时只能报错引导；`session/create` 参数为 strict zod，CLI 升级可能破坏字段契约，真实 `providerId` 取值需冒烟校准（fake 测试不消耗 zai 额度）。
- zcode 协议反向请求的应答同样受 strict zod 校验（v0.17.1 实测）：`session/requestRuntimePreferences` 必须答 `{nativeSearchEnhancementsEnabled: boolean}`，未知键（如 `presentationSurface`）会 ZodError 导致会话无法物化；CLI 升级后先用 fake server 的严格握手回归。
- 独立 CLI 的 Provider Registry 与桌面端内嵌实例不共享凭据：桌面端注入自己的凭据库，独立 CLI 只读共享 `~/.zcode/v2/credentials.json`，缺账号 identity 凭据时所有 `account:*` provider 均 `entitled:false`、注册表为空，任何 upstream 都过不了 `session/create` 校验。需 CLI 自身完成一次 `zcode login`（浏览器授权，写入共享登录态）后账号 provider 才注册。
- qoder 渠道桥接 Qoder CLI 的 daemon（`--sdk`，stdio NDJSON，`daemon_protocol_version: 2`；从 IDE 0.5.17 内嵌 `qoder-worker-runtime.obf.mjs` 反编译确认）：无自动模型发现，`models` 必填且 upstream 为 `providerId/modelId`（真实取值待冒烟校准）；默认拉起路径是 IDE 同款 `Qoder.exe + ELECTRON_RUN_AS_NODE=1 + <app.asar.unpacked>/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs --sdk`，IDE 升级会换 `.qoder-versions` 目录，配置路径要跟着改。凭据是未校准点：IDE 用 jobToken（依赖 IDE 宿主反向 RPC，网关无法复现），能否直接复用 IDE 登录态未知，兜底是 env 注入 `QODER_PERSONAL_ACCESS_TOKEN`（CN 版前缀 `QODERCN_`）；`can_use_tool` 反向请求应答 `{behavior:'allow'|'deny'}`，未知反向请求一律回 error 防悬挂。CLI 升级后先用 `test/fake-qoder-server.cjs` 的握手回归（不消耗额度）。
- OpenCode Go 渠道（`openai-compatible`）必须带稳定会话头与产品化 UA：Go 端点 `https://opencode.ai/inference/go`，OpenAI Chat 路径 `/openai/v1`、模型目录 `/v1/models`（两者不同，用 `models_url` 覆盖）。没有 `x-opencode-session` 会 400 `MissingSessionID`；每轮换 ID 会打散 prompt cache，静态 ID 会把所有会话挤进同一路由桶。网关用 `session_header: x-opencode-session` + 首条用户消息指纹兜底，`user_agent` 改写上游标识。验证只用 fake 上游（`test/session-headers.test.ts`），真实请求会消耗 Go 订阅额度并可能触发滥用监控。

## 5. 入口与命令

- Node.js >= 22.13，Windows + Git Bash；开发入口 `src/index.ts`，运行入口 `dist/index.js`。
- `npm run dev` / `npm test` / `npm run build` / `start.cmd`
- 面板：`http://127.0.0.1:8787/admin`；通过 `start.cmd` 启动时日志在 `data/gateway.out.log`。
