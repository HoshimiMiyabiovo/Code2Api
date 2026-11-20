# Code2Api —— 本地 AI 渠道网关

Code2Api 是一个只监听 `127.0.0.1` 的本地 AI 渠道网关：把 API-key 型转发站与 CLI/订阅型渠道（opencode）池化，对外提供 OpenAI / Anthropic / OpenAI Responses 兼容接口，供 OpenCode 等本地 Agent 使用。

> 非目标：公网服务、多租户、面向他人的托管。

## 功能特性

- **三套协议入口**：OpenAI Chat Completions、Anthropic Messages、OpenAI Responses；均支持流式与非流式，Chat/Messages/Responses 支持工具调用，Responses 支持 `previous_response_id` 延续上下文。
- **渠道池与故障转移**：key 轮询、按 401/402/429/5xx/网络错误分级冷却、最大尝试次数、全局并发闸；单个请求可自动跨渠道/密钥重试。
- **模型目录**：从 openai-compatible 上游 `/models` 与 opencode `/api/model` 自动同步；手工模型优先，支持别名/通配、黑名单、推理能力推断，并回填上下文窗口。
- **opencode 任务级桥接**：长驻 worker（自动拉起或连接已有 `serve`）、会话亲和、账本增量去重、SSE 事件归一化、form/permission 挂起恢复、面板待处理提问。
- **请求级工作区**：`x-code2api-workspace` 指定目标目录，受渠道 `workspace_roots` 白名单限制；会话首次创建时绑定，避免任务跑错项目。
- **监控与治理**：主动探活、额度探针、闲置保活、请求与用量/费用统计、SQLite 持久化、数据库导出。
- **管理面板**：渠道/密钥/模型增删改与热加载、模型目录、请求日志、统计、提问处理；长模型列表折叠展示。

## 架构概览

```text
客户端（OpenCode / Claude Code / curl）
        │  OpenAI / Anthropic / Responses
        ▼
Code2Api 127.0.0.1:8787
  ├─ Router：模型解析、别名/黑名单、key 轮换、冷却、故障转移、并发闸
  ├─ 模型目录：上游 /models、opencode /api/model
  ├─ 渠道池
  │   ├─ openai-compatible（HTTP API key）
  │   ├─ opencode（任务级 worker，自动拉起或外部 serve）
  │   └─ mock（自测）
  └─ SQLite：请求、用量、会话、账本、任务、提问
```

## 快速开始

环境要求：Windows 10/11、Node.js >= 22.13。

```bash
npm install

# 首次：从模板生成真实配置，按需修改
copy config\config.example.yaml config\config.yaml

# 编译并启动（自带 8787 单实例检查）
start.cmd
```

- 管理面板：`http://127.0.0.1:8787/admin`
- 启动日志：`data/gateway.out.log`
- 也可以使用 `npm run dev`（tsx 直接跑源码），或 `npm run build && npm start`。

## 配置

真实配置为 `config/config.yaml`，已被 `.gitignore` 排除；模板见 `config/config.example.yaml`。

- 密钥优先使用 `key_env` 引用环境变量，例如 `STATION_A_KEY`；也支持明文 `key`，但不推荐。
- 渠道、密钥、模型都可在面板增删改，保存后热加载，无需手改 YAML。
- `workspace_roots` 是 opencode 渠道允许的请求级工作区根目录（绝对路径）；目标目录必须已存在。
- `admin.token` 为面板口令；留空时启动会生成临时口令并打印到日志。

## 协议入口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/models` | OpenAI 模型列表 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/messages` | Anthropic Messages |
| POST | `/v1/messages/count_tokens` | Anthropic token 估算 |
| POST | `/v1/responses` | OpenAI Responses |
| GET | `/healthz` | 健康检查 |
| GET | `/admin` | 管理面板 |

流式响应遵循各自协议的 SSE 格式；上游报错会在首包校验后自动切换渠道。

## 渠道类型

### openai-compatible

面向转发站/中转 API：配置 `base_url`、密钥池、超时、认证头（`Authorization: Bearer` 或 `x-api-key`）、是否发送 `stream_options.include_usage` 等。支持从上游 `/models` 自动同步模型。

### opencode（任务级）

面向本机 opencode CLI：

- 可自动拉起 `opencode serve` worker，也可通过 `base_url` 连接已有服务。
- 模型通过 `/api/model` 自动发现，无需手填；免费模型与上下文窗口会随目录同步。
- 会话连续：请求头 `x-code2api-session` 复用同一 opencode 会话，网关负责增量去重。
- 工作区：请求头 `x-code2api-workspace` 指定项目目录，只能落在 `workspace_roots` 白名单内；会话首次创建时绑定工作区，已绑定会话换目录会返回 400。
- 审批/提问：form 与 permission 会挂起任务并出现在面板「待处理提问」，回答后自动继续。

## 模型目录

- openai-compatible：同步上游 `GET /models`。
- opencode：同步 `/api/model`，读取 `limit.context` / `limit.output`，并对已有模型回填上下文窗口。
- 手工配置的 `models` 优先，不会被同步结果覆盖。
- opencode `/api/model` 中缺 `type`、`name === modelID`、`cost` 为空的条目属于旧配置残影，会自动过滤（实际请求会返回 `Model is unavailable`）。

## 监控与数据

- 探活：定时探测 HTTP 渠道 `/models`。
- 额度：可按配置轮询渠道额度接口，并在面板展示剩余额度。
- 保活：可配置闲置时段的小额调用，降低额度窗口重置风险。
- 统计：请求、token、费用、延迟、首字节、错误均写入 SQLite；支持面板按时间范围查看。
- 导出：`GET /admin/api/export` 导出数据库（`VACUUM INTO`）。
- 数据策略：历史数据默认永久保留；面板时间范围只是查询窗口，不会删除数据。

## 测试

```bash
npm test
```

测试只使用 `test/` 下的 fake opencode server 与 mock 渠道，不调用真实上游、不消耗渠道额度。不要为了“验证一下”向真实渠道连续发请求，以免账号被封。

## 项目结构

```text
src/
  http/       协议入口、协议转换、管理 API
  core/       路由、key 池、模型目录/规则、探活/额度/保活、配置编辑
  providers/  mock、openai-compatible、opencode（任务级）
  store/      SQLite schema 与查询
public/       无框架管理面板
test/         fake opencode server 与网关测试
config/       配置模板（真实 config.yaml 不入库）
data/         数据库与日志（不入库）
```

## 状态

- 已完成：M1 网关核心、M2 opencode 任务级桥接、M3 监控/额度/保活、Responses 协议、模型目录与工作区治理。
- 已实测消费端：OpenCode。
- 待回归：Claude Code / DSH 等消费端；额度/保活高级参数目前以配置文件为主。

设计文档见 `docs/可行性分析.md`，变更记录见 `CHANGELOG.md`，Agent 工作规则见 `AGENTS.md`。

## 安全说明

- 仅监听 `127.0.0.1`；如需局域网访问，请自行增加反向代理与鉴权。
- 配置中的密钥不要提交；`config/config.yaml`、`data/`、`workspace/`、日志均已被 `.gitignore` 排除。
- 可配置 `server.client_keys`：非空时 `/v1/*` 需要匹配的 Bearer 或 `x-api-key`。
- `workspace_roots` 是文件系统边界：不要配置过宽的根目录，以免本地客户端让 Agent 读写无关项目。
