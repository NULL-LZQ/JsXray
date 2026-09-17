/* =====================================================================
 * JsXray — MCP 客户端（扩展侧，由 background.js 通过 importScripts 加载）
 *
 * 职责：
 *   1. MCP 服务开启后，作为 WebSocket 客户端连接本机桥接进程
 *      （mcp/server.js，由 Codex / Claude / Trae 等 AI 工具拉起）
 *   2. 双向令牌鉴权，心跳保活，断线自动重连
 *   3. 接收桥接进程转发的 MCP 工具调用，调度扩展能力并回传结果：
 *      信息搜集（扫描结果/指纹/路由/Cookie/JS 抓取/页面 HTML）
 *      JS 调试（页面主世界 execute_js / Hook 脚本启停 / 标签页控制）
 *
 * 注意：本文件与 background.js 共享全局作用域，
 *       可直接使用 API / JsFetcher / FingerprintEngine / HookRegistry /
 *       HeimdallrModule / safeHostname 等全局对象，禁止重复声明同名变量。
 * ===================================================================== */

'use strict';

/* 探针标记：让 hook_dynamic_code 跳过本扩展自己发起的 eval（避免「动态代码捕获」被自己的探针填满） */
const MCP_PROBE_MARK = 'happyjs-mcp-probe';

/**
 * 构造 search_in_js 的命中片段。
 * 压缩 / 混淆文件往往**整个文件只有一行**（实测 sojson 混淆的 aes.js 就是 1 行 1750 字节），
 * 若固定「从行首截断」，同一文件里的所有命中会返回一模一样的片段 —— 等于没有上下文，
 * 逆向时无法判断每个命中各自是什么。所以当上下文超出片段长度时，以**命中位置为中心开窗**。
 */
function buildHitSnippet(lines, from, to, lineIdx, colIdx, maxLen) {
    const joined = lines.slice(from, to + 1).join('\n');
    if (joined.length <= maxLen) return joined.trim();
    let off = colIdx;                                     // 命中在 joined 中的字符偏移
    for (let k = from; k < lineIdx; k++) off += lines[k].length + 1;
    const lead = Math.min(off, Math.floor(maxLen / 3));    // 命中前留 1/3 宽度
    const start = Math.max(0, off - lead);
    const body = joined.slice(start, start + maxLen);
    return (start > 0 ? '…' : '') + body + (start + maxLen < joined.length ? '…' : '');
}

/* 注入页面执行的函数（必须完全自包含，序列化后无法访问闭包变量）
 * 第二个参数是「探针标记」：执行期间在页面挂一个全局标志，
 * 让 hooks/hook_dynamic_code.js 知道这段 eval 来自本扩展的 MCP 调用、不要收录
 * ——否则我们自己的探测代码会把「动态代码捕获」的结果填满。 */
const MCP_EXEC_FN = async (src, probeMarker) => {
    const MAX = 48000;
    const ser = (v) => {
        if (v === undefined) return 'undefined';
        try {
            const seen = new WeakSet();
            let s = JSON.stringify(v, (k, val) => {
                if (typeof val === 'function') return '[Function ' + (val.name || 'anonymous') + ']';
                if (typeof val === 'bigint') return val.toString() + 'n';
                if (typeof val === 'symbol') return val.toString();
                if (val instanceof Error) return { message: val.message, stack: val.stack };
                if (val && typeof val === 'object') {
                    if (seen.has(val)) return '[Circular]';
                    seen.add(val);
                }
                return val;
            }, 2);
            if (s === undefined) s = String(v);
            return s.length > MAX ? s.slice(0, MAX) + '\n…[结果过长已截断]' : s;
        } catch (e) {
            try { return String(v); } catch { return '[结果不可序列化]'; }
        }
    };
    const markProbe = (on) => {
        try {
            if (probeMarker) window.__happyjs_probe_active = on ? probeMarker : '';
        } catch { /* 页面可能冻结了 window，忽略 */ }
    };
    try {
        markProbe(true);
        let r = (0, eval)(src);
        markProbe(false);
        if (r && typeof r.then === 'function') {
            r = await Promise.race([
                r,
                new Promise((_, rej) => setTimeout(() => rej(new Error('结果 Promise 等待超时(10s)')), 10000))
            ]);
        }
        return { ok: true, result: ser(r) };
    } catch (e) {
        markProbe(false);
        return {
            ok: false,
            error: String((e && e.message) || e),
            stack: e && e.stack ? String(e.stack).slice(0, 1500) : ''
        };
    } finally {
        markProbe(false);
    }
};

const MCPClient = {
    CFG_KEY: 'le_mcp_cfg',
    ALARM: 'le_mcp_keepalive',
    DEFAULT_PORT: 10087,
    ALT_PORTS: [10087, 10086],   // 配置端口连不上时轮换尝试（端口占用/多实例场景自愈）
    cfg: { enabled: false, port: 10087, token: '' },
    ws: null,
    status: 'disabled',        // disabled | connecting | connected | error
    lastError: '',
    connectedPort: null,       // 实际连上的端口（可能与配置端口不同）
    retryMs: 2000,
    retryTimer: null,
    _cycle: 0,
    _inited: false,

    /* ------------------------- 生命周期 ------------------------- */
    async init() {
        if (this._inited) return;
        this._inited = true;
        try {
            const d = await API.storage.local.get([this.CFG_KEY]);
            if (d[this.CFG_KEY]) Object.assign(this.cfg, d[this.CFG_KEY]);
            // 一次性迁移：默认端口 10086 → 10087（避免与旧实例/其他服务抢占）
            if (this.cfg.port === 10086 && !this.cfg.portMigrated) {
                this.cfg.port = this.DEFAULT_PORT;
                this.cfg.portMigrated = true;
                console.log('[JsXray-MCP] 默认端口已迁移 10086 → 10087');
            }
            if (!this.cfg.port) this.cfg.port = this.DEFAULT_PORT;
            if (!this.cfg.token) this.cfg.token = this.genToken();
            await this.saveCfg();
            API.alarms.onAlarm.addListener((a) => {
                // SW 意外休眠后的兜底重连（正常情况由桥端 20s 心跳保活）
                if (a.name === this.ALARM && this.cfg.enabled && !this.isOpen()) this.connect();
            });
            if (this.cfg.enabled) this.start();
        } catch (e) { console.error('[JsXray-MCP] init:', e); }
    },

    genToken() {
        const b = new Uint8Array(16);
        crypto.getRandomValues(b);
        return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    },
    saveCfg() { return API.storage.local.set({ [this.CFG_KEY]: this.cfg }); },
    isOpen() { return this.ws && this.ws.readyState === 1; },

    /** 候选端口：配置端口优先，其后是内置备选（去重） */
    portCandidates() {
        const list = [];
        if (this.cfg.port) list.push(this.cfg.port);
        for (const p of this.ALT_PORTS) if (!list.includes(p)) list.push(p);
        return list;
    },

    start() {
        try { API.alarms.create(this.ALARM, { periodInMinutes: 0.5 }); } catch {}
        this._cycle = 0;
        this.connect();
    },
    stop() {
        try { API.alarms.clear(this.ALARM); } catch {}
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        const ws = this.ws;
        this.ws = null;
        if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close(); } catch {} }
        this.status = 'disabled';
        this.lastError = '';
        this.connectedPort = null;
        this.pushStatus();
    },

    /* ------------------------- 连接管理 ------------------------- */
    connect() {
        if (!this.cfg.enabled) return;
        const old = this.ws;
        this.ws = null;
        if (old) { try { old.onclose = null; old.onerror = null; old.close(); } catch {} }
        this.status = 'connecting';
        this.lastError = '';
        this.pushStatus();
        const cands = this.portCandidates();
        const port = cands[this._cycle % cands.length];
        let ws;
        try {
            ws = new WebSocket(`ws://127.0.0.1:${port}`);
        } catch (e) {
            this.onClosed('WebSocket 创建失败: ' + ((e && e.message) || e));
            return;
        }
        this.ws = ws;
        this._attemptPort = port;
        ws.onopen = () => {
            try {
                ws.send(JSON.stringify({
                    role: 'extension', token: this.cfg.token,
                    version: API.runtime.getManifest().version
                }));
            } catch {}
        };
        ws.onmessage = (ev) => this.onMessage(ev.data);
        ws.onclose = () => {
            if (this.ws === ws) {
                this.onClosed(`未连接桥接进程（本次尝试端口 ${port}）。请确认：① AI 工具的 MCP 配置里 --port 与扩展设置页一致；② 该 MCP 会话已启动`);
            }
        };
        ws.onerror = () => { /* 随后会触发 onclose */ };
    },

    onClosed(reason) {
        this.status = 'error';
        this.lastError = reason;
        this.connectedPort = null;
        this.pushStatus();
        if (this.retryTimer) clearTimeout(this.retryTimer);
        if (this.cfg.enabled) {
            this._cycle++;   // 下次换下一个候选端口，避免死磕一个端口
            this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
            this.retryMs = Math.min(Math.round(this.retryMs * 1.5), 15000);
        }
    },

    onMessage(text) {
        let msg;
        try { msg = JSON.parse(text); } catch { return; }
        if (msg.type === 'hello') {
            if (msg.ok && msg.token === this.cfg.token) {
                this.status = 'connected';
                this.lastError = '';
                this.retryMs = 2000;
                this.connectedPort = this._attemptPort || this.cfg.port;
                // 记住成功端口，后续重连优先使用
                const i = this.portCandidates().indexOf(this.connectedPort);
                if (i >= 0) this._cycle = i;
                console.log(`[JsXray-MCP] 已连接桥接进程（端口 ${this.connectedPort}）`);
            } else {
                this.status = 'error';
                this.lastError = '令牌校验失败：请核对桥接进程 --token 参数与扩展设置页一致（或点「重置令牌」后更新配置）';
                // 置空后再关闭，避免 onclose 覆盖上面的具体错误信息；重连交给 alarms 兜底
                const ws = this.ws;
                this.ws = null;
                if (ws) { try { ws.onclose = null; ws.close(); } catch {} }
            }
            this.pushStatus();
            return;
        }
        if (msg.type === 'ping') { this.send({ type: 'pong', ts: Date.now() }); return; }
        if (msg.type === 'call') this.handleCall(msg);
    },

    async handleCall(msg) {
        try {
            const result = await this.dispatch(msg.tool, msg.args || {});
            this.send({ id: msg.id, type: 'result', result });
        } catch (e) {
            this.send({ id: msg.id, type: 'error', error: String((e && e.message) || e) });
        }
    },

    send(obj) {
        if (!this.isOpen()) return;
        try { this.ws.send(JSON.stringify(obj)); } catch {}
    },

    pushStatus() {
        try { API.runtime.sendMessage({ type: 'MCP_STATUS', ...this.getStatus() }).catch(() => {}); } catch {}
    },
    getStatus() {
        return {
            enabled: !!this.cfg.enabled,
            port: this.cfg.port,
            connectedPort: this.connectedPort,
            candidates: this.portCandidates(),
            token: this.cfg.token,
            status: this.status,
            lastError: this.lastError
        };
    },

    /* ------------------------- 设置接口（popup 调用） ------------------------- */
    async setEnabled(on) {
        this.cfg.enabled = !!on;
        await this.saveCfg();
        if (this.cfg.enabled) { this._cycle = 0; this.start(); } else this.stop();
        return this.getStatus();
    },
    async setPort(port) {
        port = parseInt(port, 10);
        if (!(port >= 1024 && port <= 65535)) throw new Error('端口需在 1024-65535 之间');
        this.cfg.port = port;
        await this.saveCfg();
        this._cycle = 0;
        if (this.cfg.enabled) { this.retryMs = 2000; this.connect(); }
        return this.getStatus();
    },
    async regenToken() {
        this.cfg.token = this.genToken();
        await this.saveCfg();
        if (this.cfg.enabled) this.connect();
        return this.getStatus();
    },

    /* ------------------------- 工具调度 ------------------------- */
    async dispatch(tool, args) {
        switch (tool) {
            /* --- 标签页 / 页面 --- */
            case 'list_tabs': return this.toolListTabs(args);
            case 'get_frame_tree': return this.toolGetFrameTree(args);
            case 'get_page_html': return this.toolGetPageHtml(args);
            case 'query_dom': return this.toolQueryDom(args);
            case 'screenshot': return this.toolScreenshot(args);
            case 'navigate_tab': return this.toolNavigate(args);
            case 'reload_tab': return this.toolReload(args);
            /* --- v1.5.0 借鉴：SourceMap / 接口认证扫描 --- */
            case 'list_sourcemaps': return this.toolListSourceMaps(args);
            case 'resolve_sourcemap': return this.toolResolveSourceMap(args);
            case 'run_auth_bypass': return this.toolRunAuthBypass(args);
            case 'get_info_leakage': return this.toolGetInfoLeakage(args);
            /* --- JS 资源预测补齐 / 覆盖对账（借鉴 hybrid_capture_project2） --- */
            case 'predict_js_chunks': return this.toolPredictJsChunks(args);
            case 'get_dynamic_code': return this.toolGetDynamicCode(args);
            case 'get_js_coverage': return this.toolGetJsCoverage(args);
            /* --- 云存储桶（只读） --- */
            case 'get_bucket_risks': return this.toolGetBucketRisks(args);
            case 'get_bucket_config': return this.toolGetBucketConfig();
            /* --- 信息搜集 --- */
            case 'get_scan_results': return this.toolGetScanResults(args);
            case 'get_fingerprints': return this.toolGetFingerprints(args);
            case 'get_routes': return this.toolGetRoutes(args);
            case 'get_cookies': return this.toolGetCookies(args);
            case 'get_storage': return this.toolGetStorage(args);
            case 'get_network_requests': return this.toolGetNetworkRequests(args);
            case 'get_console_logs': return this.toolGetConsoleLogs(args);
            /* --- JS 分析 / 下载 --- */
            case 'get_js_list': return this.toolGetJsList(args);
            case 'fetch_js': return this.toolFetchJs(args);
            case 'search_in_js': return this.toolSearchInJs(args);
            case 'beautify_js': return this.toolBeautifyJs(args);
            case 'download_js': return this.toolDownloadJs(args);
            /* --- 逆向调试 --- */
            case 'execute_js': return this.toolExecuteJs(args);
            case 'list_hooks': return this.toolListHooks(args);
            case 'enable_hook': return this.toolSetHook(args, true);
            case 'disable_hook': return this.toolSetHook(args, false);
            default: throw new Error('未知工具: ' + tool);
        }
    },

    async activeTab() {
        const tabs = await API.tabs.query({ active: true, lastFocusedWindow: true });
        return tabs && tabs[0] ? tabs[0] : null;
    },
    async resolveTabId(tabId) {
        if (typeof tabId === 'number' && tabId >= 0) return tabId;
        const t = await this.activeTab();
        if (!t || t.id == null) throw new Error('没有可用的活动标签页');
        return t.id;
    },
    // 同时兼容 Chrome（回调）与 Firefox browser.*（Promise）风格
    sendToFrame(tabId, frameId, msg) {
        return new Promise((resolve) => {
            let done = false;
            const fin = (r) => { if (!done) { done = true; resolve(r); } };
            try {
                const p = API.tabs.sendMessage(tabId, msg, { frameId }, (r) => {
                    fin(API.runtime.lastError ? null : r);
                });
                if (p && typeof p.then === 'function') p.then(fin).catch(() => fin(null));
            } catch { fin(null); }
        });
    },

    async toolListTabs(args = {}) {
        const query = args.currentWindow ? { currentWindow: true } : {};
        const tabs = await API.tabs.query(query);
        const kw = String(args.keyword || '').toLowerCase();
        let list = (tabs || [])
            .filter(t => t.url && (args.includeChromePages ? /^(https?|file):/i.test(t.url) : /^https?:/i.test(t.url)))
            .map(t => ({
                id: t.id, active: !!t.active, pinned: !!t.pinned,
                windowId: t.windowId,
                title: String(t.title || '').slice(0, 120),
                url: t.url
            }));
        if (kw) list = list.filter(t => (t.url + ' ' + t.title).toLowerCase().includes(kw));
        return { count: list.length, activeTabId: (list.find(t => t.active) || {}).id ?? null, tabs: list };
    },

    async toolGetFrameTree(args) {
        const tabId = await this.resolveTabId(args.tabId);
        let frames = [];
        try { frames = await API.webNavigation.getAllFrames({ tabId }) || []; }
        catch (e) { throw new Error('读取 frame 树失败：' + ((e && e.message) || e)); }
        const own = ResourceIndex.tabs.get(tabId) ? true : false;
        return {
            tabId,
            count: frames.length,
            frames: frames.map(f => ({
                frameId: f.frameId,
                parentFrameId: f.parentFrameId,
                url: f.url,
                errorOccurred: !!f.errorOccurred
            })),
            note: own ? undefined : '该标签页暂无资源记录，可先 reload_tab 让扩展重新观测'
        };
    },

    async toolGetScanResults(args) {
        const tabId = await this.resolveTabId(args.tabId);
        let frameIds = [0];
        if (args.allFrames === true) {
            try {
                const frames = await API.webNavigation.getAllFrames({ tabId });
                if (Array.isArray(frames) && frames.length) frameIds = frames.map(f => f.frameId);
            } catch {}
        }
        const frames = {};
        await Promise.all(frameIds.map(fid =>
            this.sendToFrame(tabId, fid, { type: 'MCP_COLLECT_RESULTS', to: 'content' }).then(r => {
                if (r && r.results) {
                    frames[fid] = { frameUrl: r.frameUrl, isInIframe: !!r.isInIframe, results: r.results };
                }
            })
        ));
        if (!Object.keys(frames).length) {
            throw new Error('未获取到扫描结果：目标页可能是受限页面（chrome:// 等）或尚未加载完成，可先 reload_tab 后重试');
        }
        // 分类过滤：只返回关注的类别，避免超大输出挤爆上下文
        let categories = (args.categories || '').split(',').map(s => s.trim()).filter(Boolean);
        if (args.preset && !categories.length) {
            const PRESETS = {
                api: ['absoluteApis', 'apis', 'routes', 'urls'],
                secret: ['idKeys', 'privateKeys', 'credentials', 'cookies', 'jwts', 'dbConns', 'mqConns', 'ossEndpoints'],
                pii: ['phones', 'emails', 'idcards', 'companies'],
                assets: ['jsFiles', 'vueFiles', 'imageFiles', 'docFiles', 'moduleFiles', 'thirdPartyLibs'],
                infra: ['domains', 'ips', 'urls', 'sourceMaps', 'windowsPaths', 'linuxPaths', 'ossEndpoints'],
                leak: ['infoLeakage', 'baseUrls', 'unauthApis'],
                all: null
            };
            categories = PRESETS[args.preset] || [];
        }
        // 有效分类键 = frame 结果里出现过的键（空数组也保留，便于区分「查了但没有」与「键名写错」）
        const validKeys = new Set();
        for (const fr of Object.values(frames)) {
            for (const k of Object.keys(fr.results || {})) if (k !== 'progress') validKeys.add(k);
        }
        const unknownCategories = categories.filter(c => !validKeys.has(c));

        const maxPerCat = Math.min(Math.max(1, args.maxPerCategory || 500), 5000);
        const out = {};
        for (const [fid, fr] of Object.entries(frames)) {
            const res = {};
            for (const [k, v] of Object.entries(fr.results || {})) {
                if (k === 'progress') continue;
                if (categories.length && !categories.includes(k)) continue;
                if (Array.isArray(v)) {
                    res[k] = v.slice(0, maxPerCat).map(x => Array.isArray(x) ? x[0] : x);
                    // _truncated 是布尔（是否被截断），被隐藏的条数放在 _hiddenCount。
                    // 旧版把「隐藏条数」写进 _truncated，调用方容易把数字误读成标志位。
                    if (v.length > maxPerCat) {
                        res[k + '_truncated'] = true;
                        res[k + '_hiddenCount'] = v.length - maxPerCat;
                    }
                } else if (args.includeMeta !== false) res[k] = v;
            }
            frames[fid] = { frameUrl: fr.frameUrl, isInIframe: fr.isInIframe, results: res };
        }
        const scanResult = {
            tabId,
            frameCount: Object.keys(frames).length,
            preset: args.preset || null,
            categories: categories.length ? categories : 'all',
            frames
        };
        if (unknownCategories.length) {
            scanResult.unknownCategories = unknownCategories;
            scanResult.validCategories = Array.from(validKeys).sort();
            scanResult.note = '以下分类键不存在，已被忽略：' + unknownCategories.join(', ') +
                '；有效分类键见 validCategories（省略 categories 可返回全部分类）';
        }
        return scanResult;
    },

    async toolGetFingerprints(args) {
        const tabId = await this.resolveTabId(args.tabId);
        return {
            tabId,
            httpFingerprints: FingerprintEngine.serialize(tabId),
            guardRuleHits: HeimdallrModule.getResults(tabId)
        };
    },

    async toolGetRoutes(args) {
        let hn = args.hostname || '';
        // 与其它工具保持一致：优先用 tabId 定位（以前只认 hostname，按惯例传 tabId 会直接 schema 报错）
        if (!hn && args.tabId != null) {
            const t = await API.tabs.get(args.tabId).catch(() => null);
            hn = t && t.url ? safeHostname(t.url) : '';
        }
        if (!hn) {
            const t = await this.activeTab();
            hn = t && t.url ? safeHostname(t.url) : '';
        }
        if (!hn) throw new Error('无法确定目标域名，请提供 hostname 或 tabId 参数');
        const d = await API.storage.local.get([`${hn}_vue_router_data`, `${hn}_react_router_data`]);
        const vue = d[`${hn}_vue_router_data`] ? d[`${hn}_vue_router_data`].data : null;
        const react = d[`${hn}_react_router_data`] ? d[`${hn}_react_router_data`].data : null;
        const out = { hostname: hn, vue, react };
        if (!vue && !react) out.note = '该站点暂未提取到路由（可能未在浏览器中访问，或非 Vue/React 站点）';
        return out;
    },

    async toolFetchJs(args) {
        if (!args.url || !/^https?:\/\//i.test(args.url)) throw new Error('请提供 http(s) 协议的 url 参数');
        const tabId = typeof args.tabId === 'number' ? args.tabId : null;
        const r = await JsFetcher.handle({ url: args.url, tabId, frameId: String(args.frameId ?? '0') });
        if (r.content == null) return { url: args.url, ok: false, error: '抓取失败（网络不可达或请求被拦截）' };
        let c = String(r.content);
        if (tabId != null) JsTextCache.put(tabId, args.url, c);
        const info = JsBeautifier.analyze(c);
        if (args.beautify === true && info.minified) {
            const pretty = JsBeautifier.beautify(c, args.indent || 4);
            c = pretty;
        }
        const maxLen = args.maxLen > 0 ? Math.min(args.maxLen, 1500000) : 200000;
        // 支持 startLine 分段读取，便于大文件逐段分析
        let startLine = Math.max(1, args.startLine || 1) | 0;
        if (startLine > 1) {
            const lines = c.split('\n');
            c = lines.slice(startLine - 1).join('\n');
        }
        return {
            url: args.url, ok: true,
            length: c.length, sourceBytes: info.bytes, lines: info.lines,
            minified: info.minified, beautified: args.beautify === true && info.minified,
            startLine,
            truncated: c.length > maxLen,
            content: c.slice(0, maxLen)
        };
    },

    /* 用 chrome.scripting 注入执行（不经过页面 CSP 检查，但函数体内的 eval 仍受世界 CSP 约束） */
    async _execInScripting(tabId, frameId, world, code) {
        try {
            const [r] = await API.scripting.executeScript({
                target: { tabId, frameIds: [frameId] },
                world,
                args: [code, MCP_PROBE_MARK],
                func: MCP_EXEC_FN
            });
            return (r && r.result) || { ok: false, error: '页面未返回结果' };
        } catch (e) {
            return { ok: false, error: '脚本注入失败：' + ((e && e.message) || e) };
        }
    },
    _isEvalBlocked(res) {
        return !!(res && res.ok === false &&
            /EvalError|Content Security Policy|unsafe-eval|Trusted Type|trusted-types/i.test(String(res.error || '')));
    },

    async toolExecuteJs(args) {
        if (!args.code || typeof args.code !== 'string') throw new Error('缺少 code 参数（要执行的 JS 代码）');
        const tabId = await this.resolveTabId(args.tabId);
        const requestedWorld = args.world === 'ISOLATED' ? 'ISOLATED' : 'MAIN';
        const allowMainFallback = args.allowMainFallback === true;
        const frameIds = args.allFrames === true
            ? ((await API.webNavigation.getAllFrames({ tabId }).catch(() => [])) || []).map(f => f.frameId)
            : [args.frameId != null ? args.frameId : 0];
        const results = [];

        for (const fid of frameIds.slice(0, 20)) {
            let res = await this._execInScripting(tabId, fid, requestedWorld, args.code);

            if (this._isEvalBlocked(res)) {
                /* MV3 隔离世界的 CSP = 扩展自身 CSP（不含 unsafe-eval），
                 * 所以「ISOLATED + 任意字符串代码」在架构上**不可能成功** —— 换到 MAIN 虽然能跑，
                 * 但语义完全不同：MAIN 能读写页面全局变量，也可能被站点反调试/防篡改检测到。
                 * 因此这里**不静默降级**：默认直接报错，只有显式传 allowMainFallback 才换世界。 */
                if (requestedWorld === 'ISOLATED') {
                    if (allowMainFallback) {
                        const res2 = await this._execInScripting(tabId, fid, 'MAIN', args.code);
                        if (res2 && res2.ok) {
                            res2.frameId = fid;
                            res2.requestedWorld = 'ISOLATED';
                            res2.actualWorld = 'MAIN';
                            res2.world = 'MAIN';
                            res2.fellBack = true;
                            res2.note = '已按 allowMainFallback 降级到 MAIN 世界执行：该代码能读写页面全局变量，' +
                                '也可能被站点的反调试/防篡改逻辑检测到。下次可直接传 world:"MAIN" 以免混淆。';
                            results.push(res2);
                            continue;
                        }
                    }
                    res.frameId = fid;
                    res.requestedWorld = 'ISOLATED';
                    res.actualWorld = null;
                    res.world = null;
                    res.ok = false;
                    res.error = res.error || 'ISOLATED 世界无法执行字符串代码';
                    res.note = 'MV3 隔离世界的 CSP 就是扩展自身的 CSP（不含 unsafe-eval），所以 ' +
                        'world:"ISOLATED" 执行任意字符串代码在架构上不可能成功，本次未执行、也未擅自换世界。' +
                        '三种可选做法：① 改用 world:"MAIN"（可直接访问页面变量，但会触碰页面全局）；' +
                        '② 确实需要自动降级时显式传 allowMainFallback:true；' +
                        '③ 在设置页开启「CDP 深度执行」后用调试协议执行（可绕过 CSP / Trusted Types）。';
                    results.push(res);
                    continue;
                }
                // 请求的就是 MAIN 且被拦：ISOLATED 同样不可能成功，直接走下面的 CDP 兜底
            }

            // 两个世界都被拦 → 有 debugger 权限时用 CDP 兜底（可绕过 CSP / Trusted Types）
            let cdpTried = false;
            if (this._isEvalBlocked(res) && typeof CDPExecutor !== 'undefined') {
                cdpTried = true;
                const cdp = await CDPExecutor.evaluateSafe(tabId, fid, args.code, args.awaitPromise !== false);
                if (cdp && cdp.ok) {
                    cdp.frameId = fid;
                    cdp.world = 'CDP';
                    cdp.requestedWorld = requestedWorld;
                    cdp.actualWorld = 'CDP';
                    cdp.fellBack = requestedWorld !== 'CDP';
                    cdp.note = `scripting(${requestedWorld}) 被 CSP 拦截，已改用 CDP Runtime.evaluate 执行（不经过页面 CSP）`;
                    results.push(cdp);
                    continue;
                }
                res.cdpError = (cdp && cdp.error) || 'CDP 执行失败';
            }

            res.frameId = fid;
            res.world = requestedWorld;
            res.requestedWorld = requestedWorld;
            res.actualWorld = (res.ok ? requestedWorld : null);
            res.fellBack = false;
            if (this._isEvalBlocked(res)) {
                res.note = '页面 CSP 禁止 eval，MAIN 世界执行被拦截（ISOLATED 世界同样无法 eval，不必再试）。' +
                    (cdpTried
                        ? 'CDP 兜底同样失败：请确认已在设置页开启「CDP 深度执行」并授予 debugger 权限，且该标签页没有打开 DevTools（DevTools 会占用调试连接）。'
                        : '可在扩展设置页开启「CDP 深度执行」（授予 debugger 权限）后重试，该模式通过调试协议执行，可绕过 CSP 与 Trusted Types 限制。');
            }
            results.push(res);
        }
        if (results.length === 1) return results[0];
        return { frames: results.length, results };
    },

    async toolGetPageHtml(args) {
        const tabId = await this.resolveTabId(args.tabId);
        const maxLen = args.maxLen > 0 ? Math.min(args.maxLen, 1500000) : 200000;
        let r;
        try {
            [r] = await API.scripting.executeScript({
                target: { tabId, frameIds: [args.frameId != null ? args.frameId : 0] },
                args: [maxLen],
                func: (ml) => {
                    const html = document.documentElement ? document.documentElement.outerHTML : '';
                    return {
                        title: document.title, url: location.href,
                        length: html.length, truncated: html.length > ml,
                        html: html.slice(0, ml)
                    };
                }
            });
        } catch (e) {
            throw new Error('无法读取页面 HTML：' + ((e && e.message) || e));
        }
        return (r && r.result) || { html: '' };
    },

    async toolGetCookies(args) {
        let url = args.url || '';
        if (!url) {
            const tabId = await this.resolveTabId(args.tabId);
            const t = await API.tabs.get(tabId).catch(() => null);
            url = (t && t.url) || '';
        }
        if (!url || !/^https?:\/\//i.test(url)) throw new Error('无法确定站点 URL，请提供 url 或有效 tabId');
        const cookies = await API.cookies.getAll({ url });
        return {
            url, count: cookies.length,
            cookies: cookies.map(c => ({
                name: c.name,
                value: c.value && c.value.length > 500 ? c.value.slice(0, 500) + '…' : c.value,
                domain: c.domain, path: c.path,
                httpOnly: !!c.httpOnly, secure: !!c.secure,
                sameSite: c.sameSite || '',
                expires: c.session ? 'session' : (c.expirationDate || '')
            }))
        };
    },

    async _loadHookMeta() {
        return fetch(API.runtime.getURL('hooks.json')).then(r => r.json()).catch(() => []);
    },
    async _hookScope(args) {
        let hn = args.hostname || '';
        if (!hn) {
            const t = await this.activeTab();
            hn = t && t.url ? safeHostname(t.url) : '';
        }
        const d = await API.storage.local.get([HookRegistry.MODE_KEY, HookRegistry.GLOBAL_KEY, hn].filter(Boolean));
        const mode = d[HookRegistry.MODE_KEY] === 'global' ? 'global' : 'standard';
        return { hn, mode, d };
    },

    async toolListHooks(args) {
        const all = await this._loadHookMeta();
        await HookRegistry.loadMeta();
        const { hn, mode, d } = await this._hookScope(args);
        const enabled = mode === 'global' ? (d[HookRegistry.GLOBAL_KEY] || []) : (d[hn] || []);
        const health = HookRegistry.health();
        return {
            mode, hostname: hn || '(未知)',
            total: all.length,
            hooks: all.filter(h => !h.hidden).map(h => ({
                id: h.id, name: h.name, category: h.category,
                enabled: enabled.includes(h.id),
                file: HookRegistry.resolved.get(h.id) || null,
                description: h.description
            })),
            unavailable: health.missing,
            unavailableNote: health.missing.length
                ? `以下 Hook 脚本文件缺失，启用也不会生效：${health.missing.join(', ')}`
                : undefined
        };
    },

    async toolSetHook(args, enable) {
        if (!args.hookId) throw new Error('缺少 hookId 参数');
        const all = await this._loadHookMeta();
        const meta = all.find(h => h.id === args.hookId);
        if (!meta) throw new Error(`未知 hookId：${args.hookId}。可用 id：${all.map(h => h.id).join(', ')}`);
        const { hn, mode, d } = await this._hookScope(args);
        const key = mode === 'global' ? HookRegistry.GLOBAL_KEY : hn;
        if (mode === 'standard' && (!hn || !hn.includes('.'))) {
            throw new Error('标准模式下需要有效的目标域名（提供 hostname 参数，或先把目标站点设为活动标签页）');
        }
        const set = new Set(Array.isArray(d[key]) ? d[key] : []);
        if (enable) set.add(args.hookId); else set.delete(args.hookId);
        await API.storage.local.set({ [key]: [...set] });
        // background 的 storage.onChanged 监听会自动调用 HookRegistry.sync 完成主世界脚本注册/注销
        let reloaded = false;
        if (args.reload === true) {
            try { await API.tabs.reload(await this.resolveTabId(args.tabId)); reloaded = true; } catch {}
        }
        return {
            ok: true, hookId: args.hookId, name: meta.name, enabled: enable, mode, scope: key, reloaded,
            note: reloaded ? '已刷新标签页，Hook 配置即刻生效' : 'Hook 将在目标页面下次刷新后生效（可传 reload=true 或用 reload_tab 立即生效）'
        };
    },

    async toolNavigate(args) {
        if (!args.url || !/^https?:\/\//i.test(args.url)) throw new Error('请提供 http(s) 协议的 url 参数');
        const tabId = await this.resolveTabId(args.tabId);
        await API.tabs.update(tabId, { url: args.url });
        return { ok: true, tabId, url: args.url, note: '已触发导航，页面加载完成后扫描结果会自动更新' };
    },

    async toolReload(args) {
        const tabId = await this.resolveTabId(args.tabId);
        await API.tabs.reload(tabId);
        return { ok: true, tabId, note: '已触发刷新，扫描与 Hook 将重新执行' };
    },

    /* ================= v1.5.0 借鉴：SourceMap 识别与还原（反混淆） ================= */
    async toolListSourceMaps(args) {
        const tabId = await this.resolveTabId(args.tabId);
        const frameIds = await this._frameIds(tabId);
        const all = [];
        await Promise.all(frameIds.map(fid =>
            this.sendToFrame(tabId, fid, { type: 'MCP_COLLECT_RESULTS', to: 'content' }).then(r => {
                if (!r || !r.results) return;
                const list = r.results.sourceMaps || [];
                list.forEach(it => all.push({ url: it[0], fromJs: it[1], frameId: fid, frameUrl: r.frameUrl }));
            })
        ));
        const seen = new Set();
        const dedup = all.filter(x => { const k = String(x.url).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
        return {
            tabId, count: dedup.length, sourcemaps: dedup,
            note: dedup.length ? '用 resolve_sourcemap 传 url 还原原始源码（支持 data: 内联 map）'
                : '未识别到 SourceMap：目标站可能未发布 .map，或页面尚未扫描完成'
        };
    },

    async toolResolveSourceMap(args) {
        let url = String((args && args.url) || '');
        const tabId = await this.resolveTabId(args.tabId);
        if (!url) {
            const list = await this.toolListSourceMaps({ tabId });
            if (!list.count) throw new Error('未识别到任何 SourceMap，请先让页面扫描完成，或手动传 url');
            if (list.count > 1) {
                return {
                    needChoose: true,
                    candidates: list.sourcemaps.slice(0, 30).map(x => ({ url: x.url, fromJs: x.fromJs })),
                    note: `识别到 ${list.count} 个 SourceMap，请用 url 参数指定其中一个`
                };
            }
            url = list.sourcemaps[0].url;
        }
        // 相对路径 → 绝对
        if (!/^(https?:|data:)/i.test(url)) {
            try { url = new URL(url, await this._pageUrl(tabId)).href; } catch {}
        }
        let text = null;
        const inline = url.match(/^data:application\/json(?:;charset=[^;,]+)?;base64,(.+)$/i);
        if (inline) {
            try {
                const bin = atob(inline[1]);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                text = new TextDecoder('utf-8').decode(bytes);
            } catch { throw new Error('内联 SourceMap base64 解码失败'); }
        } else {
            const r = await JsFetcher.handle({ url, tabId, frameId: '0' });
            text = r && r.content;
            if (text == null) throw new Error('下载 SourceMap 失败（跨域/CSP/404）；可在浏览器里直接打开该 URL 验证');
        }
        if (args && args.parse === false) {
            return { url, length: text.length, parse: false, content: text.slice(0, 200000) };
        }
        let map;
        try { map = JSON.parse(text); } catch (e) { throw new Error('SourceMap 不是合法 JSON：' + e.message); }
        const MAX_FILE = 50 * 1024, MAX_TOTAL = 900 * 1024;
        const sources = Array.isArray(map.sources) ? map.sources.slice(0, 500) : [];
        const contentArr = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
        const sourcesContent = [];
        let total = 0;
        for (let i = 0; i < sources.length; i++) {
            const c = contentArr[i];
            if (!c) continue;
            let body = c, truncated = false;
            if (body.length > MAX_FILE) { body = body.slice(0, MAX_FILE) + '\n/* ...truncated, size=' + c.length + ' */'; truncated = true; }
            if (total + body.length > MAX_TOTAL) { sourcesContent.push({ source: sources[i], truncated: true, content: '', note: '达到输出上限，后续文件省略' }); break; }
            total += body.length;
            sourcesContent.push({ source: sources[i], size: c.length, truncated, content: body });
        }
        return {
            url, parse: true, file: map.file || null, version: map.version || null,
            sources, sourcesContent, sourcesCount: sources.length,
            sourcesContentCount: sourcesContent.length,
            hasInlineContent: contentArr.filter(Boolean).length,
            names: Array.isArray(map.names) ? map.names.length : 0,
            tip: 'sourcesContent 即原始源码，可直接用于反混淆/找接口'
        };
    },

    /* ================= v1.5.0 借鉴：接口认证绕过扫描（只读 GET） ================= */
    async toolRunAuthBypass(args) {
        const tabId = await this.resolveTabId(args.tabId);
        await AuthBypass.load();
        let apis = Array.isArray(args.apis) ? args.apis.filter(Boolean) : [];
        let bases = Array.isArray(args.bases) ? args.bases.map(u => ({ url: u, rule: 'caller' })) : [];
        if (!apis.length) {
            const cand = await this.sendToFrame(tabId, args.frameId != null ? args.frameId : 0,
                { type: 'GET_AUTH_BYPASS_CANDIDATES', limit: args.limit || 60, to: 'content' });
            if (!cand || !cand.ok) {
                throw new Error('获取候选接口失败：' + ((cand && cand.error) || '页面未响应，请刷新目标页后重试'));
            }
            apis = cand.apis || [];
            if (!bases.length) bases = cand.bases || [];
        }
        if (!apis.length) return { ok: true, apiCount: 0, unauthCount: 0, note: '当前页面未发现候选接口' };
        const out = await AuthBypass.run({
            apis, bases,
            limit: args.limit,
            dryRun: args.dryRun === true
        });
        // dryRun 时给 AI 看变体清单；正式探测时只回未授权结果 + 统计
        return out.dryRun ? out : {
            ...out,
            results: (out.results || []).slice(0, 60).map(r => ({
                url: r.url, api: r.api, baseUrl: r.baseUrl, variant: r.label,
                status: r.status, contentType: r.mime, length: r.length, preview: r.preview
            })),
            hint: '仅列出「不带 Cookie 也能拿到数据」的接口；单个结果请人工复核响应内容再定级'
        };
    },

    /* ================= 信息泄露（多关键字 AND）只读查询 ================= */
    async toolGetInfoLeakage(args) {
        const tabId = await this.resolveTabId(args.tabId);
        const frameIds = await this._frameIds(tabId);
        const items = [];
        await Promise.all(frameIds.map(fid =>
            this.sendToFrame(tabId, fid, { type: 'MCP_COLLECT_RESULTS', to: 'content' }).then(r => {
                if (!r || !r.results) return;
                for (const it of (r.results.infoLeakage || [])) {
                    items.push({ hit: it[0], source: it[1], frameId: fid });
                }
            })
        ));
        const kw = String(args.keyword || '').toLowerCase();
        const filtered = kw ? items.filter(x => String(x.hit).toLowerCase().includes(kw)) : items;
        return {
            tabId, count: filtered.length,
            ruleSet: (args.ruleSet || 'all'),
            items: filtered.slice(0, Math.min(Math.max(1, args.limit || 100), 500)),
            note: filtered.length ? '这些是「多关键字同时命中」的高置信结果，建议逐条人工确认'
                : '暂无命中：可在弹窗设置页确认「信息泄露」已开启（默认开），或等待页面扫描完成'
        };
    },

    async _frameIds(tabId) {
        try {
            const fs = await API.webNavigation.getAllFrames({ tabId });
            if (Array.isArray(fs) && fs.length) return fs.map(f => f.frameId);
        } catch {}
        return [0];
    },

    /* ================= 云存储桶风险监测（只读，数据取自 storage.local） ================= */
    async toolGetBucketRisks(args) {
        const d = await API.storage.local.get(['bucketVulHistory']);
        let history = Array.isArray(d.bucketVulHistory) ? d.bucketVulHistory : [];
        const vendor = (args && typeof args.vendor === 'string') ? args.vendor.trim() : '';
        const type = (args && typeof args.type === 'string') ? args.type.trim() : '';
        const risksOnly = !(args && args.includeDomainHits === true);   // 默认只回风险，不回「域名命中」
        if (vendor) history = history.filter(it => it && String(it.vendor || '').indexOf(vendor) !== -1);
        if (type) history = history.filter(it => it && String(it.type || '').indexOf(type) !== -1);
        if (risksOnly) history = history.filter(it => it && it.type && it.type !== '域名命中');
        const total = history.length;
        const limit = (args && args.limit > 0) ? Math.min(Math.floor(args.limit), 500) : 50;
        const includeReqResp = !!(args && args.includeReqResp === true);
        const risks = history.slice(0, limit).map(it => {
            const o = {
                url: it.url || '', type: it.type || '', vendor: it.vendor || '',
                source: it.source || '', time: it.time || 0,
                timeText: it.time ? new Date(it.time).toLocaleString('zh-CN', { hour12: false }) : '',
                sourcePageUrl: it.sourcePageUrl || '', sourceLine: it.sourceLine
            };
            if (includeReqResp) { o.request = it.request || ''; o.response = it.response || ''; }
            return o;
        });
        const out = { count: total, returned: risks.length, risksOnly, includeReqResp, risks };
        if (!total) out.note = '暂无存储桶风险记录（被动检测需命中云存储域名，或在弹窗「存储桶」页发起主动检测）';
        else if (total > risks.length) out.note = `仅返回前 ${risks.length} 条，可用 limit 增大（最大 500）`;
        return out;
    },

    async toolGetBucketConfig() {
        const keys = ['bucketPassiveEnabled', 'scanPageForBuckets', 'safeModePassive', 'flagAcl',
            'flagPolicy', 'traverseBacktrack', 'detectBlacklist', 'detectWhitelist', 'whitelistMode',
            'scanMaxExternalJs', 'scanMaxInlineJs', 'scanMaxFileSize', 'scanMaxTotalCandidates'];
        const d = await API.storage.local.get(keys);
        return {
            switches: {
                passiveEnabled: d.bucketPassiveEnabled ?? true,
                scanPage: d.scanPageForBuckets ?? false,
                safeMode: d.safeModePassive ?? true,
                flagAcl: d.flagAcl ?? true,
                flagPolicy: d.flagPolicy ?? true,
                traverseBacktrack: d.traverseBacktrack ?? false
            },
            listMode: (d.whitelistMode ?? false) ? 'whitelist' : 'blacklist',
            blacklist: Array.isArray(d.detectBlacklist) ? d.detectBlacklist : [],
            whitelist: Array.isArray(d.detectWhitelist) ? d.detectWhitelist : [],
            scanLimits: {
                maxExternalJs: d.scanMaxExternalJs ?? 40,
                maxInlineJs: d.scanMaxInlineJs ?? 20,
                maxFileSizeKB: Math.round((d.scanMaxFileSize ?? 1024 * 1024) / 1024),
                maxTotalCandidates: d.scanMaxTotalCandidates ?? 60
            },
            note: '安全模式开启时，被动检测只做读类探测（可遍历/ACL读/Policy读），PUT/DELETE/写 ACL/写 Policy 仅在弹窗「存储桶 → 主动检测」里手动勾选才会执行'
        };
    },

    /* ================= JS 资源预测补齐 / 覆盖对账（借鉴 hybrid_capture_project2） ================= */

    /**
     * 预测补齐：把「没被访问过所以永远观测不到」的 JS 找出来。
     * ① webpack chunk 合成（runtime 的 .u 映射 + 名称/哈希表）并逐个校验存在性
     * ② Vite / CRA / webpack 构建清单（manifest.json / asset-manifest.json）一次拿全量产物
     * ③ Module Federation 跨源 remoteEntry.js
     * ④ SPA 路由提取（供逐条访问触发懒加载 chunk）
     */
    async toolPredictJsChunks(args) {
        const tabId = await this.resolveTabId(args.tabId);
        if (typeof JsPredictor === 'undefined') {
            throw new Error('JsPredictor 模块未加载：请到 chrome://extensions 重载扩展');
        }
        const r = await JsPredictor.predictJsResources(tabId, {
            includeThirdParty: !!args.includeThirdParty,
            skipMin: !!args.skipMin,
            verify: args.verify !== false,
            maxVerify: args.maxVerify,
            maxAnalyze: args.maxAnalyze
        });
        const detailed = args.detailed === true;
        return {
            ok: true,
            tabId,
            pageUrl: r.pageUrl,
            candidateCount: r.candidates.length,
            stats: r.stats,
            routeStats: r.routeStats,
            note: r.note,
            // 默认只回 URL + 来源，避免 AI 上下文被淹没；detailed=true 时给全字段
            candidates: r.candidates.slice(0, detailed ? 400 : 200).map(c => (detailed ? c : {
                url: c.url, source: c.source, scope: c.scope,
                size: c.size, exists: c.exists === true ? true : undefined
            })),
            routes: r.routes.slice(0, 120),
            nextStep: r.candidates.length
                ? '可把这些 URL 传给 download_js 的 urls 参数（或直接 download_js 加 predict:true）一起下载；routes 可逐条访问以触发懒加载'
                : null
        };
    },

    /**
     * 读取运行时动态代码（blob: / eval / Function）。
     * 这类代码不是网络请求，webRequest 与 DOM 采集都看不到，只能靠主世界 Hook 抓；
     * 其中常含前端加密逻辑、接口定义与密钥，是 JS 逆向的重点盲区。
     * 需先在 Hook 页启用「动态代码捕获」并刷新目标页面。
     */
    async toolGetDynamicCode(args) {
        const tabId = await this.resolveTabId(args.tabId);
        if (typeof DynamicCodeStore === 'undefined') {
            throw new Error('DynamicCodeStore 未加载：请到 chrome://extensions 重载扩展');
        }
        const withCode = args.withCode !== false;
        const d = DynamicCodeStore.list(tabId, { kind: args.kind, limit: args.limit || 30, withCode });
        if (!d.total) {
            // 提示要按真实状态给：Hook 已启用时不该让用户再去「启用」一次（那会让人以为功能坏了）
            let hn = '';
            try { hn = safeHostname((await API.tabs.get(tabId))?.url || ''); } catch {}
            let enabled = false, hooksOk = true;
            try {
                const data = await API.storage.local.get([HookRegistry.MODE_KEY, HookRegistry.GLOBAL_KEY, hn]);
                const mode = data[HookRegistry.MODE_KEY] || 'standard';
                const list = mode === 'global' ? (data[HookRegistry.GLOBAL_KEY] || []) : (data[hn] || []);
                enabled = list.includes('hook_dynamic_code');
            } catch { hooksOk = false; }
            const note = !hooksOk
                ? '暂无捕获：无法读取 Hook 配置，请在 popup「Hook」页确认「动态代码捕获」状态'
                : enabled
                    ? '暂无捕获：「动态代码捕获」已启用，但当前页面还没有产生 eval / new Function / Blob 脚本；'
                      + '若页面在启用之前就已加载，请刷新目标页面让主世界脚本重新注入'
                    : '「动态代码捕获」未启用：请在 popup「Hook」页打开并刷新目标页面（脚本在主世界 document_start 注入）';
            return { tabId, total: 0, kinds: {}, hookEnabled: enabled, note };
        }
        return {
            tabId, total: d.total, bytes: d.bytes, kinds: d.kinds,
            truncated: d.truncated,
            items: d.items.map(it => ({
                id: it.id, kind: it.kind, bytes: it.bytes, truncated: it.truncated,
                originalLength: it.originalLength, meta: it.meta,
                frameUrl: it.frameUrl,
                timeText: new Date(it.ts).toLocaleString('zh-CN', { hour12: false }),
                ...(withCode ? { code: it.code } : { preview: it.preview })
            })),
            note: 'kind 说明：blob-url = 运行时打包成 blob: 的脚本；eval / function-constructor = 字符串求值出的代码'
        };
    },

    /** 覆盖对账：候选（观测 + 预测）vs 已能下载，缺口在哪 */
    async toolGetJsCoverage(args) {
        const tabId = await this.resolveTabId(args.tabId);
        if (typeof JsPredictor === 'undefined') {
            throw new Error('JsPredictor 模块未加载：请到 chrome://extensions 重载扩展');
        }
        const r = await JsPredictor.coverage(tabId, { skipMin: !!args.skipMin });
        return {
            ok: true,
            tabId,
            pageUrl: r.pageUrl,
            total: r.total,
            observedCount: r.observedCount,
            predictedCount: r.predictedCount,
            bySource: r.bySource,
            site: r.site,
            coveragePercent: r.total ? Math.round(r.observedCount / r.total * 100) : 100,
            hasPredict: r.hasPredict,
            predictAgeMs: r.predictAgeMs,
            routesAvailable: r.routesAvailable,
            gapUrls: r.gapUrls,
            note: r.note
        };
    },

    /* ================= 新增：JS 资源清单 / 检索 / 下载 ================= */

    async _pageUrl(tabId) {
        try { return (await API.tabs.get(tabId))?.url || ''; } catch { return ''; }
    },

    async toolGetJsList(args) {
        const tabId = await this.resolveTabId(args.tabId);
        const pageUrl = args.pageUrl || await this._pageUrl(tabId);
        const collectOpts = {
            includeThirdParty: !!args.includeThirdParty,
            skipMin: !!args.skipMin,
            pageUrl,
            includeFailed: args.includeFailed === true,
            mergePageCollect: args.mergePageCollect !== false
        };
        const list = await collectTabJsUrls(tabId, collectOpts);
        const kw = String(args.keyword || '').toLowerCase();
        let filtered = kw ? list.filter(x => x.url.toLowerCase().includes(kw)) : list;
        filtered = filtered.map(x => ({
            url: x.url, host: x.host, path: x.path,
            thirdParty: !!x.thirdParty, status: x.status || 0,
            size: x.size || 0, source: x.source || '',
            minified: /\.min\.js$/i.test(x.path || '')
        }));
        filtered.sort((a, b) => (b.size || 0) - (a.size || 0));
        const limit = Math.min(Math.max(1, args.limit || 300), 2000);
        const totalBytes = filtered.reduce((n, x) => n + (x.size || 0), 0);
        return {
            tabId, pageUrl,
            count: filtered.length, totalBytes,
            truncated: filtered.length > limit,
            excludedFailed: collectOpts._excludedFailed || 0,
            includeFailed: args.includeFailed === true,
            js: filtered.slice(0, limit),
            tip: '可用 download_js 一键下载（支持 files / zip / list 三种格式），或用 search_in_js 直接在源码中检索关键字' +
                (collectOpts._excludedFailed
                    ? `。已默认排除 ${collectOpts._excludedFailed} 个状态码 >= 400 的 URL（站点失败回退请求，下载会把 404 页面当 JS 落盘）；需要时传 includeFailed:true`
                    : '')
        };
    },

    async toolSearchInJs(args) {
        const pattern = args.pattern || args.keyword;
        if (!pattern) throw new Error('缺少 pattern 参数（关键字或正则表达式）');
        const tabId = await this.resolveTabId(args.tabId);
        const pageUrl = args.pageUrl || await this._pageUrl(tabId);

        let excludedFailed = 0;
        let urls = Array.isArray(args.urls) && args.urls.length ? args.urls : null;
        if (!urls) {
            const sOpts = {
                includeThirdParty: !!args.includeThirdParty,
                skipMin: !!args.skipMin,
                pageUrl,
                includeFailed: args.includeFailed === true
            };
            const list = await collectTabJsUrls(tabId, sOpts);
            excludedFailed = sOpts._excludedFailed || 0;
            const uf = String(args.urlFilter || '').toLowerCase();
            urls = list.filter(x => !uf || x.url.toLowerCase().includes(uf)).map(x => x.url);
        }
        const candidateFiles = urls.length;                    // 切片前的候选数（判断是否被 maxFiles 截断）
        const maxFiles = Math.min(Math.max(1, args.maxFiles || 200), 800);
        urls = urls.slice(0, maxFiles);
        if (!urls.length) throw new Error('没有可检索的 JS 文件：请先刷新目标页面，或用 urls 参数显式指定');

        const cacheInfo = await JsTextCache.ensure(tabId, urls, {
            maxFiles,
            concurrency: 6
        });

        let re;
        try {
            re = args.regex === false
                ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), args.caseSensitive ? 'g' : 'gi')
                : new RegExp(pattern, args.caseSensitive ? 'g' : 'gi');
        } catch (e) {
            throw new Error('正则表达式无效：' + ((e && e.message) || e) + '（若只是想匹配普通文本，请传 regex=false）');
        }

        const maxHits = Math.min(Math.max(1, args.maxHits || 60), 500);
        const ctx = Math.min(Math.max(0, args.contextLines || 0), 5);
        const snipLen = Math.min(Math.max(60, args.snippetLength || 300), 1000);
        // 单行最多取多少条命中：压缩/混淆文件往往**整个文件只有一行**，
        // 若每行只取第一条，则这类文件永远只能返回 1 个结果（逆向时最关键的文件反而最难用）。
        const maxPerLine = Math.min(Math.max(1, args.maxPerLine || 20), 200);
        const hits = [];
        const hitsByFile = {};
        let scanned = 0, skipped = 0, stoppedByLimit = 0, perLineTruncated = 0;

        for (const url of urls) {
            const text = JsTextCache.get(tabId, url);
            if (text == null) { skipped++; continue; }
            // 已达命中上限：仍然遍历（文本已在缓存里，「扫」的成本只有正则），
            // 这样 filesScanned 反映真实覆盖情况，而不是悄悄少算一批文件。
            if (hits.length >= maxHits) { stoppedByLimit++; continue; }
            scanned++;
            const lines = text.split('\n');
            let fileHits = 0;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                re.lastIndex = 0;
                let m, n = 0;
                while ((m = re.exec(line)) !== null) {
                    const from = Math.max(0, i - ctx);
                    const to = Math.min(lines.length - 1, i + ctx);
                    hits.push({
                        url,
                        line: i + 1,
                        column: m.index + 1,
                        indexInLine: m.index,
                        match: String(m[0]).slice(0, 200),
                        snippet: buildHitSnippet(lines, from, to, i, m.index, snipLen)
                    });
                    fileHits++;
                    if (++n >= maxPerLine) { perLineTruncated++; break; }
                    // 零宽匹配（如 ^ / a*）会让 lastIndex 原地踏步 → 手动推进，避免死循环
                    if (m.index === re.lastIndex) re.lastIndex++;
                    if (hits.length >= maxHits) break;
                }
                if (hits.length >= maxHits) break;
            }
            if (fileHits) hitsByFile[url] = fileHits;
        }

        const stopReason = hits.length >= maxHits ? 'maxHits'
            : (candidateFiles > maxFiles ? 'maxFiles' : 'completed');
        const hitFiles = Object.entries(hitsByFile).sort((a, b) => b[1] - a[1]);
        // 「截断」必须把两个上限都算进去：只按 maxHits 判断时，
        // 单行文件撞到 maxPerLine（hitCount 远小于 maxHits）会被报成 truncated:false，
        // 让人以为结果已经取全 —— 逆向时这点很致命。
        const perLineLimited = perLineTruncated > 0;

        return {
            tabId, pattern,
            candidateFiles,
            maxFiles,
            filesScanned: scanned,
            filesStoppedByLimit: stoppedByLimit,
            filesFailed: cacheInfo.failed.length,
            failedSample: cacheInfo.failed.slice(0, 10),
            skippedUncached: skipped,
            excludedFailed,
            stopReason,
            hitCount: hits.length,
            truncated: hits.length >= maxHits || perLineLimited,
            truncatedReason: hits.length >= maxHits
                ? `命中数已达上限 ${maxHits}，可能还有更多结果（调大 maxHits 继续检索）`
                : (perLineLimited
                    ? `有 ${perLineTruncated} 行的命中数超过单行上限 ${maxPerLine}，这些行还有未返回的命中（压缩/混淆文件常见，调大 maxPerLine 可取全）`
                    : null),
            maxPerLine,
            perLineTruncatedLines: perLineTruncated,
            filesWithHits: hitFiles.length,
            hotFiles: hitFiles.slice(0, 10).map(([url, n]) => ({ url, hits: n })),
            cache: JsTextCache.size(tabId),
            hits
        };
    },

    async toolBeautifyJs(args) {
        let code = args.code;
        if (!code && args.url) {
            if (!/^https?:\/\//i.test(args.url)) throw new Error('url 需为 http(s) 协议');
            const r = await JsFetcher.handle({ url: args.url, tabId: typeof args.tabId === 'number' ? args.tabId : null, frameId: '0' });
            code = r && r.content;
            if (code == null) throw new Error('抓取失败：' + args.url);
        }
        if (!code) throw new Error('请提供 code 或 url 参数');
        const src = String(code);
        const info = JsBeautifier.analyze(src);
        const pretty = JsBeautifier.beautify(src, args.indent || 4);
        const maxLen = args.maxLen > 0 ? Math.min(args.maxLen, 1500000) : 200000;
        const startLine = Math.max(1, args.startLine || 1) | 0;
        const body = startLine > 1 ? pretty.split('\n').slice(startLine - 1).join('\n') : pretty;
        return {
            ok: true,
            sourceBytes: info.bytes, sourceLines: info.lines, minified: info.minified,
            prettyBytes: pretty.length, prettyLines: pretty.split('\n').length,
            startLine, truncated: body.length > maxLen,
            code: body.slice(0, maxLen)
        };
    },

    async toolDownloadJs(args) {
        const tabId = await this.resolveTabId(args.tabId);
        const pageUrl = args.pageUrl || await this._pageUrl(tabId);
        const format = ['files', 'zip', 'list', 'zip+list'].includes(args.format) ? args.format : 'files';
        let collectOpts2 = {};   // 采集阶段的统计（含被排除的 4xx 计数），透传给下载引擎

        let urls = Array.isArray(args.urls) && args.urls.length
            ? args.urls.filter(u => /^https?:/i.test(u))
            : null;
        if (!urls) {
            const dlOpts = {
                includeThirdParty: !!args.includeThirdParty || args.scope === 'site',
                skipMin: !!args.skipMin,
                pageUrl,
                // predict=true 时顺带把懒加载 chunk / 构建清单产物一起纳入下载范围
                predict: !!args.predict,
                verify: args.verifyPredict !== false,
                maxVerify: args.maxVerify,
                includeFailed: args.includeFailed === true
            };
            const list = await collectTabJsUrls(tabId, dlOpts);
            collectOpts2 = dlOpts;
            urls = list
                .filter(x => (args.scope === 'site'
                    ? (x.scope === 'site' || x.scope == null)
                    : (args.scope === 'thirdParty' ? x.thirdParty : true)))
                .map(x => x.url);
        }
        if (!urls.length) {
            throw new Error('没有可下载的 JS：请先访问目标站点并刷新，让扩展完成请求观测');
        }

        const r = await DownloadManager.downloadJs({
            tabId, pageUrl, urls, format,
            dir: args.dir, flatten: args.flatten, saveAs: args.saveAs,
            siteFolder: args.siteFolder,
            includeThirdParty: args.includeThirdParty, skipMin: args.skipMin,
            maxCount: args.maxCount, conflictAction: args.conflictAction,
            // 默认排除已知 4xx/5xx：浏览器下载接口对 404 也会落盘，会把错误页存成 .js
            includeFailed: args.includeFailed === true,
            preExcludedFailed: collectOpts2._excludedFailed || 0
        });
        // 绝对路径在浏览器下载接口下写不进去：给出可执行的替代方案，而不是让调用方困惑
        if (r && r.dirAbsolute) {
            r.note = (r.note || '') + ' ｜ 说明：目录「' + (r.dirRaw || '') + '」是绝对路径，浏览器扩展无法用下载接口写入；' +
                '文件已落到默认下载目录下的「' + (r.dir || '') + '」。要直接写进该绝对目录，请在扩展弹窗里用「直写本地目录」模式（需人工点一次目录选择）。';
        }
        return r;
    },

    /* ================= 新增：网络 / 控制台 / 存储 / DOM ================= */

    async toolGetNetworkRequests(args) {
        const tabId = await this.resolveTabId(args.tabId);
        const r = ResourceIndex.listRequests(tabId, {
            keyword: args.keyword,
            type: args.type,
            onlyThirdParty: !!args.onlyThirdParty,
            minStatus: args.minStatus,
            limit: args.limit || 200
        });
        if (!r.total) {
            return {
                tabId, total: 0, requests: [],
                note: '暂无网络记录：请先访问/刷新目标页面（记录生命周期与标签页绑定，页面跳转会清空）'
            };
        }
        return {
            tabId, total: r.total, returned: r.requests.length, truncated: r.truncated,
            requests: r.requests.map(x => ({
                url: x.url, method: x.method || 'GET', type: x.type || '',
                status: x.status || 0, size: x.size || 0, mime: x.mime || '',
                thirdParty: !!x.thirdParty, frameId: x.frameId,
                time: new Date(x.ts || Date.now()).toISOString()
            }))
        };
    },

    async toolGetConsoleLogs(args) {
        const tabId = await this.resolveTabId(args.tabId);
        const r = ConsoleStore.get(tabId, {
            level: args.level,
            keyword: args.keyword,
            since: args.since,
            limit: args.limit || 200
        });
        return {
            tabId, total: r.total, returned: r.logs.length, truncated: r.truncated,
            captureEnabled: ConsoleCapture.enabled,
            note: r.total ? undefined
                : '暂无日志。控制台捕获默认随「MCP 服务」开启；若刚开启，请刷新目标页面后再看（captureEnabled=' + ConsoleCapture.enabled + '）',
            logs: r.logs
        };
    },

    async toolGetStorage(args) {
        const tabId = await this.resolveTabId(args.tabId);
        const frameId = args.frameId != null ? args.frameId : 0;
        const maxLen = Math.min(Math.max(100, args.maxValueLength || 2000), 20000);
        let r;
        try {
            [r] = await API.scripting.executeScript({
                target: { tabId, frameIds: [frameId] },
                world: 'ISOLATED',
                args: [maxLen, args.keyFilter || ''],
                func: (ml, kf) => {
                    const dump = (store, kind) => {
                        const out = [];
                        try {
                            for (let i = 0; i < store.length; i++) {
                                const k = store.key(i);
                                if (kf && !k.toLowerCase().includes(String(kf).toLowerCase())) continue;
                                let v = store.getItem(k);
                                const len = v == null ? 0 : String(v).length;
                                if (v != null && String(v).length > ml) v = String(v).slice(0, ml) + '…';
                                out.push({ key: k, value: v, length: len });
                            }
                        } catch (e) { /* 隐私模式等 */ }
                        return { name: kind, count: out.length, items: out };
                    };
                    let cookie = '';
                    try { cookie = document.cookie || ''; } catch {}
                    return {
                        url: location.href,
                        localStorage: dump(window.localStorage, 'localStorage'),
                        sessionStorage: dump(window.sessionStorage, 'sessionStorage'),
                        // 这里只能看到 JS 可读的 document.cookie（httpOnly 的看不到），
                        // 所以数量会比 get_cookies（chrome.cookies.getAll）少——字段名已标明来源
                        cookieLength: cookie.length,
                        cookieCount: cookie ? cookie.split(';').filter(s => s.trim()).length : 0,
                        cookieCountSource: 'document.cookie'
                    };
                }
            });
        } catch (e) {
            throw new Error('读取存储失败：' + ((e && e.message) || e) + '（受限页面无法注入）');
        }
        const storeOut = (r && r.result) || { error: '无结果' };
        if (storeOut && !storeOut.error) {
            storeOut.note = 'cookieCount / cookieLength 只统计 JS 可见的 document.cookie；' +
                'httpOnly 的 Cookie 看不到，完整列表请用 get_cookies（走 chrome.cookies.getAll）';
        }
        return storeOut;
    },

    async toolQueryDom(args) {
        if (args.selector && typeof args.selector !== 'string') throw new Error('selector 需为字符串');
        const tabId = await this.resolveTabId(args.tabId);
        const frameId = args.frameId != null ? args.frameId : 0;
        const limit = Math.min(Math.max(1, args.limit || 50), 500);
        const attrs = Array.isArray(args.attributes) ? args.attributes : [];
        const htmlLen = Math.min(Math.max(0, args.htmlLength || 0), 3000);
        let r;
        try {
            [r] = await API.scripting.executeScript({
                target: { tabId, frameIds: [frameId] },
                world: 'ISOLATED',
                args: [args.selector || '', limit, attrs, htmlLen, args.includeText !== false],
                func: (sel, lim, attrList, hl, withText) => {
                    const pick = (el) => {
                        const o = { tag: el.tagName.toLowerCase() };
                        for (const a of attrList) {
                            const v = el.getAttribute(a);
                            if (v !== null) o[a] = v.length > 500 ? v.slice(0, 500) + '…' : v;
                        }
                        if (withText) {
                            const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
                            if (t) o.text = t.slice(0, 500);
                        }
                        if (hl > 0) o.html = el.outerHTML.slice(0, hl);
                        return o;
                    };
                    if (!sel) {
                        const cnt = (s) => { try { return document.querySelectorAll(s).length; } catch { return 0; } };
                        return {
                            url: location.href, title: document.title,
                            forms: Array.from(document.forms).length,
                            inputs: cnt('input,textarea,select'),
                            buttons: cnt('button,[type=submit],[type=button]'),
                            tables: cnt('table'),
                            iframes: cnt('iframe'),
                            images: cnt('img'),
                            scripts: cnt('script[src]'),
                            inlineScripts: cnt('script:not([src])'),
                            links: cnt('a[href]'),
                            // 引导下一步：概览之后通常要确认表单 / 接口入口 / 框架痕迹
                            suggestSelectors: [
                                'form', 'input[name]', 'a[href]', 'iframe[src]',
                                '[data-url],[data-href],[data-route],[to]'
                            ]
                        };
                    }
                    let nodes;
                    try { nodes = document.querySelectorAll(sel); } catch (e) { return { error: '选择器无效: ' + e.message }; }
                    return {
                        url: location.href,
                        count: nodes.length,
                        returned: Math.min(nodes.length, lim),
                        items: Array.from(nodes).slice(0, lim).map(pick)
                    };
                }
            });
        } catch (e) {
            throw new Error('DOM 查询失败：' + ((e && e.message) || e));
        }
        return (r && r.result) || { error: '无结果' };
    },

    async toolScreenshot(args) {
        const tabId = await this.resolveTabId(args.tabId);
        const tab = await API.tabs.get(tabId).catch(() => null);
        if (!tab) throw new Error('标签页不存在');
        const win = await API.windows.get(tab.windowId).catch(() => null);
        if (!tab.active && (!win || !win.focused)) {
            return {
                ok: false,
                error: '截图要求目标标签页处于前台可见状态（浏览器限制）',
                hint: '可先用 navigate_tab/list_tabs 切到该标签页，或改用 get_page_html / query_dom 获取结构化内容'
            };
        }
        let dataUrl;
        try {
            dataUrl = await API.tabs.captureVisibleTab(tab.windowId, { format: args.format === 'jpeg' ? 'jpeg' : 'png' });
        } catch (e) {
            throw new Error('截图失败：' + ((e && e.message) || e));
        }
        if (!dataUrl) throw new Error('截图失败：未返回图像数据');
        const estBytes = Math.round(dataUrl.length * 0.75);
        if (args.saveToDisk !== false && DownloadManager.hasApi()) {
            const vars = DownloadManager._vars(tabId, tab.url);
            const dir = DownloadManager.expandDir(args.dir != null ? args.dir : 'JsXray/{host}/{date}/screenshots', vars);
            const ext = args.format === 'jpeg' ? 'jpg' : 'png';
            const name = `${dir}/shot_${vars.host}_${vars.time}.${ext}`;
            try {
                const id = await DownloadManager._download({
                    url: dataUrl,
                    filename: name,
                    conflictAction: 'uniquify'
                });
                return { ok: true, saved: name, downloadId: id, approxBytes: estBytes, note: '已保存截图到下载目录' };
            } catch (e) {
                return { ok: true, saved: null, error: String(e && e.message || e), approxBytes: estBytes };
            }
        }
        return { ok: true, saved: null, approxBytes: estBytes, note: '未落盘（saveToDisk=false）' };
    },
};
