#!/usr/bin/env node
/* =====================================================================
 * JsXray — tools/test_hooks_activation.js
 * Hook 脚本「会不会真的生效」的回归测试。
 *
 * 为什么需要它：
 *   历史上这批 Hook 有过两类静默失效 ——
 *     ① hooks.json 的 id 与真实文件名不符 → 注册路径 404（v1.1.0）
 *     ② 脚本开头写 `if (!readCfg()) return;` 要求 localStorage 里有
 *        LatentEye_<id>_flag === '1'，但全仓没有任何代码会写这个标记
 *        → 脚本 100% 不激活（hook_response_body / hook_dynamic_code / hook_worker）
 *   这两种都不会报错、UI 上还显示「已启用」，只能靠断言兜住。
 *
 * 断言：
 *   · 标记缺失  → 激活（注入即启用）
 *   · 标记 '1' → 激活
 *   · 标记 '0' → 不激活（显式关闭开关）
 *   · 动态代码 Hook：本扩展自己的探针（window.__happyjs_probe_active）不被收录
 * ===================================================================== */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, label, extra) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.error('  ✗ ' + label + (extra !== undefined ? '  — ' + extra : '')); }
}

/** 造一个「主世界」沙箱：localStorage 预置指定标记值（undefined = 不预置） */
function makePage(flagKey, flagValue) {
    const store = {};
    if (flagKey && flagValue !== undefined) store[flagKey] = flagValue;
    const messages = [];
    const sandbox = {
        console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        JSON, Object, Array, String, Number, Boolean, RegExp, Error, TypeError,
        Set, Map, WeakSet, WeakMap, Math, Date, Promise, Symbol, ArrayBuffer,
        Uint8Array, TextDecoder, TextEncoder, URL, Proxy, Reflect,
        // 真实浏览器里是 Storage.prototype.getItem.call(localStorage, k)
        Storage: { prototype: { getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; } } },
        localStorage: {},
        Blob: class Blob { constructor(parts, opts) { this.size = (parts && parts.length) || 0; this.type = (opts && opts.type) || ''; } },
        document: { addEventListener() {}, querySelectorAll: () => [] },
        // Canvas Hook 需要这几个全局（真实浏览器里必然存在）
        HTMLCanvasElement: class { },
        CanvasRenderingContext2D: class { },
        OffscreenCanvas: class { },
        HTMLImageElement: class { },
        postMessage: (m) => messages.push(m),
        addEventListener() {},
        location: { href: 'https://example.com/page' }
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.window = sandbox;
    sandbox.eval = function (s) { return s; };
    sandbox.Function = function () { return function () {}; };
    sandbox.URL.createObjectURL = function () { return 'blob:https://example.com/fake'; };
    sandbox.URL.revokeObjectURL = function () {};
    vm.createContext(sandbox);
    return { sandbox, messages, store };
}

function runHook(sandbox, file) {
    // 沙箱里缺某个浏览器 API 时，Hook 本体可能抛错；但「是否激活」看的是 guard（在挂载前就已置位），
    // 所以这里吞掉异常即可 —— 我们要断言的是「有没有走到挂载那一步」。
    try {
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'hooks', file), 'utf8'), sandbox, { filename: 'hooks/' + file });
    } catch (e) {
        sandbox.__hookError = String((e && e.message) || e);
    }
}

const CASES = [
    { file: 'hook_dynamic_code.js', guard: '__happyjsDynamicCodeHooked', flag: 'LatentEye_hook_dynamic_code_flag' },
    { file: 'hook_worker.js', guard: '__happyjsWorkerHooked', flag: 'LatentEye_hook_worker_flag' },
    { file: 'hook_response_body.js', guard: '__happyjsResponseBodyHooked', flag: 'LatentEye_hook_response_body_flag' },
    { file: 'canvas_inject.js', guard: '__happyjsCanvasInjected', flag: 'LatentEye_canvas_inject_flag' }
];

console.log('\n=== 1. 注入即启用（标记缺失时必须激活）===');
for (const c of CASES) {
    const p = makePage(c.flag, undefined);
    runHook(p.sandbox, c.file);
    ok(p.sandbox.window[c.guard] === true,
        `${c.file} 无标记时仍激活（不再静默失效）`, String(p.sandbox.window[c.guard]));
}

console.log('\n=== 2. 显式关闭开关（标记 = \'0\'）===');
for (const c of CASES) {
    const p = makePage(c.flag, '0');
    runHook(p.sandbox, c.file);
    ok(!p.sandbox.window[c.guard], `${c.file} 标记为 '0' 时不激活`, String(p.sandbox.window[c.guard]));
}

console.log('\n=== 3. 兼容旧语义（标记 = \'1\' 时激活）===');
for (const c of CASES) {
    const p = makePage(c.flag, '1');
    runHook(p.sandbox, c.file);
    ok(p.sandbox.window[c.guard] === true, `${c.file} 标记为 '1' 时激活`);
}

console.log('\n=== 4. 动态代码捕获：不抓自己（P0-3）===');
{
    const p = makePage('LatentEye_hook_dynamic_code_flag', undefined);
    runHook(p.sandbox, 'hook_dynamic_code.js');
    ok(p.sandbox.window.__happyjsDynamicCodeHooked === true, 'Hook 已激活');

    // ① 带探针标记（= MCP execute_js 在页面打的旗标）→ 不得收录
    const before = p.messages.length;
    p.sandbox.window.__happyjs_probe_active = 'happyjs-mcp-probe';
    p.sandbox.window.eval('var probe_should_be_skipped = 1;');
    ok(p.messages.length === before, '探针期间执行的代码不被收录', `新增 ${p.messages.length - before} 条`);

    // ② 清掉标记（模拟探针执行结束）→ 站点自己的 eval 必须被收录
    p.sandbox.window.__happyjs_probe_active = '';
    p.sandbox.window.eval('var realSiteCode = "x".repeat(60);');
    const added = p.messages.slice(before);
    ok(added.length === 1 && added[0].type === 'HAPPYJS_DYNAMIC_CODE' && added[0].kind === 'eval',
        '探针结束后站点自己的 eval 被正常收录', JSON.stringify(added.map(m => m.kind)));
    ok(added.length >= 1 && /realSiteCode/.test(added[0].code || ''), '收录内容为站点代码本体');
}

console.log('\n=== 5. 同一页面重复注入只挂一次 ===');
{
    const p = makePage('LatentEye_hook_dynamic_code_flag', undefined);
    runHook(p.sandbox, 'hook_dynamic_code.js');
    const firstEval = p.sandbox.window.eval;
    runHook(p.sandbox, 'hook_dynamic_code.js');
    ok(p.sandbox.window.eval === firstEval, '重复执行不会二次包装（guard 生效）');
}

console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
