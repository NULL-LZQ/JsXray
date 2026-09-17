# <img src="icons/source_eye.png" width="56" align="top" alt="JsXray logo">&nbsp;JsXray

> 给前端拍一张 X 光片 —— 跨浏览器的敏感信息扫描 · 指纹识别 · JS 逆向 Hook · 一键下载站点 JS · MCP 服务（AI 工具桥接，32 个工具）

**JsXray v1.1.0**，首次发布。采用 Manifest V3，同时适配 **Chrome / Edge / Brave（Chromium 内核）** 与 **Firefox 128+**。

---

## 🔍 JsXray 是什么

JsXray 是一款面向 **Web 安全测试**与 **JS 逆向工程**的综合型浏览器扩展。它像一台 X 光机一样透视你正在访问的页面：

- **看穿页面里藏了什么** —— 对 HTML 与全部已加载 JS 做敏感信息扫描（接口、密钥、PII、连接串等 29 类），并用 171 条多关键字 AND 规则做高精度信息泄露匹配；
- **看穿站点由什么构成** —— HTTP 头 / Cookie / 页面内嵌 / CDN 多维指纹，Vue / React 完整路由表提取，云存储桶风险被动监测；
- **看穿代码在做什么** —— 反调试绕过、API Hook、请求/响应捕获、blob:/eval/Function 动态代码捕获、webpack 懒加载 chunk 合成与构建清单探测、SourceMap 还原；
- **把站点 JS 一键带走** —— 按站点/作用域批量下载（逐个文件 / 打包 ZIP / 仅导出清单），支持直写本机任意目录，自动按目标网站 URL 建文件夹；
- **让 AI 替你干活** —— 内置 MCP（Model Context Protocol）服务，Codex / Claude / Trae / Cursor 等 AI 工具可直连本插件调用全部能力，边看边调代码、边取证。

适合：授权渗透测试中的信息搜集与 JS 分析、SRC 挖洞、CTF、前端逆向学习。

### 借鉴的开源项目

JsXray 在以下优秀开源项目的能力思路上二次开发、重新实现了扫描引擎 / UI / Hook 注入架构（完整致谢见文末）：

| 项目 | 借鉴内容 |
| --- | --- |
| FindSomething | 敏感信息扫描的分类思路 |
| SnowEyes | 指纹与资源发现 |
| AntiDebug_Breaker | 反调试与 API Hook 脚本设计 |
| Heimdallr | 反蜜罐、特征对抗、指纹规则库（265 条） |
| BurpAPIFinder | 信息泄露规则逆向导入（106 条） |
| 谛听鉴 | 云存储桶检测核心（10 厂商引擎） |
| HAPPY.JS.v1.5.0（同源版本） | 信息泄露 AND 引擎 / baseURL 识别 / 认证扫描 / SourceMap 还原 / 存储桶 / Vue 路由对抗 |
| hybrid_capture_project2 | chunk 合成 / 构建清单探测 / SPA 路由提取 / 动态代码与 Worker 捕获 |

---

## ✨ 功能亮点

### 1. 敏感信息扫描（29 类）
自研正则规则集扫描页面 HTML 与全部 JS：域名 / IP / URL / API 路径 / 用户名密码 / Cookie / ID 密钥 / JWT / 私钥证书 / 数据库连接串 / 消息队列 / 对象存储 / 手机号 / 邮箱 / 身份证 / 内网路径 / SourceMap / GitHub 链接 / Vue 文件 / 页面路由……

- **云密钥识别近 20 种**：微信开放平台/小程序、企业微信、AWS、阿里云、腾讯云、京东云、Google API、GitHub/GitLab Token、支付宝、Apple、Slack、Stripe、Twilio、钉钉、飞书等
- 直接抓取 DOM `<script src>` 与 `<link rel="modulepreload">`（比纯正则更可靠），噪声过滤词降低误报
- 点击扫描项的 JS 源路径可直接在新标签打开该文件

### 2. 信息泄露高精度引擎（171 条 AND 规则）
一条规则需**多个关键字同时命中**才报警，误报远低于单正则（内置 65 条 + BurpAPIFinder 逆向导入 106 条）；命中带上下文片段与来源 JS；接口 baseURL 自动识别（`axios.defaults.baseURL` / `$.ajaxSetup` / fetch wrapper 前缀等）。

### 3. 接口认证扫描（14 种绕过变体，按最小伤害原则加固）
对提取到的接口主动探测未授权访问：`;.css` `;.js` `;.ico` `.html` `%23/` `?a=1` 等 14 变体。只发**不带 Cookie 的只读 GET**；破坏性接口（logout/delete/drop…）直接跳过；假阳性（登录页 / 401 文案 / 登录跳转）不算命中；限速自停（间隔 ≥150ms、单次上限 300 请求、429/503 立即停止）；支持 `dryRun` 预览。

### 4. 多维指纹识别
HTTP 响应头指纹 / Cookie 指纹（常见 CMS）/ 流量统计指纹 / 页面内嵌指纹（Webpack、Vite、Vue、React、Angular、jQuery、Element UI、ThinkPHP、Django…）/ CDN 识别（Cloudflare、jsDelivr、unpkg）。指纹版本号真解析（`ng-version`、`.version`…），便于关联 CVE。

### 5. JS 采集预测补齐与覆盖对账
浏览器网络清单只能看到「访问过的页面用到的 JS」，JsXray 补齐四条盲区路径：

| 路径 | 手段 |
| --- | --- |
| webpack chunk 合成 | 解析 runtime 的 `.u` 映射，多形态试探 + 逐个 GET 校验存在性 |
| 构建清单探测 | Vite / CRA / webpack / Angular 四种格式，一次拿到全量构建产物 |
| Module Federation | 发现跨源 `remoteEntry.js` 远程容器 |
| SPA 路由静态提取 | Vue / React / Angular / hash 路由，供逐条访问触发懒加载 |

配套**站点范围四分类**（自有 site / 公共 CDN / 统计噪声 / 第三方）与**覆盖对账**（候选 vs 可下载、覆盖率、缺口 URL）。另有**动态代码捕获**（Hook `Blob`/`eval`/`Function`，抓取不经过网络请求的运行时脚本）与 **Worker 脚本捕获**。所有补齐动作均为只读 GET，有限速与数量上限。

### 6. 一键下载当前网站 JS
- **三种形式**：逐个文件（浏览器直下，保留 Cookie/Referer）· 打包 ZIP（含 `_manifest.json` 与 `_list.txt`）· 仅导出 URL 清单
- **自动按目标网站 URL 建文件夹**：目录模板 `{url}` `{host}` `{date}` `{time}` 等占位符 + 实时路径预览
- **直写本地目录**：File System Access API 把 JS 直接写进本机任意文件夹（无需 downloads 权限），独立标签页承载、弹窗关掉不中断，逐文件进度 + sha256 清单
- 选项：是否含第三方 JS、跳过 `.min.js`、文件数上限；文件名安全清洗（Windows 保留名 / 非法字符 / 重复短哈希）

### 7. JS 逆向 Hook（16 个主世界脚本）
- **反调试 9 个**：Bypass Debugger（移除无限 `debugger`）· Hook Console · Hook Close · Hook History · Fixed Window Size · Hook CryptoJS（打印 AES/DES/MD5/SHA/HMAC 密钥与明密文）· Math.random / Date.now / performance.now 固定返回值
- **API Hook 7 个**：document.cookie · fetch · XMLHttpRequest.open / setRequestHeader · Storage 读写 · JSON.stringify/parse
- 支持 debugger 断点、调用栈打印、固定变量值、关键字过滤；注入即启用、开关即时生效（对已打开页面无需刷新）

### 8. 路由提取与 Vue 路由对抗
- 主世界注入提取 **Vue2/Vue3 Router 与 React Router 完整路由表**（BFS 定位根节点、路由表 4 级回退、hash/history 自动识别、多档延时覆盖 SPA 异步挂载）
- **对抗按钮即时生效且可恢复**：清除跳转（`push/replace/go/back` 换 noop，阻止鉴权重定向）· 清除路由守卫（Hook `Array.prototype.push` 丢弃守卫注册）

### 9. 反蜜罐防护（整合 Heimdallr，265 条规则）
- 蜜罐域名拦截（`declarativeNetRequest`，142 条拦截规则）+ JSONP 蜜罐告警系统通知
- 规则五维全覆盖：请求 URL / 请求头 / 请求体 / 响应头 / 响应体（响应体经主世界 hook fetch/XHR 实现，无需 debugger 权限）
- 覆盖中间件 / OA / CMS / 堡垒机 / 安全设备 / 邮件系统等指纹，及内网 IP、手机号等敏感信息命中
- 特征对抗：禁用页面缓存、Canvas 指纹干扰（Hook `toDataURL`/`toBlob`/`getImageData` 注入随机扰动）

### 10. 云存储桶风险监测（10 厂商）
阿里云 OSS / 腾讯云 COS / 华为云 OBS / Amazon S3 / 七牛 / 青云 / 又拍云 / 京东云 / 金山云 / 天翼云。风险类型：桶遍历、PUT 上传、DELETE 删除、ACL/Policy 可读写、桶接管、域名命中。被动检测默认**安全模式**（只读），写类探测仅限人工勾选的主动检测窗口（Burp 格式请求/响应流式输出）。黑白名单支持 `*.` 通配与互斥冲突检测。

### 11. MCP 服务（32 个 AI 工具直连）
**设置页 → MCP 服务** 开启后，AI 工具（Codex / Claude / Trae / Cursor…）经 stdio JSON-RPC ↔ 本地 WebSocket 桥（默认端口 10087，令牌双向鉴权）直连扩展：

| 类别 | 代表工具 |
| --- | --- |
| 标签页 | `list_tabs` `navigate_tab` `screenshot` `get_frame_tree` |
| 信息搜集 | `get_scan_results`（29 类）· `get_info_leakage`（AND 引擎）· `get_fingerprints` · `get_routes` · `get_cookies/get_storage` · `get_page_html/query_dom` · `get_network_requests` · `get_console_logs` · `get_bucket_risks` |
| JS 分析 | `get_js_list` · `fetch_js`（美化/分段）· `search_in_js`（全站 JS 批量检索）· `beautify_js` · `download_js` · `predict_js_chunks` · `get_js_coverage` · `get_dynamic_code` · `list_sourcemaps/resolve_sourcemap` |
| 漏洞验证 | `run_auth_bypass`（14 变体，只读 + dryRun） |
| JS 调试 | `execute_js`（主世界/隔离世界/CDP 深度执行）· `list_hooks/enable_hook/disable_hook` |

多客户端并存（自动中继）、20s 心跳保活 Service Worker、断线指数退避重连。

### 12. 其它
- **动态扫描**（MutationObserver 实时捕获 SPA/AJAX 渲染内容）与**深度扫描**（递归解析嵌套 JS 与 webpack chunk）
- 多 Frame 分组展示扫描结果；分类 chip 点击跳转
- 浅色 / 深色双主题（霓虹绿→青渐变品牌视觉，与「绿色之眼」图标同源）
- 运行状态自检（模块加载 / 权限 / Hook / MCP / 初始化异常）+ 一键重载扩展 + 复制诊断
- Service Worker 顶层初始化全部 try/catch，单模块异常不拖垮整体

---

## 📁 目录结构

```
JsXray/
├── manifest.json              # MV3 清单（Chrome + Firefox 兼容）
├── background.js              # 后台 Service Worker：指纹/JS抓取/Hook注册/webRequest/信息泄露引擎/下载与资源索引/MCP客户端
├── content.js                 # 内容脚本：扫描引擎（正则/动态/深度/Hook配置同步/页面JS采集/console桥接）
├── bucket/                    # 云存储桶风险监测模块
│   ├── bucket_bg.js           # 后台 BucketSentinel（被动检测/主动检测/页面扫描/黑白名单）
│   ├── content_scan.js        # 页面云存储 URL 扫描内容脚本
│   └── bucket_log.html/js     # 主动检测流式日志窗口
├── hooks.json                 # Hook 脚本元数据（id / file 实际文件名 / 分类 / 配置项）
├── hooks/                     # 16 个主世界 Hook 脚本
├── inject/
│   ├── vue_router.js          # 主世界注入：Vue/React 路由提取与对抗
│   └── capture_main.js        # 主世界注入：console / 未捕获异常捕获
├── data/
│   ├── api_finder_rules.js          # 信息泄露内置规则（65 条）
│   ├── api_finder_rules_burpapi.js  # BurpAPIFinder 逆向导入规则（106 条）
│   └── heimdallr_rules.js           # Heimdallr 规则库（265 条 + 拦截域名）
├── lib/
│   ├── bucket/bucket_core.js  # 云存储桶检测核心（10 厂商引擎）
│   ├── api_finder_engine.js   # 信息泄露多关键字 AND 匹配引擎
│   ├── chunk_finder.js        # webpack chunk 合成 + Module Federation 发现
│   ├── route_finder.js        # SPA 路由静态提取
│   ├── site_scope.js          # 站点范围四分类 + 两级后缀基础域
│   ├── downloader.js          # 资源索引 ResourceIndex + 下载引擎 DownloadManager
│   ├── recorder.js            # ConsoleStore / JsTextCache(LRU) / JsBeautifier
│   └── zip.js                 # 纯 JS ZIP 打包器
├── mcp/
│   ├── server.js              # MCP 桥接进程（stdio JSON-RPC ↔ WebSocket，纯 Node 零依赖）
│   └── ext_client.js          # 扩展侧 MCP 客户端（WS 连接管理 + 32 工具调度）
├── popup/                     # 弹窗 UI（扫描/指纹/Hook/路由/防护/存储桶/设置 七页）
│   ├── fsdl.js                # 直写本地目录引擎（File System Access API）
│   └── dlwriter.html/js       # 直写下载面板（独立标签页）
├── icons/                     # 「绿色之眼」品牌图标 16/32/48/128
└── tools/                     # 零依赖测试与工具脚本（test_all.js 一键全测）
```

---

## 🚀 浏览器安装

### Chrome / Edge / Brave（Chromium 内核）

1. 下载本仓库（`Code → Download ZIP` 解压，或 `git clone`）
2. 打开 `chrome://extensions/`
3. 右上角开启 **「开发者模式」**
4. 点击 **「加载已解压的扩展程序」**，选择包含 `manifest.json` 的 `JsXray/` 目录
5. 工具栏出现「JsXray」图标即安装成功

> 访问 `file://` 协议或 `localhost` 时，需在扩展详情中开启 **「允许访问文件网址」**。

### Firefox（128+）

1. 打开 `about:debugging#/runtime/this-firefox`
2. 点击 **「此 Firefox」→「临时载入附加组件」**
3. 选择 `JsXray/manifest.json`
4. 工具栏出现「JsXray」图标即安装成功

> 临时载入的扩展在 Firefox 重启后移除；长期使用需通过 Mozilla 签名流程。

---

## 📖 使用指南

### 基础流程（信息搜集）
1. 打开目标网站 → 点击工具栏「JsXray」图标
2. **扫描页**自动展示 29 类敏感信息，顶部进度条与分类 chip（可点击跳转）
3. **JS 资源**面板列出站点全部 JS（状态码/大小/第三方/是否压缩），可单条下载或「下载全部」
4. 多 Frame 站点在顶部切换 Frame 查看；支持结果过滤与 JSON 导出

> 资源清单依赖网络请求观测。若列表为空，刷新一次目标页面即可。

### 下载站点 JS
1. 扫描页顶部 **「下载JS」** 打开下载面板
2. 选择形式（逐个文件 / ZIP / 仅清单）与目录模板（默认自动按站点 URL 建文件夹，带实时路径预览）
3. 保存位置：浏览器默认下载目录，或「直写本地目录」选本机任意文件夹
4. 可选：含第三方 JS / 跳过 .min.js / 文件数上限

### 动态 / 深度扫描
设置页开启 **「动态扫描」**（实时监听 DOM 变化）与 **「深度扫描」**（递归解析嵌套 JS 与 webpack chunk），刷新目标页面生效。

### JS 逆向 Hook
1. **Hook 页** 切换「反调试 / API Hook」子页签，开启所需脚本（可配固定值、关键字、debugger、stack）
2. 设置页切换 **全局模式**（注入所有站点）或 **标准模式**（仅当前域名）
3. **刷新目标页面**，Hook 输出打印在页面控制台（F12）
4. 「响应体捕获」「动态代码捕获」「Worker 捕获」「Canvas 指纹干扰」同理，捕获结果可在弹窗查看或经 MCP 读取

### 路由提取与对抗
1. **路由页** 查看 Vue / React 完整路由表，支持批量复制路径/URL、当前标签页直接打开
2. 「Vue 路由对抗」面板：**清除跳转** / **清除路由守卫**，点击即时生效，再次点击恢复

### AI 工具接入（MCP）
1. 本机安装 Node.js（≥ 14，推荐 18+）
2. 扩展 **设置页 → MCP 服务** → 开启开关，复制生成的配置片段
3. 把片段中的 `<扩展目录>` 替换为 `manifest.json` 所在目录，写入 AI 工具的 MCP 配置（`claude_desktop_config.json` / `~/.codex/config.toml` / Trae MCP 设置）。Windows 路径统一用正斜杠 `/`，JSON 里反斜杠必须写成 `\\`
4. 启动 AI 会话，状态变为「已连接桥接进程」即可调用 32 个工具

### 开发与测试
```bash
node tools/test_all.js        # 一键跑全部离线测试（14 个脚本）
node tools/validate.js        # manifest / hooks / popup 一致性校验
```

---

## ⚠️ 免责声明

本工具仅供**授权的安全测试、CTF 竞赛、安全研究与学习**使用。使用者需严格遵守所在地区法律法规，并对自身行为负责：

- 未经授权对他人系统进行扫描、探测与调试**可能违法**；
- 部分功能（接口认证扫描、存储桶主动检测、JS 批量下载）具有主动请求行为，请仅在获得书面授权的范围内使用；
- JsXray 的主动探测均内置了最小伤害设计（只读 GET、破坏性接口跳过、限速自停、安全模式默认只读），但这不构成滥用免责；
- 作者不对任何滥用行为承担责任。下载或使用即表示 you agree to the above terms。

---

## 🙏 致谢

JsXray 在以下优秀开源项目的基础上二次开发，在此致谢（排名不分先后）：

| 项目 | 借鉴内容 |
| --- | --- |
| [FindSomething](https://github.com/momosecurity/FindSomething) | 敏感信息扫描分类思路 |
| [SnowEyes](https://github.com/SickleSec/SnowEyes) | 指纹与资源发现 |
| [AntiDebug_Breaker](https://github.com/0xsdeo/AntiDebug_Breaker) | 反调试与 JS Hook 脚本设计（Vue 路由对抗的原始思路来自其同类实现并做了可卸载化改造） |
| [Heimdallr](https://github.com/graynjo/Heimdallr) | 反蜜罐、特征对抗与指纹规则库（265 条规则完整保留原始结构） |
| [BurpAPIFinder](https://github.com/shuanx/BurpAPIFinder) | 信息泄露规则逆向导入（106 条 AND 规则） |
| 谛听鉴 | 云存储桶检测核心（10 厂商引擎 bundle） |
| HAPPY.JS.v1.5.0（同源版本） | 信息泄露 AND 引擎 / 接口 baseURL / 认证扫描 / SourceMap 还原 / 存储桶 / Vue 路由对抗的模块级借鉴与加固重写 |
| hybrid_capture_project2 | chunk 合成 / 构建清单探测 / SPA 路由提取 / 动态代码与 Worker 捕获的采集广度思路 |

在借鉴以上项目能力思路与部分规则数据的同时，JsXray 的扫描引擎、下载引擎、MCP 桥接、UI 与 Hook 注入架构均为重新实现。感谢这些项目的原作者与社区。

---

## 📜 License

[MIT](LICENSE) © 2026 JsXray

借鉴项目的规则数据与代码片段版权归各自原作者所有，使用方式以各原项目许可证为准，详见其仓库。
