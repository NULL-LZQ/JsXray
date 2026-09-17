# 借鉴分析：`hybrid_capture_project2` → HAPPY JS

> 分析对象：`D:\HAPPY JS\hybrid_capture_project2`（Hybrid Capture，Chrome MV3 扩展 + 本地 Python collector 的混合抓取系统，约 9.7k 行）
> 分析日期：2026-09-17 ｜ 落地版本：HAPPY JS **v1.6.0**

---

## 一、结论摘要

**这是与 HAPPY JS 定位不同但互补的一个项目**：它解决的核心问题是
**「如何把站点真实的 JS 尽可能完整地拿下来」**，而 HAPPY JS 的强项在
**「拿下来之后怎么用」**（29+ 个 MCP 工具、接口/敏感信息提取、认证扫描、存储桶监测、下载与直写落盘）。

它的独到之处集中在三块，**都是我们原先的空白**：

| # | 能力 | 它怎么做 | 我们的原状况 |
| --- | --- | --- | --- |
| 1 | **chunk 合成**：把「没被访问过因此永远不会发请求」的懒加载 chunk 算出来 | 从 webpack runtime 的 `.u` 映射 + 名称/哈希分离映射反推文件名 | 只能下载**已经被请求过**的 JS —— 覆盖率天然不全 |
| 2 | **构建清单探测**：一次拿全量产物 | `looksLikeViteAsset()` 判断是 Vite 站点后，探测 `/manifest.json` 等路径 | 无 |
| 3 | **域范围判定**：区分「站点自有 / CDN 通用库 / 统计噪声」 | 噪声域黑名单 + CDN 白名单 + 两级后缀基础域 + **组织名跨 TLD 匹配** | 只做 `host !== pageHost` 的朴素比较（自家 `api.x.com` 被当第三方、`jsdelivr` 上的 Vue 被当目标） |

另外两处值得点名的小而实用：**运行时动态代码捕获**（blob: / eval / Function，webRequest 完全看不见）
和 **JS 覆盖对账**（候选 vs 已落盘，量化「还差多少」）。

**已落地**：上面 5 项全部移植并接入（详见第四节）。
**未落地**：CDP 全量抓取体系、本地 collector、多会话合并（见第五节，附原因）。

---

## 二、架构与定位对比

| 维度 | hybrid_capture_project2 | HAPPY JS v1.6.0 |
| --- | --- | --- |
| 形态 | Chrome MV3 扩展 + **本地 Python collector 进程**（`server.py`，HTTP :17891） | **纯扩展**（无本地进程） |
| 采集手段 | **CDP（`chrome.debugger`）为主**：`Debugger.scriptParsed` + `Network.getResponseBody`，覆盖 V8 里所有脚本（含 eval/blob/worker） | `webRequest` 观测 + `chrome.scripting` 注入采集 + 主世界 Hook + 可选 CDP 兜底执行 |
| 权限代价 | manifest 强依赖 `debugger`（会显示「正在调试此浏览器」常驻提示，且与 DevTools 互斥） | `debugger` 为 **optional**，仅在需要绕过严格 CSP 执行代码时才申请 |
| 分析侧 | Python：正则引擎 + 18 条内置规则 + 接口提取（带行号/上下文/置信度） | JS：171 条 AND 规则引擎 + 40+ 分类正则 + Heimdallr 265 条 + 存储桶 10 厂商 |
| AI 集成 | 导出 `exports/ai_bundle.zip` 供人工喂给 AI | **MCP 直连**（31 工具），AI 在线取数 |
| 交互 | popup 按钮式（开始采集 / 自动遍历 / 合并会话） | 7 页面 + 面板 + 搜索/过滤/导出 |
| 落盘 | 会话目录树 + `artifacts.jsonl` + sha256 去重 | 浏览器下载三级策略 + 直写任意目录（File System Access API） |
| 代码量 | background 2663 / popup_v2 1017 / injected 572 / endpoint_extractor 878 | background 2400+ / content 1200 / popup 2000+ / hooks 20 个 |

**互补关系**：它偏「采集广度」，我们偏「采集之后的利用深度 + AI 可用性」。

---

## 三、逐模块差异（它有的 / 我们有的）

| 模块（它） | 行数 | 我们是否已有 | 处理 |
| --- | --- | --- | --- |
| `extension/chunk_discovery.js` | 353 | ❌ 无 | **已移植** → `lib/chunk_finder.js` |
| `extension/route_exhaustion.js` | 165 | 部分（运行时 `__vue_app__` 探测） | **已移植** → `lib/route_finder.js`（静态源码提取，守卫拦不住） |
| 域名过滤（`background.js` 内） | ~250 | 朴素同源比较 | **已移植** → `lib/site_scope.js` |
| Vite 清单探测（`background.js` 内） | ~110 | ❌ 无 | **已移植** → `JsPredictor.probeManifests()` |
| Module Federation 发现 | 与 chunk 同文件 | ❌ 无 | **已移植** → `ChunkFinder.discoverFederationRemotes()` |
| `extension/injected.js`（运行时 Hook） | 572 | 部分（18 个 Hook：fetch/xhr/crypto/cookie/storage/json/调试对抗） | **部分移植** → 新增 `hooks/hook_dynamic_code.js`、`hooks/hook_worker.js` |
| `storage/js_coverage.py` | 367 | ❌ 无 | **已移植** → `JsPredictor.coverage()` + popup 覆盖率行 |
| `analyzers/endpoint_extractor.py` | 878 | ✅ 已有（分类正则 + 171 条 AND 规则） | 未移植（见第五节） |
| `analyzers/finding_scanner.py` | 237 | ✅ 已有（Heimdallr + api_finder） | 未移植 |
| `analyzers/default_scan_rules.py` | 157（12 条规则） | ✅ 我们的规则库规模远超 | 不移植 |
| `storage/merge.py`（多会话合并） | 259 | ❌ 无 | 未移植（架构不匹配，见第五节） |
| `storage/session.py` / `artifacts.py`（会话与去重落盘） | 615 | 部分（ResourceIndex + JsTextCache + 下载引擎） | 不移植 |
| `server.py` / `run_collector.py`（本地 collector） | 293 | ❌ 无（也不需要） | 不移植 |
| `jsmap_analyzer_hae.py`（SourceMap 分析） | 828 | ✅ 已有（MCP `list_sourcemaps`/`resolve_sourcemap`） | 不移植 |
| `storage/hydration.py`（会话恢复） | 163 | ✅ 等价（HealthCheck + 会话自愈 + 持久化） | 不移植 |

---

## 四、已落地（v1.6.0）

### 4.1 `lib/chunk_finder.js` — webpack chunk 合成 + Module Federation

**解决的问题**：我们的「一键下载站点 JS」只能下到**浏览器实际请求过**的文件。
webpack 的懒加载 chunk 只有在对应路由被访问时才会发请求 —— 没访问到的路由，
其 chunk 永远进不了网络清单，接口提取也就漏掉一大片。

**做法**（三段推导，逐级降级）：

1. **语义映射**：`__webpack_require__.u = e => "chunk-" + e + "." + {…}[e] + ".js"`
2. **名称/哈希分离**：`({860:"LoginReset"}[e] || e) + "." + {860:"a1b2c3d4e5"}[e] + ".js"`
3. **后缀 × 分隔符试探**：`.js / .chunk.js / .bundle.js / .esm.js …` × `. - _`
   → 一个 chunk 最多产出 4 个候选（3 分隔符 + 纯哈希形态）
4. **兜底直取**：源码里静态写死的 hashed 文件名（`assets/index-6223ea2e.js`）

**关键取舍 —— 必须校验**：合成出的 URL 是**猜的**。
如果直接交给 `chrome.downloads.download()`，404 的 HTML 错误页会被当成 `.js` 落盘。
所以 `JsPredictor` 会把候选**逐个 GET 校验**（默认上限 60 个、并发 4、间隔 120ms），
只保留 2xx 且 content-type 像 JS 的；校验时抓到的内容顺手写进 `JsTextCache`，
于是这些文件也**立刻能被 MCP `search_in_js` 检索**。

**Module Federation**：`remoteEntry.js` 可能在**另一个源**上，且只有真正 import 远程模块时才会被加载 ——
未触发的远程容器对 webRequest 完全不可见。支持 `name@url`、`entry:`、`__federation_*()` 四种写法。

**移植时修的健壮性问题**（原版会漏）：
- 原版模式要求 `[e]||e` 紧邻（无空格）→ 遇到未压缩/美化过的构建产物就完全不命中。
  现已全部做空白容错。
- 原版要求后缀恰好是 `".js"` → `".chunk.js"` 这类会漏。现已放宽为 `["'][^"']{0,32}js["']`。
- 原版无源码长度上限，超大 bundle 上的惰性量词正则会退化 → 加 3MB 上限。

### 4.2 `lib/route_finder.js` — SPA 路由静态提取

**价值**：运行时路由探测（`__vue_app__` / React Router 实例）会被**路由守卫**和懒加载时机影响；
从源码静态提取则「守卫再严也挡不住源码里的定义」。

支持 Vue Router（`routes:` 数组 / 动态 `import()`）、React（`<Route path>` / `{path:...}` / `lazy(()=>import())`）、
Angular（`path: + loadChildren`）、通用路径字面量、hash 路由（`#/user/profile`）。

**修的一个真实缺陷**：Angular 的路由是 `path: 'orders'`（**无前导斜杠**），
原版会因为它不满足「以 `/` 开头」而全部丢弃。现加 `normalizeRoutePath()` 自动补 `/`。

**动态路由不进 URL 列表**：`/user/:id`、`/post/[slug]` 缺参数，盲目访问只会拿到 404 或错误页 ——
默认排除，`includeDynamic` 才纳入。

### 4.3 `lib/site_scope.js` — 站点范围判定

把「是不是站点自己的代码」从 `host !== pageHost` 升级为四分类：

| scope | 含义 | 例子 |
| --- | --- | --- |
| `site` | 同主体（含子域、**同组织名跨 TLD**） | `api.example.com` / `static.example.com` / `meituan.net` vs `meituan.com` |
| `cdn` | 公共 CDN 通用库 | `cdn.jsdelivr.net` `unpkg.com` `cdn.bootcdn.net` |
| `noise` | 统计/广告/错误上报/验证码 | `google-analytics.com` `hm.baidu.com` `sentry.io` `geetest.com` |
| `thirdparty` | 其余外部域 | 合作方、另一套域 |

技术要点：
- **两级后缀**：`dns2.example.edu.cn` → 主体是 `example.edu.cn`（不是 `edu.cn`）。
  覆盖 `.com.cn/.edu.cn/.gov.cn/.co.uk/.com.hk/.com.tw/.co.jp` 等。
- **组织名跨 TLD**：`meituan.com` ↔ `meituan.net` 视为同主体；
  但**过短/通用组织名不做匹配**（`a.com` 与 `a.net` 不该被合并，`www/api/cdn/static` 等也不参与）。

**效果**：「仅本站 JS」不再漏掉自家接口域，也不再混进 CDN 库与统计脚本。
弹窗资源列表现在每条都带 `site/cdn/noise` 标签（比只有「第三方」精确得多）。

### 4.4 `JsPredictor` — 构建清单探测 + 预测补齐 + 覆盖对账

**构建清单探测**（最省事的全量补齐手段）：
当采集到的 JS 命中 `looksLikeViteAsset()`（`/assets/index-<hash>.js`）时，
依次探测 `/.vite/manifest.json`、`/manifest.json`、`/asset-manifest.json`、
`/build/asset-manifest.json`、`/static/asset-manifest.json`、`/webpack-assets.json` 等 8 条路径
（比原版的 4 条更全，兼容 Vite / CRA / webpack-assets-manifest / Angular dist 四种清单格式）。
**一次就把全量构建产物拿到**，比逐个猜 chunk 高效得多。

判定细节：SPA 常把未知路径回落到 `index.html`，所以要求响应体以 `[` 或 `{` 开头且能 `JSON.parse`，
否则视为「不是清单」继续试下一条。

**覆盖对账**：`候选（观测 + 预测） vs 可下载`，产出总数、来源分布、站点自有缺口、
覆盖率百分比与缺口 URL 列表（对应它的 `js_coverage_report`）。

### 4.5 `hooks/hook_dynamic_code.js` + `hooks/hook_worker.js`

我们对 `webRequest` 的利用已经比较充分，所以 `injected.js` 里**大部分 Hook 对我们冗余**
（它挂在 DOM 插入上的 `<script>` 捕获，我们靠 webRequest 就全覆盖了，且不怕 Shadow DOM）。

真正是我们盲区的是这两类：

| Hook | 抓什么 | 为什么 webRequest 看不到 |
| --- | --- | --- |
| `hook_dynamic_code` | `Blob` + `URL.createObjectURL`（blob: 脚本）、`eval`、`Function` 构造器 | 这些代码**不是网络请求**，运行时凭空产生 |
| `hook_worker` | `Worker` / `SharedWorker` / `navigator.serviceWorker.register` | 走独立请求上下文；抓到的 URL 直接并进资源清单，被「下载全部」带走 |

安全设计：
- `hook_dynamic_code` 单段上限 512KB、累计 80 段 / 4MB，含**代码指纹去重**（同一段被反复求值只上报一次）；
- Blob 内容做「像不像代码」判定（控制字符占比 + 特征词），避免把图片/字体二进制当代码；
- `hook_worker` 只上报 URL，**不改写行为**，严格保留原构造器原型与返回值；
- 两个 Hook 都遵循既有约定：`localStorage LatentEye_<id>_flag` 开关 + `hooks.json` 的 `file` 字段登记。

**导出**：捕获到的动态代码可在「扫描 → JS 资源 → 动态代码」里一键落盘为 `.js` 文件
（每个片段一个文件，文件头写明 kind / 时间 / 来源 frame / 是否截断），
复用下载引擎的目录模板与命名规则（所以站点文件夹那套也自动生效）。

### 4.6 MCP 工具 29 → 31

| 工具 | 用途 |
| --- | --- |
| `predict_js_chunks` | 预测补齐：返回候选 URL + 来源 + 分析统计 + 路由清单；`dryRun` 式 `verify=false` 可只看不校验 |
| `get_js_coverage` | 覆盖对账：总数 / 来源分布 / 站点缺口 / 覆盖率 / 缺口 URL |
| `get_dynamic_code` | 读取 blob/eval/Function 捕获的运行时脚本（AI 可直接分析其中的加密逻辑与接口） |

`download_js` 同时新增 `predict: true`（下载前一并补齐）与 `scope: 'site'`（同主体范围）。

---

## 五、看过但**没有**移植的部分（含原因）

| 能力 | 为什么不做 |
| --- | --- |
| **CDP 全量抓取体系**（`Debugger.scriptParsed` + `Network.getResponseBody` 常驻） | 它把 `debugger` 作为**必选权限**常驻 attach，代价是浏览器顶部常驻「正在调试此浏览器」提示、**与 DevTools 互斥**（用户开 DevTools 就掉线，它专门写了 `reattachDebugger` 处理这种情况）。对日常使用的扩展来说这个代价过高。我们的策略是「webRequest + 注入采集 + Hook 覆盖 95%，CDP 只在需要绕过严格 CSP 执行代码时按需申请」——`CDPExecutor` 已经是这个定位。**建议保持现状**。 |
| **本地 Python collector + 会话目录树** | 它必须依靠本地进程落盘（HTTP :17891）才能保存脚本与元数据。我们已有浏览器下载三级策略 + File System Access API 直写任意目录，不需要额外进程；引入 collector 会让「装个扩展就能用」变成「还要跑 Python」。 |
| **多会话合并**（`merge.py`） | 面向「不同账号/不同入口分别采集后统一重分析」。我们的使用场景是单次交互式挖掘，合并价值有限；真要合并，把各次导出目录用文件系统合并更直接。 |
| **接口提取器**（`endpoint_extractor.py` 878 行） | 功能重叠：我们有 40+ 分类正则 + 171 条 AND 规则 + 更强的 baseURL 识别。**唯一值得抄的一点**是它给每个接口带 **行号 + 上下文片段**（便于人工复核）。我们的 MCP `search_in_js` 已经能返回文件/行号/列号/上下文，所以实际已覆盖。 |
| **`injected.js` 的 Shadow DOM / inline event handler 捕获** | 对我们**冗余**：它的必要性来自「只能靠 DOM 抓 script」；我们靠 webRequest 全量观测脚本请求（Shadow DOM 内的脚本请求同样被 webRequest 看到），且已有的页面采集会扫内联脚本正文。 |
| **规则导入/导出（JSON）** | 我们的规则是内置的（Heimdallr + api_finder + 存储桶），已有开关/来源/准确度配置；导入自定义正则属于另一条产品线，非本轮范围。 |
| **`jsmap_analyzer_hae.py`** | 已等价覆盖（MCP `list_sourcemaps` / `resolve_sourcemap` 直接返回 `sourcesContent` 原始源码）。 |
| **`session.py` / `hydration.py`（会话持久化与恢复）** | 已等价覆盖（`HealthCheck` 自检 + 会话状态持久化 + SW 冷启动恢复）。 |

---

## 六、给后续维护的提醒

1. **`lib/chunk_finder.js` 的候选是「猜测」**，任何时候都不要绕过 `JsPredictor.verifyCandidates()`
   直接把它们交给下载接口 —— 否则 404 HTML 会被存成 `.js`。
2. **`site_scope.js` 的 `NOISE_DOMAINS` / `CDN_DOMAINS` 需要长期增补**。
   新增厂商域时同时补 `tools/test_chunk_finder.js` 第 6 节的断言（该节当前 25 项）。
   注意 `GENERIC_ORGS` 的约束：**过短或通用组织名不参与跨 TLD 匹配**，这是防误判的关键。
3. **`route_finder.js` 为 Angular 补了前导斜杠**（`normalizeRoutePath`）。
   如果后续新增只在非 `/` 开头场景下成立的路由形态，走同一条规范化路径，不要另起一套。
4. **两个新 Hook 改配置键名时必须同步 `hooks.json` 的 `id` 与 `file`**
   （历史上 v1.1.0 就因为 `id`/`file` 错位导致 18 个 Hook 全部静默失效）。
5. **`JsPredictor` 与 `DynamicCodeStore` 的按标签页缓存已在导航/关标签时清理**；
   新增按标签页的缓存时记得挂到同样的两个位置（`tabs.onUpdated` 的 `loading` 分支 + `tabs.onRemoved`）。
6. 上游 `hybrid_capture_project2` 的两个参考点仍在原目录，可直接对照：
   `extension/chunk_discovery.js`（chunk 合成原版）、`storage/js_coverage.py`（覆盖对账原版）。
