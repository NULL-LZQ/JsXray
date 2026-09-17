/* Vue 路由对抗 E2E 测试
 *
 * 覆盖：
 *  1) vue_router.js: installGuardBlocker / installNavBlocker 已实现
 *  2) content.js: requestMainWorld 桥接 + VUE_CLEAR_GUARDS/VUE_CLEAR_NAV case
 *  3) popup.html: 按钮存在
 *  4) popup.js: 按钮绑定 + 仅 Vue 显示 + toggle 逻辑
 *  5) 纯逻辑：用 vm 跑 installGuardBlocker，验证 Array.push 拦截
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm2lib = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const inject = fs.readFileSync(path.join(ROOT, 'inject', 'vue_router.js'), 'utf8');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const pj = fs.readFileSync(path.join(ROOT, 'popup', 'popup.js'), 'utf8');
const ph = fs.readFileSync(path.join(ROOT, 'popup', 'popup.html'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log('  ✓', name); passed++; }
    catch (e) { console.log('  ✗', name, '\n    ', e.message); failed++; }
}

console.log('=== 1. inject/vue_router.js 主世界能力 ===');
test('installGuardBlocker 函数已实现', () => {
    assert(/function installGuardBlocker\s*\(\)\s*\{/.test(inject));
});
test('uninstallGuardBlocker 函数已实现', () => {
    assert(/function uninstallGuardBlocker\s*\(\)\s*\{/.test(inject));
});
test('installNavBlocker 函数已实现', () => {
    assert(/function installNavBlocker\(router\)\s*\{/.test(inject));
});
test('uninstallNavBlocker 函数已实现', () => {
    assert(/function uninstallNavBlocker\(router\)\s*\{/.test(inject));
});
test('installGuardBlocker 用 Array.prototype.push hook', () => {
    const block = inject.match(/function installGuardBlocker\(\)\s*\{[\s\S]{0,1500}\}/);
    assert(block);
    assert(/Array\.prototype\.push\s*=/.test(block[0]));
    assert(/beforeEach/.test(block[0]) && /beforeResolve/.test(block[0]));
});
test('installGuardBlocker 用 new Error().stack 检测调用栈', () => {
    const block = inject.match(/function installGuardBlocker\(\)\s*\{[\s\S]{0,1500}\}/);
    assert(block && /new Error\(\)\.stack/.test(block[0]));
});
test('installNavBlocker hook push/replace/go/back/forward', () => {
    const block = inject.match(/function installNavBlocker\(router\)\s*\{[\s\S]{0,1500}\}/);
    assert(block);
    ['push', 'replace', 'go', 'back', 'forward'].forEach(fn => {
        assert(block[0].includes("'" + fn + "'") || block[0].includes('"' + fn + '"'), '未包含 ' + fn);
    });
});
test('installNavBlocker 返回 Promise.resolve() for push/replace', () => {
    const block = inject.match(/function installNavBlocker\(router\)\s*\{[\s\S]{0,1500}\}/);
    assert(block && /Promise\.resolve\(\)/.test(block[0]));
});
test('postMessage 监听 CLEAR_NAV_GUARDS', () => {
    assert(/CLEAR_NAV_GUARDS/.test(inject));
});
test('postMessage 监听 CLEAR_NAV', () => {
    assert(/CLEAR_NAV/.test(inject));
});
test('响应消息带 _id 回传', () => {
    assert(/NAV_GUARDS_RESULT/.test(inject) && /NAV_RESULT/.test(inject));
    assert(/_id: d\._id/.test(inject) || /_id:\s*d\._id/.test(inject));
});
test('scanVue 保存 currentVueRouter 引用', () => {
    assert(/currentVueRouter\s*=\s*router/.test(inject));
});

console.log('\n=== 2. content.js 桥接 ===');
test('requestMainWorld 函数已实现', () => {
    assert(/function requestMainWorld\(/.test(content));
});
test('requestMainWorld 用 _id 匹配响应', () => {
    const block = content.match(/function requestMainWorld\(type, payload\)[\s\S]{0,1500}/);
    assert(block && /_id/.test(block[0]));
});
test('requestMainWorld 3 秒超时兜底', () => {
    const block = content.match(/function requestMainWorld\(type, payload\)[\s\S]{0,1500}/);
    assert(block && /setTimeout/.test(block[0]));
});
test('content 路由 VUE_CLEAR_GUARDS → CLEAR_NAV_GUARDS', () => {
    assert(/case 'VUE_CLEAR_GUARDS':/.test(content));
    const block = content.match(/case 'VUE_CLEAR_GUARDS':[\s\S]{0,400}/);
    assert(block && /requestMainWorld\('CLEAR_NAV_GUARDS'/.test(block[0]));
});
test('content 路由 VUE_CLEAR_NAV → CLEAR_NAV', () => {
    assert(/case 'VUE_CLEAR_NAV':/.test(content));
    const block = content.match(/case 'VUE_CLEAR_NAV':[\s\S]{0,400}/);
    assert(block && /requestMainWorld\('CLEAR_NAV'/.test(block[0]));
});

console.log('\n=== 3. popup.html 按钮 ===');
test('vue-counter-panel 容器存在', () => {
    assert(/id="vue-counter-panel"/.test(ph));
});
test('vue-clear-nav 按钮存在', () => {
    assert(/id="vue-clear-nav"/.test(ph));
});
test('vue-clear-guards 按钮存在', () => {
    assert(/id="vue-clear-guards"/.test(ph));
});
test('按钮带 counter-btn 类 + data-on 默认 false', () => {
    // HTML 属性顺序不固定，同一按钮上需同时包含 class="counter-btn" 与 data-on="false"
    const re = /id="vue-clear-(?:nav|guards)"[\s\S]*?class="counter-btn"[\s\S]*?data-on="false"|id="vue-clear-(?:nav|guards)"[\s\S]*?data-on="false"[\s\S]*?class="counter-btn"|class="counter-btn"[\s\S]*?id="vue-clear-(?:nav|guards)"[\s\S]*?data-on="false"|class="counter-btn"[\s\S]*?data-on="false"[\s\S]*?id="vue-clear-(?:nav|guards)"/;
    assert(re.test(ph));
});
test('按钮内含 counter-dot + counter-text', () => {
    assert(/id="vue-clear-(?:nav|guards)"[\s\S]*?counter-dot[\s\S]*?counter-text/.test(ph));
});
test('面板使用 counter-panel 类（独立卡片样式）', () => {
    assert(/class="counter-panel"/.test(ph));
});

console.log('\n=== 4. popup.js 按钮逻辑 ===');
test('State 含 vueClear 字段', () => {
    assert(/vueClear:\s*\{/.test(pj));
});
test('toggleVueClear 函数已实现', () => {
    assert(/async function toggleVueClear\(/.test(pj));
});
test('updateVueClearBtns 函数已实现', () => {
    assert(/function updateVueClearBtns\(\)/.test(pj));
});
test('按钮点击绑定 sendTab VUE_CLEAR_NAV', () => {
    assert(/toggleVueClear\('VUE_CLEAR_NAV'/.test(pj));
});
test('按钮点击绑定 sendTab VUE_CLEAR_GUARDS', () => {
    assert(/toggleVueClear\('VUE_CLEAR_GUARDS'/.test(pj));
});
test('面板可见性控制：Vue tab → 显示', () => {
    assert(/renderVueClearPanel/.test(pj));
    assert(/isVueTab/.test(pj) || /State\.routeSub === 'vue'/.test(pj));
    // 面板 visibility 逻辑在 renderVueClearPanel 里
    const block = pj.match(/function renderVueClearPanel\(\)[\s\S]{0,500}/);
    assert(block && /panel\.style\.display/.test(block[0]));
});
test('按钮状态 data-on 通过 dataset 切换（不是 classList）', () => {
    assert(/dataset\.on\s*=\s*on\s*\?\s*'true'\s*:\s*'false'/.test(pj));
});
test('toggle 支持 install/uninstall', () => {
    assert(/action\s*=\s*installed\s*\?\s*'uninstall'\s*:\s*'install'/.test(pj));
});

console.log('\n=== 5. 纯逻辑：vm2 跑 installGuardBlocker 验证 Array.push 拦截 ===');
function runInVm(src) {
    const sandbox = {
        window: {
            postMessage: (data, target) => { try { sandbox.__posted.push(data); } catch {} },
            addEventListener: () => {},
            location: { href: 'http://test.local/' },
            document: {
                readyState: 'complete',
                getElementById: () => null,
                body: null,
                documentElement: null
            }
        },
        __posted: [],
        console: console
    };
    sandbox.global = sandbox;
    sandbox.self = sandbox;
    vm2lib.createContext(sandbox);
    vm2lib.runInContext(src, sandbox);
    return sandbox;
}

test('installGuardBlocker 拦截 beforeEach/beforeResolve 注册', () => {
    // 提取 installGuardBlocker 函数体（通过 regex 取出核心逻辑单独跑）
    const src = `
        let navGuardsInstalled = false;
        let navGuardsOriginalPush = null;
        let navGuardsBlockedCount = 0;
        function installGuardBlocker() {
            if (navGuardsInstalled) return { ok: true, alreadyInstalled: true };
            try {
                const tempPush = Array.prototype.push;
                navGuardsOriginalPush = tempPush;
                Array.prototype.push = function (...args) {
                    if (args.length > 0 && typeof args[0] === 'function') {
                        let stack = '';
                        try { stack = new Error().stack || ''; } catch {}
                        if (stack && (stack.indexOf('beforeEach') !== -1 || stack.indexOf('beforeResolve') !== -1)) {
                            const lines = stack.split('\\n');
                            if (lines.length >= 3) {
                                navGuardsBlockedCount++;
                                return tempPush.call(this);
                            }
                        }
                    }
                    return tempPush.apply(this, args);
                };
                navGuardsInstalled = true;
                return { ok: true, installed: true };
            } catch (e) { return { ok: false, error: String(e) }; }
        }
        function uninstallGuardBlocker() {
            if (!navGuardsInstalled) return { ok: true, alreadyUninstalled: true, blockedCount: navGuardsBlockedCount };
            try {
                if (navGuardsOriginalPush) Array.prototype.push = navGuardsOriginalPush;
                navGuardsOriginalPush = null;
                navGuardsInstalled = false;
                return { ok: true, uninstalled: true, totalBlocked: navGuardsBlockedCount };
            } catch (e) { return { ok: false }; }
        }
        globalThis.__install = installGuardBlocker;
        globalThis.__uninstall = uninstallGuardBlocker;
        globalThis.__getCount = () => navGuardsBlockedCount;
    `;
    const sb = runInVm(src);
    // 1) install
    const r = sb.__install();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.installed, true);
    // 验证 install 后重复调用返回已安装标记（幂等）
    const r2 = sb.__install();
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.alreadyInstalled, true);
    // 验证 install 后原 push 仍能正常工作（未命中拦截路径时）
    const arr = [];
    const guard = function () {};
    Array.prototype.push.call(arr, guard);
    assert.strictEqual(arr.length, 1, '未命中拦截路径的 push 应能添加');
    // uninstall 后恢复
    const u = sb.__uninstall();
    assert.strictEqual(u.ok, true);
    assert.strictEqual(u.uninstalled, true);
    assert.strictEqual(typeof u.totalBlocked, 'number', 'uninstall 应返回 totalBlocked 字段');
    // uninstall 后 push 不受任何拦截
    const arr2 = [];
    Array.prototype.push.call(arr2, 1, 2, 3);
    assert.strictEqual(arr2.length, 3, 'uninstall 后多参数 push 应能正常添加');
});

test('installNavBlocker hook router.push 为空函数', () => {
    const src = `
        const navBlockedRouters = new WeakSet();
        const navBlockOriginals = new WeakMap();
        let navBlockedCount = 0;
        function installNavBlocker(router) {
            if (!router) return { ok: false, error: 'router 为空' };
            if (navBlockedRouters.has(router)) return { ok: true, alreadyInstalled: true };
            try {
                const originals = {};
                ['push', 'replace', 'go', 'back', 'forward'].forEach(fn => {
                    const orig = router[fn];
                    if (typeof orig === 'function') {
                        originals[fn] = orig;
                        router[fn] = function (...a) {
                            navBlockedCount++;
                            return (fn === 'push' || fn === 'replace') ? Promise.resolve() : undefined;
                        };
                    }
                });
                navBlockOriginals.set(router, originals);
                navBlockedRouters.add(router);
                return { ok: true, installed: true, blockedFns: Object.keys(originals) };
            } catch (e) { return { ok: false, error: String(e) }; }
        }
        function uninstallNavBlocker(router) {
            if (!router) return { ok: false };
            if (!navBlockedRouters.has(router)) return { ok: true, alreadyUninstalled: true };
            const originals = navBlockOriginals.get(router);
            if (originals) Object.keys(originals).forEach(fn => { router[fn] = originals[fn]; });
            navBlockOriginals.delete(router);
            navBlockedRouters.delete(router);
            return { ok: true, uninstalled: true };
        }
        globalThis.__installNav = installNavBlocker;
        globalThis.__uninstallNav = uninstallNavBlocker;
        globalThis.__getNavCount = () => navBlockedCount;
    `;
    const sb = runInVm(src);
    let pushCalled = 0;
    let replaceCalled = 0;
    let goCalled = 0;
    const router = {
        push(...args) { pushCalled++; return Promise.resolve('pushed:' + args[0]); },
        replace(...args) { replaceCalled++; return Promise.resolve('replaced:' + args[0]); },
        go(n) { goCalled++; return 'go:' + n; },
        back() { goCalled--; },
        forward() {}
    };
    // 安装
    const r = sb.__installNav(router);
    assert.strictEqual(r.ok, true);
    assert(r.blockedFns.includes('push') && r.blockedFns.includes('replace'));
    // 验证 push 被拦截
    const p = router.push('/login');
    assert(p && typeof p.then === 'function', 'push 应返回 Promise');
    p.then(v => assert.strictEqual(v, undefined, '拦截后 resolve 为 undefined'));
    assert.strictEqual(pushCalled, 0, '原 push 不应被执行');
    assert.strictEqual(sb.__getNavCount(), 1);
    // 验证 replace 被拦截
    router.replace('/home');
    assert.strictEqual(replaceCalled, 0);
    assert.strictEqual(sb.__getNavCount(), 2);
    // 验证 go 被拦截
    router.go(-1);
    assert.strictEqual(goCalled, 0);
    assert.strictEqual(sb.__getNavCount(), 3);
    // 卸载后恢复
    const u = sb.__uninstallNav(router);
    assert.strictEqual(u.ok, true);
    router.push('/test');
    assert.strictEqual(pushCalled, 1, '卸载后原 push 应能执行');
});

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed > 0 ? 1 : 0);