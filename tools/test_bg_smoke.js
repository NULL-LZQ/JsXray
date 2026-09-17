/* JsXray — background + MCP 工具层运行时冒烟测试（无需浏览器）
 *
 * 做法：用最小 chrome.* 桩在 vm 中真实加载 background.js（含 importScripts 的
 *      data/heimdallr_rules.js、lib/*.js、mcp/ext_client.js），然后：
 *        1. 触发真实的 webRequest 监听器，验证资源索引落库
 *        2. 逐一派发 background 消息，验证消息路由无异常
 *        3. 直接调用 MCP 工具实现（MCPClient.dispatch），验证 23 个工具的核心链路
 *        4. 重点回归：Hook 注册使用 hooks.json 的 file 字段（历史上的命名错位 Bug）
 *
 * 运行：node tools/test_bg_smoke.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.error(`  ✗ ${name}${extra !== undefined ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* =====================================================================
 * chrome.* 桩
 * ===================================================================== */
function makeChromeMock(initialStore) {
    const EXT = 'chrome-extension://happyjs/';
    const store = Object.assign({}, initialStore || {});
    const listeners = {
        message: [], startup: [], installed: [], alarm: [], removed: [], activated: [], updated: []
    };
    const wr = { onBeforeRequest: [], onBeforeSendHeaders: [], onHeadersReceived: [], onCompleted: [] };
    const registeredScripts = new Map();
    const downloads = [];
    const dlListeners = [];
    let dlSeq = 0;
    const extTabs = {
        1: { id: 1, url: 'https://example.com/page', title: 'Example', active: true, windowId: 1 }
    };

    const p = (v) => (v && typeof v.then === 'function') ? v : Promise.resolve(v);
    const local = {
        get(keys, cb) {
            const out = {};
            const list = keys == null ? Object.keys(store)
                : Array.isArray(keys) ? keys
                    : typeof keys === 'string' ? [keys] : Object.keys(keys);
            for (const k of list) if (k in store) out[k] = store[k];
            if (typeof cb === 'function') { cb(out); return; }
            return Promise.resolve(out);
        },
        set(obj, cb) { Object.assign(store, obj); if (cb) cb(); return Promise.resolve(); },
        remove(keys, cb) { [].concat(keys).forEach(k => delete store[k]); if (cb) cb(); return Promise.resolve(); }
    };

    const chrome = {
        runtime: {
            lastError: null,
            getManifest: () => ({ version: '1.2.0' }),
            getURL: (rel) => EXT + String(rel).replace(/^\/+/, ''),
            sendMessage: () => Promise.resolve(undefined),
            onMessage: { addListener: (l) => listeners.message.push(l) },
            onStartup: { addListener: (l) => listeners.startup.push(l) },
            onInstalled: { addListener: (l) => listeners.installed.push(l) }
        },
        storage: {
            local,
            session: { remove: () => Promise.resolve(), get: () => Promise.resolve({}), set: () => Promise.resolve() },
            onChanged: { addListener: () => {} }
        },
        tabs: {
            query: async () => Object.values(extTabs),
            get: async (id) => extTabs[id] || null,
            sendMessage: (tabId, msg, opts, cb) => {
                if (typeof opts === 'function') { cb = opts; opts = undefined; }
                let resp = null;
                if (msg && msg.type === 'COLLECT_JS_URLS') {
                    resp = { ok: true, urls: [{ url: 'https://example.com/static/app.js', source: 'script-tag' }], frameUrl: 'https://example.com/page', frameId: 0 };
                } else if (msg && msg.type === 'MCP_COLLECT_RESULTS') {
                    resp = {
                        ok: true, frameUrl: 'https://example.com/page', isInIframe: false,
                        results: { absoluteApis: [['/api/user/list', 'https://example.com/static/app.js'], ['/api/order/detail', 'https://example.com/static/app.js'], ['/api/user/profile', 'https://example.com/static/app.js']], idKeys: [['AKIAIOSFODNN7EXAMPLE', 'x.js']], jsFiles: [['/static/app.js', 'x']], ips: [], emails: [], progress: 100 }
                    };
                } else if (msg && msg.type === 'PING_CONTENT') {
                    resp = { ok: true, ready: true, frameUrl: 'https://example.com/page', frameId: 0 };
                }
                if (cb) cb(resp);
                return Promise.resolve(resp);
            },
            reload: async () => {},
            update: async () => {},
            captureVisibleTab: async () => 'data:image/png;base64,iVBORw0KGgo=',
            create: async () => ({}),
            onActivated: { addListener: (l) => listeners.activated.push(l) },
            onRemoved: { addListener: (l) => listeners.removed.push(l) },
            onUpdated: { addListener: (l) => listeners.updated.push(l) }
        },
        windows: { get: async () => ({ id: 1, focused: true }) },
        action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
        webRequest: {
            onBeforeRequest: { addListener: (l) => wr.onBeforeRequest.push(l) },
            onBeforeSendHeaders: { addListener: (l) => wr.onBeforeSendHeaders.push(l) },
            onHeadersReceived: { addListener: (l) => wr.onHeadersReceived.push(l) },
            onCompleted: { addListener: (l) => wr.onCompleted.push(l) }
        },
        webNavigation: {
            onCommitted: { addListener: () => {} },
            getAllFrames: async () => ([
                { frameId: 0, parentFrameId: -1, url: 'https://example.com/page' },
                { frameId: 3, parentFrameId: 0, url: 'https://sub.example.com/embed' }
            ])
        },
        cookies: { getAll: (q, cb) => { if (cb) cb([{ name: 'JSESSIONID' }, { name: 'token' }]); return Promise.resolve([]); } },
        declarativeNetRequest: {
            getDynamicRules: async () => [],
            updateDynamicRules: async () => {}
        },
        browsingData: { removeCache: (o, cb) => { if (cb) cb(); } },
        notifications: { create: () => {} },
        alarms: {
            onAlarm: { addListener: (l) => listeners.alarm.push(l) },
            create: () => {}, clear: () => {}
        },
        scripting: {
            getRegisteredContentScripts: async () => Array.from(registeredScripts.values()),
            registerContentScripts: async (arr) => {
                for (const s of arr) {
                    if (s.js && s.js.some(f => !fs.existsSync(path.join(root, f)))) {
                        throw new Error(`Could not load file: ${s.js.join(',')}`);
                    }
                    registeredScripts.set(s.id, s);
                }
            },
            unregisterContentScripts: async ({ ids }) => { ids.forEach(id => registeredScripts.delete(id)); },
            executeScript: async (opts) => {
                // 页面资源采集（PAGE_ASSET_FN 无参数）
                if (!opts.args) {
                    return [{ result: {
                        url: 'https://example.com/page', title: 'Example',
                        js: [
                            { url: 'https://example.com/static/frompage.js', source: 'script-tag', size: 0 },
                            { url: 'https://example.com/static/sized.js', source: 'performance', size: 4096 },
                            // 真实顺序：DOM 的 script-tag 先到（拿不到体积），performance 后到（有体积）。
                            // 去重若「保留先到的」，体积就会丢 —— 线上实测同源 JS 体积全是 0 就是这个原因。
                            { url: 'https://example.com/static/dup.js', source: 'script-tag', size: 0 },
                            { url: 'https://example.com/static/dup.js', source: 'performance', size: 8192 },
                            { url: 'https://cdn.third.com/extra.js', source: 'performance', size: 512 }
                        ]
                    } }];
                }
                // MCP execute_js：args = [code, 探针标记]，按 world 模拟真实限制
                // （必须精确匹配标记，否则会误伤同样用 ISOLATED + 字符串参数的 get_storage）
                if (Array.isArray(opts.args) && opts.args.length === 2 && opts.args[1] === 'happyjs-mcp-probe') {
                    if (opts.world === 'ISOLATED') {
                        // MV3 隔离世界 CSP 无 unsafe-eval → eval 必然被拦
                        return [{ result: { ok: false, error: 'EvalError: Refused to evaluate a string as JavaScript because unsafe-eval is not allowed' } }];
                    }
                    return [{ result: { ok: true, result: '2' } }];
                }
                // 页面内落盘回退：args = [url, text, base64, mime, name]
                if (Array.isArray(opts.args) && opts.args.length === 5 &&
                    typeof opts.args[2] === 'string' && typeof opts.args[3] === 'string') {
                    return [{ result: { ok: true, name: opts.args[4], via: 'page-blob' } }];
                }
                // FetchB64.viaTab：args = [url, maxBytes]
                if (Array.isArray(opts.args) && opts.args.length === 2 && typeof opts.args[1] === 'number') {
                    const body = 'console.log("mock js");';
                    return [{ result: {
                        ok: true, base64: Buffer.from(body).toString('base64'),
                        bytes: body.length, status: 200, mime: 'application/javascript'
                    } }];
                }
                return [{ result: { __mock: true, url: 'https://example.com/page' } }];
            }
        },
        downloads: {
            download(opts, cb) {
                const id = ++dlSeq;
                downloads.push({ id, ...opts });
                // 延迟触发完成事件，确保 DownloadManager 已注册 waiter
                setTimeout(() => dlListeners.forEach(l => l({ id, state: { current: 'complete' } })), 15);
                if (cb) setTimeout(() => cb(id), 0);
                return undefined;
            },
            onChanged: { addListener: (l) => dlListeners.push(l) }
        }
    };
    return { chrome, store, listeners, wr, registeredScripts, downloads, EXT, extTabs, downloadsMock: chrome.downloads };
}

/* =====================================================================
 * 载入 background.js
 * ===================================================================== */
function bootBackground(initialStore) {
    const M = makeChromeMock(initialStore);
    const sandbox = {
        chrome: M.chrome,
        console,
        TextEncoder, TextDecoder, URL, Date, Math, JSON, Promise, Map, Set, Array, Object,
        String, Number, Boolean, RegExp, Error, TypeError, Symbol, WeakSet, WeakMap, Function,
        setTimeout, clearTimeout, setInterval, clearInterval,
        AbortController, TextDecoder, Uint8Array, ArrayBuffer,
        crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 0xff; return a; } },
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        WebSocket: function () { throw new Error('本测试不启用 WebSocket'); },
        fetch: async (url, opts) => {
            // 允许用例注入自定义响应（认证绕过扫描需要不同状态码/内容类型）
            if (sandbox.__fetchHandler) return sandbox.__fetchHandler(url, opts);
            const rel = String(url).startsWith(M.EXT) ? String(url).slice(M.EXT.length) : null;
            if (rel) {
                const full = path.join(root, rel);
                if (fs.existsSync(full)) {
                    const text = fs.readFileSync(full, 'utf8');
                    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
                }
                return { ok: false, status: 404, text: async () => '', json: async () => { throw new Error('404'); } };
            }
            // 外部 JS 抓取：返回带可检索特征的假源码
            return {
                ok: true, status: 200,
                headers: { get: () => 'application/javascript' },
                text: async () => `/* ${url} */\nfunction login(u){ return fetch('/api/login',{method:'POST'}); }\nvar TOKEN="abc";\n`,
                json: async () => ({})
            };
        },
        importScripts: (...files) => {
            for (const f of files) {
                const full = path.join(root, f);
                vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: f });
            }
        }
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.browser = undefined;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });
    const g = (expr) => vm.runInContext(expr, sandbox);
    M.sandbox = sandbox;   // 允许用例注入 __fetchHandler 等桩行为
    return { sandbox, M, g };
}

function sendBg(M, msg, sender = { tab: { id: 1, url: 'https://example.com/page' }, frameId: 0 }, timeout = 4000) {
    return new Promise((resolve) => {
        let done = false;
        const send = (r) => { if (!done) { done = true; resolve(r); } };
        for (const l of M.listeners.message) { try { l(msg, sender, send); } catch (e) { console.error('[listener]', e); } }
        setTimeout(() => { if (!done) resolve('__NO_RESPONSE__'); }, timeout);
    });
}

(async () => {
    const { M, g } = bootBackground();
    await sleep(120);   // 等待 background 顶层异步初始化（Hook 元数据探测等）

    console.log('=== 1. background 启动与模块加载 ===');
    ok(g('typeof ResourceIndex') === 'object', 'lib/downloader.js 已加载（ResourceIndex）');
    ok(g('typeof ConsoleStore') === 'object', 'lib/recorder.js 已加载（ConsoleStore）');
    ok(g('typeof HappyZip') === 'object', 'lib/zip.js 已加载（HappyZip）');
    ok(g('typeof MCPClient') === 'object', 'mcp/ext_client.js 已加载（MCPClient）');
    ok(g('HStats.total') > 200, 'Heimdallr 规则库已加载', g('HStats.total'));
    const health = await g('HookRegistry.loadMeta().then(()=>HookRegistry.health())');
    ok(health.missing.length === 0, '全部 Hook 脚本文件均可解析', JSON.stringify(health.missing));
    ok(health.resolved['bypass_debugger'] === 'hooks/b_debugger.js', 'Hook 文件映射修复生效', health.resolved['bypass_debugger']);
    ok(health.resolved['hook_console'] === 'hooks/a_console.js', 'hook_console → a_console.js', health.resolved['hook_console']);

    console.log('\n=== 2. webRequest → 资源索引 ===');
    const wr = M.wr;
    const fire = (list, d) => list.forEach(l => { try { l(d); } catch (e) { console.error('[wr]', e); } });
    fire(wr.onBeforeRequest, { tabId: 1, frameId: 0, url: 'https://example.com/static/app.js', type: 'script', initiator: 'https://example.com/page', method: 'GET' });
    fire(wr.onBeforeRequest, { tabId: 1, frameId: 0, url: 'https://cdn.third.com/vendor.min.js', type: 'script', initiator: 'https://example.com/page', method: 'GET' });
    fire(wr.onBeforeRequest, { tabId: 1, frameId: 0, url: 'https://example.com/api/user/list', type: 'xmlhttprequest', initiator: 'https://example.com/page', method: 'POST' });
    fire(wr.onCompleted, { tabId: 1, url: 'https://example.com/static/app.js', statusCode: 200 });
    fire(wr.onHeadersReceived, { tabId: 1, type: 'script', url: 'https://example.com/static/app.js', responseHeaders: [{ name: 'Content-Length', value: '4096' }, { name: 'Content-Type', value: 'application/javascript' }] });
    await sleep(20);
    const idx = await g('({ js: ResourceIndex.listJs(1, {includeThirdParty:true}), net: ResourceIndex.listRequests(1, {}) })');
    ok(idx.js.length === 2, '资源索引记录到 2 个 JS', idx.js.length);
    ok(idx.net.total === 3, '网络清单记录 3 条请求', idx.net.total);
    ok(idx.js.find(x => x.url.includes('app.js')).size === 4096, 'Content-Length 已写入索引');

    console.log('\n=== 3. background 消息路由 ===');
    const r1 = await sendBg(M, { type: 'GET_TAB_ID' });
    ok(r1 && r1.tabId === 1, 'GET_TAB_ID 返回标签页 id', JSON.stringify(r1));
    const r2 = await sendBg(M, { type: 'GET_JS_RESOURCES', tabId: 1, includeThirdParty: false });
    ok(r2 && Array.isArray(r2.list) && r2.list.length === 4, 'GET_JS_RESOURCES 返回同源 JS（观测 + 页面采集）', JSON.stringify(r2 && r2.list && r2.list.length));
    ok(r2 && r2.list.some(x => /frompage\.js$/.test(x.url) && x.source === 'script-tag'),
        '页面资源由 background 直接注入采集（不依赖 content.js）', JSON.stringify((r2.list || []).map(x => x.url)));
    const r3 = await sendBg(M, { type: 'GET_NETLOG', tabId: 1, limit: 10 });
    ok(r3 && r3.total === 3, 'GET_NETLOG 返回网络清单');
    const r4 = await sendBg(M, { type: 'DL_GET_CFG' });
    ok(r4 && r4.cfg && r4.cfg.dir === '{url}', 'DL_GET_CFG 默认目录为「目标网站URL」文件夹', JSON.stringify(r4 && r4.cfg));
    ok(r4 && r4.cfg && r4.cfg.siteFolder === true, 'DL_GET_CFG 默认开启自动站点文件夹');
    ok(r4 && typeof r4.help === 'string' && r4.help.includes('{url}'), 'DL_GET_CFG 回传占位符说明');
    ok(r4.hasApi === true, '检测到 downloads API 可用');
    const r5 = await sendBg(M, { type: 'DL_SET_CFG', patch: { dir: 'OUT/{host}', maxCount: 42 } });
    ok(r5 && r5.cfg.dir === 'OUT/{host}' && r5.cfg.maxCount === 42, 'DL_SET_CFG 生效并持久化');
    const r6 = await sendBg(M, { type: 'CONSOLE_LOG', entries: [{ level: 'error', text: 'boom', url: 'https://example.com/page' }] });
    ok(r6 && r6.ok === true, 'CONSOLE_LOG 写入成功');
    const r7 = await sendBg(M, { type: 'GET_CONSOLE', tabId: 1, limit: 10 });
    ok(r7 && r7.total === 1 && r7.logs[0].text === 'boom', 'GET_CONSOLE 读回日志');
    const r8 = await sendBg(M, { type: 'SET_CONSOLE_CAPTURE', enabled: true });
    ok(r8 && r8.ok === true, 'SET_CONSOLE_CAPTURE 注册成功');
    ok(M.registeredScripts.has('leauto_console_capture'), '控制台捕获脚本已注册为主世界 content script');
    const reg = M.registeredScripts.get('leauto_console_capture');
    ok(reg && reg.world === 'MAIN' && reg.js[0] === 'inject/capture_main.js', '捕获脚本路径与世界正确', JSON.stringify(reg && reg.js));
    const r9 = await sendBg(M, { type: 'GET_HOOK_HEALTH' });
    ok(r9 && r9.available === true, 'GET_HOOK_HEALTH 报告 Hook 健康');
    const r10 = await sendBg(M, { type: 'update_hooks_registration', hostname: 'example.com', enabledHooks: ['bypass_debugger', 'hook_console'], isGlobal: false });
    ok(r10 && r10.ok === true, 'update_hooks_registration 响应正常');
    await sleep(60);
    const regs = Array.from(M.registeredScripts.values()).filter(s => s.world === 'MAIN' && s.js[0].startsWith('hooks/'));
    ok(regs.length === 2, '2 个 Hook 完成主世界注册', regs.length);
    ok(regs.some(s => s.js[0] === 'hooks/b_debugger.js'), 'bypass_debugger 注册到 b_debugger.js（回归命名错位 Bug）',
        JSON.stringify(regs.map(s => s.js[0])));
    ok(regs.every(s => s.matches[0] === '*://example.com/*'), '标准模式按域名匹配');
    const r11 = await sendBg(M, { type: 'HEIMDALLR_GET_CFG' });
    ok(r11 && r11.cfg && typeof r11.stats.total === 'number', 'HEIMDALLR_GET_CFG 正常');
    const r12 = await sendBg(M, { type: 'UPDATE_BADGE', results: { domains: [['a.com', 'x']], ips: [] } });
    ok(r12 && r12.ok === true, 'UPDATE_BADGE 正常');

    console.log('\n=== 4. 一键下载（format=files） ===');
    const before = M.downloads.length;
    const dl = await sendBg(M, {
        type: 'JS_DOWNLOAD', tabId: 1,
        opts: { format: 'files', dir: 'HAPPYJS/{host}/{date}', pageUrl: 'https://example.com/page' }
    }, undefined, 15000);
    ok(dl && dl.format === 'files' && dl.count === 4, '下载 4 个同源 JS', JSON.stringify({ count: dl && dl.count, err: dl && dl.error }));
    ok(dl && dl.savedCount === 4 && dl.failedCount === 0, '落盘成功 4 个', JSON.stringify(dl && dl.saved));
    const rec = M.downloads.slice(before).find(d => /app\.js$/.test(d.url || ''));
    ok(rec && /^HAPPYJS\/example\.com\/\d{4}-\d{2}-\d{2}\/static\/app\.js$/.test(rec.filename),
        '保存路径遵循目录模板且保留 URL 目录结构', rec && rec.filename);
    ok(rec && rec.url === 'https://example.com/static/app.js', '直接下载原始 URL（保留 Cookie）', rec && rec.url);
    ok(M.downloads.slice(before).some(d => /frompage\.js$/.test(d.filename || '')), '页面采集到的 JS 同样入队下载');
    ok(M.downloads.length - before === 4, '未多下载第三方 JS（默认排除）');

    console.log('\n=== 5. 一键下载（format=list / zip / 含第三方） ===');
    const dlList = await sendBg(M, { type: 'JS_DOWNLOAD', tabId: 1, opts: { format: 'list', dir: 'L/{host}', pageUrl: 'https://example.com/page' } }, undefined, 15000);
    ok(dlList && dlList.format === 'list' && dlList.count === 4, 'list 模式导出清单', JSON.stringify(dlList));
    const listRec = M.downloads[M.downloads.length - 1];
    ok(listRec && /^data:text\/plain;base64,/.test(listRec.url), '清单以 base64 data URL 落盘', listRec && listRec.url.slice(0, 30));
    const dlZip = await sendBg(M, { type: 'JS_DOWNLOAD', tabId: 1, opts: { format: 'zip', dir: 'Z/{host}', includeThirdParty: true, pageUrl: 'https://example.com/page' } }, undefined, 20000);
    ok(dlZip && dlZip.format === 'zip' && dlZip.ok === true, 'zip 模式打包成功', JSON.stringify({ err: dlZip && dlZip.error, packed: dlZip && dlZip.packed }));
    ok(dlZip && dlZip.packed >= 3, 'zip 内含 JS + _manifest.json + _list.txt', dlZip && dlZip.packed);
    const zipRec = M.downloads[M.downloads.length - 1];
    ok(zipRec && /^data:application\/zip;base64,/.test(zipRec.url), 'zip 以 data URL 落盘', zipRec && zipRec.url.slice(0, 32));
    ok(zipRec && /\.zip$/.test(zipRec.filename), 'zip 文件名以 .zip 结尾', zipRec && zipRec.filename);

    console.log('\n=== 5b. 批量保存位置保护 ===');
    const many = Array.from({ length: 25 }, (_, i) => `https://example.com/static/chunk${i}.js`);
    const dlSaveAs = await sendBg(M, {
        type: 'JS_DOWNLOAD', tabId: 1,
        opts: { urls: many, format: 'files', dir: 'SA/{host}', saveAs: true, pageUrl: 'https://example.com/page' }
    }, undefined, 60000);
    ok(dlSaveAs.count === 25 && dlSaveAs.savedCount === 25, '批量下载 25 个文件', JSON.stringify({ c: dlSaveAs.count, ok: dlSaveAs.savedCount }));
    ok(/自动关闭/.test(String(dlSaveAs.note)), '超过 20 个文件时自动关闭「每次询问保存位置」', dlSaveAs.note);
    const last25 = M.downloads.slice(-25);
    ok(last25.every(d => !d.saveAs), '实际下载参数中 saveAs 未被传递');


    console.log('\n=== 5c. 端口 10087 / 无 downloads 权限回退 / 启动自检 ===');
    ok(g('MCPClient.cfg.port') === 10087, '默认桥接端口为 10087', String(g('MCPClient.cfg.port')));
    ok(JSON.stringify(g('MCPClient.portCandidates()')) === '[10087,10086]', '连接失败时会在 10087/10086 间轮换',
        JSON.stringify(g('MCPClient.portCandidates()')));

    // 删除 downloads API → 逐文件下载必须回退到「页面内 Blob 落盘」
    delete M.chrome.downloads;
    const dlFb = await sendBg(M, {
        type: 'JS_DOWNLOAD', tabId: 1,
        opts: { urls: ['https://example.com/static/app.js'], format: 'files', dir: 'FB/{host}', pageUrl: 'https://example.com/page' }
    }, undefined, 15000);
    ok(dlFb && dlFb.savedCount === 1, '缺少 downloads 权限时仍能落盘（页面回退）', JSON.stringify(dlFb));
    ok(dlFb && dlFb.saved && /app\.js$/.test(dlFb.saved[0].file), '回退路径文件名正确', JSON.stringify(dlFb && dlFb.saved));
    const zipFb = await sendBg(M, {
        type: 'JS_DOWNLOAD', tabId: 1,
        opts: { urls: ['https://example.com/static/app.js'], format: 'zip', dir: 'FB/{host}', pageUrl: 'https://example.com/page' }
    }, undefined, 30000);
    ok(zipFb && zipFb.ok === true && zipFb.packed >= 3, 'ZIP 打包在无权限时也走页面回退', JSON.stringify({ ok: zipFb && zipFb.ok, err: zipFb && zipFb.error }));

    // 启动自检
    M.chrome.downloads = M.downloadsMock;
    const healthSelf = await sendBg(M, { type: 'GET_HEALTH' });
    ok(healthSelf && healthSelf.ok === true, 'GET_HEALTH 报告整体健康', JSON.stringify(healthSelf && { missing: healthSelf.missingModules, errors: healthSelf.errors }));
    ok(healthSelf && healthSelf.missingModules.length === 0, '14 个模块全部加载（含 SiteScope/ChunkFinder/RouteFinder/JsPredictor）', JSON.stringify(healthSelf && healthSelf.missingModules));
    ok(healthSelf && !!healthSelf.mcp && typeof healthSelf.mcp.port === 'number', '自检包含 MCP 状态');
    ok(healthSelf && healthSelf.hooks && healthSelf.hooks.missing.length === 0, '自检包含 Hook 健康');
    const cdp = await sendBg(M, { type: 'CDP_GET_STATUS' });
    ok(cdp && cdp.supported === false || cdp.granted === false, 'CDP 状态可查询（默认未授权）', JSON.stringify(cdp));

    console.log('\n=== 5d. 站点文件夹 / 绝对路径 / DL_PLAN / DL_FETCH_B64 ===');
    // 目录模板里没有站点占位符 → 自动追加「目标网站URL」文件夹
    const dlSite = await sendBg(M, {
        type: 'JS_DOWNLOAD', tabId: 1,
        opts: { urls: ['https://example.com/static/app.js'], format: 'files', dir: 'OUTER',
                pageUrl: 'http://dns2.example.edu.cn/index.html#/home' }
    }, undefined, 15000);
    ok(dlSite && dlSite.savedCount === 1, '自定义目录下载成功', JSON.stringify(dlSite && dlSite.error));
    ok(dlSite && /^OUTER\/dns2\.example\.edu\.cn\/static\/app\.js$/.test((dlSite.saved[0] || {}).file || ''),
        '自定义目录下自动创建「目标网站URL」文件夹', JSON.stringify(dlSite && dlSite.saved));
    ok(dlSite && dlSite.siteFolder === 'dns2.example.edu.cn', '结果回传站点文件夹名', String(dlSite && dlSite.siteFolder));

    const dlNoSite = await sendBg(M, {
        type: 'JS_DOWNLOAD', tabId: 1,
        opts: { urls: ['https://example.com/static/app.js'], format: 'files', dir: 'PLAIN',
                siteFolder: false, pageUrl: 'http://dns2.example.edu.cn/index.html#/home' }
    }, undefined, 15000);
    ok(dlNoSite && /^PLAIN\/static\/app\.js$/.test((dlNoSite.saved[0] || {}).file || ''),
        'siteFolder=false 时不追加站点文件夹', JSON.stringify(dlNoSite && dlNoSite.saved));

    // 绝对路径：降级到默认下载目录 + 明确告警（浏览器下载接口不接受绝对路径）
    const dlAbs = await sendBg(M, {
        type: 'JS_DOWNLOAD', tabId: 1,
        opts: { urls: ['https://example.com/static/app.js'], format: 'files', dir: 'D:////JsXray\\js',
                pageUrl: 'https://example.com/page' }
    }, undefined, 15000);
    ok(dlAbs && dlAbs.dirAbsolute === true, '绝对路径被标记', JSON.stringify(dlAbs && dlAbs.dirRaw));
    ok(dlAbs && /^JsXray\/js\/example\.com\/static\/app\.js$/.test((dlAbs.saved[0] || {}).file || ''),
        '绝对路径降级为默认下载目录下的相对路径', JSON.stringify(dlAbs && dlAbs.saved));
    ok(dlAbs && /绝对路径/.test(String(dlAbs.note)), '结果中给出绝对路径告警与替代方案', String(dlAbs && dlAbs.note).slice(0, 60));

    // DL_PLAN：直写模式与下载模式共用同一套命名
    const plan1 = await sendBg(M, {
        type: 'DL_PLAN', tabId: 1, pageUrl: 'http://dns2.example.edu.cn/index.html#/home',
        urls: ['https://dns2.example.edu.cn/js/app.js', 'https://dns2.example.edu.cn/js/app.js?v=2'],
        dir: '{url}/{date}', siteFolder: true
    });
    ok(plan1 && plan1.site === 'dns2.example.edu.cn', 'DL_PLAN 返回站点文件夹名', JSON.stringify(plan1 && plan1.site));
    ok(plan1 && plan1.files.length === 2 && /^dns2\.example\.edu\.cn\/\d{4}-\d{2}-\d{2}\/js\/app\.js$/.test(plan1.files[0].rel),
        'DL_PLAN 规划相对路径（含站点文件夹与日期）', JSON.stringify(plan1 && plan1.files.map(f => f.rel)));
    ok(plan1 && plan1.files[0].rel !== plan1.files[1].rel, 'DL_PLAN 同名文件自动区分');
    const plan2 = await sendBg(M, { type: 'DL_PLAN', tabId: 1, pageUrl: 'https://example.com/page', urls: ['https://example.com/static/app.js'], dir: 'D:////x////y' });
    ok(plan2 && plan2.absolute === true && plan2.dir === 'x/y/example.com', 'DL_PLAN 绝对路径降级并追加站点文件夹', JSON.stringify(plan2 && plan2.dir));

    // DL_FETCH_B64：直写模式取原始字节
    const fb64 = await sendBg(M, { type: 'DL_FETCH_B64', tabId: 1, url: 'https://example.com/static/app.js' });
    ok(fb64 && fb64.ok === true, 'DL_FETCH_B64 取到文件内容', JSON.stringify(fb64 && fb64.error));
    ok(fb64 && Buffer.from(fb64.base64 || '', 'base64').toString('utf8').includes('mock js'), 'DL_FETCH_B64 返回的 base64 可解码');
    const fb64bad = await sendBg(M, { type: 'DL_FETCH_B64', tabId: 1, url: 'file:///etc/passwd' });
    ok(fb64bad && fb64bad.ok === false, 'DL_FETCH_B64 拒绝非 http(s) URL');


    console.log('\n=== 5e. 信息泄露引擎（多关键字 AND） ===');
    const IL = g('InfoLeak');
    const ilStats = IL.stats();
    ok(ilStats.total === 171, '规则总数 171 条（内置 65 + BurpAPIFinder 106）', JSON.stringify(ilStats));
    ok(ilStats.builtin === 65 && ilStats.burpapi === 106, '内置/BurpAPI 规则数分别正确', JSON.stringify(ilStats));
    ok(ilStats.engine === true, 'ApiFinderEngine 已由 importScripts 加载');

    // AND 规则：只有 userName + newPwd 同时出现才命中
    const hitBoth = IL.match('var d={newPwd:"1",userName:"admin"};', '/user/changePwd');
    ok(hitBoth.hits.length >= 1, 'AND 规则两个关键字同时出现 → 命中', JSON.stringify(hitBoth.hits.slice(0, 2)));
    ok(hitBoth.hits.some(h => /修改密码|newPwd/.test(h.text)), '命中内容含规则描述或关键字', JSON.stringify((hitBoth.hits[0] || {}).text || ''));
    const hitOne = IL.match('var d={newPwd:"1"};', '/user/changePwd');
    ok(!hitOne.hits.some(h => h.ruleId === 'cred-modpwd-1'), '只出现一个关键字 → 该 AND 规则不命中（降误报）');
    ok(IL.match('', '/x').hits.length === 0, '空文本不产生命中');

    // 白名单规则不参与匹配
    ok(!IL.match('anything', '/x').hits.some(h => /白名单/.test(h.category)), '白名单规则不作为命中输出');

    // 准确度过滤：acc=3 时结果 <= acc=1 时
    const acc3 = IL.match('var d={newPwd:"1",userName:"admin"};', '/x', { acc: 3 });
    IL.cfg.acc = 3; IL._cacheKey = '';
    const only3 = IL.match('var d={newPwd:"1",userName:"admin"};', '/x');
    IL.cfg.acc = 1; IL._cacheKey = '';
    const all1 = IL.match('var d={newPwd:"1",userName:"admin"};', '/x');
    IL.cfg.acc = 2; IL._cacheKey = '';
    ok(only3.hits.length <= all1.hits.length, '准确度阈值生效（acc=3 结果不多于 acc=1）', `acc3=${only3.hits.length} acc1=${all1.hits.length}`);
    ok(only3.hits.every(h => h.accuracy >= 3), 'acc=3 时所有命中的准确度都 >= 3');

    // 规则来源过滤
    IL.cfg.src = 'burpapi'; IL._cacheKey = '';
    ok(IL.rules().every(r => String(r.id).startsWith('burp-')), '规则来源可切换为仅 BurpAPIFinder');
    IL.cfg.src = 'builtin'; IL._cacheKey = '';
    ok(IL.rules().every(r => !String(r.id).startsWith('burp-')), '规则来源可切换为仅内置');
    IL.cfg.src = 'all'; IL._cacheKey = '';
    const ilCfg = await sendBg(M, { type: 'INFO_LEAK_GET_CFG' });
    ok(ilCfg && ilCfg.cfg && typeof ilCfg.stats.total === 'number', 'INFO_LEAK_GET_CFG 正常');
    const ilSet = await sendBg(M, { type: 'INFO_LEAK_SET_CFG', patch: { acc: 3 } });
    ok(ilSet && ilSet.cfg.acc === 3, 'INFO_LEAK_SET_CFG 生效', JSON.stringify(ilSet && ilSet.cfg));
    const ilMatch = await sendBg(M, { type: 'INFO_LEAK_MATCH', text: 'var d={newPwd:"1",userName:"admin"};', urlPath: '/x' });
    ok(ilMatch && ilMatch.ok && Array.isArray(ilMatch.hits), 'INFO_LEAK_MATCH 消息链路正常', JSON.stringify({ n: ilMatch && ilMatch.hits.length }));
    const ilOff = await sendBg(M, { type: 'INFO_LEAK_SET_CFG', patch: { enabled: false, acc: 2 } });
    ok((await sendBg(M, { type: 'INFO_LEAK_MATCH', text: 'var d={newPwd:"1",userName:"admin"};', urlPath: '/x' })).hits.length === 0,
        '关闭后不再产生命中');

    console.log('\n=== 5f. 接口认证绕过扫描（加固版） ===');
    const AB = g('AuthBypass');
    const variants = AB.buildVariants('https://a.com', '/api/user/list');
    ok(variants.length === 14, '共 14 种绕过变体', String(variants.length));
    ok(variants.some(v => v.url === 'https://a.com/api/user/list;.css'), ';.css 变体正确', JSON.stringify(variants[0]));
    ok(variants.some(v => v.url.endsWith('%23/')), '%23/ 变体正确');
    ok(AB.buildVariants('https://a.com', 'https://b.com/x').every(v => v.url.startsWith('https://b.com')), '绝对 URL 候选不再拼 base');

    // 危险路径与噪声过滤
    ok(AB.isProbeable('/user/home/getNav') === true, '正常接口可探测');
    ok(AB.isProbeable('/user/logout') === false, '登出接口被跳过（红线：不吊销会话）');
    ok(AB.isProbeable('/api/user/delete') === false, '删除类接口被跳过');
    ok(AB.isProbeable('/static/app.js') === false, '静态 JS 被跳过');
    ok(AB.isProbeable('MM/D/YYYY') === false, '日期格式噪声被跳过');
    ok(AB.isProbeable('/api/v1/report.pdf') === false, '静态文档被跳过');

    // 探测判定：2xx 且不像登录页 → 未授权；含"请先登录" → 排除
    const setFetch = (h) => { M.sandbox.__fetchHandler = h; };
    setFetch(async (url) => ({
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ code: 0, data: [{ id: 1, name: 'x' }] })
    }));
    const abRun = await AB.run({
        apis: ['/api/user/list', '/user/logout', '/static/app.js'],
        bases: [{ url: 'https://a.com', rule: 'test' }],
        limit: 5
    });
    ok(abRun.total === 14, '只对 1 个可探测接口生成 14 个变体', String(abRun.total));
    ok(abRun.meta.skippedDanger.includes('/user/logout'), '跳过清单包含登出接口', JSON.stringify(abRun.meta.skippedDanger));
    ok(abRun.unauthCount === 14, '2xx JSON 响应全部判定为可未授权访问', String(abRun.unauthCount));
    ok(abRun.results[0].status === 200 && abRun.results[0].variant !== undefined, '结果含状态码与变体标签');
    ok(abRun.results[0].status === 200 && abRun.results[0].label !== undefined, '结果含变体标签（label）');

    // 假阳性：返回"请先登录"
    setFetch(async () => ({
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ code: 401, msg: '请先登录' })
    }));
    const abLogin = await AB.run({ apis: ['/api/user/list'], bases: [{ url: 'https://a.com' }], limit: 2 });
    ok(abLogin.unauthCount === 0, '返回「请先登录」的响应不算未授权（假阳性已过滤）', JSON.stringify(abLogin.unauthCount));

    // 风控：429 立即停止
    setFetch(async () => ({ ok: false, status: 429, headers: { get: () => 'text/html' }, text: async () => 'too many requests' }));
    const abWaf = await AB.run({ apis: ['/api/user/list'], bases: [{ url: 'https://a.com' }], limit: 2 });
    ok(abWaf.aborted === true && /风控|限流|429/.test(abWaf.abortReason || ''), '命中 429 立即停止探测', abWaf.abortReason);
    ok(abWaf.unauthCount === 0, '限流响应不计为未授权');

    // redirect: 'manual' → status 0 视为跳转，不算未授权
    setFetch(async () => ({ ok: false, status: 0, type: 'opaqueredirect', headers: { get: () => '' }, text: async () => '' }));
    const abRedir = await AB.run({ apis: ['/api/user/list'], bases: [{ url: 'https://a.com' }], limit: 2 });
    ok(abRedir.unauthCount === 0, '登录跳转（opaque redirect）不算未授权', JSON.stringify(abRedir.unauthCount));

    // dryRun 不发请求
    let fetchCalls = 0;
    setFetch(async () => { fetchCalls++; return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}' }; });
    const abDry = await AB.run({ apis: ['/api/user/list'], bases: [{ url: 'https://a.com' }], limit: 2, dryRun: true });
    ok(abDry.dryRun === true && fetchCalls === 0, 'dryRun 只生成变体、不发请求', `fetchCalls=${fetchCalls}`);
    ok(abDry.items.length === 14, 'dryRun 返回 14 个待探测变体');

    // 请求上限保护
    setFetch(async () => { fetchCalls++; return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}' }; });
    const savedCfg = { ...AB.cfg };
    AB.cfg.maxRequests = 3;
    const abCap = await AB.run({ apis: ['/api/a', '/api/b'], bases: [{ url: 'https://a.com' }], limit: 5 });
    ok(abCap.aborted === true && abCap.probed <= 8, '超过单次请求上限立即停止', `probed=${abCap.probed} reason=${abCap.abortReason}`);
    Object.assign(AB.cfg, savedCfg);
    setFetch(null);


    console.log('\n=== 5g. 云存储桶模块（BucketSentinel + 10 厂商引擎） ===');
    ok(g('typeof BucketSentinel') === 'object', 'bucket_bg.js 已加载（BucketSentinel）');
    ok(g('typeof BucketDetect') === 'object' && typeof g('BucketDetect.detectVendor') === 'function',
        'bucket_core.js 已加载（10 厂商引擎）');
    ok(g('typeof BucketVendors') === 'object', '厂商检测函数已注册到 BucketVendors');
    ok(g('BucketSentinel.handles("list-update")') === true, 'BucketSentinel 接管 list-update 消息');
    ok(g('BucketSentinel.handles("REGEX_MATCH")') === false, 'BucketSentinel 不抢我们的消息类型');

    // 厂商识别（纯域名判断，不发请求）
    const vendorCases = [
        ['https://x.oss-cn-hangzhou.aliyuncs.com/a.js', '阿里云'],
        ['https://x-1250000000.cos.ap-guangzhou.myqcloud.com/a.js', '腾讯云'],
        ['https://x.obs.cn-north-4.myhuaweicloud.com/a.js', '华为云'],
        ['https://s3.amazonaws.com/bucket/a.js', 'AmazonS3']
    ];
    const vendorOk = vendorCases.every(([u, want]) => g(`BucketDetect.detectVendor(${JSON.stringify(u)})`) === want);
    ok(vendorOk, '厂商识别正确（阿里云/腾讯云/华为云/S3）', vendorCases.map(([u]) => g(`BucketDetect.detectVendor(${JSON.stringify(u)})`)).join(','));

    // 黑白名单：走真实消息委派（BucketSentinel.handle）
    const blAdd = await sendBg(M, { type: 'list-update', key: 'detectBlacklist', action: 'add', value: 'evil.example' });
    ok(blAdd && blAdd.ok && blAdd.list.includes('evil.example'), '黑名单添加走 BucketSentinel 委派', JSON.stringify(blAdd));
    ok(M.store.detectBlacklist && M.store.detectBlacklist.includes('evil.example'), '黑名单已持久化到 storage');
    const wlAdd = await sendBg(M, { type: 'list-update', key: 'detectWhitelist', action: 'add', value: '*.example.com' });
    ok(wlAdd && wlAdd.ok, '白名单通配符条目添加成功', JSON.stringify(wlAdd));
    const conflict = await sendBg(M, { type: 'list-update', key: 'detectBlacklist', action: 'add', value: 'a.example.com' });
    ok(conflict && conflict.ok === false && conflict.reason === 'conflict',
        '黑白名单互斥冲突检测生效（通配符覆盖）', JSON.stringify(conflict));
    const blClear = await sendBg(M, { type: 'list-update', key: 'detectBlacklist', action: 'clear' });
    ok(blClear && blClear.ok && blClear.list.length === 0, '黑名单清空');
    await sendBg(M, { type: 'list-update', key: 'detectWhitelist', action: 'clear' });
    const badKey = await sendBg(M, { type: 'list-update', key: 'hackKey', action: 'add', value: 'x' });
    ok(badKey && badKey.ok === false, '非法名单键被拒绝');

    // 安全模式：被动检测默认只读（不产生 PUT/DELETE/写 ACL/写 Policy 请求）
    ok(g('BucketDetect.detectBucketVul') && true, '检测入口存在（写类探测由 safeMode/enabledTypes 门控，见 test_bucket_core.js）');

    ok(M.wr.onCompleted.length >= 1, '被动检测监听已注册到 webRequest.onCompleted');

    // MCP 只读工具
    const MCPb = g('MCPClient');
    M.store.bucketVulHistory = [
        { url: 'https://x.oss-cn-hangzhou.aliyuncs.com/', type: '存储桶可遍历', vendor: 'aliyun', source: '主动', time: 1700000000000, request: 'GET / HTTP/1.1', response: 'HTTP/1.1 200 OK' },
        { url: 'https://x.oss-cn-hangzhou.aliyuncs.com/a.js', type: '域名命中', vendor: 'aliyun', source: '被动-页面扫描', time: 1700000001000 },
        { url: 'https://y.s3.amazonaws.com/', type: 'ACL可读', vendor: 'AmazonS3', source: '被动', time: 1700000002000 }
    ];
    const br = await MCPb.dispatch('get_bucket_risks', {});
    ok(br.count === 2, 'get_bucket_risks 默认排除「域名命中」弱信号', JSON.stringify({ count: br.count }));
    ok(br.risks.length === 2 && br.risks.every(r => r.type !== '域名命中'), '返回内容只含真实风险');
    const brVendor = await MCPb.dispatch('get_bucket_risks', { vendor: 'AmazonS3' });
    ok(brVendor.count === 1 && brVendor.risks[0].type === 'ACL可读', '按厂商过滤生效');
    const brAll = await MCPb.dispatch('get_bucket_risks', { includeDomainHits: true, includeReqResp: true });
    ok(brAll.count === 3 && brAll.risks.some(r => r.request), 'includeDomainHits + includeReqResp 生效');
    const bc = await MCPb.dispatch('get_bucket_config', {});
    ok(bc && bc.switches && bc.switches.safeMode === true, 'get_bucket_config 读取配置（安全模式默认开）', JSON.stringify(bc && bc.switches));
    ok(bc.scanLimits && bc.scanLimits.maxTotalCandidates === 60, '配置含页面扫描性能上限');
    ok(/安全模式/.test(bc.note || ''), '配置返回安全模式说明（写类探测需手动勾选）');


    console.log('\n=== 5h. JS 预测补齐 / 覆盖对账 / 动态代码（借鉴 hybrid_capture_project2） ===');
    ok(g('typeof SiteScope') === 'object', 'site_scope.js 已由 importScripts 加载');
    ok(g('typeof ChunkFinder') === 'object' && typeof g('ChunkFinder.discoverChunks') === 'function',
        'chunk_finder.js 已加载（chunk 合成）');
    ok(g('typeof RouteFinder') === 'object' && typeof g('RouteFinder.extractRoutes') === 'function',
        'route_finder.js 已加载（路由提取）');
    ok(g('typeof JsPredictor') === 'object', 'JsPredictor 模块已定义');
    ok(g('typeof DynamicCodeStore') === 'object', 'DynamicCodeStore 模块已定义');

    // 站点范围分类：让「仅本站 JS」不再把自家接口域当第三方，也不再把 CDN 库当目标
    ok(g(`SiteScope.classify('https://api.example.com/a.js','example.com').scope`) === 'site',
        '自有接口子域判定为 site');
    ok(g(`SiteScope.classify('https://cdn.jsdelivr.net/vue.js','example.com').scope`) === 'cdn',
        '公共 CDN 判定为 cdn');
    ok(g(`SiteScope.classify('https://www.google-analytics.com/ga.js','example.com').scope`) === 'noise',
        '统计域判定为 noise');
    ok(g(`SiteScope.baseDomain('dns2.example.edu.cn')`) === 'example.edu.cn', '两级后缀基础域切分正确');

    // 资源清单现在带 scope 字段
    const resScoped = await sendBg(M, { type: 'GET_JS_RESOURCES', tabId: 1, includeThirdParty: true, pageUrl: 'https://example.com/page' });
    ok(resScoped && resScoped.list.every(x => 'scope' in x), 'GET_JS_RESOURCES 每条都带 scope 字段',
        JSON.stringify((resScoped.list[0] || {})));
    ok(resScoped.list.some(x => x.scope === 'site'), '同源 JS 被标为 site');
    const resSite = await sendBg(M, { type: 'GET_JS_RESOURCES', tabId: 1, includeThirdParty: true, scope: 'site', pageUrl: 'https://example.com/page' });
    ok(resSite && resSite.list.every(x => x.scope === 'site' || x.scope == null),
        'scope=site 过滤只留同主体资源', JSON.stringify((resSite.list || []).map(x => x.scope)));

    // 预测补齐：桩里没有 webpack runtime，应为「空结果但结构完整」，不能抛错
    const pred = await sendBg(M, {
        type: 'GET_JS_PREDICT', tabId: 1, pageUrl: 'https://example.com/page'
    }, undefined, 30000);
    ok(pred && pred.ok === true, 'GET_JS_PREDICT 正常返回', JSON.stringify(pred && pred.error));
    ok(Array.isArray(pred.candidates) && Array.isArray(pred.routes), '预测结果含 candidates 与 routes');
    ok(pred.stats && typeof pred.stats.analyzedFiles === 'number', '预测返回分析统计', JSON.stringify(pred.stats));
    ok(pred.stats.analyzedFiles <= 24, '分析文件数受上限约束', String(pred.stats.analyzedFiles));
    ok(typeof pred.note === 'string' && pred.note.length > 0, '预测返回可读的结论说明（空结果也有解释）');

    // 无 pageUrl 时不应崩溃（mock 标签页有 url，用不存在的 tabId 触发兜底分支）
    const predNoTab = await sendBg(M, { type: 'GET_JS_PREDICT', tabId: 999, pageUrl: '' }, undefined, 30000);
    ok(predNoTab && predNoTab.ok === true || (predNoTab && predNoTab.error), '未知标签页不抛未捕获异常',
        JSON.stringify(predNoTab && predNoTab.error));

    // 覆盖对账
    const cov = await sendBg(M, { type: 'DL_COVERAGE', tabId: 1, pageUrl: 'https://example.com/page' });
    ok(cov && cov.ok === true, 'DL_COVERAGE 正常返回', JSON.stringify(cov && cov.error));
    ok(cov.total === cov.observedCount + cov.predictedCount, '覆盖对账总数 = 观测 + 预测',
        JSON.stringify({ total: cov.total, o: cov.observedCount, p: cov.predictedCount }));
    ok(cov.site && typeof cov.site.gap === 'number', '覆盖对账给出站点自有缺口', JSON.stringify(cov.site));
    ok(typeof cov.note === 'string' && cov.note.length > 0, '覆盖对账给出可读说明');
    ok(cov.scopeAvailable === true, '覆盖对账确认域分类能力可用');

    // 动态代码存储：入队 → 读取 → 隔离（不同标签页互不干扰）
    const d1 = await sendBg(M, { type: 'DYNAMIC_CODE_ADD', tabId: 1, kind: 'blob-url', code: 'var a=1;'.repeat(20), meta: { blobUrl: 'blob:https://example.com/x' } });
    ok(d1 && d1.ok === true && d1.id > 0, '动态代码入库成功', JSON.stringify(d1));
    await sendBg(M, { type: 'DYNAMIC_CODE_ADD', tabId: 1, kind: 'eval', code: 'eval("var b=2;")' });
    const dyn = await sendBg(M, { type: 'GET_DYNAMIC_CODE', tabId: 1, limit: 10 });
    ok(dyn && dyn.total === 2, '动态代码可读取', JSON.stringify({ total: dyn && dyn.total }));
    ok(dyn.kinds['blob-url'] === 1 && dyn.kinds.eval === 1, '按类型统计正确', JSON.stringify(dyn.kinds));
    ok(dyn.items[0].code && dyn.items[0].code.length > 0, '默认返回完整代码（供 AI 分析）');
    const dynPreview = await sendBg(M, { type: 'GET_DYNAMIC_CODE', tabId: 1, limit: 10, withCode: false });
    ok(dynPreview.items.every(x => x.code === undefined && typeof x.preview === 'string'),
        'withCode=false 时只回预览');
    // 注意：background 取的是 sender.tab.id（优先于 msg.tabId），所以要造另一个标签页的 sender
    const SENDER_TAB2 = { tab: { id: 2, url: 'https://other.example.com/' }, frameId: 0 };
    const dynOther = await sendBg(M, { type: 'GET_DYNAMIC_CODE', limit: 10 }, SENDER_TAB2);
    ok(dynOther.total === 0, '动态代码按标签页隔离');

    // 上限：超过 120 条时丢弃最旧
    const SENDER_TAB3 = { tab: { id: 3, url: 'https://third.example.com/' }, frameId: 0 };
    for (let i = 0; i < 130; i++) {
        await sendBg(M, { type: 'DYNAMIC_CODE_ADD', kind: 'eval', code: 'var x' + i + '=1;' }, SENDER_TAB3);
    }
    const dynCap = await sendBg(M, { type: 'GET_DYNAMIC_CODE', limit: 200, withCode: false }, SENDER_TAB3);
    ok(dynCap.total <= 120, '动态代码条数上限生效（丢弃最旧）', String(dynCap.total));

    // Worker 脚本并入资源清单 → 会被「下载全部」一起带走
    // 用独立标签页（tab 4），避免污染后面针对 tab 1 的计数断言
    const SENDER_TAB4 = { tab: { id: 4, url: 'https://worker.example.com/page' }, frameId: 0 };
    await sendBg(M, { type: 'WORKER_SCRIPT', kind: 'worker', url: 'https://worker.example.com/w/crypto.worker.js', meta: {} }, SENDER_TAB4);
    const resAfterWorker = await sendBg(M, { type: 'GET_JS_RESOURCES', includeThirdParty: true, pageUrl: 'https://worker.example.com/page' }, SENDER_TAB4);
    ok(resAfterWorker.list.some(x => /crypto\.worker\.js$/.test(x.url)), 'Worker 脚本已并入 JS 资源清单',
        JSON.stringify(resAfterWorker.list.map(x => x.url)));
    const badWorker = await sendBg(M, { type: 'WORKER_SCRIPT', kind: 'worker', url: 'chrome-extension://x/y.js', meta: {} }, SENDER_TAB4);
    ok(badWorker && badWorker.ok === true, '非 http(s) 的 Worker 地址被静默忽略（不入清单）');
    ok(!resAfterWorker.list.some(x => x.url.startsWith('chrome-extension://')), '清单里不含扩展自身资源');

    // MCP 只读工具
    const MCPd = g('MCPClient');
    const tDyn = await MCPd.dispatch('get_dynamic_code', { tabId: 1, limit: 2 });
    ok(tDyn && tDyn.total === 2, 'MCP get_dynamic_code 可读动态代码', JSON.stringify({ total: tDyn && tDyn.total }));
    ok(tDyn.items.every(x => x.timeText && x.kind), '动态代码返回可读时间与类型');
    const tCov = await MCPd.dispatch('get_js_coverage', { tabId: 1 });
    ok(tCov && typeof tCov.coveragePercent === 'number', 'MCP get_js_coverage 返回覆盖率',
        JSON.stringify({ pct: tCov && tCov.coveragePercent }));
    const tPred = await MCPd.dispatch('predict_js_chunks', { tabId: 1, verify: false });
    ok(tPred && tPred.ok === true && typeof tPred.candidateCount === 'number',
        'MCP predict_js_chunks 可调用', JSON.stringify({ n: tPred && tPred.candidateCount }));
    ok(tPred.note && typeof tPred.note === 'string', 'MCP 预测工具返回说明文案');

    console.log('\n=== 6. MCP 工具实现链路（MCPClient.dispatch） ===');
    const MCP = g('MCPClient');
    ok(typeof MCP.dispatch === 'function', 'MCPClient.dispatch 存在');

    const t1 = await MCP.dispatch('list_tabs', {});
    ok(t1.count === 1 && t1.activeTabId === 1, 'list_tabs', JSON.stringify(t1));
    const t2 = await MCP.dispatch('get_frame_tree', { tabId: 1 });
    ok(t2.count === 2 && t2.frames[1].frameId === 3, 'get_frame_tree', JSON.stringify(t2.count));
    const t3 = await MCP.dispatch('get_js_list', { tabId: 1, includeThirdParty: true });
    ok(t3.count === 6 && t3.js.some(x => x.thirdParty), 'get_js_list 含第三方标记（观测 3 + 页面 3）', JSON.stringify(t3.count));
    const t4 = await MCP.dispatch('get_network_requests', { tabId: 1 });
    ok(t4.total === 3 && t4.requests[0].method, 'get_network_requests', JSON.stringify(t4.total));
    const t5 = await MCP.dispatch('search_in_js', { tabId: 1, pattern: 'api/login', includeThirdParty: true });
    ok(t5.filesScanned >= 1 && t5.hitCount >= 1, 'search_in_js 命中源码', JSON.stringify({ scanned: t5.filesScanned, hits: t5.hitCount }));
    ok(t5.hits[0].line >= 1 && typeof t5.hits[0].snippet === 'string', '命中结果含行号与片段');
    const t5b = await MCP.dispatch('search_in_js', { tabId: 1, pattern: 'login(', regex: false, caseSensitive: true, includeThirdParty: true });
    ok(t5b.hitCount >= 1, 'search_in_js 支持纯文本模式');
    const t6 = await MCP.dispatch('beautify_js', { code: 'function a(){var b=1;return b}' });
    ok(t6.ok && t6.code.includes('function a()') && t6.prettyLines > 1, 'beautify_js 生效', JSON.stringify(t6.prettyLines));
    const t7 = await MCP.dispatch('get_console_logs', { tabId: 1 });
    ok(t7.total === 1 && t7.logs[0].text === 'boom', 'get_console_logs', JSON.stringify(t7.total));
    const t8 = await MCP.dispatch('get_storage', { tabId: 1 });
    ok(t8 && t8.__mock === true, 'get_storage 注入执行（桩返回）', JSON.stringify(t8));
    const t9 = await MCP.dispatch('query_dom', { tabId: 1, selector: 'a[href]' });
    ok(t9 && t9.__mock === true, 'query_dom 注入执行（桩返回）');
    const t10 = await MCP.dispatch('execute_js', { tabId: 1, code: '1+1' });
    ok(t10 && t10.world === 'MAIN' && t10.frameId === 0, 'execute_js 在主世界执行且带 frameId', JSON.stringify(t10));
    const t11 = await MCP.dispatch('get_page_html', { tabId: 1 });
    ok(t11 && t11.__mock === true, 'get_page_html 注入执行');
    const t12 = await MCP.dispatch('screenshot', { tabId: 1 });
    ok(t12.ok === true && !!t12.saved, 'screenshot 落盘', JSON.stringify(t12));
    const t13 = await MCP.dispatch('list_hooks', {});
    ok(t13.total === 20 && t13.unavailable.length === 0, 'list_hooks 20 个 Hook 全部可用（含动态代码/Worker 捕获）', JSON.stringify({ total: t13.total, bad: t13.unavailable }));
    ok(t13.hooks.find(h => h.id === 'bypass_debugger').file === 'hooks/b_debugger.js', 'list_hooks 暴露实际文件路径');
    const t14 = await MCP.dispatch('enable_hook', { hookId: 'hook_cookie', hostname: 'example.com' });
    ok(t14 && t14.ok === true, 'enable_hook 成功', JSON.stringify(t14));
    const t15 = await MCP.dispatch('disable_hook', { hookId: 'hook_cookie', hostname: 'example.com' });
    ok(t15 && t15.enabled === false, 'disable_hook 成功');
    const t16 = await MCP.dispatch('get_fingerprints', { tabId: 1 });
    ok(t16 && t16.httpFingerprints && t16.guardRuleHits, 'get_fingerprints 返回结构正常');
    const t17 = await MCP.dispatch('get_scan_results', { tabId: 1, preset: 'api' });
    ok(t17 && t17.preset === 'api' && t17.categories.includes('absoluteApis') && t17.frames[0].results.absoluteApis,
        'get_scan_results 支持 preset 过滤', JSON.stringify({ preset: t17.preset, cats: t17.categories }));
    const t18 = await MCP.dispatch('download_js', { tabId: 1, format: 'files', dir: 'MCP/{host}', pageUrl: 'https://example.com/page' });
    ok(t18 && t18.count === 4, 'MCP download_js 复用下载引擎', JSON.stringify({ count: t18 && t18.count, err: t18 && t18.error }));
    const t19 = await MCP.dispatch('fetch_js', { url: 'https://example.com/static/app.js', beautify: true, tabId: 1 });
    ok(t19.ok === true && typeof t19.content === 'string', 'fetch_js 抓取成功');

    let threw = '';
    try { await MCP.dispatch('nope', {}); } catch (e) { threw = String(e.message); }
    ok(/未知工具/.test(threw), '未知工具抛出明确错误', threw);


    console.log('\n=== 8. 修复回归：4xx 过滤 / 体积回填 / world 语义 / 字段语义 ===');

    /* ① 状态码过滤：站点自己的失败回退请求会把 404 混进清单，
     *    浏览器下载接口对 404 同样落盘 → 会把 HTML 错误页存成 .js */
    fire(wr.onBeforeRequest, { tabId: 1, frameId: 0, url: 'https://example.com/ghost/piwik.js', type: 'script', initiator: 'https://example.com/page', method: 'GET' });
    fire(wr.onCompleted, { tabId: 1, url: 'https://example.com/ghost/piwik.js', statusCode: 404 });
    const resBad = await sendBg(M, { type: 'GET_JS_RESOURCES', tabId: 1, includeThirdParty: true, pageUrl: 'https://example.com/page' });
    ok(!resBad.list.some(x => /ghost\/piwik\.js$/.test(x.url)), '404 资源默认不进 JS 清单',
        JSON.stringify(resBad.list.filter(x => /ghost/.test(x.url)).map(x => x.url)));
    ok(resBad.excludedFailed >= 1, '回传被排除的失败资源数', String(resBad.excludedFailed));
    ok(resBad.includeFailed === false, '默认 includeFailed=false');
    const resBadIncl = await sendBg(M, { type: 'GET_JS_RESOURCES', tabId: 1, includeThirdParty: true, includeFailed: true, pageUrl: 'https://example.com/page' });
    ok(resBadIncl.list.some(x => /ghost\/piwik\.js$/.test(x.url)), 'includeFailed=true 时才包含 404');
    ok(resBadIncl.excludedFailed === 0, 'includeFailed 时不计入 excludedFailed', String(resBadIncl.excludedFailed));

    // ② 显式传入 urls 时也要剔除已知 4xx
    const dlBad = await sendBg(M, {
        type: 'JS_DOWNLOAD', tabId: 1,
        opts: {
            urls: ['https://example.com/ghost/piwik.js', 'https://example.com/static/app.js'],
            format: 'files', dir: 'X/{host}', pageUrl: 'https://example.com/page'
        }
    }, undefined, 15000);
    ok(dlBad && dlBad.count === 1, '显式传入的 404 URL 被自动剔除', JSON.stringify({ count: dlBad && dlBad.count }));
    ok(dlBad && dlBad.excludedFailed === 1, '下载结果回传剔除数量', String(dlBad && dlBad.excludedFailed));

    // ③ 体积回填：webRequest 侧拿不到 Content-Length（压缩/chunked）时用页面 performance 的值
    fire(wr.onBeforeRequest, { tabId: 1, frameId: 0, url: 'https://example.com/static/sized.js', type: 'script', initiator: 'https://example.com/page', method: 'GET' });
    const resSize = await sendBg(M, { type: 'GET_JS_RESOURCES', tabId: 1, includeThirdParty: true, pageUrl: 'https://example.com/page' });
    const sized = resSize.list.find(x => /sized\.js$/.test(x.url));
    ok(sized && sized.size === 4096, '页面采集的体积被回填到 webRequest 记录（不再恒为 0）', JSON.stringify(sized));
    ok(sized && sized.sizeSource === 'performance', '体积来源标注为 performance', sized && sized.sizeSource);
    // 同一 URL 先被 script-tag 收到（size 0）、后被 performance 收到（size 8192）→ 必须取到有体积的那条
    const dup = resSize.list.find(x => /dup\.js$/.test(x.url));
    ok(dup && dup.size === 8192, '重复 URL 去重时保留带体积的记录（DOM 先到也不能覆盖）', JSON.stringify(dup));

    // 根因在页面侧采集函数本体：它必须先建「URL→体积」索引再收集，
    // 否则 script-tag（无体积）先入会被后面的 performance 条目挤掉体积。
    // 桩返回的是合并后的数据，覆盖不到这段，所以这里直接跑 PAGE_ASSET_FN。
    M.sandbox.document = {
        title: 'T',
        querySelectorAll: (sel) => (sel === 'script[src]' ? [{ src: 'https://example.com/static/dup.js' }] : [])
    };
    M.sandbox.location = { href: 'https://example.com/page' };
    M.sandbox.performance = {
        getEntriesByType: () => ([
            { name: 'https://example.com/static/dup.js', initiatorType: 'script', transferSize: 0, encodedBodySize: 8192 }
        ])
    };
    const pageJs = g('PAGE_ASSET_FN().js');
    const pDup = pageJs.find(x => /dup\.js$/.test(x.url));
    ok(pDup && pDup.size === 8192, 'PAGE_ASSET_FN 先建体积索引：DOM 先收集也不丢体积', JSON.stringify(pageJs));
    ok(pageJs.every(x => typeof x.size === 'number'), 'PAGE_ASSET_FN 每条都带 size 字段');

    /* ④ execute_js 的 world 语义：ISOLATED 无法执行字符串代码时必须明确报错，不得静默换到 MAIN */
    const MCPe = g('MCPClient');
    const execIso = await MCPe.dispatch('execute_js', { tabId: 1, code: '1+1', world: 'ISOLATED' });
    const framesIso = execIso && execIso.results ? execIso.results[0] : execIso;
    ok(framesIso && framesIso.requestedWorld === 'ISOLATED', 'ISOLATED 请求回传 requestedWorld', JSON.stringify(framesIso));
    ok(framesIso && framesIso.fellBack !== true, '默认不降级（fellBack 不为 true）', String(framesIso && framesIso.fellBack));
    ok(framesIso && framesIso.ok === false, 'ISOLATED 执行字符串代码返回明确失败（而非静默换世界）', JSON.stringify(framesIso && framesIso.error));
    ok(/allowMainFallback|world:"MAIN"|CDP/.test(String(framesIso && framesIso.note)),
        'ISOLATED 失败时给出可行替代方案（MAIN / allowMainFallback / CDP）', String(framesIso && framesIso.note).slice(0, 80));
    const execMain = await MCPe.dispatch('execute_js', { tabId: 1, code: '1+1', world: 'MAIN' });
    const frMain = execMain && execMain.results ? execMain.results[0] : execMain;
    ok(frMain && frMain.actualWorld === 'MAIN' && frMain.fellBack === false,
        'MAIN 请求正常执行、actualWorld=MAIN 且 fellBack=false', JSON.stringify({ a: frMain && frMain.actualWorld, f: frMain && frMain.fellBack }));

    /* ⑤ search_in_js：单行文件必须能返回多条命中（压缩/混淆文件整个文件只有一行）；
     *    统计字段要能说明「为什么没扫完」 */
    const srch = await MCPe.dispatch('search_in_js', { tabId: 1, pattern: 'o', regex: false, urls: ['https://example.com/static/app.js'], maxHits: 50 });
    const perLine = {};
    (srch.hits || []).forEach(x => { perLine[x.line] = (perLine[x.line] || 0) + 1; });
    const maxPerLineHits = Math.max(0, ...Object.values(perLine));
    ok(maxPerLineHits > 1, '同一行可返回多条命中（行内循环，而非每行只取第一条）', JSON.stringify(perLine));
    ok((srch.hits || []).every(x => typeof x.indexInLine === 'number'), '命中带 indexInLine 偏移');
    ok(typeof srch.stopReason === 'string', '返回 stopReason 说明停止原因', String(srch && srch.stopReason));
    ok(typeof srch.candidateFiles === 'number' && typeof srch.maxFiles === 'number', '返回 candidateFiles / maxFiles');
    ok(typeof srch.filesStoppedByLimit === 'number', '返回 filesStoppedByLimit（达上限而未做正则的文件数）');
    ok(Array.isArray(srch.hotFiles), '返回 hotFiles（命中最多的文件）');
    ok(typeof srch.excludedFailed === 'number', '返回 excludedFailed');
    const srchStop = await MCPe.dispatch('search_in_js', { tabId: 1, pattern: 'o', regex: false, urls: ['https://example.com/static/app.js'], maxHits: 1 });
    ok(srchStop.stopReason === 'maxHits', '命中达上限时 stopReason=maxHits', String(srchStop.stopReason));
    ok(/上限/.test(String(srchStop.truncatedReason)), 'truncatedReason 说明结果为何不完整', String(srchStop.truncatedReason).slice(0, 50));
    ok(srch.truncated === false && srch.truncatedReason === null, '未发生截断时 truncated=false 且无 truncatedReason');

    /* ⑤b 命中片段：压缩/混淆文件整个文件只有一行，若固定从行首截断，
     *     同一文件的所有命中会返回完全相同的片段（实测 sojson 的 aes.js 就是如此）→ 必须围绕命中开窗 */
    const longLine = 'x'.repeat(200) + 'MATCH_A' + 'y'.repeat(400) + 'MATCH_B' + 'z'.repeat(200);
    const snipA = g(`buildHitSnippet([${JSON.stringify(longLine)}], 0, 0, 0, 200, 120)`);
    const snipB = g(`buildHitSnippet([${JSON.stringify(longLine)}], 0, 0, 0, 607, 120)`);
    ok(snipA !== snipB, '单行长行：不同命中位置得到不同片段（以命中为中心开窗）');
    ok(/MATCH_A/.test(snipA) && /MATCH_B/.test(snipB), '片段里包含命中本身',
        JSON.stringify([snipA.slice(0, 16), snipB.slice(0, 16)]));
    ok(/^…/.test(snipA) && /…$/.test(snipB), '被裁剪的一端带省略号');
    ok(g(`buildHitSnippet(['short line'], 0, 0, 0, 0, 300)`) === 'short line', '短行直接返回整行（不裁剪、不加省略号）');

    /* ⑥ get_scan_results：_truncated 是布尔、隐藏条数在 _hiddenCount；未知分类要报出来 */
    const scan = await MCPe.dispatch('get_scan_results', { tabId: 1, categories: 'absoluteApis', maxPerCategory: 1 });
    const fr0 = scan.frames[0].results;
    ok(fr0.absoluteApis_truncated === true, '_truncated 是布尔（不再塞隐藏条数）', JSON.stringify(fr0.absoluteApis_truncated));
    ok(typeof fr0.absoluteApis_hiddenCount === 'number' && fr0.absoluteApis_hiddenCount > 0,
        '被隐藏条数放在 _hiddenCount', String(fr0.absoluteApis_hiddenCount));
    const scanUnknown = await MCPe.dispatch('get_scan_results', { tabId: 1, categories: 'absoluteApis,iamCompanies' });
    ok(Array.isArray(scanUnknown.unknownCategories) && scanUnknown.unknownCategories.includes('iamCompanies'),
        '未知分类键被显式报出（不再静默忽略）', JSON.stringify(scanUnknown.unknownCategories));
    ok(Array.isArray(scanUnknown.validCategories) && scanUnknown.validCategories.includes('absoluteApis'),
        '同时回传有效分类键列表');
    ok(/iamCompanies/.test(String(scanUnknown.note)), 'note 里说明哪个键无效');

    /* ⑦ get_storage：cookie 计数来源要说清楚（document.cookie 看不到 httpOnly） */
    const st = await MCPe.dispatch('get_storage', { tabId: 1 });
    ok(/httpOnly/.test(String(st.note || '')), 'get_storage 说明 cookieCount 只是 JS 可见量');

    /* ⑧ get_routes 接受 tabId（与其它工具参数一致） */
    const rt = await MCPe.dispatch('get_routes', { tabId: 1 });
    ok(rt && rt.hostname === 'example.com', 'get_routes 支持 tabId 定位', JSON.stringify({ hn: rt && rt.hostname }));

    /* ⑨ query_dom 的 iframes/buttons/suggestSelectors 等扩展字段需要真实 DOM，
     *    这里只验证调用链路不抛错（字段本身已在真机 MCP 实测中确认） */
    const qd = await MCPe.dispatch('query_dom', { tabId: 1 });
    ok(qd && typeof qd === 'object', 'query_dom 调用链路正常', JSON.stringify(Object.keys(qd || {})));

    console.log('\n=== 7. 旧配置端口迁移 ===');
    const boot2 = bootBackground({ le_mcp_cfg: { enabled: false, port: 10086, token: 'oldtoken' } });
    await sleep(120);
    ok(boot2.g('MCPClient.cfg.port') === 10087, '存储中的 10086 被一次性迁移为 10087', String(boot2.g('MCPClient.cfg.port')));
    ok(boot2.g('MCPClient.cfg.portMigrated') === true, '迁移标记已写入（不会反复改写）');
    ok(boot2.M.store.le_mcp_cfg.port === 10087, '迁移结果已持久化');

    console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
