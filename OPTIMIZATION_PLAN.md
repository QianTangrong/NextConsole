# NextConsole 优化方案

生成时间：2026-06-18  
依据：`PROJECT_REPORT.md`、`package.json`、`vite.config.ts`、`tsconfig.json`、`npm outdated`、`npm audit`

## 1. 优化目标

本方案面向 NextConsole 的可维护性、可靠性、安全性和发布质量优化，不直接改变产品定位。优化目标分为四类：

| 目标 | 衡量标准 |
| --- | --- |
| 工程治理稳定 | 包管理器统一，锁文件单一，仓库元数据一致，CI 可复现 |
| 安全风险降低 | `npm audit --audit-level=moderate` 无 high 告警，dev 依赖风险有明确处理策略 |
| 回归能力建立 | 至少覆盖核心模块单元测试、浏览器 smoke 测试、打包产物验证 |
| 运行时更可靠 | 全局 hook、REPL、Network stream、插件生命周期有测试和文档边界 |

## 2. 当前关键问题

| 优先级 | 问题 | 影响 |
| --- | --- | --- |
| P0 | 存在 14 个 npm audit 告警，其中 6 个 high、8 个 moderate | 发布和长期维护风险 |
| P0 | 没有自动化测试配置 | 无法稳定验证全局 hook、Shadow DOM、打包输出 |
| P0 | 包管理器状态混乱：`package-lock.json`、未跟踪 `pnpm-lock.yaml`、pnpm 风格 `node_modules` 并存 | 安装结果不可复现，CI 选择不明确 |
| P1 | Vite 5 和 vite-plugin-dts 3 落后，升级涉及破坏性变更 | 后续生态兼容和安全修复成本上升 |
| P1 | REPL 使用全局 `eval`，默认能力边界不够醒目 | 调试工具合理，但生产误用有安全风险 |
| P1 | 全局 hook console/fetch/XHR/EventSource/WebSocket，兼容性依赖手工验证 | 容易与其他 SDK 或调试工具冲突 |
| P2 | `package.json` repository 与当前 remote 不一致 | 发布元数据和项目归属可能混淆 |
| P2 | 存在未跟踪 `null` 文件 | 仓库卫生问题 |

## 3. 推荐优化路线

### 阶段一：工程底座整理（P0，预计 0.5-1 天）

目标：让项目安装、构建、审计在本地和 CI 中可复现。

任务：

1. 选择包管理器。
   - 如果继续使用 npm：保留 `package-lock.json`，删除或忽略 `pnpm-lock.yaml`，重新 `npm install`。
   - 如果切换 pnpm：提交 `pnpm-lock.yaml`，移除 `package-lock.json`，在 `package.json` 增加 `packageManager`。
   - 推荐：如果团队没有明确 pnpm 规范，短期保留 npm，因为仓库已有 `package-lock.json`。

2. 清理仓库状态。
   - 确认 `null` 文件来源。
   - 若无用途，删除该文件。
   - 若是工具生成物，加入 `.gitignore` 并注明来源。

3. 统一仓库元数据。
   - 核对 `package.json.repository.url` 与当前 remote。
   - 若当前项目以 `QianTangrong/NextConsole` 为准，更新 package 元数据。
   - 若包发布归属仍是 `royalscome/NextConsole`，保持不变，但在维护文档中说明。

验收命令：

```bash
npm install
npm run typecheck
npm run build
npm audit --audit-level=moderate --registry=https://registry.npmjs.org
```

通过标准：

- 安装命令只使用一种包管理器。
- lockfile 只有一种。
- `typecheck` 和 `build` 通过。
- audit 结果被记录，并进入阶段二处理。

### 阶段二：依赖与安全升级（P0，预计 1-2 天）

目标：优先消除 high 级别风险，同时控制 Vite/vite-plugin-dts 大版本升级风险。

当前依赖状态：

| 依赖 | 当前 | wanted | latest | 建议 |
| --- | --- | --- | --- | --- |
| `ws` | `8.20.0` | `8.21.0` | `8.21.0` | 优先升级，风险较低 |
| `@types/node` | `25.6.0` | `25.9.3` | `25.9.3` | 可随手升级 |
| `vite` | `5.4.21` | `5.4.21` | `8.0.16` | 单独分支评估破坏性升级 |
| `vite-plugin-dts` | `3.9.1` | `3.9.1` | `5.0.2` | 单独分支评估声明文件输出 |
| `typescript` | `5.9.3` | `5.9.3` | `6.0.3` | 暂缓，避免叠加风险 |

建议拆成两批：

1. 低风险安全修复批次。
   - 升级 `ws` 到 `8.21.0`。
   - 升级 `@types/node` 到 `25.9.3`。
   - 重新安装并运行 typecheck/build/audit。

2. 构建链升级评估批次。
   - 建立独立分支测试 `vite@8.0.16` 和 `vite-plugin-dts@5.0.2`。
   - 重点比较 `dist/index.d.ts`、ESM/UMD 输出文件名、gzip 体积、sourcemap。
   - 若 Vite 8 升级代价高，先评估是否可升到解决 audit 的较小兼容版本；不能解决时记录暂缓原因。

验收标准：

- `npm audit` high 告警清零，或每个遗留 high 告警都有“来源、影响面、暂缓原因、后续计划”。
- 构建产物保持以下兼容性：
  - `dist/nextconsole.es.js`
  - `dist/nextconsole.umd.js`
  - `dist/index.d.ts`
  - `exports.import/require/types` 可用。

### 阶段三：测试体系建立（P0，预计 2-4 天）

目标：从“能构建”升级到“核心行为可回归”。

推荐测试分层：

| 类型 | 工具 | 覆盖范围 |
| --- | --- | --- |
| 单元测试 | Vitest + jsdom | `utils`、`ConsoleCore`、`StorageCore`、`ReplCore` |
| 浏览器 smoke | Playwright | 面板挂载、打开关闭、tab 切换、Shadow DOM、fetch/XHR 捕获 |
| 打包验证 | Node script 或 Vitest | ESM 导入、UMD 文件存在、类型入口存在、`npm pack` 内容 |

建议先写最小测试集：

1. `ConsoleCore`
   - hook 后原始 console 仍被调用。
   - 日志条目包含 level、args、timestamp。
   - `maxLogs` 能裁剪旧日志。
   - `appendStream/endStream` 能更新同一条 stream log。

2. `StorageCore`
   - 能读取 localStorage/sessionStorage。
   - 能 set/remove/clear。
   - storage 不可用时不会抛出未捕获异常。

3. `ReplCore`
   - 能执行表达式并记录 output。
   - 错误表达式记录 error。
   - history 数量受限。

4. Playwright smoke
   - 在 `examples/index.html` 创建 `NextConsole`。
   - 点击浮动按钮后面板可见。
   - 切换 Console/Network/Storage tab 不报错。
   - 调用 `fetch` 后 Network tab 出现记录。

新增脚本建议：

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:e2e": "playwright test",
  "verify": "npm run typecheck && npm run test && npm run build"
}
```

验收标准：

- `npm run verify` 可一键完成类型检查、单元测试、构建。
- Playwright smoke 至少覆盖 Chromium。
- CI 中运行 `verify`，浏览器测试可作为单独 job。

### 阶段四：运行时可靠性优化（P1，预计 3-5 天）

目标：降低全局 hook 和高频日志场景的兼容风险。

优化项：

1. 全局 hook 防御。
   - 为 fetch/XHR/EventSource/WebSocket hook 增加重复 hook 检测。
   - 验证 destroy 后可以还原原始 API。
   - 对环境缺失 API 的情况保持 no-op。

2. Network 体积控制。
   - 当前响应体文本截断为 10000 字符，建议把该值配置化。
   - SSE/WebSocket 消息上限当前为 1000，建议暴露为配置或在文档中注明。

3. Console 参数快照。
   - 当前 JSON stringify 对循环引用会降级为 `String(arg)`。
   - 建议引入内部 safe serializer，改善循环引用、BigInt、TypedArray、DOM 节点、Map/Set 的展示一致性。

4. REPL 安全边界。
   - 在 README 和 API 文档中明确 REPL 仅用于调试环境。
   - 增加配置项允许关闭 REPL tab，例如 `repl?: { enabled?: boolean }`。
   - 若项目未来面向生产 CDN 使用，可考虑默认关闭 REPL 或提供 production guard 示例。

5. 插件生命周期。
   - 验证插件 tab render 只执行一次。
   - destroy 时清理 tab、事件监听、observer、custom marks。
   - 插件同名去重已有实现，建议补测试。

验收标准：

- 全局 hook/destroy 行为有自动化测试。
- 大日志、高频 stream、SSE/WebSocket 长连接场景不出现明显内存无限增长。
- REPL 和 Source 插件的安全边界在文档中可见。

### 阶段五：发布质量与文档优化（P1，预计 1-2 天）

目标：让包发布前检查可重复、文档和产物一致。

任务：

1. 增加发布前检查脚本。

```json
{
  "prepublishOnly": "npm run verify && npm run pack:check",
  "pack:check": "npm pack --dry-run"
}
```

2. 增加产物体积记录。
   - 构建后记录 ES/UMD/gzip 体积。
   - 若 gzip 超过约定阈值，例如 25 KB，CI 给出提醒。

3. 修正文档编码和展示。
   - 当前终端默认读取时曾出现 README 乱码显示，建议确认文件统一为 UTF-8。
   - README 中强调：
     - 仅调试环境使用。
     - 会 hook 全局 API。
     - REPL 执行全局 JS。
     - Source 插件读取外部资源受跨域限制。

4. 完善 examples。
   - 保持 `examples/index.html` 为基础 demo。
   - `examples/mobile.html` 用于移动端综合 demo。
   - `examples/test.html` 可改名或文档注明为手工测试页。

验收标准：

- `npm pack --dry-run` 输出只包含预期文件。
- README 的快速开始、配置、API 与实际类型一致。
- 发布前脚本能拦住类型、构建、测试失败。

## 4. 推荐执行顺序

| 顺序 | 工作 | 预期收益 |
| --- | --- | --- |
| 1 | 统一包管理器和清理未跟踪文件 | 降低协作和 CI 不确定性 |
| 2 | 升级 `ws`、`@types/node`，重跑 audit | 快速消除部分安全风险 |
| 3 | 建立 Vitest 单元测试基线 | 给后续重构和升级兜底 |
| 4 | 建立 Playwright smoke | 验证真实浏览器行为 |
| 5 | 评估 Vite/vite-plugin-dts 大版本升级 | 处理剩余 dev 依赖告警 |
| 6 | 优化全局 hook、REPL、Network 上限 | 提升运行时稳定性 |
| 7 | 增加发布前检查和文档边界 | 提高发布质量 |

## 5. 建议里程碑

### M1：工程可复现

完成标准：

- 只有一种 lockfile。
- `packageManager` 明确。
- `npm run typecheck` 和 `npm run build` 通过。
- 仓库没有来源不明的未跟踪文件。

### M2：安全风险可控

完成标准：

- `ws` 升级完成。
- `npm audit` high 告警清零，或剩余告警有明确暂缓说明。
- 构建链升级评估完成并记录结果。

### M3：测试基线可用

完成标准：

- 有 Vitest 单元测试。
- 有 Playwright smoke。
- 有 `npm run verify`。
- CI 可执行 verify。

### M4：发布前质量门禁

完成标准：

- `prepublishOnly` 或等价脚本存在。
- `npm pack --dry-run` 已纳入检查。
- README 与实际 API/配置同步。
- 包体积变化有记录。

## 6. 风险控制

| 风险 | 控制策略 |
| --- | --- |
| Vite/vite-plugin-dts 大版本升级破坏声明文件输出 | 独立分支升级，diff `dist/index.d.ts` 和 `exports` 行为 |
| 测试引入导致工程复杂度上升 | 先做最小 smoke 和核心单元测试，不追求一次性高覆盖率 |
| REPL 安全优化影响现有用户 | 先文档提示，再新增可选配置，避免破坏默认行为 |
| Network hook 改动影响真实请求 | 先补测试，再做小步修改，每次验证 fetch/XHR/SSE/WebSocket |
| 包管理器切换造成锁文件大 diff | 单独提交包管理器整理，不与业务优化混在一起 |

## 7. 不建议短期执行的事项

- 不建议立刻大规模重构 `src/ui`，当前问题主要是测试和治理不足，不是结构不可用。
- 不建议同时升级 TypeScript 6、Vite 8、vite-plugin-dts 5，这会让问题定位变困难。
- 不建议默认禁用 REPL，以免破坏现有用户预期；应先加文档和配置开关。
- 不建议引入大型 UI 框架，项目优势之一是运行时零依赖和轻量体积。

## 8. 一句话结论

NextConsole 的核心功能已经成型，最优先的优化不是继续堆功能，而是先把包管理、依赖安全、自动化测试和发布门禁补齐；等工程底座稳定后，再有节奏地优化全局 hook、REPL 安全边界和高频网络/日志场景。
