# Changelog

本文件记录 Code2Api 的重要变更。版本号遵循 SemVer，格式参考 Keep a Changelog。

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
