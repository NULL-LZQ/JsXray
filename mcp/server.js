#!/usr/bin/env node
/* =====================================================================
 * JsXray — MCP 桥接服务（纯 Node.js，零第三方依赖）
 *
 * 架构：
 *   Codex / Claude / Trae 等 AI 工具 (MCP Client)
 *     │ stdio · JSON-RPC 2.0 · MCP 协议（换行分隔消息）
 *     ▼
 *   本进程（mcp/server.js）
 *     │ WebSocket  ws://127.0.0.1:<port>（令牌双向鉴权）
 *     ▼
 *   JsXray 浏览器扩展（background Service Worker 主动连出）
 *
 * 多实例：第一个绑定端口的进程成为「桥(bridge)」，直接对接扩展；
 *   后续进程（其他 AI 工具同时配置时）自动降级为「中继(relay)」，
 *   将 tools/call 转发给桥进程，实现多客户端并存。
 *
 * 用法：
 *   node mcp/server.js --port 10087 --token <令牌>
 *   （令牌在扩展「设置 → MCP 服务」中查看，配置片段可直接复制）
 * ===================================================================== */

'use strict';

const http = require('http');
const crypto = require('crypto');

const VERSION = '1.1.0';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 64 * 1024 * 1024;   // 单帧上限 64MB
const CALL_TIMEOUT = 60000;           // 工具调用超时 60s
const RESULT_CAP = 900 * 1024;        // 返回给 AI 的结果文本上限 ~900KB
const PING_INTERVAL = 20000;          // 应用层心跳（保活扩展 SW）
const DEAD_AFTER = 55000;             // 超过该时长无任何帧则判定连接死亡

/* ------------------------- 启动参数 ------------------------- */
function parseArgs() {
    const args = process.argv.slice(2);
    const cfg = {
        port: parseInt(process.env.HAPPYJS_MCP_PORT || '', 10) || 10087,
        token: process.env.HAPPYJS_MCP_TOKEN || '',
        anyToken: false            // 排障用：接受任意令牌并回显（仅监听 127.0.0.1）
    };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port' && args[i + 1]) cfg.port = parseInt(args[++i], 10) || cfg.port;
        else if (args[i] === '--token' && args[i + 1]) cfg.token = args[++i];
        else if (args[i] === '--accept-any-token') cfg.anyToken = true;
        else if (args[i] === '--version' || args[i] === '-v') {
            process.stdout.write(VERSION + '\n');
            process.exit(0);
        } else if (args[i] === '--help' || args[i] === '-h') {
            process.stderr.write([
                `JsXray MCP 桥接服务 v${VERSION}`,
                '',
                '用法: node mcp/server.js [--port <端口>] [--token <令牌>]',
                '',
                '  --port,  -p   扩展侧「设置 → MCP 服务」中的监听端口，默认 10087',
                '  --token, -t   扩展生成的连接令牌（必填，否则拒绝所有连接）',
                '  --accept-any-token  排障用：跳过令牌校验并回显扩展令牌（扩展未同步令牌时临时救急）',
                '  --version     打印版本号',
                '  --help        显示本帮助',
                '',
                '环境变量: HAPPYJS_MCP_PORT / HAPPYJS_MCP_TOKEN',
                `当前可用工具（${TOOLS.length} 个）:`,
                '  ' + TOOLS.map(t => t.name).join(', ')
            ].join('\n') + '\n');
            process.exit(0);
        }
    }
    return cfg;
}
// CFG 在工具清单定义之后初始化（--help 需要列出工具名，避免 TDZ）
let CFG = { port: 10087, token: '' };

// 注意：stdout 只允许输出 MCP 协议消息，日志一律走 stderr
function log(...a) { console.error('[happyjs-mcp]', ...a); }
/* =====================================================================
 * MCP 工具清单（静态定义，桥/中继共用）
 * ===================================================================== */
const TAB_ID_PROP = { type: 'number', description: '目标标签页 id（可用 list_tabs 获取），省略则取当前活动标签页' };
const FRAME_ID_PROP = { type: 'number', description: '目标 iframe 的 frameId（用 get_frame_tree 查看），默认 0 主文档' };
const TOOLS = [
    {
        name: 'list_tabs',
        description: '列出浏览器标签页（id/标题/URL/是否激活/所属窗口），用于选择后续操作的目标标签页',
        inputSchema: {
            type: 'object',
            properties: {
                keyword: { type: 'string', description: '按 URL/标题过滤' },
                currentWindow: { type: 'boolean', description: '仅当前窗口，默认 false（全部窗口）' },
                includeChromePages: { type: 'boolean', description: '是否包含 file:// 等非 http 页面，默认 false' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'get_frame_tree',
        description: '列出标签页内全部 frame（frameId/父 frame/URL），用于定位需要注入的 iframe',
        inputSchema: { type: 'object', properties: { tabId: TAB_ID_PROP }, additionalProperties: false }
    },
    {
        name: 'get_scan_results',
        description: '获取敏感信息扫描结果（域名/IP/URL/API/凭证/Cookie/云密钥/私钥/数据库连接/手机号/邮箱/身份证/JWT/页面路由等约 29 类）。信息搜集核心工具；支持按分类筛选，避免返回过大',
        inputSchema: {
            type: 'object',
            properties: {
                tabId: TAB_ID_PROP,
                allFrames: { type: 'boolean', description: '是否包含所有 iframe，默认 false 仅主页面' },
                categories: { type: 'string', description: '逗号分隔的分类键，如 "absoluteApis,apis,idKeys"；留空返回全部' },
                preset: {
                    type: 'string',
                    enum: ['api', 'secret', 'pii', 'assets', 'infra', 'all'],
                    description: '分类预设：api=接口相关 / secret=密钥凭证 / pii=个人信息 / assets=静态资源 / infra=基础设施信息'
                },
                maxPerCategory: { type: 'number', description: '每个分类最多返回条数，默认 500；被截断时该分类会同时出现 `<分类>_truncated: true` 与 `<分类>_hiddenCount: n`' },
                includeMeta: { type: 'boolean', description: '是否包含非数组的元信息字段，默认 true' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'get_fingerprints',
        description: '获取指纹识别结果：HTTP 响应头指纹、Cookie 指纹、页面内嵌指纹、构建工具，以及 Heimdallr 规则库命中（Web 服务器/Java 框架/OA/CMS/WAF/堡垒机/蜜罐等 265 条规则）',
        inputSchema: { type: 'object', properties: { tabId: TAB_ID_PROP }, additionalProperties: false }
    },
    {
        name: 'get_routes',
        description: '获取站点的 Vue/React 完整路由表（扩展会自动绕过前端路由守卫提取）。hostname 与 tabId 二选一，都省略时取当前活动标签页域名',
        inputSchema: {
            type: 'object',
            properties: {
                hostname: { type: 'string', description: '站点域名，如 example.com' },
                tabId: TAB_ID_PROP
            },
            additionalProperties: false
        }
    },
    {
        name: 'get_js_list',
        description: '列出目标站点已加载的全部 JS 资源（URL/大小/状态码/是否第三方/是否压缩），数据来自扩展的网络观测 + 页面 DOM/performance 采集。分析前端与准备批量下载前先调用它。默认已排除状态码 >= 400 的 URL（站点失败回退请求会把 404 页面混进来，下载会把错误页当 JS 落盘），被排除的数量在 excludedFailed 字段',
        inputSchema: {
            type: 'object',
            properties: {
                tabId: TAB_ID_PROP,
                includeThirdParty: { type: 'boolean', description: '是否包含第三方（CDN）JS，默认 false' },
                skipMin: { type: 'boolean', description: '跳过 .min.js，默认 false' },
                keyword: { type: 'string', description: '按 URL 关键字过滤' },
                limit: { type: 'number', description: '最多返回条数，默认 300' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'fetch_js',
        description: '抓取指定 URL 的 JS 源码，用于分析接口定义、密钥、加密逻辑。支持 beautify=true 自动美化压缩代码，startLine 分段读取大文件',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'JS 文件完整 URL' },
                tabId: TAB_ID_PROP,
                frameId: FRAME_ID_PROP,
                beautify: { type: 'boolean', description: '检测到压缩代码时自动美化，默认 false' },
                startLine: { type: 'number', description: '从第几行开始返回（美化后的行号），默认 1' },
                maxLen: { type: 'number', description: '返回内容最大字符数，默认 200000，上限 1500000' }
            },
            required: ['url'],
            additionalProperties: false
        }
    },
    {
        name: 'search_in_js',
        description: '在目标站点已加载的 JS 源码中批量检索关键字/正则，返回命中文件、行号、列号与上下文片段。逆向定位接口、密钥、加密参数的首选工具',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: '关键字或正则表达式' },
                tabId: TAB_ID_PROP,
                regex: { type: 'boolean', description: 'pattern 是否按正则解析，默认 true；只想匹配普通文本时传 false' },
                caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
                urls: { type: 'array', items: { type: 'string' }, description: '仅检索这些 JS URL（默认检索站点全部 JS）' },
                urlFilter: { type: 'string', description: '按 URL 关键字缩小检索范围' },
                includeThirdParty: { type: 'boolean', description: '是否包含第三方 JS，默认 false' },
                skipMin: { type: 'boolean', description: '跳过 .min.js，默认 false' },
                maxFiles: { type: 'number', description: '最多抓取分析的 JS 文件数，默认 200' },
                maxHits: { type: 'number', description: '最多返回命中数，默认 60' },
                maxPerLine: { type: 'number', description: '单行最多返回命中数，默认 20。压缩/混淆文件往往整个文件只有一行，需要行内多命中才能枚举关键字' },
                includeFailed: { type: 'boolean', description: '是否也检索状态码 >= 400 的 URL，默认 false' },
                contextLines: { type: 'number', description: '命中行上下各附带几行上下文，默认 0' },
                snippetLength: { type: 'number', description: '片段最大字符数，默认 300' }
            },
            required: ['pattern'],
            additionalProperties: false
        }
    },
    {
        name: 'beautify_js',
        description: '美化（格式化）压缩 JS 代码，便于阅读与定位逻辑。可传 url 抓取后美化，或直接传 code；支持 startLine 分段返回',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'JS 文件 URL（与 code 二选一）' },
                code: { type: 'string', description: '要美化的 JS 源码' },
                tabId: TAB_ID_PROP,
                indent: { type: 'number', description: '缩进空格数，默认 4' },
                startLine: { type: 'number', description: '从第几行开始返回，默认 1' },
                maxLen: { type: 'number', description: '返回内容最大字符数，默认 200000' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'download_js',
        description: '一键下载目标站点全部 JS 到本机。format=files 逐个文件下载（保留目录结构，可选「每次询问保存位置」）；format=zip 打包成单个 ZIP（内含 _manifest.json 与 _list.txt，便于交付/喂给分析）；format=list 只导出 URL 清单。默认会自动创建「以目标网站 URL 命名的文件夹」（如 dns2.example.edu.cn/），再由 dir 模板控制外层目录，例如 "HAPPYJS/{url}/{date}"。注意：浏览器下载接口只接受相对「默认下载目录」的路径，绝对路径（如 D:////js）会被降级到默认下载目录下——要写入任意本机目录需在扩展弹窗使用「直写本地目录」模式',
        inputSchema: {
            type: 'object',
            properties: {
                tabId: TAB_ID_PROP,
                format: { type: 'string', enum: ['files', 'zip', 'list', 'zip+list'], description: '下载形式，默认 files' },
                scope: { type: 'string', enum: ['all', 'sameOrigin', 'thirdParty'], description: '下载范围，默认 all（是否含第三方由 includeThirdParty 决定）' },
                urls: { type: 'array', items: { type: 'string' }, description: '显式指定要下载的 JS URL 列表（默认整个站点）' },
                dir: { type: 'string', description: '保存目录模板，支持占位符 {url}（目标网站URL，文件夹名）{urlfull} {host} {date} {time} {page} {tab}，默认 {url}（即直接在默认下载目录下以站点URL建文件夹）' },
                siteFolder: { type: 'boolean', description: '目录模板未含 {url}/{host} 时是否自动追加「以目标网站URL命名的文件夹」，默认 true' },
                predict: { type: 'boolean', description: '下载前先做预测补齐，把懒加载 chunk / 构建清单产物一并纳入下载范围，默认 false' },
                includeFailed: { type: 'boolean', description: '是否也下载状态码 >= 400 的 URL，默认 false（浏览器下载接口对 404 也会落盘，会把错误页存成 .js）' },
                scope: { type: 'string', enum: ['sameOrigin', 'site', 'all', 'thirdParty'], description: '范围：sameOrigin 同源 / site 同主体（含子域与同主体其它 TLD，排除公共 CDN 与统计域名）/ all 全部 / thirdParty 仅第三方' },
                flatten: { type: 'boolean', description: '是否扁平化目录（用 __ 连接路径），默认 false 保留目录结构' },
                saveAs: { type: 'boolean', description: '是否每次弹出「另存为」由用户选择位置，默认 false' },
                includeThirdParty: { type: 'boolean', description: '是否包含第三方 JS，默认 false' },
                skipMin: { type: 'boolean', description: '跳过 .min.js，默认 false' },
                maxCount: { type: 'number', description: '单次最多下载文件数，默认 500' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'execute_js',
        description: '在页面上下文执行任意 JavaScript 并返回结果。默认在页面主世界(MAIN)执行，可直接访问页面 JS 变量/函数，用于逆向加密逻辑。注意：world=ISOLATED 无法执行字符串代码（MV3 隔离世界的 CSP 不含 unsafe-eval，架构上不可能），请求 ISOLATED 会明确报错而不会静默换世界；确实需要降级时传 allowMainFallback=true。MAIN 被页面 CSP 拦截时会自动走 CDP 兜底（需在设置页开启「CDP 深度执行」）。支持 frameId 指定 iframe',
        inputSchema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: '要执行的 JS 代码，最后一个表达式的值（或 Promise）将作为结果返回' },
                tabId: TAB_ID_PROP,
                frameId: FRAME_ID_PROP,
                allFrames: { type: 'boolean', description: '在所有 frame 中执行，默认 false' },
                world: { type: 'string', enum: ['MAIN', 'ISOLATED'], description: '执行世界，默认 MAIN（页面主世界，可访问页面变量）。world=ISOLATED 执行字符串代码必然失败（MV3 CSP 限制），会直接返回错误' },
                allowMainFallback: { type: 'boolean', description: '仅在 world=ISOLATED 时有意义：为 true 时允许在被 CSP 拦截后自动降级到 MAIN 世界执行（会触碰页面全局变量，返回里 fellBack=true 标记）。默认 false —— 不静默改变执行语义' }
            },
            required: ['code'],
            additionalProperties: false
        }
    },
    {
        name: 'get_page_html',
        description: '获取页面完整 HTML 源码（可指定 frameId），用于分析 DOM 结构、内嵌数据、注释信息泄露等',
        inputSchema: {
            type: 'object',
            properties: { tabId: TAB_ID_PROP, frameId: FRAME_ID_PROP, maxLen: { type: 'number', description: '返回内容最大字符数，默认 200000' } },
            additionalProperties: false
        }
    },
    {
        name: 'query_dom',
        description: '用 CSS 选择器查询页面元素（返回数量、指定属性、文本、outerHTML 片段），比拉取整页 HTML 更省上下文。不传 selector 时返回页面结构概览（表单/输入框/脚本/链接数量）',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS 选择器，如 "a[href]"、"form"、"#app .menu li"' },
                tabId: TAB_ID_PROP,
                frameId: FRAME_ID_PROP,
                limit: { type: 'number', description: '最多返回元素数，默认 50' },
                attributes: { type: 'array', items: { type: 'string' }, description: '需要提取的属性名列表，如 ["href","src","value","name"]' },
                includeText: { type: 'boolean', description: '是否返回元素文本，默认 true' },
                htmlLength: { type: 'number', description: '每个元素附带多少字符的 outerHTML，默认 0 不附带' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'screenshot',
        description: '对目标标签页（须处于前台可见）截图并存到下载目录，用于留存证据/报告配图',
        inputSchema: {
            type: 'object',
            properties: {
                tabId: TAB_ID_PROP,
                format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式，默认 png' },
                dir: { type: 'string', description: '保存目录模板，默认 HAPPYJS/{host}/{date}/screenshots' },
                saveToDisk: { type: 'boolean', description: '是否保存到磁盘，默认 true' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'get_storage',
        description: '读取页面 localStorage / sessionStorage / Cookie 概况（逆向常用来找 token、用户信息、加密盐值）',
        inputSchema: {
            type: 'object',
            properties: {
                tabId: TAB_ID_PROP,
                frameId: FRAME_ID_PROP,
                keyFilter: { type: 'string', description: '仅返回键名包含该字符串的项' },
                maxValueLength: { type: 'number', description: '单个值最大字符数，默认 2000' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'get_network_requests',
        description: '获取目标标签页的网络请求记录（URL/方法/类型/状态码/大小/MIME/是否第三方/时间），用于梳理接口、找隐藏接口与第三方数据外发',
        inputSchema: {
            type: 'object',
            properties: {
                tabId: TAB_ID_PROP,
                keyword: { type: 'string', description: '按 URL 关键字过滤' },
                type: { type: 'string', description: '按资源类型过滤（逗号分隔），如 "xmlhttprequest,script,fetch"' },
                onlyThirdParty: { type: 'boolean', description: '只看第三方请求' },
                minStatus: { type: 'number', description: '只返回状态码 >= 该值的请求' },
                limit: { type: 'number', description: '最多返回条数，默认 200' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'get_console_logs',
        description: '获取页面控制台日志与未捕获异常（需在扩展设置中开启调试捕获，默认随 MCP 服务开启），用于定位报错、观察加解密过程输出',
        inputSchema: {
            type: 'object',
            properties: {
                tabId: TAB_ID_PROP,
                level: { type: 'string', description: '按级别过滤（逗号分隔）：log,info,warn,error,debug,trace' },
                keyword: { type: 'string', description: '按内容/来源 URL 关键字过滤' },
                since: { type: 'number', description: '只返回该时间戳（毫秒）之后的日志' },
                limit: { type: 'number', description: '最多返回条数，默认 200' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'get_cookies',
        description: '获取站点全部 Cookie（会话凭证信息搜集）。省略 url 时取目标标签页 URL',
        inputSchema: {
            type: 'object',
            properties: { tabId: TAB_ID_PROP, url: { type: 'string', description: '站点 URL' } },
            additionalProperties: false
        }
    },
    {
        name: 'list_hooks',
        description: '列出全部 JS Hook 脚本（反调试 + API Hook + Canvas 干扰 + 响应体捕获）及其在目标站点的启用状态',
        inputSchema: {
            type: 'object',
            properties: { hostname: { type: 'string', description: '站点域名，省略则取当前活动标签页域名' } },
            additionalProperties: false
        }
    },
    {
        name: 'enable_hook',
        description: '启用指定 Hook 脚本（如 bypass_debugger 绕过无限 Debugger、hook_cookie 捕获 Cookie 写入、hook_fetch 捕获请求参数、hook_crypto 打印加解密密钥明文、hook_xhr_open 等）。页面刷新后生效，可设 reload=true 自动刷新',
        inputSchema: {
            type: 'object',
            properties: {
                hookId: { type: 'string', description: 'Hook 脚本 id（用 list_hooks 查看）' },
                hostname: { type: 'string', description: '目标站点域名，省略则取当前活动标签页域名' },
                tabId: TAB_ID_PROP,
                reload: { type: 'boolean', description: '启用后自动刷新标签页使 Hook 生效，默认 false' }
            },
            required: ['hookId'],
            additionalProperties: false
        }
    },
    {
        name: 'disable_hook',
        description: '停用指定 Hook 脚本，页面刷新后生效',
        inputSchema: {
            type: 'object',
            properties: {
                hookId: { type: 'string', description: 'Hook 脚本 id' },
                hostname: { type: 'string', description: '目标站点域名，省略则取当前活动标签页域名' },
                tabId: TAB_ID_PROP,
                reload: { type: 'boolean', description: '停用后自动刷新标签页，默认 false' }
            },
            required: ['hookId'],
            additionalProperties: false
        }
    },
    {
        name: 'navigate_tab',
        description: '让标签页导航到指定 URL（配合路由提取结果验证页面、访问发现的接口）',
        inputSchema: {
            type: 'object',
            properties: { url: { type: 'string', description: '目标 URL（http/https）' }, tabId: TAB_ID_PROP },
            required: ['url'],
            additionalProperties: false
        }
    },
    {
        name: 'reload_tab',
        description: '刷新标签页（使新配置/Hook 生效，或重新触发扫描与资源观测）',
        inputSchema: { type: 'object', properties: { tabId: TAB_ID_PROP }, additionalProperties: false }
    },
    /* ---------------- v1.5.0 借鉴：SourceMap / 认证扫描 / 信息泄露 ---------------- */
    {
        name: 'list_sourcemaps',
        description: '列出目标站点扫描结果中识别到的全部 SourceMap（含 data: 内联 map）。拿到 .map 后可调用 resolve_sourcemap 还原原始源码，用于反混淆快速定位接口与密钥',
        inputSchema: { type: 'object', properties: { tabId: TAB_ID_PROP }, additionalProperties: false }
    },
    {
        name: 'resolve_sourcemap',
        description: '下载并解析 SourceMap，返回 sources 与 sourcesContent（**原始未压缩源码**）。不传 url 时自动取当前页唯一识别到的 map；有多个候选项会返回 needChoose 让调用方指定。支持 data:application/json;base64 内联 map',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'SourceMap 的完整 URL（http(s) 或 data:）；省略则自动识别' },
                tabId: TAB_ID_PROP,
                parse: { type: 'boolean', description: 'false 时只返回原文不解析 JSON，默认 true' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'run_auth_bypass',
        description: '接口认证绕过扫描：对目标页已发现的接口尝试 14 种绕过变体（;.css / ;.js / .html / %23/ / #/ / ?a=1 等），用「不带 Cookie 的只读 GET」判断是否存在未授权访问。自动跳过登出/删除等破坏性接口、过滤静态资源噪声、识别「请先登录」类假阳性、命中风控立即停止。建议先用 dryRun=true 预览将要发出的请求',
        inputSchema: {
            type: 'object',
            properties: {
                tabId: TAB_ID_PROP,
                apis: { type: 'array', items: { type: 'string' }, description: '指定要探测的接口路径（省略则自动取当前页 absoluteApis + apis）' },
                bases: { type: 'array', items: { type: 'string' }, description: '指定 baseURL 列表（省略则用「手动配置 > JS 识别 > 当前源」）' },
                limit: { type: 'number', description: '最多探测多少个接口（每个接口 14 个变体），默认 20，上限 100' },
                dryRun: { type: 'boolean', description: 'true 时只生成变体清单不发请求，默认 false' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'get_bucket_risks',
        description: '查询云存储桶风险记录（10 厂商：阿里云 OSS / 腾讯云 COS / 华为云 OBS / Amazon S3 / 七牛 / 青云 / 又拍 / 京东云 / 金山云 / 天翼云）。默认只返回真实风险（存储桶可遍历、PUT 上传、ACL/Policy 可读可写、桶接管），不含"域名命中"；可附带 Burp 格式请求/响应原文用于取证',
        inputSchema: {
            type: 'object',
            properties: {
                vendor: { type: 'string', description: '按厂商过滤（如 aliyun / tencent / AmazonS3 / huawei）' },
                type: { type: 'string', description: '按风险类型过滤（如 存储桶可遍历 / ACL可读）' },
                includeDomainHits: { type: 'boolean', description: '是否包含"域名命中"这类弱信号记录，默认 false' },
                includeReqResp: { type: 'boolean', description: '是否附带请求/响应原文，默认 false（内容较大）' },
                limit: { type: 'number', description: '最多返回条数，默认 50，上限 500' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'get_bucket_config',
        description: '查询云存储桶监测的开关与配置：被动检测/页面扫描/安全模式/ACL与Policy检测/目录回溯、黑白名单、页面扫描性能上限。用于确认当前是否会发起写类探测（安全模式默认开启 = 只读）',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'get_dynamic_code',
        description: '读取运行时动态代码：blob: 脚本（URL.createObjectURL）、eval 求值代码、Function 构造器拼装的代码。这类代码不是网络请求，webRequest/DOM 采集完全看不到，其中常含前端加密逻辑、接口定义与密钥，是 JS 逆向的重点盲区。需先在 Hook 页启用「动态代码捕获」并刷新页面',
        inputSchema: {
            type: 'object',
            properties: {
                tabId: TAB_ID_PROP,
                kind: { type: 'string', description: '按类型过滤：blob-url / eval / function-constructor' },
                limit: { type: 'number', description: '最多返回条数，默认 30，上限 200' },
                withCode: { type: 'boolean', description: '是否返回完整代码，默认 true；false 时只回前 200 字符预览' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'predict_js_chunks',
        description: '预测补齐目标站点**未被浏览器请求过**的 JS：① 从 webpack runtime 的 chunk 映射合成懒加载 chunk 文件并逐个校验存在性；② 探测 Vite/CRA/webpack 构建清单（manifest.json）一次拿到全量产物；③ 发现 Module Federation 的跨源 remoteEntry.js；④ 提取 SPA 路由清单。用于解决「一键下载只能下到已访问页面用到的 JS」的覆盖不全问题。所有动作均为只读 GET，逐条限速',
        inputSchema: {
            type: 'object',
            properties: {
                tabId: TAB_ID_PROP,
                includeThirdParty: { type: 'boolean', description: '是否也分析第三方 JS（默认只分析站点自有，减少噪声）' },
                verify: { type: 'boolean', description: '是否逐个校验合成出的 chunk 是否真实存在，默认 true（不校验会得到大量 404 猜测）' },
                maxVerify: { type: 'number', description: '最多校验多少个候选，默认 60（每个校验 = 一次 GET）' },
                maxAnalyze: { type: 'number', description: '最多分析多少个 JS 源码，默认 24，上限 60' },
                skipMin: { type: 'boolean', description: '跳过 .min.js' },
                detailed: { type: 'boolean', description: '返回候选的完整字段（含 chunk 名/哈希/来源脚本），默认 false 只回 URL 与来源' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'get_js_coverage',
        description: 'JS 覆盖对账：把「候选 JS URL」（浏览器观测到的 + 预测补齐的）与可下载集合对比，给出总数、来源分布、站点自有部分的缺口、覆盖率百分比与缺口 URL 列表。用于判断还有多少 JS 没拿到',
        inputSchema: {
            type: 'object',
            properties: {
                tabId: TAB_ID_PROP,
                skipMin: { type: 'boolean', description: '统计时跳过 .min.js' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'get_info_leakage',
        description: '读取「信息泄露」高精度匹配结果（多关键字 AND 规则，171 条 = 内置 65 + BurpAPIFinder 106）。一条规则需多个关键字同时命中才报警，误报远低于单正则。命中项含规则描述、上下文片段与来源 JS',
        inputSchema: {
            type: 'object',
            properties: {
                tabId: TAB_ID_PROP,
                keyword: { type: 'string', description: '按命中内容/来源过滤' },
                ruleSet: { type: 'string', enum: ['all', 'builtin', 'burpapi'], description: '规则来源标记（仅用于回显，实际过滤在扩展设置页）' },
                limit: { type: 'number', description: '最多返回条数，默认 100，上限 500' }
            },
            additionalProperties: false
        }
    }
];
const TOOL_NAMES = new Set(TOOLS.map(t => t.name));
const TOOL_REQUIRED = new Map(TOOLS.map(t => [t.name, (t.inputSchema && t.inputSchema.required) || []]));

CFG = parseArgs();

/* =====================================================================
 * WebSocket 帧编解码（RFC 6455 最小实现）
 * ===================================================================== */
class WsConn {
    constructor(socket, isClient) {
        this.socket = socket;
        this.isClient = isClient;   // 客户端帧必须掩码
        this.buf = Buffer.alloc(0);
        this.frags = [];            // 分片重组
        this.lastActivity = Date.now();
        this.onText = null;         // (string) => void
        this.onClose = null;        // () => void
        this.closed = false;

        socket.on('data', (chunk) => this._feed(chunk));
        const bye = () => this._dead();
        socket.on('close', bye); socket.on('error', bye); socket.on('end', bye);
    }
    _dead() {
        if (this.closed) return;
        this.closed = true;
        if (this.onClose) this.onClose();
        try { this.socket.destroy(); } catch {}
    }
    _feed(chunk) {
        this.lastActivity = Date.now();
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        try {
            for (;;) {
                if (this.buf.length < 2) return;
                const b0 = this.buf[0], b1 = this.buf[1];
                const fin = (b0 & 0x80) !== 0;
                const op = b0 & 0x0f;
                const masked = (b1 & 0x80) !== 0;
                let len = b1 & 0x7f;
                let off = 2;
                if (len === 126) {
                    if (this.buf.length < 4) return;
                    len = this.buf.readUInt16BE(2); off = 4;
                } else if (len === 127) {
                    if (this.buf.length < 10) return;
                    const big = this.buf.readBigUInt64BE(2);
                    if (big > BigInt(MAX_FRAME)) throw new Error('frame too large');
                    len = Number(big); off = 10;
                }
                const mLen = masked ? 4 : 0;
                if (this.buf.length < off + mLen + len) return;
                let payload = this.buf.subarray(off + mLen, off + mLen + len);
                if (masked) {
                    const m = this.buf.subarray(off, off + 4);
                    payload = Buffer.from(payload);
                    for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
                }
                this.buf = this.buf.subarray(off + mLen + len);
                this._frame(fin, op, payload);
            }
        } catch (e) {
            log('WS 帧解析错误:', e.message);
            this._dead();
        }
    }
    _frame(fin, op, payload) {
        if (op === 0x8) { this._send(0x8, Buffer.alloc(0)); this._dead(); return; }  // close
        if (op === 0x9) { this._send(0xA, payload); return; }                        // ping → pong
        if (op === 0xA) return;                                                      // pong
        if (op === 0x1 || op === 0x2 || op === 0x0) {
            this.frags.push(payload);
            if (!fin) return;
            const full = Buffer.concat(this.frags);
            this.frags = [];
            if (this.onText) {
                try { this.onText(full.toString('utf8')); } catch (e) { log('WS 消息处理错误:', e.message); }
            }
        }
    }
    _send(op, payload) {
        if (this.closed) return;
        const len = payload.length;
        let header;
        if (len < 126) {
            header = Buffer.from([0x80 | op, len]);
        } else if (len < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | op; header[1] = 126;
            header.writeUInt16BE(len, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | op; header[1] = 127;
            header.writeBigUInt64BE(BigInt(len), 2);
        }
        if (this.isClient) {
            const mask = crypto.randomBytes(4);
            header[1] |= 0x80;
            const masked = Buffer.from(payload);
            for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
            try { this.socket.write(Buffer.concat([header, mask, masked])); } catch { this._dead(); }
        } else {
            try { this.socket.write(Buffer.concat([header, payload])); } catch { this._dead(); }
        }
    }
    sendJson(obj) {
        if (this.closed) return;
        this._send(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
    }
    close() { this._dead(); }
}

/* =====================================================================
 * 桥 / 中继 统一管理（Link）
 *   - 先尝试监听端口成为桥；端口被占用则作为中继连接已有桥
 *   - 中继断开（桥可能已退出）后回到监听流程，实现自愈
 * ===================================================================== */
class Link {
    constructor() {
        this.mode = 'init';          // init | bridge | relay
        this.ext = null;             // 扩展连接（桥模式）
        this.relays = new Map();     // relayId -> WsConn（桥模式）
        this.nextRelayId = 1;
        this.pending = new Map();    // callId -> { resolve, kind, conn, origId, timer }
        this.server = null;
        this.relayConn = null;
        this.relayPending = new Map(); // 中继模式：origId -> { resolve, timer }
        this.relaySeq = 0;
        this.pingTimer = null;
    }

    extConnected() { return this.mode === 'bridge' && this.ext && !this.ext.closed; }

    /* ---------- 对外：调用扩展 ---------- */
    callExt(tool, args) {
        if (this.mode === 'bridge') {
            if (!this.extConnected()) {
                return Promise.reject(new Error(
                    'JsXray 扩展未连接。请确认：1) 浏览器已加载 JsXray 扩展；2) 扩展「设置 → MCP 服务」已开启；' +
                    `3) 扩展端口/令牌与本进程一致（当前端口 ${CFG.port}）。配置后重试。`));
            }
            const id = crypto.randomBytes(8).toString('hex');
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error('扩展响应超时（60s）。目标页面可能未加载完成或无权限访问。'));
                }, CALL_TIMEOUT);
                this.pending.set(id, { resolve, reject, kind: 'direct', timer });
                this.ext.sendJson({ id, type: 'call', tool, args });
            });
        }
        if (this.mode === 'relay' && this.relayConn && !this.relayConn.closed) {
            const id = `c${++this.relaySeq}`;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.relayPending.delete(id);
                    reject(new Error('桥接进程响应超时（60s）'));
                }, CALL_TIMEOUT);
                this.relayPending.set(id, { resolve, reject, timer });
                this.relayConn.sendJson({ id, type: 'call', tool, args });
            });
        }
        return Promise.reject(new Error(`桥接尚未就绪（当前模式 ${this.mode}），请稍后重试`));
    }

    /* ---------- 桥模式：监听端口 ---------- */
    async startBridge() {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`JsXray MCP bridge v${VERSION} running (extension ${this.extConnected() ? 'connected' : 'not connected'})\n`);
        });
        this.server = server;
        server.on('upgrade', (req, socket) => {
            const key = req.headers['sec-websocket-key'];
            if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
                socket.destroy(); return;
            }
            const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
            socket.setNoDelay(true);
            this._onConn(new WsConn(socket, false));
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(CFG.port, '127.0.0.1', resolve);
        });
        this.mode = 'bridge';
        log(`桥模式：已监听 ws://127.0.0.1:${CFG.port}，等待扩展连接…`);
        this._startPing();
        // 桥生命周期：服务器关闭前一直等待
        await new Promise((resolve) => server.on('close', resolve));
    }

    _onConn(ws) {
        let role = null;
        let relayId = 0;
        ws.onText = (text) => {
            let msg;
            try { msg = JSON.parse(text); } catch { return; }
            if (!role) {
                // 首条消息必须是身份登记
                if (!CFG.anyToken && msg.token !== CFG.token) {
                    log(`拒绝未授权连接（令牌不匹配）role=${msg.role || '?'}`);
                    ws.sendJson({ type: 'hello', ok: false, error: 'token mismatch' });
                    ws.close();
                    return;
                }
                if (CFG.anyToken) log(`[排障] 已接受任意令牌连接（role=${msg.role || '?'}，token=${String(msg.token || '').slice(0, 8)}…）`);
                if (msg.role === 'extension') {
                    if (this.ext && !this.ext.closed) this.ext.close();
                    this.ext = ws; role = 'extension';
                    // anyToken 模式下必须回显对端令牌，扩展侧会校验 hello.token === 本地令牌
                    ws.sendJson({ type: 'hello', ok: true, token: CFG.anyToken ? msg.token : CFG.token, version: VERSION });
                    log(`扩展已连接（v${msg.version || '?'}）`);
                } else if (msg.role === 'relay') {
                    relayId = this.nextRelayId++;
                    this.relays.set(relayId, ws); role = 'relay';
                    ws.sendJson({ type: 'hello', ok: true, token: CFG.token, version: VERSION });
                    log(`中继 #${relayId} 已接入`);
                } else {
                    ws.close();
                }
                return;
            }
            if (msg.type === 'ping') { ws.sendJson({ type: 'pong', ts: Date.now() }); return; }
            if (msg.type === 'pong') return;
            if (role === 'extension' && (msg.type === 'result' || msg.type === 'error')) {
                const p = this.pending.get(msg.id);
                if (!p) return;
                this.pending.delete(msg.id);
                clearTimeout(p.timer);
                if (p.kind === 'direct') {
                    if (msg.type === 'error') p.reject(new Error(msg.error || '扩展执行失败'));
                    else p.resolve(msg.result);
                } else if (p.kind === 'relay' && p.conn && !p.conn.closed) {
                    p.conn.sendJson({ id: p.origId, type: msg.type, result: msg.result, error: msg.error });
                }
                return;
            }
            if (role === 'relay' && msg.type === 'call') {
                if (!this.extConnected()) {
                    ws.sendJson({ id: msg.id, type: 'error', error: 'JsXray 扩展未连接到桥，请在扩展设置中开启 MCP 服务' });
                    return;
                }
                const nsId = `r${relayId}#${msg.id}`;
                const timer = setTimeout(() => {
                    const p = this.pending.get(nsId);
                    this.pending.delete(nsId);
                    if (p && p.conn && !p.conn.closed) {
                        p.conn.sendJson({ id: p.origId, type: 'error', error: '扩展响应超时（60s）' });
                    }
                }, CALL_TIMEOUT);
                this.pending.set(nsId, { kind: 'relay', conn: ws, origId: msg.id, timer });
                this.ext.sendJson({ id: nsId, type: 'call', tool: msg.tool, args: msg.args });
            }
        };
        ws.onClose = () => {
            if (role === 'extension') {
                if (this.ext === ws) this.ext = null;
                log('扩展连接已断开');
                // 拒绝该扩展上的所有挂起调用
                for (const [id, p] of this.pending) {
                    if (p.kind === 'direct') {
                        this.pending.delete(id); clearTimeout(p.timer);
                        p.reject(new Error('扩展连接已断开'));
                    }
                }
            } else if (role === 'relay') {
                this.relays.delete(relayId);
                log(`中继 #${relayId} 已断开`);
            }
        };
    }

    /* ---------- 中继模式：连接已有桥 ---------- */
    async startRelay() {
        const key = crypto.randomBytes(16).toString('base64');
        const ws = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port: CFG.port, path: '/happyjs-mcp',
                headers: {
                    'Connection': 'Upgrade', 'Upgrade': 'websocket',
                    'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13'
                },
                timeout: 5000
            });
            req.on('upgrade', (res, socket) => {
                socket.setNoDelay(true);
                resolve(new WsConn(socket, true));
            });
            req.on('response', () => reject(new Error('对端不是 WebSocket 服务')));
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('连接超时')); });
            req.end();
        });
        this.relayConn = ws;
        this.mode = 'relay';
        let greeted = false;
        ws.onText = (text) => {
            let msg;
            try { msg = JSON.parse(text); } catch { return; }
            if (!greeted) {
                greeted = true;
                if (msg.type === 'hello' && msg.ok) log(`中继模式：已接入桥 ws://127.0.0.1:${CFG.port}`);
                else log('中继模式：桥拒绝了连接（可能是令牌不匹配）');
                return;
            }
            if (msg.type === 'ping') { ws.sendJson({ type: 'pong', ts: Date.now() }); return; }
            if (msg.type === 'result' || msg.type === 'error') {
                const p = this.relayPending.get(msg.id);
                if (!p) return;
                this.relayPending.delete(msg.id);
                clearTimeout(p.timer);
                if (msg.type === 'error') p.reject(new Error(msg.error || '桥执行失败'));
                else p.resolve(msg.result);
            }
        };
        ws.onClose = () => {
            for (const [, p] of this.relayPending) { clearTimeout(p.timer); p.reject(new Error('与桥的连接已断开')); }
            this.relayPending.clear();
        };
        ws.sendJson({ role: 'relay', token: CFG.token, version: VERSION });
        // 中继生命周期：连接关闭后返回，外层重新尝试桥模式
        await new Promise((resolve) => {
            const orig = ws.onClose;
            ws.onClose = () => { orig(); resolve(); };
        });
    }

    /* ---------- 心跳保活（桥模式，对扩展与中继） ---------- */
    _startPing() {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
            const targets = [];
            if (this.ext) targets.push(this.ext);
            for (const ws of this.relays.values()) targets.push(ws);
            for (const ws of targets) {
                if (Date.now() - ws.lastActivity > DEAD_AFTER) { ws.close(); continue; }
                ws.sendJson({ type: 'ping', ts: Date.now() });
            }
        }, PING_INTERVAL);
        this.pingTimer.unref();
    }

    /* ---------- 主循环：桥 ↔ 中继 自适应 ---------- */
    async run() {
        for (;;) {
            try {
                await this.startBridge();
            } catch (e) {
                if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
                    try { await this.startRelay(); }
                    catch (e2) { log(`中继接入失败（${e2.message}），1s 后重试…`); }
                } else {
                    log(`桥监听失败（${e.message}），1s 后重试…`);
                }
            }
            this.mode = 'init';
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

const link = new Link();
link.run().catch(e => { log('主循环异常:', e); process.exit(1); });

/* =====================================================================
 * MCP stdio 协议（换行分隔的 JSON-RPC 2.0）
 * ===================================================================== */
function rpcReply(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function rpcError(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}
function toolText(text) {
    if (typeof text !== 'string') text = JSON.stringify(text, null, 2);
    if (text.length > RESULT_CAP) text = text.slice(0, RESULT_CAP) + '\n…[结果过大已截断]';
    return { content: [{ type: 'text', text }] };
}
/** 生成工具签名提示，如 download_js(tabId?, format?, ...) */
function describeTool(name) {
    const t = TOOLS.find(x => x.name === name);
    if (!t || !t.inputSchema || !t.inputSchema.properties) return name + '()';
    const req = new Set(t.inputSchema.required || []);
    const parts = Object.keys(t.inputSchema.properties).map(p => req.has(p) ? p : '[' + p + ']');
    return `${name}(${parts.join(', ')})`;
}

async function handleRpc(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || msg.jsonrpc !== '2.0' || !msg.method) return;
    if (msg.id === undefined || msg.id === null) return;   // 通知无需响应
    const { id, method, params } = msg;
    try {
        switch (method) {
            case 'initialize':
                rpcReply(id, {
                    protocolVersion: (params && params.protocolVersion) || '2024-11-05',
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'happy-js', version: VERSION }
                });
                return;
            case 'ping':
                rpcReply(id, {});
                return;
            case 'tools/list':
                rpcReply(id, { tools: TOOLS });
                return;
            case 'resources/list':
                rpcReply(id, { resources: [] });
                return;
            case 'prompts/list':
                rpcReply(id, { prompts: [] });
                return;
            case 'tools/call': {
                const name = params && params.name;
                const args = (params && params.arguments) || {};
                if (!TOOL_NAMES.has(name)) {
                    rpcReply(id, {
                        content: [{ type: 'text', text: `未知工具：${name}。可用工具：${[...TOOL_NAMES].join(', ')}` }],
                        isError: true
                    });
                    return;
                }
                // 必填参数前置校验：错误信息更直接，避免白跑一趟扩展
                const missing = (TOOL_REQUIRED.get(name) || []).filter(k => args[k] === undefined || args[k] === null || args[k] === '');
                if (missing.length) {
                    rpcReply(id, {
                        content: [{ type: 'text', text: `参数缺失：${missing.join(', ')}。工具 ${name} 用法：${describeTool(name)}` }],
                        isError: true
                    });
                    return;
                }
                try {
                    const result = await link.callExt(name, args);
                    rpcReply(id, toolText(result));
                } catch (e) {
                    rpcReply(id, { content: [{ type: 'text', text: `工具调用失败：${e.message}` }], isError: true });
                }
                return;
            }
            default:
                rpcError(id, -32601, `Method not found: ${method}`);
        }
    } catch (e) {
        rpcError(id, -32603, String(e && e.message || e));
    }
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    stdinBuf += chunk;
    let idx;
    while ((idx = stdinBuf.indexOf('\n')) >= 0) {
        const line = stdinBuf.slice(0, idx).trim();
        stdinBuf = stdinBuf.slice(idx + 1);
        if (line) handleRpc(line);
    }
});
process.stdin.on('end', () => process.exit(0));

log(`JsXray MCP 桥接服务 v${VERSION} 已启动（stdio），端口 ${CFG.port}，令牌${CFG.token ? '已配置' : '【未配置，将拒绝所有连接】'}`);
