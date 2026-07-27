# NextConsole 项目报告

生成时间：2026-06-17  
扫描范围：当前工作区，排除 `.git`、`node_modules`、`.history`

## 1. 项目概览

NextConsole 是一个面向移动 H5 和现代 Web 的前端调试控制台库，定位为 vConsole 的现代替代方案。项目以纯 TypeScript 实现，运行时无框架依赖，核心能力包括 Console 日志捕获、Network 请求拦截、Storage 管理、DOM 查看、System 信息、REPL 执行，以及 Source/Performance 内置插件。

| 项目项 | 当前状态 |
| --- | --- |
| 包名 | `@royalscome/nextconsole` |
| 版本 | `1.0.4` |
| License | MIT |
| 主入口 | `dist/nextconsole.umd.js` |
| ESM 入口 | `dist/nextconsole.es.js` |
| 类型入口 | `dist/index.d.ts` |
| 包格式 | ES + UMD + `.d.ts` |
| 包内仓库地址 | `https://github.com/royalscome/NextConsole.git` |
| 当前 Git remote | `https://github.com/QianTangrong/NextConsole.git` |

## 2. 技术栈与依赖

项目使用 Vite 构建库模式，TypeScript 负责类型检查和声明文件输出，`vite-plugin-dts` 负责打包类型声明。`ws` 仅用于 examples 中的 SSE/WebSocket 测试服务器。

| 分类 | 依赖/工具 | 当前安装版本 |
| --- | --- | --- |
| 语言 | TypeScript | `5.9.3` |
| 构建 | Vite | `5.4.21` |
| 类型声明 | vite-plugin-dts | `3.9.1` |
| Node 类型 | @types/node | `25.6.0` |
| 示例服务 | ws | `8.20.0` |

`package.json` 没有 `packageManager` 字段。当前工作区同时存在 `package-lock.json` 和未跟踪的 `pnpm-lock.yaml`，且 `node_modules` 显示为 pnpm 风格安装结构，建议后续统一包管理器和锁文件策略。

## 3. 目录结构

| 路径 | 作用 |
| --- | --- |
| `src/index.ts` | 公共 API 入口，导出 `NextConsole`、类型和内置插件工厂 |
| `src/core/` | 核心能力：console/network/storage/element/system/repl |
| `src/ui/` | 面板 UI：主面板、浮动按钮、各功能 tab |
| `src/types/` | 外部配置、日志、网络、存储、插件等类型定义 |
| `src/plugins/` | 内置 Source 和 Performance 插件 |
| `src/styles/theme.ts` | 注入 Shadow DOM 的主题 CSS |
| `src/utils/` | DOM、JSON、时间、事件发射器工具 |
| `examples/` | 浏览器演示页和 SSE/WebSocket 测试服务 |

## 4. 代码规模

| 类型 | 文件数 | 行数 |
| --- | ---: | ---: |
| `.ts` | 30 | 4409 |
| `.json` | 3 | 2064 |
| `.html` | 3 | 1527 |
| `.yaml` | 1 | 987 |
| `.md` | 2 | 520 |
| `.js` | 1 | 148 |
| 无扩展名 | 2 | 18 |

合计扫描到 42 个文件。主要源码集中在 `src/ui`、`src/core` 和 `src/plugins`。

## 5. 架构说明

项目采用“公共 API + 面板外壳 + 核心采集模块 + UI tab + 插件系统”的结构：

- `NextConsole` 是用户侧入口，并通过单例 `_instance` 避免多个实例重复 hook 全局 API。
- `MainPanel` 创建 closed Shadow DOM，注入主题样式，管理浮动按钮、底部面板、tab 切换、面板高度调整和插件生命周期。
- `ConsoleCore` hook `console.log/info/warn/error/debug`，保留原始 console 输出，同时捕获日志、栈信息和 AI streaming 日志。
- `NetworkCore` hook `fetch`、`XMLHttpRequest`、`EventSource`、`WebSocket`，记录请求/响应、SSE 事件和 WebSocket 双向消息。
- `StorageCore` 按需读取和操作 `localStorage`、`sessionStorage`、Cookie。
- `ElementCore` 渲染可折叠 DOM 树，并通过 overlay 高亮目标元素。
- `ReplCore` 使用 indirect `eval` 在全局作用域执行 JS 表达式。
- 插件通过 `NextConsolePlugin` 接口扩展 tab、样式和初始化/销毁逻辑。

## 6. 功能清单

| 功能 | 当前实现 |
| --- | --- |
| Console | 捕获多级别日志、克隆参数快照、过滤搜索、导出 JSON、AI streaming 日志 RAF 批量刷新 |
| Network | 捕获 fetch/XHR/SSE/WebSocket，支持请求体/响应体、耗时、状态、消息流 |
| Storage | 查看、编辑、删除、清空 localStorage/sessionStorage/Cookie |
| Element | DOM 树查看、折叠展开、hover 高亮 |
| System | UA、平台、语言、屏幕、视口、DPR、内存、网络类型、性能指标 |
| REPL | 全局 JS 执行、历史记录、输出/错误格式化 |
| Source 插件 | 收集外部/内联脚本和样式，支持源码查看和大文件截断渲染 |
| Performance 插件 | Core metrics、资源分布、慢资源、Long Task、自定义 performance mark |

## 7. 构建与验证结果

已执行以下命令：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `npm audit --audit-level=moderate --registry=https://registry.npmjs.org` | 发现 14 个中高危依赖告警 |

构建产物：

| 文件 | 大小 | Gzip |
| --- | ---: | ---: |
| `dist/nextconsole.es.js` | 97.49 KB | 22.19 KB |
| `dist/nextconsole.umd.js` | 80.22 KB | 19.85 KB |
| `dist/index.d.ts` | 12.24 KB | - |

构建过程有两个维护提示：

- `vite-plugin-dts`/API Extractor 提示当前项目 TypeScript 版本 `5.9.3` 高于其 bundled compiler engine `5.4.2`。
- Vite 输出 `The CJS build of Vite's Node API is deprecated`，后续升级 Vite 时需要关注配置和插件兼容性。

## 8. 测试现状

项目当前没有自动化测试脚本，也没有 Vitest/Jest/Playwright/Cypress 等测试配置。`examples/test.html`、`examples/index.html`、`examples/mobile.html` 和 `examples/server.js` 更偏向演示与手工验证。

建议补充三类测试：

1. 单元测试：覆盖 `utils`、`StorageCore`、`ConsoleCore` 参数克隆、过滤和 stream 更新逻辑。
2. 浏览器集成测试：用 Playwright 验证 Shadow DOM 挂载、面板打开关闭、tab 切换、fetch/XHR/SSE/WebSocket 捕获。
3. 打包测试：验证 ESM/UMD 导入、类型声明和发布文件列表。

## 9. 安全与维护风险

| 风险 | 说明 | 建议 |
| --- | --- | --- |
| 依赖审计告警 | 官方 npm audit 报告 14 个中高危告警，主要来自 dev/build 链路：`vite`/`esbuild`、`vite-plugin-dts` 传递依赖、`ws`。 | 分支中升级 Vite、vite-plugin-dts、ws 后重新跑 typecheck/build/audit；注意 `vite-plugin-dts@5` 属于破坏性升级。 |
| 默认 registry audit 不可用 | 当前 npm registry 是 `http://registry.npm.taobao.org/`，其 audit endpoint 返回 `NOT_IMPLEMENTED`。 | 安全审计使用官方 registry，或在 CI 中显式指定 audit registry。 |
| REPL 执行风险 | `ReplCore` 使用全局 `eval`，这是调试工具的合理能力，但不适合默认暴露给不可信用户。 | README/API 文档明确“仅调试环境使用”，必要时提供开关或生产保护建议。 |
| 全局 API hook | 会重写 console/fetch/XHR/EventSource/WebSocket，虽有 destroy 还原，但与其他调试工具可能互相影响。 | 增加集成测试，文档说明单例和 hook 行为；对 WebSocket/EventSource 代理兼容性做更多验证。 |
| 包管理器不统一 | `package-lock.json` 已存在，`pnpm-lock.yaml` 未跟踪且 node_modules 为 pnpm 结构。 | 选择 npm 或 pnpm，保留一种 lockfile，补充 `packageManager` 字段。 |
| 仓库地址不一致 | `package.json` 指向 `royalscome/NextConsole`，当前 remote 是 `QianTangrong/NextConsole`。 | 发布前确认 repository 元数据是否需要同步。 |
| 未跟踪 `null` 文件 | 当前 Git 状态存在未跟踪文件 `null`。 | 确认来源，删除或加入忽略规则。 |
| 自动化测试缺失 | 类型检查和构建通过，但缺少回归测试。 | 引入 Vitest/Playwright，并在 CI 中运行。 |

## 10. Git 状态

当前分支：`master`，跟踪 `origin/master`。扫描前工作区已有未跟踪文件：

- `pnpm-lock.yaml`
- `null`

本报告生成过程中执行了 `npm run build`，产物位于 `dist/`，该目录已在 `.gitignore` 中忽略。

## 11. 推荐后续路线

优先级建议如下：

1. 统一包管理器：决定 npm 或 pnpm，清理多余 lockfile，补充 `packageManager`。
2. 升级依赖并重跑审计：先处理 `ws` 和 `postcss` 可非破坏性修复项，再评估 Vite/vite-plugin-dts 的大版本升级。
3. 建立测试基线：先加 `typecheck + build + Playwright smoke`，再逐步补核心单元测试。
4. 补充发布前检查：验证 `npm pack` 内容、ESM/UMD 可用性、类型声明可导入性。
5. 强化文档边界：明确 REPL、全局 hook、closed Shadow DOM、Source 插件跨域获取源码等行为限制。

## 12. 结论

NextConsole 的项目结构清晰，核心能力集中，公共 API 简洁，构建链路当前可用，包体积与 README 描述基本一致。主要短板不在功能实现，而在工程化保障：测试体系缺失、依赖审计告警、包管理器约定不统一、发布元数据存在不一致。若补齐测试与依赖治理，这个项目具备较好的继续发布和迭代基础。
