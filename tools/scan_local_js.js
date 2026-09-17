/* =====================================================================
 * JsXray — tools/scan_local_js.js
 * 对「本地已下载的 JS 目录」跑一遍插件自己的扫描引擎（不需要浏览器）。
 *
 * 做法：在 vm 里用桩环境加载 src="content.js" 本体，
 *       直接复用它的 PATTERNS / Filter / Handlers / Extractor / Results，
 *       逐个文件调用 dealContent()，最后汇总分类结果。
 *       （仅 REGEX_MATCH 一项在桩里用与 background 相同的算法实现，
 *         其余规则、去噪、分类逻辑全部来自插件源码。）
 *
 * 用法：node tools/scan_local_js.js <js目录> [--json <输出报告路径>]
 *       例：node tools/scan_local_js.js "D:/JsXray/js"
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = process.argv[2] || path.join(__dirname, '..', 'js');
const jsonArgIdx = process.argv.indexOf('--json');
const outJson = jsonArgIdx > 0 ? process.argv[jsonArgIdx + 1] : path.join(dir, '_scan.json');

/* ---------- 与 background.RegexMatcher 一致的匹配实现（桩用） ---------- */
function regexMatch(text, patternStrs) {
    const matches = [];
    for (const ps of patternStrs) {
        let re;
        try {
            const m = String(ps).match(/^\/([\s\S]+)\/([a-z]*)$/i);
            if (!m) continue;
            const flags = m[2].split('').filter(f => 'gimsuy'.includes(f)).join('');
            re = new RegExp(m[1], flags);
        } catch { continue; }
        let iter = 100000, m, last = -1;
        while ((m = re.exec(text)) !== null) {
            matches.push({ match: m[0] });
            if (--iter <= 0) break;
            if (!re.global) break;
            if (re.lastIndex === last || re.lastIndex <= m.index) re.lastIndex = m.index + 1;
            last = re.lastIndex;
        }
    }
    return matches;
}

/* ---------- 构造 content.js 需要的浏览器桩 ---------- */
function makeSandbox() {
    const store = {};
    const API = {
        runtime: {
            lastError: null,
            getURL: (r) => 'chrome-extension://happyjs/' + r,
            sendMessage: (msg, cb) => {
                let resp = null;
                if (msg.type === 'REGEX_MATCH') resp = { matches: regexMatch(msg.chunk, msg.patterns) };
                else if (msg.type === 'GET_TAB_ID') resp = { tabId: 1 };
                else if (msg.type === 'GET_IFRAME_ID') resp = { frameId: '0' };
                else if (msg.type === 'FETCH_JS') resp = { content: null, frameId: '0' };
                else resp = { ok: true };
                if (cb) cb(resp);
                return Promise.resolve(resp);
            },
            onMessage: { addListener: () => {} }
        },
        storage: {
            local: {
                get(keys, cb) { const out = {}; (Array.isArray(keys) ? keys : []).forEach(k => { if (k in store) out[k] = store[k]; }); if (cb) cb(out); return Promise.resolve(out); },
                set(o, cb) { Object.assign(store, o); if (cb) cb(); return Promise.resolve(); }
            }
        }
    };
    const win = {
        postMessage: () => {},
        addEventListener: () => {},
        setTimeout: setTimeout,
        get self() { return win; },
        get top() { return win; }
    };
    const location = { protocol: 'http:', hostname: 'local.scan', port: '', href: 'http://local.scan/', origin: 'http://local.scan' };
    const sandbox = {
        API, chrome: API,
        console, TextEncoder, TextDecoder, URL, Date, Math, JSON, Promise, Map, Set,
        Array, Object, String, Number, RegExp, Error, TypeError, Symbol, WeakSet, WeakMap, Boolean,
        setTimeout, clearTimeout, setInterval, clearInterval,
        window: win,
        location,
        performance: { getEntriesByType: () => [], now: () => 0 },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        MutationObserver: class { observe() {} disconnect() {} },
        document: {
            readyState: 'loading',          // 关键：避免触发 bootstrap()（不需要 DOM 流程）
            addEventListener: () => {},
            querySelectorAll: () => [],
            querySelector: () => null,
            getElementById: () => null,
            createElement: () => ({ style: {}, remove() {}, setAttribute() {}, appendChild() {} }),
            documentElement: { innerHTML: '', outerHTML: '' },
            body: null, head: null,
            cookie: ''
        }
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8'), sandbox, { filename: 'content.js' });
    return sandbox;
}

/* ---------- 脱敏（PII 只留 1~2 条样本，其余只计数） ---------- */
function mask(key, v) {
    const s = String(v);
    if (key === 'emails') { const [a, b] = s.split('@'); return String(a).slice(0, 1) + '***@' + (b || ''); }
    if (key === 'phones') return s.slice(0, 3) + '****' + s.slice(-2);
    if (key === 'idcards') return s.slice(0, 4) + '**********' + s.slice(-2);
    if (key === 'credentials' || key === 'cookies') return s.replace(/([:=])\s*.+$/, '$1 ****');
    if (key === 'idKeys') return s.slice(0, 6) + '…' + s.slice(-4);
    if (key === 'privateKeys') return s.slice(0, 32) + '…（已截断）';
    if (key === 'dbConns') return s;
    return s;
}
const SENSITIVE = new Set(['emails', 'phones', 'idcards', 'credentials', 'cookies', 'idKeys', 'privateKeys', 'dbConns', 'jwts']);

(async () => {
    if (!fs.existsSync(dir)) { console.error('目录不存在: ' + dir); process.exit(1); }
    const files = fs.readdirSync(dir).filter(f => /\.(js|mjs)$/i.test(f)).sort();
    if (!files.length) { console.error('目录下没有 .js 文件: ' + dir); process.exit(1); }
    console.log('扫描目录：' + dir);
    console.log('文件数量：' + files.length + '，总大小 ' + (files.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0) / 1048576).toFixed(2) + ' MB\n');

    const S = makeSandbox();
    const G = (expr) => vm.runInContext(expr, S);
    G('Ctx.tabId = 1; Ctx.frameId = "0"; Ctx.hostname = "local.scan"; Ctx.protocol = "http:"; Ctx.whitelisted = false; Ctx.deepScan = false;');

    const t0 = Date.now();
    for (const f of files) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const src = 'file://' + dir.replace(/\\/g, '/') + '/' + f;
        await G('dealContent')(text, src, false);
        process.stdout.write('.');
    }
    console.log('\n扫描完成，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's\n');

    const results = G('JSON.parse(JSON.stringify(Results.get()))');
    const report = { dir, scannedAt: new Date().toISOString(), files: files.length, categories: {} };
    const order = ['absoluteApis', 'apis', 'routes', 'urls', 'domains', 'jsFiles', 'moduleFiles', 'sourceMaps',
        'idKeys', 'privateKeys', 'credentials', 'cookies', 'jwts', 'dbConns', 'mqConns', 'ossEndpoints',
        'emails', 'phones', 'idcards', 'companies', 'ips', 'githubUrls', 'windowsPaths', 'linuxPaths', 'fingers'];

    for (const key of order) {
        const arr = results[key] || [];
        if (!arr.length) continue;
        const values = arr.map(x => Array.isArray(x) ? x[0] : x);
        const entry = { count: values.length };
        if (SENSITIVE.has(key)) entry.samples = values.slice(0, 2).map(v => mask(key, v));
        else entry.items = values.slice(0, 60);
        report.categories[key] = entry;
    }

    console.log('=== 分类统计 ===');
    for (const [k, v] of Object.entries(report.categories)) {
        console.log('  ' + k.padEnd(16) + String(v.count).padStart(5) + (v.samples ? '   [敏感项仅留脱敏样本]' : ''));
    }
    console.log('\n=== 接口类摘录（前 12 条绝对路径 API）===');
    console.log('  ' + ((report.categories.absoluteApis && report.categories.absoluteApis.items) || []).slice(0, 12).join('\n  '));
    console.log('\n=== 密钥/凭证类 ===');
    for (const k of ['idKeys', 'privateKeys', 'credentials', 'dbConns', 'ossEndpoints', 'sourceMaps']) {
        if (report.categories[k]) console.log('  ' + k + ': ' + JSON.stringify(report.categories[k].samples || report.categories[k].items.slice(0, 5)));
    }

    fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
    console.log('\n报告已写入：' + outJson);
})().catch(e => { console.error('扫描异常:', e); process.exit(1); });
