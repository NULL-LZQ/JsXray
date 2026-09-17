/* =====================================================================
 * JsXray — background service worker
 * 职责：徽章管理 / HTTP头指纹识别 / JS抓取 / CSP安全正则匹配
 *       Hook脚本动态注册(主世界) / webRequest观测 / 消息路由
 * 兼容：Chrome MV3 + Firefox MV3 (115+)
 * ===================================================================== */

'use strict';

// Firefox 兼容：chrome 命名空间在 Firefox MV3 下同样可用，无需额外 polyfill
const API = (typeof browser !== 'undefined') ? browser : chrome;

// 加载 Heimdallr 规则库（反蜜罐 / 指纹识别 / 特征对抗）
try { importScripts('data/heimdallr_rules.js'); } catch (e) { console.error('[LatentEye] load heimdallr_rules:', e); }
// 加载工具库：ZIP 打包 / 资源索引与下载引擎 / 运行时记录（控制台、JS 缓存、美化）
try { importScripts('lib/zip.js'); } catch (e) { console.error('[LatentEye] load lib/zip:', e); }
try { importScripts('lib/downloader.js'); } catch (e) { console.error('[LatentEye] load lib/downloader:', e); }
try { importScripts('lib/recorder.js'); } catch (e) { console.error('[LatentEye] load lib/recorder:', e); }
// 加载信息泄露引擎（多关键字 AND 高精度二轮匹配；借鉴 v1.5.0，规则源自 BurpAPIFinder）
try { importScripts('lib/api_finder_engine.js'); } catch (e) { console.error('[HAPPYJS] load api_finder_engine:', e); }
try { importScripts('data/api_finder_rules.js'); } catch (e) { console.error('[HAPPYJS] load api_finder_rules:', e); }
try { importScripts('data/api_finder_rules_burpapi.js'); } catch (e) { console.error('[HAPPYJS] load api_finder_rules_burpapi:', e); }
// 加载站点范围判定（自有/同主体/CDN 库/统计噪声）与 JS 资源预测补齐（chunk 合成 / 路由提取）
try { importScripts('lib/site_scope.js'); } catch (e) { console.error('[HAPPYJS] load site_scope:', e); }
try { importScripts('lib/chunk_finder.js'); } catch (e) { console.error('[HAPPYJS] load chunk_finder:', e); }
try { importScripts('lib/route_finder.js'); } catch (e) { console.error('[HAPPYJS] load route_finder:', e); }
// 加载云存储桶检测引擎（10 厂商 bundle，来自 谛听鉴 V1.1.0）+ 后台模块 BucketSentinel
try { importScripts('lib/bucket/bucket_core.js'); } catch (e) { console.error('[BucketSentinel] load bucket_core:', e); }
try { importScripts('bucket/bucket_bg.js'); } catch (e) { console.error('[BucketSentinel] load bucket_bg:', e); }
// 加载 MCP 客户端模块（AI 工具桥接：Codex / Claude / Trae 通过 MCP 调用扩展能力）
try { importScripts('mcp/ext_client.js'); } catch (e) { console.error('[LatentEye] load mcp/ext_client:', e); }

/* ========================== 工具函数 ========================== */
function safeHostname(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
function genId() { return `le_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`; }

/* =====================================================================
 * 1. 徽章管理器：按"有结果的非空分类数"显示徽章
 * ===================================================================== */
const BadgeManager = {
    cache: new Map(), // tabId -> count
    RESULT_KEYS: ['domains', 'routes', 'absoluteApis', 'apis', 'moduleFiles', 'docFiles',
        'ips', 'phones', 'emails', 'idcards', 'jwts', 'imageFiles', 'jsFiles',
        'vueFiles', 'urls', 'githubUrls', 'companies', 'credentials', 'cookies',
        'idKeys', 'windowsPaths', 'thirdPartyLibs', 'fingers', 'iframes',
        'privateKeys', 'dbConns', 'mqConns', 'linuxPaths', 'sourceMaps', 'ossEndpoints',
        'infoLeakage', 'baseUrls', 'unauthApis'],

    init() {
        API.tabs.onActivated.addListener(({ tabId }) => this.refresh(tabId));
        API.tabs.onRemoved.addListener((tabId) => {
            this.cache.delete(tabId);
            API.storage.session && API.storage.session.remove(`tab_${tabId}`).catch(() => {});
        });
    },
    set(tabId, count) {
        this.cache.set(tabId, count);
        const show = count > 0;
        API.action.setBadgeText({ text: show ? String(count > 999 ? '999+' : count) : '', tabId });
        API.action.setBadgeBackgroundColor({ color: show ? '#4e6ef2' : '#8f959e', tabId });
    },
    refresh(tabId) {
        if (this.cache.has(tabId)) this.set(tabId, this.cache.get(tabId));
        else this.set(tabId, 0);
    },
    // 由 content 上报扫描结果时调用
    updateFromResults(results, tabId) {
        let n = 0;
        for (const k of this.RESULT_KEYS) {
            const v = results[k];
            if (Array.isArray(v) && v.length > 0) n++;
        }
        this.set(tabId, n);
    }
};

/* =====================================================================
 * 2. 指纹引擎：HTTP响应头 / Cookie / 流量统计 三类指纹
 * ===================================================================== */
const FINGERPRINT_DESC = {
    framework: '框架', technology: '语言', security: '(安全应用/策略)', server: '服务器',
    os: '操作系统', app: '应用', env: '环境', port: '端口', version: '版本', builder: '构建工具',
    appType: '应用类型', time: '时间', component: '组件', panel: '面板', cdn: 'CDN', analytics: '统计分析'
};

const FingerprintEngine = {
    // 按 tabId 缓存指纹聚合结果
    store: new Map(),
    analyticsSeen: { baidu: new Map(), yahoo: new Map(), google: new Map() },

    get(tabId) {
        if (!this.store.has(tabId)) {
            this.store.set(tabId, {
                server: [], component: [], technology: [], security: [],
                analytics: [], builder: [], framework: [], os: [], panel: [], cdn: [],
                nameMap: new Set()
            });
        }
        return this.store.get(tabId);
    },

    // HTTP 响应头规则（type/name/pattern/header/value[/extType/extName]）
    HEADER_RULES: [
        { type: 'server', name: 'Apache', pattern: /apache\/?([\d\.]+)?/i, header: 'server', value: 'version' },
        { type: 'server', name: 'Tomcat', pattern: /apache-coyote\/?([\d\.]+)?/i, header: 'server', value: 'version', extType: 'technology', extName: 'Java' },
        { type: 'server', name: 'Nginx', pattern: /nginx\/?([\d\.]+)?/i, header: 'server', value: 'version' },
        { type: 'server', name: 'IIS', pattern: /microsoft-iis\/?([\d\.]+)?/i, header: 'server', value: 'version', extType: 'os', extName: 'Windows' },
        { type: 'server', name: 'Jetty', pattern: /jetty\s?\/?\(?([0-9a-zA-Z.-]*)\)?/i, header: 'server', value: 'version', extType: 'technology', extName: 'Java' },
        { type: 'server', name: 'Resin', pattern: /resin\/?([\d\.]+)?/i, header: 'server', value: 'version' },
        { type: 'server', name: 'Cloudflare', pattern: /cloudflare/i, header: 'server', extType: 'cdn', extName: 'Cloudflare' },
        { type: 'server', name: 'OpenResty', pattern: /openresty\/?([\d\.]+)?/i, header: 'server', value: 'version', extType: 'server', extName: 'Nginx' },
        { type: 'server', name: 'Tengine', pattern: /tengine\/?([\d\.]+)?/i, header: 'server', value: 'version' },
        { type: 'server', name: 'Varnish', pattern: /varnish\/?([\d\.]+)?/i, header: 'server', value: 'version' },
        { type: 'server', name: 'Caddy', pattern: /caddy\/?([\d\.]+)?/i, header: 'server', value: 'version' },
        { type: 'server', name: 'LiteSpeed', pattern: /litespeed/i, header: 'server' },
        { type: 'component', name: 'OpenSSL', pattern: /openssl\s?\/?\(?([0-9a-zA-Z.-]*)\)?/i, header: 'server', value: 'version' },
        { type: 'component', name: 'PHP-FPM', pattern: /php\/?([\d\.]+)?/i, header: 'server', value: 'version', extType: 'technology', extName: 'PHP' },
        { type: 'os', name: 'Windows', pattern: /win64|win32/i, header: 'server' },
        { type: 'os', name: 'Ubuntu', pattern: /ubuntu/i, header: 'server' },
        { type: 'os', name: 'CentOS', pattern: /centos/i, header: 'server' },
        { type: 'os', name: 'Debian', pattern: /debian/i, header: 'server' },
        { type: 'framework', name: 'Spring', pattern: /([a-zA-Z0-9.\-]+):([a-zA-Z0-9\-]+):(\d+)/i, header: 'x-application-context', value: 'app,env,port', extType: 'technology', extName: 'Java' },
        { type: 'framework', name: 'JFinal', pattern: /jfinal\s?\/?([\d\.]+)?/i, header: 'server', value: 'version', extType: 'technology', extName: 'Java' },
        { type: 'framework', name: 'ASP.NET', pattern: /[0-9.]+/i, header: 'x-aspnet-version', value: 'version' },
        { type: 'framework', name: 'ASP.NET', pattern: /asp\.net/i, header: 'x-powered-by' },
        { type: 'framework', name: 'ASP.NET MVC', pattern: /[0-9.]+/i, header: 'x-aspnetmvc-version', value: 'version' },
        { type: 'framework', name: 'Express', pattern: /express/i, header: 'x-powered-by', extType: 'technology', extName: 'Node.js' },
        { type: 'framework', name: 'ThinkPHP', pattern: /thinkphp\/?([\d\.]+)?/i, header: 'x-powered-by', value: 'version', extType: 'technology', extName: 'PHP' },
        { type: 'framework', name: 'Laravel', pattern: /laravel/i, header: 'x-powered-by', extType: 'technology', extName: 'PHP' },
        { type: 'technology', name: 'PHP', pattern: /php\/?([\d\.]+)?/i, header: 'x-powered-by', value: 'version' },
        { type: 'technology', name: 'PHP', pattern: /PHPSESSID/i, header: 'set-cookie' },
        { type: 'technology', name: 'Java', pattern: /java/i, header: 'x-powered-by' },
        { type: 'technology', name: 'Java', pattern: /JSESSIONID|jeesite/i, header: 'set-cookie' },
        { type: 'technology', name: 'Python', pattern: /python\/?([\d\.]+)?/i, header: 'server', value: 'version' },
        { type: 'technology', name: 'Node.js', pattern: /node/i, header: 'x-powered-by' },
        { type: 'technology', name: 'Ruby', pattern: /ruby|rails/i, header: 'x-powered-by' },
        { type: 'security', name: '安全狗', pattern: /waf\/?([\d\.]+)?$/i, header: 'x-powered-by', value: 'version' },
        { type: 'security', name: 'Janusec', pattern: /janusec/i, header: 'x-powered-by' },
        { type: 'security', name: '360防火墙', pattern: /360/i, header: 'x-safe-firewall' },
        { type: 'security', name: 'HSTS', pattern: /max-age=(\d+)/i, header: 'strict-transport-security', value: 'time' },
        { type: 'security', name: 'CSP', pattern: /.+/i, header: 'content-security-policy' },
        { type: 'panel', name: 'Plesk', pattern: /plesk/i, header: 'x-powered-by' },
        { type: 'panel', name: '宝塔', pattern: /bt-panel|baota/i, header: 'server' },
        { type: 'panel', name: 'phpMyAdmin', pattern: /phpmyadmin/i, header: 'set-cookie' }
    ],

    COOKIE_RULES: [
        { type: 'technology', name: 'PHP', match: /PHPSESSID/i },
        { type: 'framework', name: 'ASP.NET', match: /ASP\.NET_SessionId|ASPSESSIONID/i },
        { type: 'technology', name: 'Java', match: /JSESSIONID|jeesite/i },
        { type: 'framework', name: 'ThinkPHP', match: /think_php/i },
        { type: 'technology', name: 'Ruby', match: /_session_id/i }
    ],

    ANALYTICS: {
        baidu: { pattern: '*://hm.baidu.com/hm.js*', name: '百度统计' },
        google: { pattern: '*://www.google-analytics.com/*', name: 'Google Analytics' },
        cnzz: { pattern: '*://*.cnzz.com/*', name: 'CNZZ统计' },
        umeng: { pattern: '*://*.umeng.com/*', name: '友盟统计' },
        matomo: { pattern: '*://*/matomo.js*', name: 'Matomo统计' }
    },

    desc(type) { return FINGERPRINT_DESC[type] || type; },

    processHeaders(responseHeaders, tabId) {
        const fp = this.get(tabId);
        const map = new Map((responseHeaders || []).map(h => [h.name.toLowerCase(), h.value || '']));
        for (const rule of this.HEADER_RULES) {
            if (!rule.header) continue;
            const val = map.get(rule.header.toLowerCase());
            if (!val) continue;
            const m = val.match(rule.pattern);
            if (!m || fp.nameMap.has(rule.name)) continue;
            const item = { ...rule };
            item.description = `通过 ${rule.header} 识别到 ${rule.name} ${this.desc(rule.type)}`;
            // 扩展指纹（如 Java、Windows、CDN）
            if (rule.extType && rule.extName && !fp.nameMap.has(rule.extName)) {
                fp[rule.extType].push({ type: rule.extType, name: rule.extName, header: rule.header,
                    description: `通过 ${rule.header} 识别到 ${rule.extName} ${this.desc(rule.extType)}` });
                fp.nameMap.add(rule.extName);
            }
            if (rule.value) {
                const parts = rule.value.split(',');
                if (m.length > 1) parts.forEach((p, i) => { item[p] = m[i + 1] || null; });
                else item[rule.value] = m[0] || null;
            }
            delete item.pattern;
            fp[rule.type].push(item);
            fp.nameMap.add(rule.name);
        }
    },

    identifyFromCookie(cookieNamesStr, tabId) {
        const fp = this.get(tabId);
        for (const r of this.COOKIE_RULES) {
            if (r.match.test(cookieNamesStr) && !fp.nameMap.has(r.name)) {
                fp[r.type].push({ type: r.type, name: r.name,
                    description: `通过 Cookie 识别到 ${r.name} ${this.desc(r.type)}` });
                fp.nameMap.add(r.name);
            }
        }
    },

    handleAnalytics(url, tabId) {
        for (const [key, info] of Object.entries(this.ANALYTICS)) {
            const re = new RegExp(info.pattern.replace(/\*/g, '.*'));
            if (re.test(url)) {
                if (this.analyticsSeen[key].has(tabId)) return;
                this.analyticsSeen[key].set(tabId, true);
                const fp = this.get(tabId);
                fp.analytics.push({ type: 'analytics', name: info.name,
                    description: `通过网络请求识别到 ${info.name}，用户访问数据会被记录` });
                return;
            }
        }
    },

    // content 在页面中识别到的构建工具/CDN/框架指纹（如 webpack chunk、cdnjs）
    updateBuilder(tabId, finger) {
        const fp = this.get(tabId);
        if (fp.nameMap.has(finger.name)) return;
        fp[finger.type] = fp[finger.type] || [];
        fp[finger.type].push(finger);
        fp.nameMap.add(finger.name);
    },

    serialize(tabId) {
        const fp = this.get(tabId);
        const out = {};
        for (const k of ['server', 'component', 'technology', 'security', 'analytics',
            'builder', 'framework', 'os', 'panel', 'cdn']) {
            out[k] = fp[k] || [];
        }
        return out;
    },

    clear(tabId) {
        this.store.delete(tabId);
        for (const k of Object.keys(this.analyticsSeen)) this.analyticsSeen[k].delete(tabId);
    }
};

/* =====================================================================
 * 3. JS 抓取器：主fetch + 标签页注入回退（绕过跨域/CSP）
 * ===================================================================== */
const JsFetcher = {
    async fetch(url) {
        // 方案一：SW 直接 fetch（带上 Cookie：大量站点的 JS 也走登录态）
        try {
            const res = await fetch(url, {
                headers: { 'Accept': '*/*' },
                credentials: 'include'
            });
            if (res.ok) return await res.text();
        } catch (e) { /* 落入回退方案 */ }
        return null;
    },
    async fetchViaTab(tabId, url) {
        try {
            const [res] = await API.scripting.executeScript({
                target: { tabId },
                func: (u) => fetch(u, { credentials: 'include' }).then(r => r.text()).catch(() => null),
                args: [url]
            });
            return res?.result ?? null;
        } catch { return null; }
    },
    async handle({ url, tabId, frameId }) {
        let content = await this.fetch(url);
        if (content === null && tabId != null) content = await this.fetchViaTab(tabId, url);
        return { content, frameId };
    }
};

/* =====================================================================
 * 4.1 FetchB64 —— 取原始字节（base64）
 *     供「直写本地目录」模式使用：优先经目标标签页请求（带登录态/Cookie、
 *     不受 SW 第三方 Cookie 策略影响），失败再回退 SW fetch。
 * ===================================================================== */
const FetchB64 = {
    MAX: 64 * 1024 * 1024,

    toBase64(u8) {
        try { return HappyZip.toBase64(u8); } catch { /* 兜底手写 */ }
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        return btoa(bin);
    },

    /** 经目标标签页隔离世界请求：保留 Cookie，且不受 SW 生命周期影响 */
    async viaTab(tabId, url) {
        const max = this.MAX;
        try {
            const [res] = await API.scripting.executeScript({
                target: { tabId, frameIds: [0] },
                world: 'ISOLATED',
                args: [url, max],
                func: async (u, maxBytes) => {
                    try {
                        const r = await fetch(u, { credentials: 'include' });
                        const buf = await r.arrayBuffer();
                        if (buf.byteLength > maxBytes) {
                            return { ok: false, status: r.status, error: `文件过大（${(buf.byteLength / 1048576).toFixed(1)}MB），超出单文件上限` };
                        }
                        const bytes = new Uint8Array(buf);
                        let bin = '';
                        const CH = 0x8000;
                        for (let i = 0; i < bytes.length; i += CH) {
                            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
                        }
                        return {
                            ok: r.ok && bytes.length > 0,
                            base64: btoa(bin),
                            bytes: bytes.length,
                            status: r.status,
                            mime: r.headers.get('content-type') || '',
                            error: r.ok ? undefined : ('HTTP ' + r.status)
                        };
                    } catch (e) {
                        return { ok: false, error: '页面请求失败：' + String((e && e.message) || e) };
                    }
                }
            });
            const r = res && res.result;
            if (r && r.ok) return { ...r, via: 'tab' };
            return r || { ok: false, error: '页面请求无结果' };
        } catch (e) {
            return { ok: false, error: '注入请求失败：' + String((e && e.message) || e) };
        }
    },

    async viaSw(url) {
        try {
            const res = await fetch(url, { credentials: 'include', headers: { 'Accept': '*/*' } });
            const buf = await res.arrayBuffer();
            if (buf.byteLength > this.MAX) return { ok: false, status: res.status, error: '文件过大，超出单文件上限' };
            const u8 = new Uint8Array(buf);
            return {
                ok: res.ok && u8.length > 0, base64: this.toBase64(u8), bytes: u8.length,
                status: res.status, mime: res.headers.get('content-type') || '', via: 'sw',
                error: res.ok ? undefined : ('HTTP ' + res.status)
            };
        } catch (e) {
            return { ok: false, error: '后台请求失败：' + String((e && e.message) || e) };
        }
    },

    async fetch(url, tabId) {
        if (tabId != null) {
            const r = await this.viaTab(tabId, url);
            if (r && r.ok) return r;
            const sw = await this.viaSw(url);
            if (sw && sw.ok) return sw;
            return { ok: false, error: [r && r.error, sw && sw.error].filter(Boolean).join(' ｜ ') || '抓取失败' };
        }
        return this.viaSw(url);
    }
};

/* =====================================================================
 * 4. 正则匹配器：在 background 执行（CSP安全），支持大文本分块
 * ===================================================================== */
const RegexMatcher = {
    MAX_ITER: 100000,
    perform(text, patternStrs, typeName) {
        const matches = [];
        for (const ps of patternStrs) {
            let re;
            try {
                const m = ps.match(/^\/([\s\S]+)\/([a-z]*)$/i);
                if (!m) continue;
                // 仅保留合法 flag，避免因 s/d 等新 flag 导致整条规则被丢弃
                const flags = m[2].split('').filter(f => 'gimsuy'.includes(f)).join('');
                re = new RegExp(m[1], flags);
            } catch { continue; }
            let last = -1, iter = this.MAX_ITER, m;
            while ((m = re.exec(text)) !== null) {
                matches.push({ match: m[0] });
                if (--iter <= 0) { console.warn('[LatentEye] 超过最大迭代:', typeName); break; }
                if (!re.global) break;
                // 零宽匹配防护：lastIndex 未推进则手动 +1，避免死循环且不丢失后续匹配
                if (re.lastIndex === last || re.lastIndex <= m.index) {
                    re.lastIndex = m.index + 1;
                }
                last = re.lastIndex;
            }
        }
        return matches;
    }
};

/* =====================================================================
 * 4.2 信息泄露匹配器（多关键字 AND 高精度二轮扫描）
 *     借鉴 v1.5.0：engine = lib/api_finder_engine.js，规则 = data/api_finder_*.js
 *     放在 background 执行（importScripts 可直接拿到全局），
 *     因此不需要像 v1.5.0 那样把引擎 inline 进 content.js（省掉打包步骤）
 * ===================================================================== */
const INFO_LEAK_CFG_KEY = 'le_info_leak_cfg';
const INFO_LEAK_DEFAULT_CFG = {
    enabled: true,
    acc: 2,            // 最低准确度（1-3），2 = 跳过纯猜测类规则
    src: 'all'         // all | builtin | burpapi
};

const InfoLeak = {
    cfg: { ...INFO_LEAK_DEFAULT_CFG },
    _all: null,
    _cacheKey: '',
    _cache: [],

    _collect() {
        if (this._all) return this._all;
        const pick = (v) => (Array.isArray(v) ? v : []);
        const a = pick(typeof API_FINDER_RULES !== 'undefined' ? API_FINDER_RULES : null);
        const b = pick(typeof BURPAPI_RULES !== 'undefined' ? BURPAPI_RULES : null);
        const seen = new Set();
        this._all = a.concat(b).filter(r => r && r.id && !seen.has(r.id) && seen.add(r.id));
        return this._all;
    },

    stats() {
        const all = this._collect();
        return {
            total: all.length,
            builtin: all.filter(r => !String(r.id).startsWith('burp-')).length,
            burpapi: all.filter(r => String(r.id).startsWith('burp-')).length,
            engine: typeof ApiFinderEngine !== 'undefined'
        };
    },

    async load() {
        try {
            const d = await API.storage.local.get([INFO_LEAK_CFG_KEY]);
            if (d[INFO_LEAK_CFG_KEY]) Object.assign(this.cfg, d[INFO_LEAK_CFG_KEY]);
        } catch {}
        return { ...this.cfg };
    },
    async save(patch) {
        Object.assign(this.cfg, patch || {});
        try { await API.storage.local.set({ [INFO_LEAK_CFG_KEY]: this.cfg }); } catch {}
        return { ...this.cfg };
    },

    rules() {
        const key = `${this.cfg.src}|${this.cfg.acc}`;
        if (key === this._cacheKey) return this._cache;
        let list = this._collect();
        if (this.cfg.src === 'builtin') list = list.filter(r => !String(r.id).startsWith('burp-'));
        else if (this.cfg.src === 'burpapi') list = list.filter(r => String(r.id).startsWith('burp-'));
        const acc = Number(this.cfg.acc) || 1;
        list = list.filter(r => Number(r.accuracy || 1) >= acc);
        this._cacheKey = key;
        this._cache = list;
        return list;
    },

    /** 跑一轮；text 为 JS/HTML 文本，urlPath 用于 location=urlPath 的规则 */
    match(text, urlPath) {
        if (typeof ApiFinderEngine === 'undefined') return { hits: [], error: '引擎未加载' };
        if (!this.cfg.enabled) return { hits: [] };
        const body = String(text || '');
        if (!body) return { hits: [] };
        let hits = [];
        try {
            hits = ApiFinderEngine.match({ body, urlPath: urlPath || '' }, { rules: this.rules() });
        } catch (e) {
            return { hits: [], error: String((e && e.message) || e) };
        }
        const out = [];
        const seen = new Set();
        for (const h of hits) {
            const r = h.rule || {};
            if (r.category && String(r.category).indexOf('白名单') >= 0) continue;
            const rid = r.id || r.describe || '';
            if (seen.has(rid)) continue;      // 同一规则只保留首个命中，避免刷屏
            seen.add(rid);
            const ctx = String(h.context || '').replace(/\s+/g, ' ').slice(0, 200);
            const desc = String(r.describe || r.subcategory || r.category || '').trim();
            out.push({
                ruleId: rid,
                category: r.category || '',
                subcategory: r.subcategory || '',
                describe: desc,
                accuracy: Number(r.accuracy || 1),
                important: !!r.important,
                location: h.location || r.location || 'body',
                matched: (h.keywords || []).join(' + '),
                context: ctx,
                text: `【${r.category || '信息泄露'}】${desc}${h.keywords && h.keywords.length ? '（' + h.keywords.join(' + ') + '）' : ''}｜${ctx}`
            });
        }
        out.sort((a, b) => (b.accuracy - a.accuracy) || (b.important - a.important));
        return { hits: out.slice(0, 120), total: out.length };
    }
};

/* =====================================================================
 * 4.3 接口认证绕过扫描（借鉴 v1.5.0，并按「最小伤害 / 不误报」口径加固）
 *   相比 v1.5.0 的加强点：
 *     ① 跳过登出/删除/改名等破坏性路径（绝不触发会改状态或吊销会话的接口）
 *     ② 过滤静态资源与日期格式等噪声候选（apis 分类里的误报不再发请求）
 *     ③ 读取响应体识别「请先登录 / code:401」类假阳性，避免把登录页当洞
 *     ④ redirect:'manual' 下 3xx 是登录跳转，不再当作「未授权」（v1.5.0 会误判）
 *     ⑤ 全局请求节流 + 硬上限 + 命中风控(429/503)立即停止
 * ===================================================================== */
const AB_CFG_KEY = 'le_auth_bypass_cfg';
const AB_DEFAULT_CFG = {
    limit: 20,             // 参与探测的 API 条数上限
    concurrency: 3,
    timeout: 8000,
    intervalMs: 150,       // 相邻请求最小间隔（全局限速）
    maxRequests: 300,      // 硬上限，超出立即停
    filterDanger: true,    // 跳过破坏性路径
    bodyCheck: true,       // 读响应体过滤假阳性
    stopOnThrottle: true   // 命中 429/503 停止
};

const AuthBypass = {
    BYPASS_SUFFIXES: [
        { suf: '', label: '原始' },
        { suf: ';.css', label: ';.css' },
        { suf: ';.js', label: ';.js' },
        { suf: ';.ico', label: ';.ico' },
        { suf: ';.png', label: ';.png' },
        { suf: ';.html', label: ';.html' },
        { suf: '.css', label: '.css' },
        { suf: '.js', label: '.js' },
        { suf: '.ico', label: '.ico' },
        { suf: '.png', label: '.png' },
        { suf: '.html', label: '.html' },
        { suf: '%23/', label: '%23/' },
        { suf: '#/', label: '#/' },
        { suf: '?a=1', label: '?a=1' }
    ],
    // 破坏性/会话类路径：绝不探测（用户红线：不登出、不删改数据）
    DANGER_RE: /(?:^|[\/_.\-?=&])(logout|signout|sign-?out|loginout|exit|delete|del|remove|drop|truncate|clear|reset|revoke|kill|shutdown|reboot|restart|destroy|disable|unbind|unlink|deauth|unsubscribe)(?:[\/_.\-?=&]|$)/i,
    // 静态资源 / 噪声（apis 分类中的日期格式串、图片等）
    NOISE_RE: /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|eot|mp[34]|pdf|zip)(?:\?|$)/i,
    NOISE_TEXT_RE: /\s|\{|\}|\[|\]|<|>|\\/,
    DATE_RE: /^\d{1,4}[\/\-.]\d{1,4}[\/\-.]\d{1,4}$/,
    // 日期/时间模板串（MM/D/YYYY、yyyy-mm-dd、HH:mm:ss…）：apis 分类里的常见误报
    NAMED_DATE_RE: /^(?:[YMDHhms]{1,4}[\/\-._:]){2,}[YMDHhms]{1,4}$/,

    cfg: { ...AB_DEFAULT_CFG },
    _loaded: false,
    _cursor: 0,
    _lastAt: 0,
    aborted: false,
    abortReason: '',

    async load() {
        try {
            const d = await API.storage.local.get([AB_CFG_KEY]);
            if (d[AB_CFG_KEY]) Object.assign(this.cfg, d[AB_CFG_KEY]);
        } catch {}
        this._loaded = true;
        return { ...this.cfg };
    },
    async save(patch) {
        Object.assign(this.cfg, patch || {});
        try { await API.storage.local.set({ [AB_CFG_KEY]: this.cfg }); } catch {}
        return { ...this.cfg };
    },

    /** 候选是否值得探测（过滤破坏性路径与噪声） */
    isProbeable(api) {
        const p = String(api || '').trim();
        if (!p || p.length > 300) return false;
        const path = (() => { try { return new URL(p, 'http://x.invalid').pathname; } catch { return p; } })();
        if (this.NOISE_TEXT_RE.test(p)) return false;
        if (this.NOISE_RE.test(path)) return false;
        const bare = path.replace(/^\//, '');
        if (this.DATE_RE.test(bare)) return false;
        if (this.NAMED_DATE_RE.test(bare)) return false;
        if (this.cfg.filterDanger !== false && this.DANGER_RE.test(path)) return false;
        return true;
    },

    /** 生成某个 API 的全部绕过变体 */
    buildVariants(baseUrl, apiPath) {
        if (!apiPath) return [];
        let base = (baseUrl || '').replace(/\/+$/, '');
        let p = String(apiPath).trim();
        if (!/^https?:\/\//i.test(p) && !p.startsWith('//')) {
            if (!p.startsWith('/')) p = '/' + p;
            p = base + p;
        } else if (p.startsWith('//')) {
            p = 'http:' + p;
        }
        const m = p.match(/^([^?#]+)(.*)$/);
        if (!m) return [];
        const main = m[1], tail = m[2] || '';
        return this.BYPASS_SUFFIXES.map(v => ({ url: main + v.suf + tail, label: v.label, variant: v.suf }));
    },

    async _throttle() {
        const gap = Number(this.cfg.intervalMs) || 0;
        const now = Date.now();
        const wait = Math.max(0, this._lastAt + gap - now);
        this._lastAt = now + wait;
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
    },

    async fetchWithTimeout(url, opts, timeoutMs) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs || this.cfg.timeout || 8000);
        try {
            return await fetch(url, { ...opts, signal: ctl.signal });
        } finally { clearTimeout(timer); }
    },

    /** 探测单个 URL：不带 Cookie（credentials: omit）请求 */
    async probe(url) {
        await this._throttle();
        this._cursor++;
        if (this._cursor > (Number(this.cfg.maxRequests) || 300)) {
            this.aborted = true;
            this.abortReason = '达到单次请求上限';
            return { error: '达到单次请求上限', skipped: true };
        }
        let res;
        try {
            res = await this.fetchWithTimeout(url, {
                method: 'GET',
                credentials: 'omit',
                redirect: 'manual',
                headers: { 'Accept': '*/*' }
            });
        } catch (e) {
            return { error: String((e && e.message) || e) };
        }
        const status = res.status;
        // 风控/限流：立即停止整轮扫描
        if (this.cfg.stopOnThrottle !== false && (status === 429 || status === 503 || status === 412)) {
            this.aborted = true;
            this.abortReason = `目标返回 ${status}（疑似风控/限流），已停止探测`;
        }
        // redirect:'manual' → 3xx 会以 status 0（opaqueredirect）返回：那是登录跳转，不是未授权
        if (!status) return { status: 0, redirect: true, unauth: false, reason: '跳转/不透明响应（多为登录跳转）' };

        const mime = (res.headers && res.headers.get('content-type')) || '';
        let text = '';
        if (this.cfg.bodyCheck !== false && status < 400) {
            try { text = String(await res.text()).slice(0, 32768); } catch {}
        }
        const authLike = this.cfg.bodyCheck !== false && (
            /(请先登录|请登录|未登录|登录已过期|登录失效|会话失效|会话过期|重新登录|无权限|权限不足|unauthorized|not\s*logged|login\s*required|invalid\s*token|token\s*(?:已)?(?:失效|过期))/i.test(text) ||
            /<title>[^<]{0,40}登录/i.test(text) ||
            /"(?:code|status)"\s*:\s*(?:401|403)\b/.test(text)
        );
        const len = text.length;
        const looksHtml = /^\s*<(?:!doctype|html)/i.test(text);
        const unauth = status < 400 && !authLike && (status === 204 || len > 0);
        let reason = '';
        if (unauth) reason = '无凭证可访问且响应不像登录/鉴权失败';
        else if (authLike) reason = '响应内容判定为鉴权失败（假阳性已过滤）';
        else if (looksHtml && len < 1024) reason = '疑似空壳 HTML';
        return {
            status, mime, length: len, authLike, unauth, reason,
            preview: text.slice(0, 200).replace(/\s+/g, ' ')
        };
    },

    async pMap(items, mapper, concurrency) {
        const results = new Array(items.length);
        let idx = 0;
        const worker = async () => {
            while (idx < items.length) {
                if (this.aborted) return;
                const i = idx++;
                results[i] = await mapper(items[i], i);
            }
        };
        const n = Math.min(Math.max(1, concurrency || 1), Math.max(1, items.length));
        await Promise.all(Array.from({ length: n }, () => worker()));
        return results;
    },

    /**
     * 主入口
     * @param {object} input { apis, bases, limit, dryRun, onProgress }
     *   dryRun=true 只生成变体 URL，不发请求（用于预览）
     */
    async run(input = {}) {
        if (!this._loaded) await this.load();
        this._cursor = 0;
        this.aborted = false;
        this.abortReason = '';
        const allApis = Array.isArray(input.apis) ? input.apis : [];
        const bases = Array.isArray(input.bases) && input.bases.length ? input.bases : [{ url: '', rule: 'relative' }];
        const limit = Math.max(1, Math.min(Number(input.limit) || this.cfg.limit || 20, 100));
        const skipped = { danger: [], noise: [] };
        const usable = [];
        for (const a of allApis) {
            if (usable.length >= limit) break;
            const p = String(a || '').trim();
            if (!p) continue;
            if (this.isProbeable(p)) usable.push(p);
            else if (this.cfg.filterDanger !== false && this.DANGER_RE.test(p)) skipped.danger.push(p);
            else skipped.noise.push(p);
        }
        const items = [];
        const seen = new Set();
        for (const api of usable) {
            for (const b of bases) {
                for (const v of this.buildVariants((b && b.url) || '', api)) {
                    const k = v.url.toLowerCase();
                    if (seen.has(k)) continue;
                    seen.add(k);
                    items.push({ ...v, api, baseUrl: (b && b.url) || '', baseRule: (b && b.rule) || '' });
                }
            }
        }
        const meta = {
            apiCount: usable.length,
            maxRequests: Number(this.cfg.maxRequests) || 300,
            variantCount: this.BYPASS_SUFFIXES.length,
            requestCount: items.length,
            skippedDanger: skipped.danger.slice(0, 20),
            skippedNoiseCount: skipped.noise.length,
            bases: bases.map(b => b.url).filter(Boolean)
        };
        if (input.dryRun) return { ok: true, dryRun: true, items, meta, total: items.length, results: [], unauthCount: 0 };

        const probed = await this.pMap(items, async (it) => {
            const r = await this.probe(it.url);
            return { ...it, ...r };
        }, this.cfg.concurrency);

        const results = probed.filter(r => r && r.unauth === true);
        const attempted = probed.filter(r => r && !r.skipped).length;
        return {
            ok: true,
            results,
            probed: attempted,
            unauthCount: results.length,
            total: items.length,
            aborted: this.aborted,
            abortReason: this.abortReason,
            meta,
            note: this.aborted ? this.abortReason : ''
        };
    }
};

/* =====================================================================
 * 5. Hook 脚本注册表：动态注册 hooks/*.js 到主世界(document_start)
 *    支持标准模式(按域名) / 全局模式(<all_urls>)
 * ===================================================================== */
const HookRegistry = {
    registry: new Map(), // `${prefix}|${hookId}` -> 注册ID
    MODE_KEY: 'le_mode',
    GLOBAL_KEY: 'le_global_hooks',
    initialized: false,

    // hooks.json 元数据 → id 到实际文件的映射（含存在性探测与兜底）
    meta: null,          // Map<id, {file, name, category}>
    resolved: new Map(), // id -> 'hooks/xxx.js' | null
    missing: [],         // 探测不到文件的 hook id

    async loadMeta() {
        if (this.meta) return this.meta;
        if (this._metaPromise) return this._metaPromise;
        this._metaPromise = (async () => {
            const map = new Map();
            let list = [];
            try {
                const res = await fetch(API.runtime.getURL('hooks.json'));
                list = await res.json();
            } catch (e) {
                console.error('[HAPPYJS] 读取 hooks.json 失败:', e);
            }
            this.missing = [];
            for (const h of list) {
                if (!h || !h.id) continue;
                map.set(h.id, h);
                const file = await this.resolveFile(h);
                this.resolved.set(h.id, file);
                if (!file) this.missing.push(h.id);
            }
            if (this.missing.length) {
                console.error('[HAPPYJS] 以下 Hook 脚本未找到对应文件，将无法注入:', this.missing.join(', '));
            }
            this.meta = map;
            return map;
        })();
        return this._metaPromise;
    },

    async fileExists(path) {
        try {
            const r = await fetch(API.runtime.getURL(path));
            return r.ok;
        } catch { return false; }
    },

    // 候选顺序：hooks.json 的 file 字段 → <id>.js → 常见前缀变体（a_/b_/c_/f_ + 去 hook_ 前缀）
    async resolveFile(h) {
        const id = String(h.id);
        const bare = id.replace(/^hook_/, '');
        const cands = [h.file, `${id}.js`, `a_${bare}.js`, `b_${bare}.js`, `c_${bare}.js`, `f_${bare}.js`]
            .filter(Boolean)
            .filter((v, i, a) => a.indexOf(v) === i);
        for (const c of cands) {
            const p = `hooks/${c}`;
            if (await this.fileExists(p)) return p;
        }
        return null;
    },

    async init() {
        if (this.initialized) return;
        this.initialized = true;
        try {
            const registered = await API.scripting.getRegisteredContentScripts();
            // 仅清理 Hook 注册项，保留控制台捕获（leauto_）等其他注册
            const ours = registered.filter(s => s.id.startsWith('le_'));
            if (ours.length) await API.scripting.unregisterContentScripts({ ids: ours.map(s => s.id) });
        } catch (e) { console.error('[LatentEye] HookRegistry init:', e); }
        await this.loadMeta();
    },

    async clearMode(isGlobal) {
        const toRemove = [];
        for (const key of this.registry.keys()) {
            if (isGlobal ? key.startsWith('global|') : (!key.startsWith('global|') && key.includes('|'))) {
                toRemove.push(key);
            }
        }
        if (toRemove.length) {
            try { await API.scripting.unregisterContentScripts({ ids: toRemove.map(k => this.registry.get(k)) }); }
            catch (e) { if (!/Nonexistent/.test(e.message)) console.error(e); }
            toRemove.forEach(k => this.registry.delete(k));
        }
    },

    async sync(hostname, hookIds, isGlobal) {
        if (!isGlobal && (!hostname || !hostname.includes('.'))) return;
        await this.loadMeta();
        const prefix = isGlobal ? 'global' : hostname;
        const valid = (hookIds || []).filter(id => typeof id === 'string' && id.trim());
        const want = new Set(valid.map(id => `${prefix}|${id}`));

        // 注销不再需要的
        const toRemove = [];
        for (const [key] of this.registry) {
            if (key.startsWith(`${prefix}|`) && !want.has(key)) toRemove.push(key);
        }
        if (toRemove.length) {
            try { await API.scripting.unregisterContentScripts({ ids: toRemove.map(k => this.registry.get(k)) }); }
            catch (e) { if (!/Nonexistent/.test(e.message)) console.error(e); }
            toRemove.forEach(k => this.registry.delete(k));
        }

        // 注册新增的（文件缺失的跳过并登记告警）
        const toAdd = [];
        this.missing = [];
        for (const id of valid) {
            const key = `${prefix}|${id}`;
            if (this.registry.has(key)) continue;
            const file = this.resolved.get(id);
            if (!file) {
                if (!this.missing.includes(id)) this.missing.push(id);
                continue;
            }
            const regId = genId();
            this.registry.set(key, regId);
            toAdd.push({
                id: regId,
                js: [file],
                matches: isGlobal ? ['<all_urls>'] : [`*://${hostname}/*`],
                runAt: 'document_start',
                world: 'MAIN'
            });
        }
        if (toAdd.length) {
            try { await API.scripting.registerContentScripts(toAdd); }
            catch (e) {
                console.error('[HAPPYJS] register hooks failed:', e);
                // 注册失败时回滚登记，避免下次误判为已注册
                for (const r of toAdd) {
                    for (const [k, v] of this.registry) if (v === r.id) this.registry.delete(k);
                }
            }
        }
        // 借鉴 v1.5.0：新开启的 Hook 立刻注入到已打开的匹配标签页（开启即时生效；关闭仍需刷新）
        if (toAdd.length) await this.injectToOpenTabs(hostname, toAdd, isGlobal);
    },

    /** 把刚开启的 Hook 脚本立即注入已打开的目标标签（避免「开启后必须刷新页面」） */
    async injectToOpenTabs(hostname, toAdd, isGlobal) {
        const files = toAdd.map(r => r.js[0]).filter(Boolean);
        if (!files.length) return { injected: 0 };
        let injected = 0;
        try {
            const tabs = await API.tabs.query({});
            for (const tab of tabs) {
                if (!tab || tab.id == null || tab.id < 0) continue;
                const tabUrl = tab.url || tab.pendingUrl || '';
                if (!/^https?:/i.test(tabUrl)) continue;
                let matched = false;
                try { matched = isGlobal ? true : new URL(tabUrl).hostname === hostname; } catch { continue; }
                if (!matched) continue;
                try {
                    await API.scripting.executeScript({
                        target: { tabId: tab.id, frameIds: [0] },
                        world: 'MAIN',
                        files
                    });
                    injected++;
                    // 通知 content 重新下发 Hook 配置，让脚本读到最新开关
                    try { API.tabs.sendMessage(tab.id, { type: 'HOOKS_INJECTED', files, to: 'content' }).catch(() => {}); } catch {}
                } catch (e) { /* CSP 严格 / 受限页面：忽略，刷新后仍会由注册脚本生效 */ }
            }
        } catch (e) { console.error('[HAPPYJS] injectToOpenTabs:', e); }
        return { injected };
    },

    health() {
        const out = { missing: [...this.missing], resolved: {}, available: true };
        for (const [id, f] of this.resolved) out.resolved[id] = f;
        out.available = this.missing.length === 0;
        return out;
    }
};

/* =====================================================================
 * 6. webRequest 观测器：记录每标签页/每frame的JS文件 + 头指纹 + 统计
 *    同时向 ResourceIndex 写入全量资源（含第三方），供：
 *      · 「一键下载当前网站 JS」
 *      · MCP get_js_list / get_network_requests
 *    仅观测不拦截；Firefox 不支持 extraHeaders 时自动降级。
 * ===================================================================== */
const WebRequestObserver = {
    tabJs: {}, // tabId -> { frameId -> Set<jsUrl> }

    init() {
        API.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
            if (frameId === 0 && this.tabJs[tabId]) this.tabJs[tabId].clear?.();
        });
        API.webRequest.onBeforeRequest.addListener((d) => {
            const { tabId, url, type, frameId } = d;
            if (tabId < 0) return;
            // ① 全量资源索引（含第三方，供下载 / MCP 网络清单）
            ResourceIndex.record(tabId, { url, type, frameId, initiator: d.initiator, method: d.method });
            let isJs = type === 'script';
            if (!isJs) { try { isJs = /\.(?:js|mjs|jsx|ts|tsx)(\?|$)/i.test(new URL(url).pathname); } catch {} }
            if (!isJs) return;
            FingerprintEngine.handleAnalytics(url, tabId);
            try {
                const ini = new URL(d.initiator || '');
                const tgt = new URL(url);
                if (ini.hostname !== tgt.hostname) return; // 仅跟踪同源JS（第三方库单独识别）
            } catch {}
            if (!this.tabJs[tabId]) this.tabJs[tabId] = new Map();
            const fid = String(frameId);
            if (!this.tabJs[tabId].has(fid)) this.tabJs[tabId].set(fid, new Set());
            this.tabJs[tabId].get(fid).add(url);
        }, { urls: ['<all_urls>'] });

        // 请求完成：记录状态码（仅观测，不做拦截）
        API.webRequest.onCompleted.addListener((d) => {
            if (d.tabId < 0) return;
            ResourceIndex.complete(d.tabId, d.url, {
                status: d.statusCode,
                fromCache: !!d.fromCache
            });
        }, { urls: ['<all_urls>'] });

        API.webRequest.onHeadersReceived.addListener((d) => {
            if (d.tabId >= 0 && d.responseHeaders) {
                try { ResourceIndex.head(d.tabId, d.url, d.responseHeaders); } catch {}
            }
            if (d.type !== 'main_frame') return;
            if (!d.responseHeaders) return;
            // 异步处理，避免阻塞请求
            setTimeout(() => {
                FingerprintEngine.processHeaders(d.responseHeaders, d.tabId);
                API.cookies.getAll({ url: d.url }, (cookies) => {
                    if (cookies && cookies.length) {
                        FingerprintEngine.identifyFromCookie(cookies.map(c => c.name).join(';'), d.tabId);
                    }
                });
            }, 0);
            return { responseHeaders: d.responseHeaders };
        }, { urls: ['<all_urls>'] }, ['responseHeaders']);

        API.tabs.onRemoved.addListener((tabId) => {
            delete this.tabJs[tabId];
            FingerprintEngine.clear(tabId);
            ResourceIndex.clear(tabId);
            ConsoleStore.clear(tabId);
            JsTextCache.clear(tabId);
            JsPredictor.clear(tabId);
            DynamicCodeStore.clear(tabId);
        });
    },

    getTabJs(tabId, frameId) {
        return Array.from(this.tabJs[tabId]?.get(String(frameId)) || []);
    }
};

/* =====================================================================
 * 6.1 控制台捕获注册表：按需把 inject/capture_main.js 注入主世界
 *     与「MCP 服务」或设置页开关联动，默认关闭（零性能开销）
 * ===================================================================== */
const ConsoleCapture = {
    ID: 'leauto_console_capture',
    USER_KEY: 'le_console_capture_user',   // 用户在设置页的显式开关
    enabled: false,        // 实际生效状态 = userWanted || mcpWanted
    userWanted: false,
    mcpWanted: false,      // MCP 服务开启时自动联动
    _registered: false,

    async load() {
        try {
            const d = await API.storage.local.get([this.USER_KEY]);
            this.userWanted = d[this.USER_KEY] === true;
        } catch {}
        try {
            if (typeof MCPClient !== 'undefined' && MCPClient.cfg) {
                this.mcpWanted = !!MCPClient.cfg.enabled;
            }
        } catch {}
        await this.refresh();
        return this.state();
    },

    state() {
        return {
            enabled: this.enabled,
            userWanted: this.userWanted,
            mcpWanted: this.mcpWanted,
            registered: this._registered
        };
    },

    async setUser(on) {
        this.userWanted = !!on;
        try { await API.storage.local.set({ [this.USER_KEY]: this.userWanted }); } catch {}
        await this.refresh();
        return this.state();
    },

    async setMcp(on) {
        this.mcpWanted = !!on;
        await this.refresh();
        return this.state();
    },

    // 保持向后兼容：直接同步为指定状态（视为用户意图）
    async sync(enabled) { return this.setUser(!!enabled); },

    async refresh() {
        const want = this.userWanted || this.mcpWanted;
        this.enabled = want;
        try {
            const reg = await API.scripting.getRegisteredContentScripts();
            const mine = reg.filter(s => s.id === this.ID);
            if (want && !mine.length) {
                await API.scripting.registerContentScripts([{
                    id: this.ID,
                    js: ['inject/capture_main.js'],
                    matches: ['<all_urls>'],
                    runAt: 'document_start',
                    allFrames: true,
                    world: 'MAIN'
                }]);
                this._registered = true;
                console.log('[HAPPYJS] 控制台捕获已注册（刷新页面后生效）');
            } else if (!want && mine.length) {
                await API.scripting.unregisterContentScripts({ ids: [this.ID] });
                this._registered = false;
                console.log('[HAPPYJS] 控制台捕获已注销');
            } else {
                this._registered = mine.length > 0;
            }
        } catch (e) {
            console.error('[HAPPYJS] ConsoleCapture.refresh:', e);
        }
        return this._registered;
    }
};

/* =====================================================================
 * 6.2 页面资源采集（不依赖 content.js）
 *     直接从 background 用 chrome.scripting 采集，避免「页面在扩展重载前就已加载」
 *     导致 content 侧拿不到脚本清单（旧实现依赖 tabs.sendMessage，老页面无响应 → 列表为空）
 * ===================================================================== */
const PAGE_ASSET_FN = () => {
    const out = { js: [], title: document.title, url: location.href };
    const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
    /* 体积必须先建索引再收集。
     * DOM 的 <script src> 拿不到体积（size=0），只有 performance 有 transferSize/encodedBodySize，
     * 而 performance 的遍历顺序在 DOM 之后 —— 若按「收集顺序去重」，先到的空体积记录会把
     * 后面带体积的那条挤掉，结果就是真实站点同源 JS 的体积全部为 0（实测踩到）。
     * 这里先扫一遍 performance 建 URL→体积 映射，add() 时直接查表。 */
    const sizeByUrl = new Map();
    const perfUrls = [];
    try {
        performance.getEntriesByType('resource').forEach(e => {
            if (e.initiatorType !== 'script' && !/\.(?:js|mjs|jsx)(\?|$)/i.test(e.name)) return;
            perfUrls.push(e.name);
            const size = Math.round(e.transferSize || e.encodedBodySize || 0);
            if (size > 0) { try { sizeByUrl.set(new URL(e.name, location.href).href, size); } catch {} }
        });
    } catch {}
    const add = (u, source) => {
        const url = abs(u);
        if (!url || !/^https?:/i.test(url)) return;
        out.js.push({ url, source, size: sizeByUrl.get(url) || 0 });
    };
    try {
        document.querySelectorAll('script[src]').forEach(s => add(s.src || s.getAttribute('src'), 'script-tag'));
        document.querySelectorAll('link[rel="modulepreload"][href],link[rel="preload"][as="script"][href]')
            .forEach(l => add(l.href, 'modulepreload'));
    } catch {}
    // performance 里可能有 DOM 已看不到的（动态注入 / 已被移除的 script）
    try { perfUrls.forEach(u => add(u, 'performance')); } catch {}
    try {
        const re = /["'`]([^"'`\s<>()]{1,300}\.(?:js|mjs))(\?[^"'`\s<>()]*)?["'`]/g;
        document.querySelectorAll('script:not([src])').forEach(s => {
            const t = s.textContent || '';
            if (!t || t.length > 300000) return;
            let m, n = 0;
            while ((m = re.exec(t)) !== null && n++ < 300) add(m[1] + (m[2] || ''), 'inline-script');
        });
    } catch {}
    return out;
};

async function collectPageAssets(tabId) {
    const frameIds = [];
    try {
        const list = await API.webNavigation.getAllFrames({ tabId });
        if (Array.isArray(list) && list.length) frameIds.push(...list.map(f => f.frameId));
    } catch {}
    if (!frameIds.length) frameIds.push(0);

    const results = await Promise.all(frameIds.slice(0, 12).map(fid =>
        API.scripting.executeScript({ target: { tabId, frameIds: [fid] }, func: PAGE_ASSET_FN })
            .then(r => ({ fid, data: (r && r[0] && r[0].result) || null }))
            .catch(() => null)
    ));

    const pageUrl = ((results.find(r => r && r.fid === 0) || {}).data || {}).url || '';
    let pageHost = '';
    try { pageHost = new URL(pageUrl).hostname.toLowerCase(); } catch {}

    const js = [];
    const byUrl = new Map();
    for (const r of results) {
        if (!r || !r.data || !Array.isArray(r.data.js)) continue;
        for (const item of r.data.js) {
            if (!item || !item.url) continue;
            const prev = byUrl.get(item.url);
            if (prev) {
                // 同一 URL 可能先被 script-tag 收到（无体积）、后被 performance 收到（有体积）→ 回填
                if (!prev.size && item.size) prev.size = item.size;
                continue;
            }
            let host = '';
            try { host = new URL(item.url).hostname.toLowerCase(); } catch {}
            const rec = {
                url: item.url, host,
                path: (() => { try { return new URL(item.url).pathname; } catch { return ''; } })(),
                source: item.source, thirdParty: !!(pageHost && host && host !== pageHost),
                status: 0, size: item.size || 0, frameId: r.fid
            };
            byUrl.set(item.url, rec);
            js.push(rec);
        }
    }
    return { pageUrl, js };
}

/* =====================================================================
 * 6.3 CDP 兜底执行器（可选 · 需 debugger 权限）
 *     CSP 禁 eval / 开启 Trusted Types 时 scripting 无法执行任意字符串代码，
 *     改用调试协议 Runtime.evaluate 绕过（与主流浏览器 MCP 实现一致）。
 * ===================================================================== */
const CDPExecutor = {
    ALARM: 'le_cdp_idle',
    IDLE_MS: 90 * 1000,
    attached: new Map(),   // tabId -> { ts, contexts: Map<frameId, contextId> }
    _listening: false,

    available() { return !!(API.debugger && API.debugger.attach); },

    async hasPermission() {
        if (!this.available()) return false;
        try { return await API.permissions.contains({ permissions: ['debugger'] }); } catch { return false; }
    },

    _ensureListeners() {
        if (this._listening) return;
        this._listening = true;
        try {
            API.debugger.onEvent.addListener((source, method, params) => {
                const rec = this.attached.get(source.tabId);
                if (!rec || method !== 'Runtime.executionContextCreated') return;
                const ctx = params && params.context;
                if (!ctx || !ctx.auxData) return;
                if (ctx.auxData.isDefault === false) return;
                if (ctx.auxData.frameId == null) return;
                rec.contexts.set(String(ctx.auxData.frameId), ctx.id);
            });
            API.debugger.onDetach.addListener((source) => { this.attached.delete(source.tabId); });
        } catch (e) { console.error('[HAPPYJS] debugger 监听注册失败:', e); }
    },

    _send(tabId, method, params) {
        return new Promise((resolve, reject) => {
            try {
                API.debugger.sendCommand({ tabId }, method, params, (r) => {
                    if (API.runtime.lastError) reject(new Error(API.runtime.lastError.message));
                    else resolve(r);
                });
            } catch (e) { reject(e); }
        });
    },

    async attach(tabId) {
        const exist = this.attached.get(tabId);
        if (exist) { exist.ts = Date.now(); return exist; }
        if (!this.available()) throw new Error('当前浏览器不支持 chrome.debugger');
        if (!(await this.hasPermission())) throw new Error('未授予 debugger 权限（设置页 → CDP 深度执行）');
        await new Promise((resolve, reject) => {
            try {
                API.debugger.attach({ tabId }, '1.3', () => {
                    if (API.runtime.lastError) reject(new Error(API.runtime.lastError.message));
                    else resolve();
                });
            } catch (e) { reject(e); }
        });
        const rec = { ts: Date.now(), contexts: new Map() };
        this.attached.set(tabId, rec);
        this._ensureListeners();
        try { await this._send(tabId, 'Runtime.enable', {}); } catch {}
        try { API.alarms.create(this.ALARM, { periodInMinutes: 1 }); } catch {}
        return rec;
    },

    async detach(tabId) {
        if (!this.attached.has(tabId)) return;
        this.attached.delete(tabId);
        try { await new Promise((resolve) => API.debugger.detach({ tabId }, () => resolve())); } catch {}
    },

    async detachIdle() {
        const now = Date.now();
        for (const [tabId, rec] of Array.from(this.attached.entries())) {
            if (now - rec.ts > this.IDLE_MS) await this.detach(tabId);
        }
        if (!this.attached.size) { try { API.alarms.clear(this.ALARM); } catch {} }
    },

    /** 结果序列化包装（returnByValue 遇循环引用会报错，故兜一层 stringify） */
    _wrap(expression) {
        return `(() => { const v = (${expression}); let s; try { s = JSON.stringify(v, function (k, x) {
            if (typeof x === 'function') return '[Function ' + (x.name || 'anonymous') + ']';
            if (typeof x === 'bigint') return String(x) + 'n';
            if (typeof x === 'symbol') return String(x);
            if (x instanceof Error) return { message: x.message, stack: x.stack };
            return x;
        }, 2); } catch (e) { s = undefined; } if (s === undefined) { try { s = String(v); } catch (e) { s = '[结果不可序列化]'; } } return s; })()`;
    },

    _isSerializationError(text) {
        return /returned by value|circular|reference chain|too long|Cannot serialize/i.test(String(text || ''));
    },

    async evaluate(tabId, frameId, expression, awaitPromise = true) {
        const rec = await this.attach(tabId);
        rec.ts = Date.now();
        const ctxId = rec.contexts.get(String(frameId == null ? 0 : frameId));
        const attempt = async (expr) => {
            const params = { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true, timeout: 30000 };
            if (ctxId) params.contextId = ctxId;
            return this._send(tabId, 'Runtime.evaluate', params);
        };
        const shape = (out) => {
            if (out && out.exceptionDetails) {
                const ex = out.exceptionDetails;
                const msg = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || 'CDP 执行抛错';
                return { ok: false, error: String(msg) };
            }
            const r = out && out.result;
            let val;
            if (r) {
                if ('value' in r && r.value !== undefined) val = r.value;
                else if (r.unserializableValue != null) val = String(r.unserializableValue);
                else if (r.description != null) val = String(r.description);
                else val = r.type || 'undefined';
            }
            let result = typeof val === 'string' ? val : (val === undefined ? 'undefined' : JSON.stringify(val, null, 2));
            const MAX = 48000;
            if (typeof result === 'string' && result.length > MAX) result = result.slice(0, MAX) + '\n…[结果过长已截断]';
            return { ok: true, result, cdp: true };
        };

        let res = shape(await attempt(expression));
        if (!res.ok && this._isSerializationError(res.error)) res = shape(await attempt(this._wrap(expression)));
        return res;
    },

    async evaluateSafe(tabId, frameId, code, awaitPromise = true) {
        try {
            if (!this.available()) return { ok: false, error: '当前浏览器不支持 chrome.debugger' };
            if (!(await this.hasPermission())) return { ok: false, error: '未授予 debugger 权限' };
            return await this.evaluate(tabId, frameId, code, awaitPromise);
        } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    }
};

try {
    API.alarms.onAlarm.addListener((a) => { if (a.name === CDPExecutor.ALARM) CDPExecutor.detachIdle(); });
} catch (e) { /* 忽略 */ }

/* =====================================================================
 * 6.4 启动自检：把「哪一块没起来」变成可读诊断，避免只看到「后台未就绪」
 * ===================================================================== */
const HealthCheck = {
    errors: [],
    startedAt: Date.now(),
    note(section, e) {
        const msg = `${section}: ${(e && e.message) || e}`;
        this.errors.push(msg);
        console.error('[HAPPYJS] 初始化异常 →', msg);
    },
    _has(fn) { try { return fn() === true; } catch (e) { return false; } },

    async snapshot() {
        const chk = (fn) => this._has(fn);
        const out = {
            version: (() => { try { return API.runtime.getManifest().version; } catch { return ''; } })(),
            uptimeMs: Date.now() - this.startedAt,
            errors: this.errors.slice(-20),
            missingModules: [],
            permissions: {
                downloads: !!(API.downloads && API.downloads.download),
                debugger: await CDPExecutor.hasPermission()
            },
            hooks: { missing: [], resolved: {} },
            mcp: null,
            consoleCapture: null,
            modules: {}
        };
        out.modules = {
            HappyZip: chk(() => typeof HappyZip === 'object'),
            ResourceIndex: chk(() => typeof ResourceIndex === 'object'),
            DownloadManager: chk(() => typeof DownloadManager === 'object'),
            ConsoleStore: chk(() => typeof ConsoleStore === 'object'),
            JsTextCache: chk(() => typeof JsTextCache === 'object'),
            JsBeautifier: chk(() => typeof JsBeautifier === 'object'),
            HeimdallrModule: chk(() => typeof HeimdallrModule === 'object'),
            HookRegistry: chk(() => typeof HookRegistry === 'object'),
            MCPClient: chk(() => typeof MCPClient === 'object'),
            CDPExecutor: chk(() => typeof CDPExecutor === 'object'),
            SiteScope: chk(() => typeof SiteScope === 'object'),
            ChunkFinder: chk(() => typeof ChunkFinder === 'object'),
            RouteFinder: chk(() => typeof RouteFinder === 'object'),
            JsPredictor: chk(() => typeof JsPredictor === 'object'),
            DynamicCodeStore: chk(() => typeof DynamicCodeStore === 'object')
        };
        out.missingModules = Object.entries(out.modules).filter(([, v]) => !v).map(([k]) => k);
        try { out.mcp = typeof MCPClient !== 'undefined' ? MCPClient.getStatus() : null; } catch {}
        try { out.consoleCapture = ConsoleCapture.state(); } catch {}
        try { Object.assign(out.hooks, HookRegistry.health()); } catch {}
        out.ok = out.missingModules.length === 0 && out.errors.length === 0;
        return out;
    }
};

/* =====================================================================
 * 6.5 站点 JS 清单汇总：webRequest 观测 + 页面侧 DOM/performance 采集
 * ===================================================================== */
/**
 * 站点范围分类（借鉴 hybrid_capture_project2 的域过滤体系）
 *   site / cdn / noise / thirdparty —— 用于「仅本站 JS」的精准过滤
 * 页面域未知时返回 null，调用方退回旧的同源比较逻辑。
 */
function scopeOf(url, pageHost, extraHosts) {
    if (!pageHost || typeof SiteScope === 'undefined') return null;
    try { return SiteScope.classify(url, pageHost, extraHosts).scope; } catch { return null; }
}

/** 构建清单探测结果是否已在缓存（供覆盖对账复用） */
async function collectTabJsUrls(tabId, opts = {}) {
    const out = new Map();
    const pageHost = (() => {
        try { return new URL(opts.pageUrl || '').hostname.toLowerCase(); } catch { return ''; }
    })();
    const extras = opts.extraHosts || [];

    for (const r of ResourceIndex.listJs(tabId, { includeThirdParty: true, skipMin: !!opts.skipMin })) {
        out.set(r.url, {
            url: r.url, host: r.host, path: r.path,
            source: 'webRequest', thirdParty: !!r.thirdParty,
            scope: scopeOf(r.url, pageHost, extras),
            status: r.status || 0, size: r.size || 0,
            sizeSource: r.size ? 'header' : '',
            frameId: r.frameId
        });
    }

    if (opts.mergePageCollect !== false) {
        // ① 首选：background 直接注入采集（不依赖 content.js 版本 / 不受老页面影响）
        try {
            const page = await collectPageAssets(tabId);
            if (page.pageUrl && !opts.pageUrl) opts.pageUrl = page.pageUrl;
            const ph = (() => { try { return new URL(page.pageUrl || '').hostname.toLowerCase(); } catch { return ''; } })();
            for (const item of page.js) {
                const prev = out.get(item.url);
                if (prev) {
                    /* 回填体积：webRequest 侧只有 Content-Length，而压缩 / chunked 响应往往不返回它
                     * （实测真实站点同源 JS 全部为 0），页面 performance 的 transferSize 更可靠 ——
                     * 不要因为「URL 已存在」就把这个更有价值的信息丢掉。 */
                    if (!prev.size && item.size) { prev.size = item.size; prev.sizeSource = 'performance'; }
                    continue;
                }
                out.set(item.url, {
                    url: item.url, host: item.host, path: item.path,
                    source: item.source, thirdParty: !!(ph && item.host && item.host !== ph),
                    scope: scopeOf(item.url, ph || pageHost, extras),
                    status: 0, size: item.size || 0,
                    sizeSource: item.size ? 'performance' : '',
                    frameId: item.frameId
                });
            }
        } catch (e) {
            HealthCheck.note('collectPageAssets', e);
        }
        // ② 补充：content.js 上报（含它自己递归发现的 chunk，旧版 content 不响应也无妨）
        let frames = [0];
        try {
            const fs = await API.webNavigation.getAllFrames({ tabId });
            if (Array.isArray(fs) && fs.length) frames = fs.map(f => f.frameId);
        } catch {}
        const results = await Promise.all(frames.map(fid => new Promise((resolve) => {
            let done = false;
            const fin = (v) => { if (!done) { done = true; resolve(v); } };
            try {
                const p = API.tabs.sendMessage(tabId, { type: 'COLLECT_JS_URLS', to: 'content' }, { frameId: fid },
                    (r) => fin(API.runtime.lastError ? null : r));
                if (p && typeof p.then === 'function') p.then(fin).catch(() => fin(null));
            } catch { fin(null); }
            setTimeout(() => fin(null), 1500);
        })));
        for (const r of results) {
            if (!r || !Array.isArray(r.urls)) continue;
            for (const u of r.urls) {
                if (!u || !u.url) continue;
                const prev = out.get(u.url);
                if (prev) {
                    if (!prev.size && u.size) { prev.size = u.size; prev.sizeSource = 'performance'; }
                    continue;
                }
                let host = '';
                try { host = new URL(u.url).hostname.toLowerCase(); } catch {}
                out.set(u.url, {
                    url: u.url, host, path: (() => { try { return new URL(u.url).pathname; } catch { return ''; } })(),
                    source: u.source || 'page',
                    thirdParty: !!(pageHost && host && host !== pageHost),
                    scope: scopeOf(u.url, pageHost, extras),
                    status: 0, size: u.size || 0,
                    sizeSource: u.size ? 'performance' : '',
                    frameId: u.frameId
                });
            }
        }
    }

    /* 预测补齐：从已采集 JS 的源码里静态合成懒加载 chunk / 联邦远程入口 / 构建清单产物，
     * 把「没被访问过所以永远观测不到」的 JS 也补进清单（可选，默认关闭以免拖慢常规调用） */
    if (opts.predict && typeof JsPredictor !== 'undefined') {
        try {
            const pred = await JsPredictor.predictJsResources(tabId, {
                pageUrl: opts.pageUrl,
                includeThirdParty: !!opts.includeThirdParty,
                skipMin: !!opts.skipMin,
                verify: opts.verify !== false,
                maxVerify: opts.maxVerify,
                maxAnalyze: opts.maxAnalyze,
                baseList: Array.from(out.values())
            });
            for (const c of pred.candidates || []) {
                if (!c || !c.url || out.has(c.url)) continue;
                out.set(c.url, c);
            }
            opts._predictResult = pred;
        } catch (e) {
            HealthCheck.note('collectTabJsUrls.predict', e);
        }
    }

    let list = Array.from(out.values());
    if (!opts.includeThirdParty) list = list.filter(x => !x.thirdParty);
    // 精准范围过滤（site 排除 CDN 通用库与统计噪声）
    if (opts.scope) list = list.filter(x => x.scope === opts.scope);
    if (opts.skipMin) list = list.filter(x => !/\.min\.js$/i.test(x.path || ''));

    /* 状态码过滤（默认开启）：
     * 站点自己的失败回退脚本会把 404 地址混进 JS 清单（例如「先试 CDN 再试本地」的 loader，
     * 或把相对路径拼错），而浏览器下载接口对 404 **同样会落盘** —— 于是 HTML 错误页被存成 .js，
     * 之后检索与分析全被污染。这里默认排除 status >= 400；
     * status === 0 表示「尚未完成观测」，无法判断，保留。 */
    let excludedFailed = 0;
    if (opts.includeFailed !== true) {
        const before = list.length;
        list = list.filter(x => !((x.status || 0) >= 400));
        excludedFailed = before - list.length;
    }
    opts._excludedFailed = excludedFailed;
    return list;
}


/* =====================================================================
 * 6.3 JS 资源预测补齐（借鉴 hybrid_capture_project2）
 * =====================================================================
 * 背景：webRequest / DOM / performance 三路采集只能覆盖「浏览器真正请求过」的 JS。
 * 真实站点里大量代码在懒加载 chunk 里 —— 不访问对应路由就永远观测不到，
 * 于是「一键下载站点 JS」拿不全、接口提取漏掉一大片。
 *
 * 本模块从**已采集 JS 的源码**里静态推导出这些文件：
 *   ① webpack chunk 合成（ChunkFinder）—— 从 runtime 的 .u 映射 + 名称/哈希表
 *      还原出 chunk 文件名，合成 URL 后**逐个校验存在性**，只保留真实存在的；
 *   ② 构建清单探测 —— Vite 的 .vite/manifest.json、CRA/webpack 的
 *      asset-manifest.json 里写着**全部**构建产物，一次拿到全量；
 *   ③ Module Federation —— 跨源 remoteEntry.js（未触发远程模块时完全不可见）；
 *   ④ 路由提取（RouteFinder）—— 拿到 SPA 路由清单，供人工/工具逐条访问以触发懒加载。
 *
 * 所有网络动作都是**只读 GET**，并且逐个限速、有总量上限。
 * ===================================================================== */
const JsPredictor = {
    /* 构建清单候选路径（Vite / CRA / webpack-assets-manifest / Angular dist） */
    MANIFEST_PATHS: [
        '/.vite/manifest.json',
        '/manifest.json',
        '/asset-manifest.json',
        '/build/asset-manifest.json',
        '/static/asset-manifest.json',
        '/assets/manifest.json',
        '/webpack-assets.json',
        '/dist/manifest.json'
    ],
    MAX_ANALYZE_FILES: 24,               // 最多分析多少个 JS 源码
    MAX_ANALYZE_BYTES: 3 * 1024 * 1024,  // 单文件分析上限
    MAX_TOTAL_BYTES: 24 * 1024 * 1024,   // 分析总量上限
    MAX_CANDIDATES: 400,                 // 合成候选上限
    MAX_VERIFY: 60,                      // 默认校验多少个候选（校验 = 一次 GET）
    VERIFY_CONC: 4,                      // 校验并发
    CACHE_TTL: 10 * 60 * 1000,

    _cache: new Map(),                   // tabId -> { ts, candidates, routes, stats }

    clear(tabId) { this._cache.delete(tabId); },
    last(tabId) { return this._cache.get(tabId) || null; },

    /** base64 → UTF-8 文本 */
    b64ToText(b64) {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(u8);
    },

    /** 取 JS 源码：优先命中文档缓存，未命中则抓取并回填（供 search_in_js 复用） */
    async sourceOf(tabId, url, budget) {
        try {
            const hit = JsTextCache.get(tabId, url);
            if (typeof hit === 'string' && hit.length > 0) return hit.slice(0, this.MAX_ANALYZE_BYTES);
        } catch {}
        if (budget && budget.left <= 0) return null;
        try {
            const r = await FetchB64.fetch(url, tabId);
            if (!r || !r.ok || !r.base64) return null;
            const bytes = r.bytes || 0;
            if (bytes > this.MAX_ANALYZE_BYTES) return null;
            if (budget) budget.left -= bytes;
            const text = this.b64ToText(r.base64);
            try { JsTextCache.put(tabId, url, text); } catch {}
            return text;
        } catch { return null; }
    },

    /** 把清单 JSON 里的 JS 相对路径全部抽出来 */
    extractManifestFiles(json) {
        const files = new Set();
        const add = (v) => {
            if (typeof v !== 'string') return;
            const clean = v.split('?')[0];
            if (/\.(?:m?js)$/i.test(clean)) files.add(clean.replace(/^\/+/, ''));
        };
        if (!json || typeof json !== 'object') return files;

        // ① Vite / Rollup manifest：{ "src/main.js": { file, imports[], dynamicImports[] } }
        let viteLike = false;
        for (const key of Object.keys(json)) {
            const entry = json[key];
            if (entry && typeof entry === 'object' && typeof entry.file === 'string') {
                viteLike = true;
                add(entry.file);
                for (const listKey of ['imports', 'dynamicImports']) {
                    const list = entry[listKey];
                    if (!Array.isArray(list)) continue;
                    for (const dep of list) {
                        const depEntry = json[dep];
                        if (depEntry && typeof depEntry.file === 'string') add(depEntry.file);
                        else add(dep);   // 有些工具直接写路径
                    }
                }
            }
        }
        // ② CRA / webpack-assets-manifest：{ files: { "main.js": "static/js/main.abc.js" } }
        if (!viteLike && json.files && typeof json.files === 'object') {
            for (const v of Object.values(json.files)) add(v);
        }
        // ③ entrypoints 数组形式
        if (Array.isArray(json.entrypoints)) {
            for (const v of json.entrypoints) {
                if (typeof v === 'string') add(v);
                else if (v && typeof v === 'object') for (const x of Object.values(v)) add(x);
            }
        }
        // ④ 纯数组
        if (Array.isArray(json)) for (const v of json) add(v);
        return files;
    },

    /** 探测构建清单（同一 origin 只探一次），命中即把全部产物加入候选 */
    async probeManifests(tabId, origin, probed) {
        if (!origin || probed.has(origin)) return [];
        probed.add(origin);
        for (const path of this.MANIFEST_PATHS) {
            const url = origin + path;
            try {
                const r = await FetchB64.fetch(url, tabId);
                if (!r || !r.ok || !r.base64) continue;
                const mime = String(r.mime || '').toLowerCase();
                if (r.bytes > 8 * 1024 * 1024) continue;
                const text = this.b64ToText(r.base64);
                // 很多 SPA 会把未知路径回落到 index.html —— 不是 JSON 就跳过
                if (!/^[\s\r\n]*[[{]/.test(text)) continue;
                let json;
                try { json = JSON.parse(text); } catch { continue; }
                const files = this.extractManifestFiles(json);
                if (!files.size) continue;
                const out = [];
                for (const rel of files) {
                    out.push({
                        url: (/^https?:/i.test(rel) ? rel : origin + '/' + rel.replace(/^\/+/, '')),
                        source: 'build-manifest',
                        via: path
                    });
                }
                console.log(`[HAPPYJS] 构建清单命中 ${path}：${out.length} 个产物`);
                return out;
            } catch { /* 换下一条路径 */ }
        }
        return [];
    },

    /** 校验候选是否真实存在（GET 一次，只留 2xx 且像 JS 的），并把内容回填缓存 */
    async verifyCandidates(tabId, cands, maxVerify) {
        const limit = Math.max(1, Math.min(maxVerify || this.MAX_VERIFY, cands.length));
        const targets = cands.slice(0, limit);
        const rest = cands.slice(limit);
        const okList = [];
        const gone = [];
        let idx = 0;
        const worker = async () => {
            while (idx < targets.length) {
                const c = targets[idx++];
                try {
                    const r = await FetchB64.fetch(c.url, tabId);
                    const mime = String((r && r.mime) || '').toLowerCase();
                    const looksJs = mime.includes('javascript') || mime.includes('ecmascript') || mime.includes('text/plain');
                    if (r && r.ok && (!mime || looksJs)) {
                        c.exists = true;
                        c.size = r.bytes || 0;
                        if (r.base64) {
                            try {
                                const text = this.b64ToText(r.base64);
                                if (text.length <= this.MAX_ANALYZE_BYTES) JsTextCache.put(tabId, c.url, text);
                            } catch {}
                        }
                        okList.push(c);
                    } else {
                        c.exists = false;
                        gone.push(c.url);
                    }
                } catch { c.exists = false; gone.push(c.url); }
                await new Promise(res => setTimeout(res, 120));
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.VERIFY_CONC, targets.length) }, worker));
        return { okList, gone, unverified: rest };
    },

    /**
     * 主入口：产出「预测到的、真实存在的、还没被观测到」的 JS 候选。
     * @returns { candidates, routes, stats, manifests }
     */
    async predictJsResources(tabId, opts = {}) {
        const t0 = Date.now();
        let pageUrl = opts.pageUrl || '';
        if (!pageUrl && tabId != null) {
            try { pageUrl = (await API.tabs.get(tabId))?.url || ''; } catch {}
        }
        let pageHost = '';
        try { pageHost = new URL(pageUrl).hostname.toLowerCase(); } catch {}

        const baseList = Array.isArray(opts.baseList) && opts.baseList.length
            ? opts.baseList
            : await collectTabJsUrls(tabId, {
                includeThirdParty: true, skipMin: !!opts.skipMin, pageUrl,
                mergePageCollect: opts.mergePageCollect !== false
            });

        const known = new Set(baseList.map(x => x.url));

        /* ---- 选分析目标：站点自有优先，体积大的优先（runtime 通常在中大型文件里） ---- */
        const maxAnalyze = Math.max(1, Math.min(opts.maxAnalyze || this.MAX_ANALYZE_FILES, 60));
        const pool = baseList
            .filter(x => x && x.url && /^https?:/i.test(x.url))
            .filter(x => opts.includeThirdParty || x.scope === 'site' || x.scope == null)
            .filter(x => x.scope !== 'noise')
            .sort((a, b) => (b.size || 0) - (a.size || 0));
        const targets = pool.slice(0, maxAnalyze);

        const budget = { left: this.MAX_TOTAL_BYTES };
        const stats = {
            analyzedFiles: 0, analyzeFailed: 0, chunksSynthesized: 0,
            manifests: [], federation: 0, routes: 0, verified: 0, missing: 0
        };

        const chunkCands = [];
        const mfCands = [];
        const manifestCands = [];
        const routeBag = [];
        const probedOrigins = new Set();
        const seenUrl = new Set();
        const pushCand = (arr, url, source, extra) => {
            if (!url || !/^https?:/i.test(url)) return;
            if (known.has(url) || seenUrl.has(url)) return;
            if (seenUrl.size >= this.MAX_CANDIDATES * 2) return;
            seenUrl.add(url);
            let host = '', path = '';
            try { const u = new URL(url); host = u.hostname.toLowerCase(); path = u.pathname; } catch {}
            arr.push({
                url, host, path, source,
                thirdParty: !!(pageHost && host && host !== pageHost),
                scope: scopeOf(url, pageHost, opts.extraHosts || []),
                status: 0, size: 0, frameId: 0, predicted: true,
                ...(extra || {})
            });
        };

        for (const t of targets) {
            const src = await this.sourceOf(tabId, t.url, budget);
            if (!src) { stats.analyzeFailed++; continue; }
            stats.analyzedFiles++;

            // ① chunk 合成
            try {
                const chunks = ChunkFinder.discoverChunks(src, t.url, { limit: 120 });
                stats.chunksSynthesized += chunks.length;
                for (const c of chunks) {
                    pushCand(chunkCands, c.url, 'chunk-predict', { chunkName: c.chunkName, hash: c.hash, strategy: c.strategy, fromJs: t.url });
                }
            } catch (e) { HealthCheck.note('JsPredictor.chunks', e); }

            // ② Module Federation 远程入口
            try {
                const remotes = ChunkFinder.discoverFederationRemotes(src, t.url);
                stats.federation += remotes.length;
                for (const r of remotes) {
                    // 联邦远程是宿主应用自己的模块，跨源也要抓（但仍排除统计噪声域）
                    if (pageHost && typeof SiteScope !== 'undefined' && SiteScope.isNoise(r.url)) continue;
                    pushCand(mfCands, r.url, 'mf-remote', { remoteName: r.remoteName, strategy: r.strategy, fromJs: t.url });
                }
            } catch (e) { HealthCheck.note('JsPredictor.federation', e); }

            // ③ 路由提取（供人工逐条访问触发懒加载）
            try {
                const routes = RouteFinder.extractRoutes(src, t.url);
                if (routes.length) routeBag.push(routes);
            } catch (e) { HealthCheck.note('JsPredictor.routes', e); }

            // ④ Vite 产物 → 探测构建清单
            try {
                if (ChunkFinder.looksLikeViteAsset(t.url)) {
                    let origin = '';
                    try { origin = new URL(t.url).origin; } catch {}
                    const mf = await this.probeManifests(tabId, origin, probedOrigins);
                    if (mf.length) {
                        stats.manifests.push(origin);
                        for (const m of mf) pushCand(manifestCands, m.url, 'build-manifest', { via: m.via, fromJs: t.url });
                    }
                }
            } catch (e) { HealthCheck.note('JsPredictor.manifest', e); }
        }

        // 站点自有的构建清单也试一次（有些站根路径就有 manifest.json）
        try {
            if (pageHost && !probedOrigins.size) {
                let origin = '';
                try { origin = new URL(pageUrl).origin; } catch {}
                const mf = await this.probeManifests(tabId, origin, probedOrigins);
                if (mf.length) {
                    stats.manifests.push(origin);
                    for (const m of mf) pushCand(manifestCands, m.url, 'build-manifest', { via: m.via });
                }
            }
        } catch {}

        /* ---- 校验：构建清单/联邦入口来自权威来源，直接保留；chunk 合成是猜的，必须校验 ---- */
        const authoritative = manifestCands.concat(mfCands).slice(0, this.MAX_CANDIDATES);
        let synthetic = chunkCands.slice(0, this.MAX_CANDIDATES);
        if (opts.verify !== false) {
            const v = await this.verifyCandidates(tabId, synthetic, opts.maxVerify);
            stats.verified = v.okList.length;
            stats.missing = v.gone.length;
            synthetic = v.okList;
            // 联邦/清单也顺手校验一下（数量通常很小），拿到内容还能供 search_in_js 用
            try {
                const v2 = await this.verifyCandidates(tabId, authoritative, Math.min(20, authoritative.length));
                const okSet = new Set(v2.okList.map(x => x.url));
                for (const a of authoritative) if (!okSet.has(a.url) && a.exists !== true) a.exists = undefined;
            } catch {}
        } else {
            for (const c of synthetic) c.exists = undefined;
        }

        const candidates = authoritative.concat(synthetic).slice(0, this.MAX_CANDIDATES);

        const mergedRoutes = typeof RouteFinder !== 'undefined'
            ? RouteFinder.mergeRoutes(routeBag) : { routes: [], stats: { total: 0, static: 0, dynamic: 0 } };
        const routeUrls = RouteFinder.routesToUrls(mergedRoutes.routes, pageUrl).slice(0, 300);
        stats.routes = mergedRoutes.stats.total;

        const result = {
            ok: true,
            tabId, pageUrl,
            candidates,
            routes: routeUrls,
            routeStats: mergedRoutes.stats,
            stats: { ...stats, candidateCount: candidates.length, elapsedMs: Date.now() - t0 },
            note: candidates.length
                ? `预测补齐 ${candidates.length} 个未观测到的 JS（chunk 合成 ${synthetic.length} / 构建清单 ${manifestCands.length} / 联邦远程 ${mfCands.length}）`
                : '未发现可补齐的 JS：目标可能不是 webpack/Vite 构建，或源码已被缓存清理（可先刷新页面再试）'
        };
        this._cache.set(tabId, { ts: Date.now(), ...result });
        return result;
    },

    /**
     * 覆盖对账（借鉴 hybrid_capture_project2 的 js_coverage）：候选 vs 可下载，缺口在哪。
     */
    async coverage(tabId, opts = {}) {
        let pageUrl = opts.pageUrl || '';
        if (!pageUrl && tabId != null) {
            try { pageUrl = (await API.tabs.get(tabId))?.url || ''; } catch {}
        }
        let pageHost = '';
        try { pageHost = new URL(pageUrl).hostname.toLowerCase(); } catch {}

        const observed = await collectTabJsUrls(tabId, {
            includeThirdParty: true, skipMin: !!opts.skipMin, pageUrl
        });
        const last = this.last(tabId);
        const predicted = (last && Date.now() - last.ts < this.CACHE_TTL) ? (last.candidates || []) : [];
        const hasPredict = predicted.length > 0;

        const union = new Map();
        for (const x of observed) union.set(x.url, x);
        for (const x of predicted) if (!union.has(x.url)) union.set(x.url, x);

        const bySource = {};
        let siteTotal = 0, siteObserved = 0;
        for (const x of union.values()) {
            const key = x.predicted ? (x.source || 'predicted') : (x.source || 'observed');
            bySource[key] = (bySource[key] || 0) + 1;
            if (x.scope === 'site' || x.scope == null) {
                siteTotal++;
                if (!x.predicted) siteObserved++;
            }
        }
        const sites = SiteScope && typeof SiteScope.classify === 'function';

        return {
            ok: true,
            tabId, pageUrl,
            hasPredict,
            predictAgeMs: last ? Date.now() - last.ts : null,
            total: union.size,
            observedCount: observed.length,
            predictedCount: predicted.length,
            bySource,
            site: { total: siteTotal, observed: siteObserved, gap: siteTotal - siteObserved },
            gapUrls: Array.from(union.values()).filter(x => x.predicted && (x.scope === 'site' || x.scope == null))
                .slice(0, 100).map(x => ({ url: x.url, source: x.source })),
            routes: (last && last.routes) || [],
            routesAvailable: !!(last && last.routes && last.routes.length),
            scopeAvailable: !!sites,
            note: hasPredict
                ? `可下载 JS 共 ${union.size} 个（观测 ${observed.length} + 预测补齐 ${predicted.length}）；覆盖率 ${union.size ? Math.round(observed.length / union.size * 100) : 100}%`
                : '尚未做预测补齐：点「预测补齐」后再看覆盖率（当前仅有浏览器实际观测到的 JS）'
        };
    }
};


/* =====================================================================
 * 6.4 动态代码存储（blob: / eval / Function 捕获）
 * =====================================================================
 * 这类代码**不是网络请求**，webRequest 与页面 DOM 采集都看不到，
 * 只能靠主世界 Hook（hooks/hook_dynamic_code.js）抓。
 * 抓到的内容存这里，供 popup 导出为文件、供 MCP get_dynamic_code 读取分析。
 * ===================================================================== */
const DynamicCodeStore = {
    MAX_ENTRIES: 120,                    // 单标签页条数上限
    MAX_TOTAL: 8 * 1024 * 1024,          // 单标签页总字节上限
    tabs: new Map(),
    seq: 0,

    _entry(tabId) {
        let t = this.tabs.get(tabId);
        if (!t) { t = { list: [], bytes: 0 }; this.tabs.set(tabId, t); }
        return t;
    },

    add(tabId, item) {
        if (tabId == null || tabId < 0 || !item || !item.code) return null;
        const t = this._entry(tabId);
        const code = String(item.code);
        if (!code) return null;
        const rec = {
            id: ++this.seq,
            kind: String(item.kind || 'unknown'),
            code,
            bytes: code.length,
            truncated: !!item.truncated,
            originalLength: item.originalLength || code.length,
            meta: item.meta || {},
            frameUrl: item.frameUrl || '',
            ts: Date.now()
        };
        t.list.push(rec);
        t.bytes += rec.bytes;
        // 双重上限：条数 + 字节，超了从最旧的丢
        while (t.list.length > this.MAX_ENTRIES || (t.bytes > this.MAX_TOTAL && t.list.length > 1)) {
            const old = t.list.shift();
            t.bytes -= old.bytes;
        }
        return rec;
    },

    list(tabId, opts = {}) {
        const t = this.tabs.get(tabId);
        if (!t) return { total: 0, bytes: 0, items: [] };
        let list = t.list;
        if (opts.kind) list = list.filter(x => x.kind === opts.kind);
        if (opts.withCode === false) list = list.map(x => ({ ...x, code: undefined, preview: x.code.slice(0, 200) }));
        const limit = Math.min(Math.max(1, opts.limit || 50), 200);
        return {
            total: list.length,
            bytes: t.bytes,
            kinds: t.list.reduce((m, x) => { m[x.kind] = (m[x.kind] || 0) + 1; return m; }, {}),
            truncated: list.length > limit,
            items: list.slice(-limit)
        };
    },

    stats(tabId) {
        const t = this.tabs.get(tabId);
        if (!t) return { count: 0, bytes: 0, kinds: {} };
        return {
            count: t.list.length,
            bytes: t.bytes,
            kinds: t.list.reduce((m, x) => { m[x.kind] = (m[x.kind] || 0) + 1; return m; }, {})
        };
    },

    clear(tabId) { this.tabs.delete(tabId); }
};

/* =====================================================================
 * 7. 初始化 + 消息路由
 * ===================================================================== */
API.runtime.onStartup.addListener(() => HookRegistry.init());
API.runtime.onInstalled.addListener(() => HookRegistry.init());

API.storage.local.get(null, (data) => {
    try {
        HookRegistry.init().then(() => {
            const mode = data[HookRegistry.MODE_KEY] || 'standard';
            const globalHooks = data[HookRegistry.GLOBAL_KEY] || [];
            if (mode === 'global' && globalHooks.length) HookRegistry.sync('*', globalHooks, true);
            if (mode === 'standard') {
                for (const key of Object.keys(data)) {
                    if (Array.isArray(data[key]) && key.includes('.')) HookRegistry.sync(key, data[key], false);
                }
            }
        }).catch(e => HealthCheck.note('HookRegistry.init', e));
    } catch (e) { HealthCheck.note('storage.local.get', e); }
});

// 存储变化时同步 Hook 注册
API.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
        if (key === HookRegistry.MODE_KEY) continue;
        if (key === HookRegistry.GLOBAL_KEY && Array.isArray(newValue)) {
            HookRegistry.sync('*', newValue, true);
            continue;
        }
        if (Array.isArray(newValue) && key.includes('.')) HookRegistry.sync(key, newValue, false);
    }
});

try { BadgeManager.init(); } catch (e) { HealthCheck.note('BadgeManager.init', e); }
// 云存储桶监测（被动检测 / 右键菜单 / 日志窗口）
try {
    if (typeof BucketSentinel !== 'undefined') BucketSentinel.init();
    else HealthCheck.note('BucketSentinel', new Error('bucket_bg.js 未加载'));
} catch (e) { HealthCheck.note('BucketSentinel.init', e); }
try { WebRequestObserver.init(); } catch (e) { HealthCheck.note('WebRequestObserver.init', e); }

API.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.to && msg.to !== 'background') return true;
    const tabId = sender.tab?.id ?? msg.tabId;
    const frameId = String(sender.frameId ?? msg.frameId ?? '0');
    // 云存储桶模块（BucketSentinel）消息委派：其类型与下方 switch 无重叠，优先路由
    try {
        if (typeof BucketSentinel !== 'undefined' && BucketSentinel.handles(msg.type)) {
            return BucketSentinel.handle(msg, sender, sendResponse);
        }
    } catch (e) { console.error('[HAPPYJS] BucketSentinel delegate:', e); }
    try {
        switch (msg.type) {
            case 'GET_TAB_ID':
                sendResponse({ tabId: sender.tab?.id ?? null }); return true;
            case 'GET_IFRAME_ID':
                sendResponse({ frameId }); return true;
            case 'REGISTER_CONTENT': {
                if (tabId != null) sendResponse({ tabJs: WebRequestObserver.getTabJs(tabId, frameId), tabId, frameId });
                else sendResponse({ tabJs: [], tabId: null, frameId });
                return true;
            }
            case 'FETCH_JS':
                JsFetcher.handle({ url: msg.url, tabId, frameId: msg.frameId }).then(r => sendResponse(r));
                return true;
            case 'REGEX_MATCH':
                sendResponse({ matches: RegexMatcher.perform(msg.chunk, msg.patterns, msg.patternType) });
                return true;
            case 'UPDATE_BADGE':
                if (tabId != null) BadgeManager.updateFromResults(msg.results, tabId);
                sendResponse({ ok: true }); return true;
            case 'GET_FINGERPRINTS':
                sendResponse(tabId != null ? FingerprintEngine.serialize(tabId) : {});
                return true;
            case 'UPDATE_BUILDER':
                if (tabId != null) FingerprintEngine.updateBuilder(tabId, msg.finger);
                sendResponse({ ok: true }); return true;
            case 'update_hooks_registration':
                HookRegistry.sync(msg.isGlobal ? '*' : msg.hostname, msg.enabledHooks, !!msg.isGlobal);
                sendResponse({ ok: true }); return true;
            case 'clear_mode_hooks':
                HookRegistry.clearMode(!!msg.clearGlobal);
                sendResponse({ ok: true }); return true;
            case 'GET_HOOK_HEALTH':
                HookRegistry.loadMeta().then(() => sendResponse(HookRegistry.health()))
                    .catch(e => sendResponse({ available: false, missing: [], error: String(e && e.message || e) }));
                return true;
            /* ---------- 自检 / CDP ---------- */
            case 'GET_HEALTH':
                HealthCheck.snapshot().then(sendResponse)
                    .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
                return true;
            case 'CDP_GET_STATUS':
                CDPExecutor.hasPermission().then(granted => sendResponse({
                    supported: CDPExecutor.available(),
                    granted,
                    attached: Array.from(CDPExecutor.attached.keys())
                })).catch(e => sendResponse({ supported: false, granted: false, error: String(e && e.message || e) }));
                return true;
            case 'CDP_REQUEST':
                // 必须在用户手势（popup 点击）上下文中调用，才会弹授权
                Promise.resolve()
                    .then(() => API.permissions.request({ permissions: ['debugger'] }))
                    .then(granted => sendResponse({ ok: !!granted, granted: !!granted }))
                    .catch(e => sendResponse({ ok: false, granted: false, error: String(e && e.message || e) }));
                return true;
            case 'CDP_REVOKE':
                CDPExecutor.attached.forEach((_, tabId) => CDPExecutor.detach(tabId));
                Promise.resolve()
                    .then(() => API.permissions.remove({ permissions: ['debugger'] }))
                    .then(removed => sendResponse({ ok: true, removed: !!removed }))
                    .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
                return true;
            case 'VUE_ROUTER_DATA':
            case 'REACT_ROUTER_DATA': {
                if (sender.tab) {
                    const hn = safeHostname(sender.tab.url);
                    API.storage.local.set({ [`${hn}_${msg.type.toLowerCase()}`]: { data: msg.data, ts: Date.now() } });
                    API.runtime.sendMessage({ type: msg.type + '_UPDATE', hostname: hn, data: msg.data }).catch(() => {});
                }
                sendResponse({ ok: true }); return true;
            }
            case 'HEIMDALLR_GET_CFG':
                sendResponse({ cfg: HeimdallrModule.getCfg(), stats: HeimdallrModule.getStats() });
                return true;
            case 'HEIMDALLR_SET_OPTION':
                HeimdallrModule.setOption(msg.key, !!msg.enabled).then(() => sendResponse({ ok: true }));
                return true;
            case 'HEIMDALLR_GET_RESULTS':
                sendResponse({ results: HeimdallrModule.getResults(msg.tabId || tabId) });
                return true;
            case 'HEIMDALLR_MATCH_BODY':
                HeimdallrModule.matchBody(tabId, msg.url, msg.bodyUrl, msg.body);
                sendResponse({ ok: true });
                return true;
            /* ---------- 信息泄露（多关键字 AND 高精度二轮扫描） ---------- */
            case 'INFO_LEAK_MATCH': {
                const r = InfoLeak.match(msg.text, msg.urlPath);
                sendResponse({ ok: !r.error, hits: r.hits || [], total: r.total || 0, error: r.error || null });
                return true;
            }
            case 'INFO_LEAK_GET_CFG':
                InfoLeak.load().then(async (cfg) => sendResponse({ cfg, stats: InfoLeak.stats() }));
                return true;
            case 'INFO_LEAK_SET_CFG':
                InfoLeak.save(msg.patch || {}).then(cfg => sendResponse({ ok: true, cfg, stats: InfoLeak.stats() }));
                return true;
            /* ---------- 接口认证绕过扫描 ---------- */
            case 'AB_GET_CFG':
                AuthBypass.load().then(cfg => sendResponse({ cfg }));
                return true;
            case 'AB_SET_CFG':
                AuthBypass.save(msg.patch || {}).then(cfg => sendResponse({ ok: true, cfg }));
                return true;
            case 'GET_AUTH_BYPASS_CANDIDATES': {
                // 候选 = 当前帧的 absoluteApis + apis + 识别/手动的 baseURL
                const abTab = msg.tabId != null ? msg.tabId : tabId;
                if (abTab == null) { sendResponse({ ok: false, error: '缺少标签页上下文' }); return true; }
                API.tabs.sendMessage(abTab, { type: 'GET_AUTH_BYPASS_CANDIDATES', limit: msg.limit || 60, to: 'content' })
                    .then(r => sendResponse(r || { ok: false, error: 'content 无响应（页面可能未加载完/已重载，刷新后重试）' }))
                    .catch(e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
                return true;
            }
            case 'RUN_AUTH_BYPASS': {
                const abTab = msg.tabId != null ? msg.tabId : tabId;
                const run = async () => {
                    await AuthBypass.load();
                    let cand = { apis: msg.apis || [], bases: msg.bases || [] };
                    if ((!cand.apis.length) && abTab != null) {
                        try {
                            const r = await API.tabs.sendMessage(abTab, {
                                type: 'GET_AUTH_BYPASS_CANDIDATES', limit: msg.limit || 60, to: 'content'
                            });
                            if (r && r.ok) cand = { apis: r.apis || [], bases: r.bases || [] };
                        } catch {}
                    }
                    const out = await AuthBypass.run({
                        apis: cand.apis, bases: cand.bases,
                        limit: msg.limit, dryRun: !!msg.dryRun
                    });
                    if (abTab != null) {
                        try {
                            API.tabs.sendMessage(abTab, { type: 'RUN_AUTH_BYPASS', results: out.results || [], meta: out.meta, to: 'content' }).catch(() => {});
                        } catch {}
                    }
                    return { ...out, bases: (cand.bases || []).map(b => b.url).filter(Boolean) };
                };
                run().then(sendResponse).catch(e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
                return true;
            }
            /* ---------- 控制台 / 错误日志 ---------- */
            case 'CONSOLE_LOG':
                if (tabId != null && Array.isArray(msg.entries)) {
                    for (const e of msg.entries) ConsoleStore.push(tabId, { ...e, frameId: sender.frameId });
                }
                sendResponse({ ok: true });
                return true;
            case 'GET_CONSOLE':
                sendResponse(ConsoleStore.get(tabId, msg));
                return true;
            case 'CLEAR_CONSOLE':
                if (tabId != null) ConsoleStore.clear(tabId);
                sendResponse({ ok: true });
                return true;
            case 'SET_CONSOLE_CAPTURE':
                ConsoleCapture.setUser(!!msg.enabled)
                    .then(st => sendResponse({ ok: true, ...st }))
                    .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
                return true;
            case 'GET_CONSOLE_CAPTURE':
                sendResponse(ConsoleCapture.state());
                return true;
            /* ---------- 资源索引 / 网络清单 ---------- */
            case 'GET_JS_RESOURCES': {
                const pageUrl = (() => { try { return msg.pageUrl || ''; } catch { return ''; } })();
                const collectOpts = {
                    includeThirdParty: !!msg.includeThirdParty,
                    skipMin: !!msg.skipMin,
                    pageUrl,
                    scope: msg.scope,
                    predict: !!msg.predict,
                    verify: msg.verify !== false,
                    maxVerify: msg.maxVerify,
                    includeFailed: msg.includeFailed === true,
                    mergePageCollect: msg.mergePageCollect !== false
                };
                collectTabJsUrls(tabId, collectOpts).then(list => sendResponse({
                    tabId,
                    pageUrl,
                    list,
                    excludedFailed: collectOpts._excludedFailed || 0,
                    includeFailed: msg.includeFailed === true,
                    predict: collectOpts._predictResult || null,
                    netTotal: ResourceIndex.listRequests(tabId, { limit: 1 }).total,
                    netAll: ResourceIndex.listRequests(tabId, { limit: 2000 }).requests.length
                })).catch(e => sendResponse({ tabId, list: [], error: String(e && e.message || e) }));
                return true;
            }
            case 'GET_NETLOG':
                // 注意：不能用 msg.type 作为资源类型过滤（会被消息类型本身占用）→ 使用 resourceType
                sendResponse(ResourceIndex.listRequests(tabId, {
                    keyword: msg.keyword,
                    type: msg.resourceType,
                    onlyThirdParty: msg.onlyThirdParty,
                    minStatus: msg.minStatus,
                    limit: msg.limit
                }));
                return true;
            case 'JS_TEXT_CACHE_INFO':
                sendResponse(JsTextCache.size(tabId));
                return true;
            /* ---------- 动态代码（blob/eval/Function）与 Worker 脚本 ---------- */
            case 'DYNAMIC_CODE_ADD': {
                const added = DynamicCodeStore.add(tabId, {
                    kind: msg.kind, code: msg.code, truncated: msg.truncated,
                    originalLength: msg.originalLength, meta: msg.meta, frameUrl: msg.frameUrl
                });
                sendResponse(added ? { ok: true, id: added.id } : { ok: false });
                return true;
            }
            case 'WORKER_SCRIPT': {
                // 线程脚本本质就是一次脚本请求，直接并进资源清单 → 会被「下载全部」带走
                try {
                    ResourceIndex.record(tabId, {
                        url: msg.url, type: 'script',
                        initiator: msg.frameUrl || msg.url, frameId: 0
                    });
                    ResourceIndex.complete(tabId, msg.url, { status: 0, size: 0 });
                    sendResponse({ ok: true });
                } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
                return true;
            }
            case 'GET_DYNAMIC_CODE': {
                sendResponse(DynamicCodeStore.list(tabId, {
                    kind: msg.kind, limit: msg.limit, withCode: msg.withCode
                }));
                return true;
            }
            /* 把捕获到的运行时脚本落盘为 .js 文件（复用下载引擎的命名与目录规则） */
            case 'DL_SAVE_DYNAMIC': {
                const run = async () => {
                    if (!DynamicCodeStore.stats(tabId).count) return { ok: false, error: '暂无捕获到的动态代码' };
                    if (!DownloadManager._loaded) await DownloadManager.load();
                    let pageUrl = msg.pageUrl || '';
                    if (!pageUrl) { try { pageUrl = (await API.tabs.get(tabId))?.url || ''; } catch {} }
                    const data = DynamicCodeStore.list(tabId, { limit: 120 });
                    const pseudo = data.items.map((it, i) =>
                        `https://${(() => { try { return new URL(pageUrl).hostname; } catch { return 'dynamic.local'; } })()}` +
                        `/__dynamic__/${it.kind}-${String(i + 1).padStart(3, '0')}.js`);
                    const plan = DownloadManager.planFiles(pseudo, {
                        tabId, pageUrl,
                        dir: msg.dir, siteFolder: msg.siteFolder, flatten: !!msg.flatten
                    });
                    const saved = [];
                    const failed = [];
                    for (let i = 0; i < data.items.length; i++) {
                        const it = data.items[i];
                        const rel = (plan.files[i] && plan.files[i].rel) || `dynamic-${i + 1}.js`;
                        try {
                            const header = `/* kind: ${it.kind} | ${new Date(it.ts).toISOString()} | ${it.frameUrl}\n` +
                                ` * meta: ${JSON.stringify(it.meta)}\n` +
                                ` * originalLength: ${it.originalLength}${it.truncated ? ' (已截断)' : ''} */\n\n`;
                            const r = await DownloadManager.downloadText(header + it.code, rel, 'text/javascript', tabId);
                            if (r && r.ok) saved.push({ file: r.path || rel, kind: it.kind, bytes: it.bytes });
                            else failed.push({ kind: it.kind, error: (r && r.error) || '写入失败' });
                        } catch (e) { failed.push({ kind: it.kind, error: String(e && e.message || e) }); }
                    }
                    return {
                        ok: failed.length === 0, count: data.items.length,
                        savedCount: saved.length, failedCount: failed.length,
                        saved: saved.slice(0, 30), failed: failed.slice(0, 10),
                        note: '动态代码已按目录规则落盘（每个片段一个 .js，文件头含来源与截断信息）'
                    };
                };
                run().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
                return true;
            }
            /* ---------- JS 预测补齐 / 覆盖对账（借鉴 hybrid_capture_project2） ---------- */
            case 'GET_JS_PREDICT': {
                const pTabId = msg.tabId != null ? msg.tabId : tabId;
                JsPredictor.predictJsResources(pTabId, {
                    pageUrl: msg.pageUrl,
                    includeThirdParty: !!msg.includeThirdParty,
                    skipMin: !!msg.skipMin,
                    verify: msg.verify !== false,
                    maxVerify: msg.maxVerify,
                    maxAnalyze: msg.maxAnalyze,
                    extraHosts: msg.extraHosts
                }).then(r => sendResponse(r))
                    .catch(e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
                return true;
            }
            case 'DL_COVERAGE': {
                const cTabId = msg.tabId != null ? msg.tabId : tabId;
                JsPredictor.coverage(cTabId, {
                    pageUrl: msg.pageUrl, skipMin: !!msg.skipMin
                }).then(r => sendResponse(r))
                    .catch(e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
                return true;
            }
            /* ---------- 一键下载 ---------- */
            case 'DL_GET_CFG':
                DownloadManager.load().then(cfg => sendResponse({
                    cfg, recent: DownloadManager.recent(20),
                    hasApi: DownloadManager.hasApi(),
                    help: DL_PLACEHOLDER_HELP
                }));
                return true;
            case 'DL_SET_CFG':
                DownloadManager.save(msg.patch || {}).then(cfg => sendResponse({ ok: true, cfg }));
                return true;
            /* 目录与文件名规划（界面预览 / 直写本地目录模式共用同一套命名规则） */
            case 'DL_PLAN': {
                const planTabId = msg.tabId != null ? msg.tabId : tabId;
                let planExcludedFailed = 0;
                const run = async () => {
                    if (!DownloadManager._loaded) await DownloadManager.load();
                    let pageUrl = msg.pageUrl || '';
                    if (!pageUrl && planTabId != null) {
                        try { pageUrl = (await API.tabs.get(planTabId))?.url || ''; } catch {}
                    }
                    let urls = Array.isArray(msg.urls) ? msg.urls : [];
                    if (!urls.length && !msg.noCollect && planTabId != null) {
                        const planOpts = {
                            includeThirdParty: !!msg.includeThirdParty || msg.scope === 'thirdParty' || msg.scope === 'site',
                            skipMin: !!msg.skipMin, pageUrl, predict: !!msg.predict,
                            includeFailed: msg.includeFailed === true
                        };
                        const list = await collectTabJsUrls(planTabId, planOpts);
                        planExcludedFailed = planOpts._excludedFailed || 0;
                        urls = list
                            .filter(x => (msg.scope === 'site' ? (x.scope === 'site' || x.scope == null)
                                : (msg.scope === 'thirdParty' ? x.thirdParty : true)))
                            .map(x => x.url);
                    }
                    const plan = DownloadManager.planFiles(urls, {
                        tabId: planTabId, pageUrl,
                        dir: msg.dir, siteFolder: msg.siteFolder, flatten: !!msg.flatten
                    });
                    return {
                        ...plan,
                        files: plan.files.slice(0, 400),
                        total: plan.files.length,
                        excludedFailed: planExcludedFailed,
                        help: DL_PLACEHOLDER_HELP
                    };
                };
                run().then(r => sendResponse(r)).catch(e => sendResponse({ error: String((e && e.message) || e) }));
                return true;
            }
            /* 取单个文件的原始字节（base64），供「直写本地目录」模式落盘 */
            case 'DL_FETCH_B64': {
                if (!/^https?:/i.test(String(msg.url || ''))) { sendResponse({ ok: false, error: '非法 URL' }); return true; }
                const fTabId = msg.tabId != null ? msg.tabId : tabId;
                FetchB64.fetch(msg.url, fTabId).then(sendResponse)
                    .catch(e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
                return true;
            }
            case 'JS_DOWNLOAD': {
                const opts = { ...(msg.opts || {}) };
                const dlTabId = msg.tabId != null ? msg.tabId : tabId;
                const run = async () => {
                    if (!opts.pageUrl && dlTabId != null) {
                        try { opts.pageUrl = (await API.tabs.get(dlTabId))?.url || ''; } catch {}
                    }
                    // 未显式给 urls 时，自动汇总：webRequest 观测 + 页面 DOM/performance
                    if (!Array.isArray(opts.urls) || !opts.urls.length) {
                        const dlOpts = {
                            includeThirdParty: !!opts.includeThirdParty || opts.scope === 'thirdParty' || opts.scope === 'site',
                            skipMin: !!opts.skipMin,
                            pageUrl: opts.pageUrl,
                            predict: !!opts.predict,
                            verify: opts.verifyPredict,
                            maxVerify: opts.maxVerify,
                            includeFailed: opts.includeFailed === true
                        };
                        const list = await collectTabJsUrls(dlTabId, dlOpts);
                        opts.preExcludedFailed = dlOpts._excludedFailed || 0;
                        opts.urls = list
                            .filter(x => (opts.scope === 'site' ? (x.scope === 'site' || x.scope == null)
                                : (opts.scope === 'thirdParty' ? x.thirdParty : true)))
                            .map(x => x.url);
                    }
                    return DownloadManager.downloadJs({
                        ...opts,
                        tabId: dlTabId,
                        onProgress: (p) => {
                            try {
                                API.runtime.sendMessage({ type: 'JS_DOWNLOAD_PROGRESS', tabId: dlTabId, progress: p }).catch(() => {});
                            } catch {}
                        }
                    });
                };
                run().then(r => sendResponse(r))
                    .catch(e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
                return true;
            }
            case 'MCP_GET_STATUS':
                sendResponse(typeof MCPClient !== 'undefined' ? MCPClient.getStatus() : null);
                return true;
            case 'MCP_SET_ENABLED':
                if (typeof MCPClient === 'undefined') { sendResponse(null); return true; }
                MCPClient.setEnabled(!!msg.enabled).then((st) => {
                    // MCP 开启时自动启用控制台捕获（AI 需要看页面报错），关闭时仅在用户未显式开启时收回
                    ConsoleCapture.setMcp(!!msg.enabled).catch(() => {});
                    sendResponse(st);
                });
                return true;
            case 'MCP_SET_PORT':
                if (typeof MCPClient === 'undefined') { sendResponse(null); return true; }
                MCPClient.setPort(msg.port).then(sendResponse)
                    .catch(e => sendResponse({ error: String((e && e.message) || e) }));
                return true;
            case 'MCP_REGEN_TOKEN':
                if (typeof MCPClient === 'undefined') { sendResponse(null); return true; }
                MCPClient.regenToken().then(sendResponse);
                return true;
            default:
                sendResponse(null); return true;
        }
    } catch (e) {
        console.error('[LatentEye] bg message error:', e);
        sendResponse(null);
        return true;
    }
});

// 标签页 URL 变化时：刷新徽章 + 清理旧路由数据 + 清理该页运行期记录
API.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === 'complete') BadgeManager.refresh(tabId);
    if (info.status === 'loading' && tab.url) {
        const hn = safeHostname(tab.url);
        if (hn) API.storage.local.remove([`${hn}_vue_router_data`, `${hn}_react_router_data`]).catch(() => {});
        // 页面切换：旧页资源/日志/缓存失效
        ResourceIndex.clear(tabId);
        ConsoleStore.clear(tabId);
        JsTextCache.clear(tabId);
        JsPredictor.clear(tabId);   // 预测结果绑定当前页面，跳转后作废
        DynamicCodeStore.clear(tabId);
        if (HeimdallrModule.cfg.pluginStart && HeimdallrModule.cfg.noPageCache) {
            API.browsingData.removeCache({ since: Date.now() - 3600000 }, () => {});
        }
    }
});

// 启动控制台捕获状态（用户此前已开启，或 MCP 服务开启时联动）
// 所有顶层初始化一律容错：任何一块失败都不允许拖垮整个 Service Worker
try { ConsoleCapture.load().catch(e => HealthCheck.note('ConsoleCapture.load', e)); } catch (e) { HealthCheck.note('ConsoleCapture.load', e); }
try { DownloadManager.init(); } catch (e) { HealthCheck.note('DownloadManager.init', e); }

/* =====================================================================
 * 7. Heimdallr 模块（整合自 Heimdallr by Ghroth）
 *    反蜜罐检测 / 特征对抗 / 指纹规则识别
 *    文档：https://github.com/graynjo/Heimdallr
 * ===================================================================== */
const HeimdallrModule = {
    STORAGE_KEY: 'le_heimdallr_cfg',     // 配置存储键
    RESULT_KEY: 'le_heimdallr_results',  // 按标签页存储命中结果
    cfg: { blockHoneypot: false, noPageCache: false, jsonpAlert: true, pluginStart: true },
    results: {},  // { tabId: { host, items: [{type, msg, url, ts}], jsonpCount } }
    initialized: false,

    init() {
        if (this.initialized) return;
        // 读取配置
        API.storage.local.get([this.STORAGE_KEY], (d) => {
            const saved = d[this.STORAGE_KEY];
            if (saved) Object.assign(this.cfg, saved);
            this.applyAll();
            this.initialized = true;
            console.log('[Heimdallr] init', this.cfg);
        });
        // 监听标签页关闭：清理结果
        API.tabs.onRemoved.addListener((tabId) => {
            if (this.results[tabId]) delete this.results[tabId];
        });
        // 监听标签页 URL 变更：清空该标签页结果（host 变了）
        API.tabs.onUpdated.addListener((tabId, info, tab) => {
            if (info.status === 'loading' && tab.url) {
                if (this.results[tabId]) {
                    this.results[tabId] = { host: safeHostname(tab.url), items: [], jsonpCount: 0 };
                    this.broadcast(tabId);
                }
            }
        });
    },

    // 应用所有配置（开关变更后调用）
    async applyAll() {
        // 蜜罐域名拦截
        await this.applyBlockHoneypot();
        // 页面缓存禁用
        await this.applyNoPageCache();
    },

    // 蜜罐域名拦截：通过 declarativeNetRequest 动态规则
    async applyBlockHoneypot() {
        if (!this.cfg.pluginStart || !this.cfg.blockHoneypot) {
            // 关闭：移除所有已有规则
            try {
                const existing = await API.declarativeNetRequest.getDynamicRules();
                if (existing.length) {
                    await API.declarativeNetRequest.updateDynamicRules({
                        removeRuleIds: existing.map(r => r.id)
                    });
                    console.log('[Heimdallr] 移除蜜罐拦截规则', existing.length);
                }
            } catch (e) { console.error('[Heimdallr] removeBlockRules:', e); }
            return;
        }
        // 开启：添加规则
        try {
            const existing = await API.declarativeNetRequest.getDynamicRules();
            if (existing.length) {
                await API.declarativeNetRequest.updateDynamicRules({
                    removeRuleIds: existing.map(r => r.id)
                });
            }
            const rules = (typeof self !== 'undefined' && self.HBlockingDomainRules) || [];
            if (rules.length) {
                await API.declarativeNetRequest.updateDynamicRules({
                    addRules: rules,
                    removeRuleIds: []
                });
                console.log('[Heimdallr] 添加蜜罐拦截规则', rules.length);
            }
        } catch (e) { console.error('[Heimdallr] addBlockRules:', e); }
    },

    // 页面缓存禁用：清缓存 + 后续请求加载时清
    async applyNoPageCache() {
        if (!this.cfg.pluginStart || !this.cfg.noPageCache) return;
        try {
            await new Promise(r => API.browsingData.removeCache({ since: Date.now() - 3600000 }, r));
            console.log('[Heimdallr] 已清除页面缓存');
        } catch (e) { console.error('[Heimdallr] clearCache:', e); }
    },

    // 设置单个开关
    async setOption(key, enabled) {
        this.cfg[key] = !!enabled;
        API.storage.local.set({ [this.STORAGE_KEY]: this.cfg });
        // 立即应用
        if (key === 'blockHoneypot') await this.applyBlockHoneypot();
        if (key === 'noPageCache') await this.applyNoPageCache();
        console.log('[Heimdallr] option', key, '=', enabled);
    },

    // 添加命中结果
    addHit(tabId, host, rule) {
        if (tabId == null) return;
        if (!this.results[tabId] || this.results[tabId].host !== host) {
            this.results[tabId] = { host, items: [], jsonpCount: 0 };
        }
        const r = this.results[tabId];
        // 去重
        if (r.items.some(it => it.msg === rule.commandments)) return;
        r.items.push({
            type: rule.type,
            msg: rule.commandments,
            rulename: rule.rulename,
            ts: Date.now()
        });
        // JSONP 计数（type=4）
        if (rule.type === 4) r.jsonpCount++;
        this.broadcast(tabId);
        // 蜜罐告警通知：JSONP 命中 > 10
        if (this.cfg.jsonpAlert && r.jsonpCount === 10) {
            this.notifyHoneypot(tabId, host, r.jsonpCount);
        }
    },

    // 通知蜜罐告警
    notifyHoneypot(tabId, host, count) {
        try {
            API.notifications.create('honeypot_' + tabId, {
                type: 'basic',
                iconUrl: 'icons/icon128.png',
                title: 'JsXray · 蜜罐告警',
                message: `检测到 ${count} 个 JSONP 蜜罐特征请求\n主机：${host}\n该站点有较大可能为蜜罐`
            });
        } catch (e) { console.error('[Heimdallr] notify:', e); }
    },

    // 广播结果变更
    broadcast(tabId) {
        API.runtime.sendMessage({
            type: 'HEIMDALLR_UPDATE',
            tabId,
            results: this.results[tabId] || null
        }).catch(() => {});
    },

    // 规则匹配（请求 URL / 请求头 / 请求体）
    matchRequest(tabId, url, reqHeaders, reqBody) {
        if (!this.cfg.pluginStart) return;
        const host = safeHostname(url);
        const H = (typeof self !== 'undefined' && self.HPrinter) || { position1: [], position2: [], position3: [] };

        // position1: 请求 URL
        for (const rule of H.position1) {
            try {
                if (rule.rulecontent instanceof RegExp) {
                    if (rule.rulecontent.test(url)) this.addHit(tabId, host, rule);
                }
            } catch {}
        }
        // position2: 请求头
        if (reqHeaders && Array.isArray(reqHeaders)) {
            const headerMap = {};
            reqHeaders.forEach(h => { headerMap[h.name] = h.value; });
            for (const rule of H.position2) {
                try {
                    const name = rule.rulecontent.name;
                    const valRe = rule.rulecontent.value;
                    if (headerMap[name] && valRe.test(headerMap[name])) {
                        this.addHit(tabId, host, rule);
                    }
                } catch {}
            }
        }
        // position3: 请求体
        if (reqBody && typeof reqBody === 'string') {
            for (const rule of H.position3) {
                try {
                    if (rule.rulecontent instanceof RegExp && rule.rulecontent.test(reqBody)) {
                        this.addHit(tabId, host, rule);
                    }
                } catch {}
            }
        }
    },

    // 规则匹配（响应头 position4）
    matchResponseHeaders(tabId, url, respHeaders) {
        if (!this.cfg.pluginStart) return;
        const host = safeHostname(url);
        const H = (typeof self !== 'undefined' && self.HPrinter) || { position4: [] };
        if (!respHeaders || !Array.isArray(respHeaders)) return;
        const headerMap = {};
        respHeaders.forEach(h => { headerMap[h.name] = h.value; });
        for (const rule of H.position4) {
            try {
                const name = rule.rulecontent.name;
                const valRe = rule.rulecontent.value;
                if (headerMap[name] && valRe.test(headerMap[name])) {
                    this.addHit(tabId, host, rule);
                }
            } catch {}
        }
    },

    // 规则匹配（响应体 position5）
    // body: 响应体文本（来自 content.js 页面 HTML 或 hook_response_body AJAX 响应）
    matchBody(tabId, pageUrl, bodyUrl, body) {
        if (!this.cfg.pluginStart || !body) return;
        const host = safeHostname(pageUrl);
        const H = (typeof self !== 'undefined' && self.HPrinter) || { position5: [] };
        for (const rule of H.position5) {
            try {
                if (rule.rulecontent instanceof RegExp) {
                    if (rule.rulecontent.test(body)) {
                        this.addHit(tabId, host, rule);
                    }
                }
            } catch {}
        }
    },

    // 获取标签页结果
    getResults(tabId) {
        return this.results[tabId] || { host: '', items: [], jsonpCount: 0 };
    },

    // 获取规则统计
    getStats() {
        return (typeof self !== 'undefined' && self.HStats) || { total: 0, fingerprint: 0, keyword: 0, blockUrl: 0, blockJsonp: 0, alert: 0, blockingRules: 0 };
    },

    // 获取配置
    getCfg() { return { ...this.cfg }; }
};

// 注册 webRequest 监听器（Heimdallr 规则匹配）
// extraHeaders / requestBody 为 Chromium 增强项，Firefox 不支持 → 逐级降级注册
function safeAddWebRequest(kind, listener, filter, specChain) {
    for (const specs of specChain) {
        try {
            API.webRequest[`on${kind}`].addListener(listener, filter, specs);
            return specs;
        } catch (e) { /* 尝试下一组 */ }
    }
    console.error(`[HAPPYJS] webRequest.on${kind} 注册失败（全部降级失败）`);
    return null;
}

safeAddWebRequest('BeforeRequest',
    (d) => {
        if (!HeimdallrModule.cfg.pluginStart) return;
        const { tabId, url, type, requestBody } = d;
        if (type === 'main_frame' || type === 'sub_frame' || type === 'script' || type === 'xmlhttprequest' || type === 'image' || type === 'other') {
            let bodyStr = null;
            if (requestBody) {
                if (requestBody.formData) {
                    bodyStr = JSON.stringify(requestBody.formData);
                } else if (requestBody.raw && requestBody.raw.length === 1 && requestBody.raw[0].bytes) {
                    try {
                        bodyStr = new TextDecoder().decode(new Uint8Array(requestBody.raw[0].bytes));
                    } catch {}
                }
            }
            HeimdallrModule.matchRequest(tabId, url, null, bodyStr);
        }
    },
    { urls: ['http://*/*', 'https://*/*'] },
    [['requestBody', 'extraHeaders'], ['requestBody'], []]
);

safeAddWebRequest('BeforeSendHeaders',
    (d) => {
        if (!HeimdallrModule.cfg.pluginStart) return;
        const { tabId, url, type, requestHeaders } = d;
        if (type === 'main_frame' || type === 'sub_frame' || type === 'script' || type === 'xmlhttprequest' || type === 'other') {
            HeimdallrModule.matchRequest(tabId, url, requestHeaders, null);
        }
    },
    { urls: ['http://*/*', 'https://*/*'] },
    [['requestHeaders', 'extraHeaders'], ['requestHeaders'], []]
);

// 响应头监听（position4 规则匹配）
safeAddWebRequest('HeadersReceived',
    (d) => {
        if (!HeimdallrModule.cfg.pluginStart) return;
        const { tabId, url, type, responseHeaders } = d;
        if (type === 'main_frame' || type === 'sub_frame' || type === 'script' || type === 'xmlhttprequest' || type === 'other') {
            HeimdallrModule.matchResponseHeaders(tabId, url, responseHeaders);
        }
    },
    { urls: ['http://*/*', 'https://*/*'] },
    [['responseHeaders', 'extraHeaders'], ['responseHeaders'], []]
);

HeimdallrModule.init();

// MCP 客户端：若用户已开启 MCP 服务，自动连接本机桥接进程
// 连接状态确定后再联动控制台捕获（MCP 开启时 AI 需要读页面报错）
if (typeof MCPClient !== 'undefined') {
    MCPClient.init()
        .then(() => ConsoleCapture.setMcp(!!MCPClient.cfg.enabled))
        .catch(() => {});
}
