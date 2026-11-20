# AGENTS.md

> 面向在本仓库工作的 AI Agent 的硬性规则。项目设计与变更历史见 `docs/可行性分析.md`、`CHANGELOG.md`。

## 0. 第一原则：不准用真实请求做测试（防封号）

- 任何时候都不要为了“验证一下”去调用真实上游或消耗真实渠道额度；真实请求可能导致账号被封。
- 默认验证方式只有：
  - `npm test`（`test/` 下的 fake opencode server / mock 渠道）
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
- 模型同步只进内存、不回写 YAML；手工 `models` 优先；上下文窗口从 `limit.context` / `limit.output` 发现并回填。
- 历史数据永久保留；面板的时间范围只是查询窗口。

## 5. 入口与命令

- Node.js >= 22.13，Windows + Git Bash；开发入口 `src/index.ts`，运行入口 `dist/index.js`。
- `npm run dev` / `npm test` / `npm run build` / `start.cmd`
- 面板：`http://127.0.0.1:8787/admin`；通过 `start.cmd` 启动时日志在 `data/gateway.out.log`。
