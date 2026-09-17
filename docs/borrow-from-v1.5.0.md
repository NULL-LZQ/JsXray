# 借鉴分析：HAPPY.JS.v1.5.0 → 本项目（v1.3.0 → v1.4.0）

> 分析对象：`D:\HAPPY JS\HAPPY.JS.v1.5.0`（1.7MB / 144 文件，含 74 JS + 58 Java）
> 分析方式：文件树 + 逐模块 diff（manifest / hooks / background / content / popup / mcp / inject / tools）
> 结论：v1.5.0 与本项目**同源**（同一套 Bridge/PATTERNS/Ctx/Results/Handlers/Extractor 架构），
> 但 v1.5.0 在「信息情报精度」与「云资产」方向走得更远；本项目在「MCP 能力」「一键下载」
> 「运行时自愈」方向更完整。因此是**双向借鉴、按模块合并**，不是整包替换。

---

## 一、两版能力矩阵

| 能力 | 本项目 v1.3.0 | v1.5.0 | 本轮处理 |
| --- | --- | --- | --- |
| 敏感信息扫描（29 类单正则） | ✅ | ✅ | 保留 |
| 动态扫描 / 深度扫描 | ✅ | ✅ | 保留 |
| 指纹识别（HTTP/Cookie/页面/Heimdallr 265 条） | ✅ | ✅ | 保留 |
| Hook 脚本（18 个，反调试 + API Hook） | ✅ | ✅ | 保留 |
| Hook 开启**即时生效**（注入已打开标签） | ❌ | ✅ v1.1.2 | **✅ 已移植** |
| Vue/React 路由提取 | ✅ | ✅ | 保留 |
| Vue 路由对抗（清守卫 / 清跳转，可卸载） | ❌ | ✅ v1.1.3 | ⏳ 待移植（P2） |
| **信息泄露：多关键字 AND 高精度引擎** | ❌ | ✅ v1.3.0（65+106 条） | **✅ 已移植** |
| **接口 baseURL 识别 + 手动配置** | ❌ | ✅ v1.5.0 | **✅ 已移植** |
| **接口认证扫描（14 种绕过变体）** | ❌ | ✅ v1.5.0 | **✅ 已移植并加固** |
| **SourceMap 识别 + 原始源码还原** | ❌ | ✅ v1.3.0（2 个 MCP 工具） | **✅ 已移植** |
| 扫描页 chip 点击跳转 + 高亮 | ❌ | ✅ v1.3.5 | **✅ 已移植** |
| 复制 URL 的相对路径解析 | 部分 | ✅ v1.1.2 `resolveUrl` | ⏳ 待移植（P3） |
| **云存储桶风险监测（10 厂商 / 被动+主动+页面扫描）** | ❌ | ✅ v1.2.0~v1.4.0 | ⏳ 待移植（P1，见第四节） |
| MCP 工具数 | 23 | 17 | 保留我们的，**扩到 27** |
| 一键下载站点 JS（files/zip/list + 直写本地目录） | ✅ v1.3.0 | ❌ | 保留（v1.5.0 无此能力） |
| 资源索引 / 网络清单 / 控制台捕获 | ✅ | 部分 | 保留 |
| 运行状态自检 / CDP 兜底执行 | ✅ | ❌ | 保留 |

---

## 二、代码级差异地图（用于精确合并）

| 文件 | 本项目 | v1.5.0 | 差异性质 |
| --- | --- | --- | --- |
| `background.js` | 1643 行 | 1126 行 | v1.5.0 多 `AuthBypass`(167 行) + BucketSentinel 接线；我们多 Health/CDP/下载/控制台 |
| `content.js` | 954 行 | 3549 行 | v1.5.0 多 `ApiFinder`/`BaseUrlExtractor`/`WebpackExtractor`/**内联的 65+106 条规则** |
| `popup/popup.js` | 1395 行 | 1420 行 | 页面结构不同（他们多「信息泄露」「存储桶」两页） |
| `popup/popup.css` | 490 行 | 574 行 | 新分类样式 |
| `inject/vue_router.js` | 324 行 | 500 行 | 多路由对抗（清守卫/清跳转） |
| `mcp/server.js` / `ext_client.js` | 856 / 1009 行 | 674 / 631 行 | 我们工具更多，他们多 sourcemap + bucket 工具 |
| `hooks.json` | 18 条 | 18 条 | **完全相同**，hooks 无需移植 |
| `data/heimdallr_rules.js` | 2011 行 | 2011 行 | 完全相同 |
| `bucket/*` + `lib/bucket/bucket_core.js` | — | 4 文件 + 3041 行 | 整模块，见第四节 |
| `data/api_finder_*.js` | — | 243 + 392 + 1748 行 | **已整体搬入** |

### 关键的架构差异（决定了移植方式）

v1.5.0 把 `api_finder_engine.js` + 两份规则库**内联进 content.js**（用 `tools/bundle_content.js`
生成，v1.3.5 还为此修过一个 `global.` → `self.` 的 bug，否则 171 条规则全部静默失效）。

本项目**不采用这种方式**：我们的 background 已用 `importScripts` 统一加载 `data/*.js` + `lib/*.js`，
而且本来就有「正则匹配放 background 执行」的 CSP 安全架构。所以信息泄露引擎与规则改为：

```
content.js  ──INFO_LEAK_MATCH{text,urlPath}──▶  background.js (InfoLeak)
                                                  ├─ importScripts lib/api_finder_engine.js
                                                  ├─ importScripts data/api_finder_rules.js
                                                  └─ importScripts data/api_finder_rules_burpapi.js
```

好处：**不需要打包步骤**（无 `bundle_content.js`）、规则可独立更新、`validate.js` 能自动检查
`lib/*.js` 是否被 importScripts（新增文件漏加载会被测试抓住）。

---

## 三、本轮已移植的内容（v1.4.0）

### 1. 信息泄露引擎（多关键字 AND，171 条规则）
- 新增 `lib/api_finder_engine.js`（引擎）、`data/api_finder_rules.js`（内置 65 条）、
  `data/api_finder_rules_burpapi.js`（BurpAPIFinder 逆向导入 106 条）
- `InfoLeak` 模块：规则来源过滤（全部/内置/BurpAPI）、最低准确度（1~3）、
  同一规则只保留首个命中（去噪）、白名单规则不参与匹配、命中含**上下文片段**
- content 侧按 `LEAK_BUDGET`（8MB/页）节流送匹配；设置页可开关 + 切规则来源 + 调准确度，
  **改完即时同步到已打开页面**（`UPDATE_INFO_LEAKAGE`，无需刷新）
- 扫描页新增分类「信息泄露(多关键字 AND)」；MCP 新增 `get_info_leakage` 与 `preset=leak`

### 2. 接口 baseURL 识别 + 手动配置
- `BaseUrlExtractor`：`axios.defaults.baseURL` / `axios.create({baseURL})` / `$.ajaxSetup({url})` /
  `BASE_URL|API_URL|API_HOST|API_PREFIX|SERVER_URL|BACKEND|API_ROOT` / fetch wrapper 前缀，
  最后回退 `location.origin`；过滤 example.com / localhost / `{{}}` 等占位
- 优先级：**手动配置 > 识别结果 > location.origin**（设置页可手动指定，保存即同步）
- 扫描页新增分类「接口 baseURL(识别)」

### 3. 接口认证绕过扫描（14 变体）
变体：`;.css` `;.js` `;.ico` `;.png` `;.html` `.css` `.js` `.ico` `.png` `.html` `%23/` `#/` `?a=1` + 原始路径。

**相比 v1.5.0 的加固（按你的挖掘口径）**：

| 加固点 | 说明 |
| --- | --- |
| 破坏性路径黑名单 | `logout/signout/delete/remove/drop/reset/revoke/disable/kill/shutdown…` 一律**不发请求**（红线：不登出不删改），并在结果里回报「跳过 N 个危险接口」 |
| 噪声候选过滤 | 静态资源（js/css/png/woff/pdf…）、含空格与括号的假路径、日期模板串（`MM/D/YYYY`、`yyyy-mm-dd`）全部剔除 —— 直接解决我们之前观察到的 `apis` 误报会变成垃圾请求的问题 |
| 假阳性过滤 | 读取响应体，识别「请先登录 / 未登录 / unauthorized / `"code":401` / `<title>…登录`」→ **不算**未授权 |
| 跳转不误判 | v1.5.0 把 3xx 也算「未授权」；但 `redirect:'manual'` 下 3xx 实际以 `status 0`（opaqueredirect）返回，因此本实现把 status 0 明确判为「登录跳转，不是未授权」 |
| 全局限速 | 相邻请求最小间隔 `intervalMs`（默认 150ms）+ 并发 3 + 单次硬上限 300 请求 |
| 风控自停 | 命中 `429/503/412` 立即停止整轮，并回报原因 |
| 可预览 | `dryRun` 只生成变体清单不发请求（MCP 工具与 UI 都支持） |

只发**不带 Cookie 的只读 GET**（`credentials:'omit'`），扫描页新增分类「接口未授权(绕过扫描)」，
每行显示 状态码标签（2xx 绿 / 3xx 橙 / 4xx 红）+ 变体标签 + 完整 URL；MCP 新增 `run_auth_bypass`。

### 4. SourceMap 识别与还原（反混淆）
- MCP 新增 `list_sourcemaps`（列出扫描到的全部 .map，含 `data:` 内联）与
  `resolve_sourcemap`（下载解析，返回 `sources` + `sourcesContent` **原始源码**；
  支持相对路径自动补全、多个候选时返回 `needChoose`、单文件 50KB / 总输出 900KB 上限）

### 5. 小改进（顺手移植）
- **Hook 开启即时生效**：`HookRegistry.sync` 后向已打开的匹配标签 `executeScript(MAIN)` 注入，
  并 post `HOOKS_INJECTED` 让 content 重发配置 —— 开启不再需要刷新页面（关闭仍需刷新）
- **扫描页 chip 点击跳转**：chip 可点击，滚到对应分类（popup 的滚动容器是 `main.pages`）并闪烁高亮 1.2s
- **manifest 去掉 `background.scripts`**（MV3 下该键在部分 Chrome 版本会导致加载失败）
- `validate.js` 增强：多 popup 页面（`popup.html` / `dlwriter.html`）引用与元素 id 双页校验

---

## 四、后续移植清单（P1/P2/P3 已于 v1.5.0 全部完成）

> 状态更新：下面三项**均已在 v1.5.0 落地并带测试**，本节保留当时的评估与风险提示，作为实现依据与维护参考。
> - P1 云存储桶 → `lib/bucket/bucket_core.js` + `bucket/` 4 文件 + popup「存储桶」页 + 右键菜单 + MCP `get_bucket_risks`/`get_bucket_config` + `tools/test_bucket_core.js`(33) + `tools/test_bucket_mcp.js`(19)
> - P2 Vue 路由对抗 → `inject/vue_router.js`(469 行) + content `requestMainWorld` + popup 对抗面板 + `tools/test_vue_clear.js`(33)
> - P3 → popup `resolveUrl()`（复制/打开相对路径解析）、`validate.js` 递归校验 `lib/**`、信息泄露以扫描页分类呈现（独立页暂不做）

## 四之二、当时的移植评估（保留）


### P1 · 云存储桶风险监测（v1.5.0 的招牌模块，工作量最大）
包含：`lib/bucket/bucket_core.js`(3041 行 bundle，10 厂商引擎) + `bucket/bucket_bg.js`(524) +
`bucket/content_scan.js`(365) + `bucket/bucket_log.{html,js}` + manifest 追加 content_script +
右键菜单 + popup「存储桶」页（风险记录/黑白名单/检测策略/高级性能 4 个子页签）+
MCP `get_bucket_risks` / `get_bucket_config`。

移植要点与风险：
1. **不能靠 build 脚本重建**：`tools/build_bucket_core.js` 读的是仓库外路径
   `../../优秀项目集合/谛听鉴-云存储桶风险监测-V1.1.0-By狐狸/lib`，该目录不在本仓库 →
   只能把 bundle 当唯一事实源（或把 10 个厂商源码一并纳入 `bucket/vendors/` 以保证可重建）。
2. `bucket_bg.js` 通过 `BucketSentinel.handles(msg.type)` 抢在消息路由前面接管，需要与
   我们现有的消息 `switch` 顺序对齐，避免与我们新增的 `INFO_LEAK_*`/`AB_*` 冲突。
3. **写探测（PUT/DELETE/ACL/Policy）与红线冲突**：必须默认开启安全模式（被动检测只做读），
   写类探测只允许在「主动检测」窗口里由人工勾选后执行 —— 与 v1.5.0 的策略一致，
   移植时要把默认值钉死为 read-only。

### P2 · Vue 路由对抗面板（v1.1.3，约 200 行）
`inject/vue_router.js` 增加 `CLEAR_NAV_GUARDS` / `CLEAR_NAV` 两个可卸载指令
（Hook `Array.prototype.push` 拦 `beforeEach`/`beforeResolve`；覆写 `push/replace/go/back/forward`），
popup 路由页加两个 ON/OFF 按钮。v1.5.0 还修了原版 `temp_array < 4` 的栈深度 bug 并补了
33 个测试用例，移植时一并带上。

### P3 · 零散项
- `resolveUrl(v, base)`：复制/打开 URL 时正确处理 `/path`、`relative/path`、`./a`、`../a`、`?q`、`#h`、`//cdn/x`
- popup「信息泄露」独立页面（现在先做成扫描页分类，独立页可选）

---

## 五、合并时**不要倒退**的我们自己的东西

| 我们独有 | 为什么保留 |
| --- | --- |
| MCP 27 工具（v1.5.0 只有 17） | `get_js_list`/`search_in_js`/`beautify_js`/`download_js`/`get_network_requests`/`get_console_logs`/`get_storage`/`query_dom`/`get_frame_tree`/`screenshot` + 本轮 4 个 |
| 一键下载站点 JS | files / zip / list 三种形式 + 「直写本地目录」任意路径 + 自动站点文件夹 |
| 运行状态自检 `HealthCheck` + `GET_HEALTH` | SW 单点异常可见化，排障入口 |
| CDP 兜底执行（可选 debugger 权限） | 严格 CSP / Trusted Types 站点的最后手段 |
| 控制台捕获 / 资源索引 / JS 缓存 / 美化器 | 逆向与取证基础件 |
| 桥接端口 10087 + 10087/10086 轮换重连 | 端口漂移自愈 |

---

## 六、移植过程中的经验（已写入 SKILL.md）

1. **同源不等于可整包替换**：两版 `content.js` 差 2600 行，直接覆盖会把我们的下载/自检/控制台全丢掉；
   正确做法是「按模块读差异 → 用我们的架构重写接线」。
2. **规则类数据可以直接搬**（`data/api_finder_*.js` 是自包含 IIFE），**引擎要换个地方跑**
   （他们 inline 进 content，我们放 background）。
3. **移植别人的主动扫描功能时，安全口径要重做**：v1.5.0 的判定（3xx 即未授权、不读响应体、
   不过滤危险路径）在真实目标上会既误报又可能触发登出，本轮的加固版才是可直接用于 SRC 的形态。
4. **测试必须覆盖新模块的"负向断言"**：本轮新增 30 项断言里，一半是「不该命中的场景」
   （只命中一个关键字不报、登出接口不探测、限流响应不算漏洞、跳转不算漏洞）。
