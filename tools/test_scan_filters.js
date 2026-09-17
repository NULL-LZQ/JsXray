/* =====================================================================
 * JsXray — 扫描引擎过滤规则回归（不需要浏览器）
 *
 * 直接在 vm 里加载 content.js 本体，调用它自己的 Handlers / Extractor，
 * 验证两类刚修过的误报 / 数据质量问题：
 *   1. apis（相对路径接口）的误报过滤
 *      · 布尔字面量加斜杠   —— true/
 *      · 页面模板包含文件   —— inc/EAS_header_teacher.html
 *      · 以 / 结尾的拼接残片 —— studentspace/professionalcommittee/
 *      同时保证真实接口不被误杀
 *   2. 指纹 version 字段：必须真解析版本；解析不到就**不输出**该字段
 *      （旧实现写死 version = name，于是「jQuery 的版本」= "jQuery"）
 *
 * 运行：node tools/test_scan_filters.js
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.error(`  ✗ ${name}${extra !== undefined ? ' — ' + extra : ''}`); }
}
function eq(actual, expected, name) {
    ok(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ---------- 承载给插件侧的消息（用于观察 UPDATE_BUILDER 等上报） ---------- */
const sent = [];

function makeSandbox() {
    const store = {};
    const API = {
        runtime: {
            lastError: null,
            getURL: (r) => 'chrome-extension://happyjs/' + r,
            sendMessage: (msg, cb) => {
                sent.push(msg);
                // REGEX_MATCH 桩：与 background.RegexMatcher 同算法，供 Extractor 使用
                let resp = { ok: true };
                if (msg.type === 'REGEX_MATCH') {
                    const matches = [];
                    for (const ps of (msg.patterns || [])) {
                        let re;
                        try {
                            const m = String(ps).match(/^\/([\s\S]+)\/([a-z]*)$/i);
                            if (!m) continue;
                            re = new RegExp(m[1], m[2].split('').filter(f => 'gimsuy'.includes(f)).join(''));
                        } catch { continue; }
                        let iter = 10000, mm;
                        while ((mm = re.exec(msg.chunk)) !== null) {
                            matches.push({ match: mm[0] });
                            if (--iter <= 0) break;
                            if (!re.global) break;
                            if (re.lastIndex === mm.index) re.lastIndex++;
                        }
                    }
                    resp = { matches };
                } else if (msg.type === 'GET_TAB_ID') resp = { tabId: 1 };
                else if (msg.type === 'GET_IFRAME_ID') resp = { frameId: '0' };
                if (cb) cb(resp);
                return Promise.resolve(resp);
            },
            onMessage: { addListener: () => {} }
        },
        storage: {
            local: {
                get(keys, cb) {
                    const out = {};
                    (Array.isArray(keys) ? keys : []).forEach(k => { if (k in store) out[k] = store[k]; });
                    if (cb) cb(out);
                    return Promise.resolve(out);
                },
                set(o, cb) { Object.assign(store, o); if (cb) cb(); return Promise.resolve(); }
            }
        }
    };
    const win = { postMessage: () => {}, addEventListener: () => {}, get self() { return win; }, get top() { return win; } };
    const sandbox = {
        API, chrome: API,
        console, TextEncoder, TextDecoder, URL, Date, Math, JSON, Promise, Map, Set,
        Array, Object, String, Number, RegExp, Error, TypeError, Symbol, WeakSet, WeakMap, Boolean,
        setTimeout, clearTimeout, setInterval, clearInterval,
        window: win,
        location: { protocol: 'http:', hostname: 'local.scan', port: '', href: 'http://local.scan/', origin: 'http://local.scan' },
        performance: { getEntriesByType: () => [], now: () => 0 },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        MutationObserver: class { observe() {} disconnect() {} },
        document: {
            readyState: 'loading',          // 关键：避免触发 bootstrap()
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

const S = makeSandbox();
const { Handlers, Results, FingerExtractor } =
    vm.runInContext('({ Handlers, Results, FingerExtractor })', S);

/* ================================================================
 * 1. apis（相对路径接口）误报过滤
 * ================================================================ */
console.log('\n=== 1. apis 误报过滤 ===');

const apiCount = () => Results.get().apis.length;
const lastApi = () => { const a = Results.get().apis; return a.length ? a[a.length - 1][0] : ''; };

// 正向：真实接口必须保留
const beforeOk = apiCount();
Handlers.api('"portal/regionSession.do"', 'a.js');
ok(apiCount() === beforeOk + 1 && lastApi() === 'portal/regionSession.do',
    '真实相对接口被保留', `${apiCount()} / ${lastApi()}`);
Handlers.api('"management/exportfilerecord/listByType.do?type=1"', 'a.js');
ok(lastApi().startsWith('management/exportfilerecord/'), '带查询串的接口被保留', lastApi());
Handlers.api('"common/findRegisterAreaLink.do"', 'a.js');
ok(lastApi() === 'common/findRegisterAreaLink.do', '普通 .do 接口被保留');

// 负向：三类误报
const before = apiCount();
Handlers.api('"true/"', 'a.js');
eq(apiCount(), before, '拒绝布尔字面量加斜杠（true/）');
Handlers.api('"false/"', 'a.js');
eq(apiCount(), before, '拒绝 false/');
Handlers.api('"null/"', 'a.js');
eq(apiCount(), before, '拒绝 null/');

Handlers.api('"inc/EAS_header_teacher.html"', 'a.js');
eq(apiCount(), before, '拒绝页面包含文件（.html）');
Handlers.api('"inc/header_twoRow.html"', 'a.js');
eq(apiCount(), before, '拒绝另一个 .html 包含文件');
Handlers.api('"tpl/user.jsp"', 'a.js');
eq(apiCount(), before, '拒绝 .jsp 模板');

Handlers.api('"studentspace/professionalcommittee/"', 'a.js');
eq(apiCount(), before, '拒绝以 / 结尾的拼接残片');
Handlers.api('"inc/"', 'a.js');
eq(apiCount(), before, '拒绝单段以 / 结尾的残片');

// absoluteApis 分支：布尔字面量同样拒绝，真实绝对接口保留
const absBefore = Results.get().absoluteApis.length;
Handlers.api('"/true"', 'a.js');
eq(Results.get().absoluteApis.length, absBefore, 'absoluteApis 拒绝 /true');
Handlers.api('"/mizar/login/getToken.do"', 'a.js');
ok(Results.get().absoluteApis.length === absBefore + 1, 'absoluteApis 保留真实绝对接口');

/* ================================================================
 * 2. 指纹 version 字段
 * ================================================================ */
console.log('\n=== 2. 指纹 version 解析 ===');

const fingerMsgs = () => sent.filter(m => m.type === 'UPDATE_BUILDER' && m.finger);
const lastFinger = () => { const l = fingerMsgs(); return l.length ? l[l.length - 1].finger : null; };

(async () => {
    // ① 能从文本里解析出版本
    sent.length = 0;
    await new FingerExtractor().extract('var x="jquery-3.7.1.min.js";', 'https://a.com/jquery-3.7.1.min.js');
    let f = lastFinger();
    ok(f && f.name === 'jQuery', '识别出 jQuery 指纹', JSON.stringify(f));
    eq(f && f.version, '3.7.1', 'version 从文本解析为 3.7.1（而不是回显 name）');

    // ② 解析不到版本 → 不输出 version 字段
    sent.length = 0;
    await new FingerExtractor().extract('https://cdnjs.cloudflare.com/ajax/libs/x.js', 'https://a.com/x.js');
    f = lastFinger();
    ok(f && f.name === 'Cloudflare CDN', '识别出 Cloudflare CDN 指纹', JSON.stringify(f));
    eq(f && Object.prototype.hasOwnProperty.call(f, 'version'), false,
        '解析不到版本时不输出 version 字段（旧实现会写 version: "Cloudflare CDN"）');

    // ③ Vue 版本
    sent.length = 0;
    await new FingerExtractor().extract('Vue.version = "3.4.21"; __vue_app__', 'https://a.com/vue.js');
    f = lastFinger();
    ok(f && f.name === 'Vue', '识别出 Vue 指纹', JSON.stringify(f));
    eq(f && f.version, '3.4.21', 'Vue 版本正确解析');

    // ④ Angular ng-version
    sent.length = 0;
    await new FingerExtractor().extract('<app-root ng-version="17.1.0"></app-root>', 'https://a.com/index.html');
    f = lastFinger();
    ok(f && f.name === 'Angular', '识别出 Angular 指纹', JSON.stringify(f));
    eq(f && f.version, '17.1.0', 'Angular 版本从 ng-version 解析');

    // ⑤ 无指纹特征的文本不应产生任何上报
    sent.length = 0;
    await new FingerExtractor().extract('var a = 1; var b = 2;', 'https://a.com/plain.js');
    eq(fingerMsgs().length, 0, '无特征文本不产生指纹上报');

    // ⑥ 描述文案仍完整
    ok(fingerMsgs().every(m => /通过页面内容识别到/.test(m.finger.description)), '指纹描述文案保持原有格式');

    console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
    process.exit(fail === 0 ? 0 : 1);
})();
