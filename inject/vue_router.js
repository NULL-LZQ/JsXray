/* =====================================================================
 * 潜影 LatentEye — inject/vue_router.js (主世界)
 * 注入到页面主世界，提取 Vue2/Vue3 与 React Router 路由表
 * 通过 window.postMessage 与 content 通信
 *
 * 增强点（参考 VueCrack / SnowEyes）：
 *   - BFS 全 DOM 定位 Vue 根（__vue_app__/__vue__/_vnode），不限 #app
 *   - Vue3 三条路径取 router（globalProperties/appContext/ctx）
 *   - Vue2 四条路径取 router（$router/$root.$router/$options.router/_router）
 *   - 路由表 4 级回退（getRoutes → options.routes 递归 → matcher → history.matched）
 *   - 清空守卫 beforeHooks/beforeGuards/beforeResolveGuards/afterGuards
 *   - 关闭 meta.auth 鉴权标记
 *   - hash/history 模式识别 + base 路径
 *   - 多次延迟重试（SPA 异步挂载）
 * ===================================================================== */
(function () {
    'use strict';

    const SOURCE = 'latenteye-inject';
    let vueScanned = false;
    let reactScanned = false;
    let vueTimer = null;
    let reactTimer = null;
    // 当前扫描到的 Vue Router 实例（供「清除跳转」使用）
    let currentVueRouter = null;

    /* -------------------- 路由对抗状态（借鉴 v1.5.0 / AntiDebug_Breaker） -------------------- */
    // 清除路由守卫：hook Array.prototype.push，丢弃 beforeEach/beforeResolve 注册的守卫函数
    let navGuardsInstalled = false;
    let navGuardsOriginalPush = null;
    let navGuardsBlockedCount = 0;
    // 清除跳转：把 router.push/replace/go/back/forward 换成 noop
    const navBlockedRouters = new WeakSet();
    const navBlockOriginals = new WeakMap();
    let navBlockedCount = 0;

    /* -------------------- 清除路由守卫（参考 AntiDebug_Breaker） -------------------- */
    // 原理：Vue Router 注册全局守卫时会 push 到 beforeHooks/beforeGuards/beforeResolveHooks。
    // 全局 hook Array.prototype.push + 检查调用栈是否含 beforeEach/beforeResolve，
    // 命中则以「不传参」调用原 push（守卫被丢弃，不真正注册）。
    function installGuardBlocker() {
        if (navGuardsInstalled) return { ok: true, alreadyInstalled: true, blockedCount: navGuardsBlockedCount };
        try {
            const tempPush = Array.prototype.push;
            navGuardsOriginalPush = tempPush;
            Array.prototype.push = function (...args) {
                if (args.length > 0 && typeof args[0] === 'function') {
                    let stack = '';
                    try { stack = new Error().stack || ''; } catch {}
                    if (stack && (stack.indexOf('beforeEach') !== -1 || stack.indexOf('beforeResolve') !== -1)) {
                        const lines = stack.split('\n');
                        if (lines.length >= 3) {
                            navGuardsBlockedCount++;
                            try { console.log('[HAPPYJS] 已拦截 Vue 路由守卫注册（累计 ' + navGuardsBlockedCount + '）'); } catch {}
                            return tempPush.call(this);   // 不传参 → 不添加守卫
                        }
                    }
                }
                return tempPush.apply(this, args);
            };
            navGuardsInstalled = true;
            return { ok: true, installed: true };
        } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    }
    function uninstallGuardBlocker() {
        if (!navGuardsInstalled) return { ok: true, alreadyUninstalled: true, blockedCount: navGuardsBlockedCount };
        try {
            if (navGuardsOriginalPush) Array.prototype.push = navGuardsOriginalPush;
            navGuardsOriginalPush = null;
            navGuardsInstalled = false;
            return { ok: true, uninstalled: true, totalBlocked: navGuardsBlockedCount };
        } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    }

    /* -------------------- 清除跳转（router.push/replace/go/back/forward → noop） -------------------- */
    function installNavBlocker(router) {
        if (!router) return { ok: false, error: 'router 为空' };
        if (navBlockedRouters.has(router)) return { ok: true, alreadyInstalled: true, blockedCount: navBlockedCount };
        try {
            const originals = {};
            ['push', 'replace', 'go', 'back', 'forward'].forEach(fn => {
                const orig = router[fn];
                if (typeof orig === 'function') {
                    originals[fn] = orig;
                    router[fn] = function (...a) {
                        navBlockedCount++;
                        try { console.log('[HAPPYJS] 已拦截 router.' + fn, a); } catch {}
                        // push/replace 约定返回 Promise，保持返回类型兼容，避免 await 后报错
                        return (fn === 'push' || fn === 'replace') ? Promise.resolve() : undefined;
                    };
                }
            });
            navBlockOriginals.set(router, originals);
            navBlockedRouters.add(router);
            return { ok: true, installed: true, blockedFns: Object.keys(originals) };
        } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    }
    function uninstallNavBlocker(router) {
        if (!router) return { ok: false, error: 'router 为空' };
        if (!navBlockedRouters.has(router)) return { ok: true, alreadyUninstalled: true };
        try {
            const originals = navBlockOriginals.get(router);
            if (originals) {
                Object.keys(originals).forEach(fn => { try { router[fn] = originals[fn]; } catch {} });
                navBlockOriginals.delete(router);
            }
            navBlockedRouters.delete(router);
            return { ok: true, uninstalled: true };
        } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    }

    /** BFS 找 Vue Router 实例（「清除跳转」在未扫描到路由时兜底用） */
    function findRouterByBFS() {
        const candidates = [
            document.getElementById('app'),
            document.getElementById('root'),
            document.getElementById('__nuxt'),
            document.body,
            document.documentElement
        ];
        for (const c of candidates) {
            if (!c) continue;
            const rootEl = findVueRoot(c);
            if (!rootEl) continue;
            const { router } = findVueRouter(rootEl);
            if (router) return router;
        }
        return null;
    }

    function postVue(payload) {
        window.postMessage({ type: 'VUE_ROUTER_DATA', source: SOURCE, data: payload }, '*');
    }
    function postReact(payload) {
        window.postMessage({ type: 'REACT_ROUTER_DATA', source: SOURCE, data: payload }, '*');
    }

    /* -------------------- 工具 -------------------- */
    function joinPath(base, path) {
        if (!path) return base || '/';
        if (path.startsWith('/')) return path;
        if (!base || base === '/') return '/' + path;
        return (base.endsWith('/') ? base.slice(0, -1) : base) + '/' + path;
    }

    function normalizePath(p, base) {
        if (!p) return '/';
        if (!p.startsWith('/')) p = '/' + p;
        if (base && base.endsWith('/')) base = base.slice(0, -1);
        return (base || '') + p;
    }

    // 关闭路由 meta 鉴权标记
    function disableAuthMeta(route) {
        if (route && route.meta && typeof route.meta === 'object') {
            Object.keys(route.meta).forEach(k => {
                if (/auth|login|permission/i.test(k)) {
                    try { route.meta[k] = false; } catch {}
                }
            });
        }
    }

    // 清空 router 守卫容器（兼容 Vue Router 2/3/4 的各种内部字段）
    function clearGuards(router) {
        if (!router) return;
        const containers = ['beforeHooks', 'beforeGuards', 'beforeResolveGuards',
            'afterGuards', 'afterHooks', 'beforeResolveHooks'];
        containers.forEach(k => {
            try {
                const v = router[k];
                if (Array.isArray(v)) v.length = 0;
                else if (v instanceof Set) v.clear();
                else if (v && typeof v.clear === 'function') v.clear();
                else if (v && Array.isArray(v.list)) v.list.length = 0;
            } catch {}
        });
        // 替换注册函数为空函数
        ['beforeEach', 'beforeResolve', 'afterEach'].forEach(fn => {
            try {
                if (typeof router[fn] === 'function') {
                    router[fn] = () => () => {};
                }
            } catch {}
        });
    }

    /* -------------------- Vue 根定位（BFS） -------------------- */
    function findVueRoot(root) {
        const queue = [root];
        let i = 0;
        while (i < queue.length) {
            const el = queue[i++];
            if (!el || el.nodeType !== 1) continue;
            if (el.__vue_app__ || el.__vue__ || el._vnode) return el;
            if (el.shadowRoot) {
                const r = findVueRoot(el.shadowRoot);
                if (r) return r;
            }
            const children = el.children || [];
            for (let j = 0; j < children.length; j++) queue.push(children[j]);
        }
        return null;
    }

    function findVueRouter(rootEl) {
        // Vue 3
        if (rootEl.__vue_app__) {
            const app = rootEl.__vue_app__;
            if (app.config?.globalProperties?.$router) return { router: app.config.globalProperties.$router, version: app.version, isV3: true };
            const inst = app._instance;
            if (inst?.appContext?.config?.globalProperties?.$router) return { router: inst.appContext.config.globalProperties.$router, version: app.version, isV3: true };
            if (inst?.ctx?.$router) return { router: inst.ctx.$router, version: app.version, isV3: true };
        }
        // Vue 2
        if (rootEl.__vue__) {
            const vm = rootEl.__vue__;
            const router = vm.$router || vm.$root?.$router || vm.$root?.$options?.router || vm._router;
            if (router) {
                const version = vm.$root?.$options?._base?.version || (window.Vue && Vue.version) || '2.x';
                return { router, version, isV3: false };
            }
        }
        return {};
    }

    function detectRouterMode(router, isV3) {
        // hash 模式识别
        try {
            const hist = router.options?.history || router.history;
            if (hist) {
                if (/hash/i.test(hist.constructor?.name) || /hash/i.test(typeof hist === 'object' ? JSON.stringify(Object.keys(hist)) : '')) return 'hash';
            }
        } catch {}
        // Vue Router 4: createWebHashHistory → history._value / location
        try {
            if (isV3 && router.options?.history?.base !== undefined && /#/i.test(window.location.href)) return 'hash';
        } catch {}
        // 兜底：URL 含 # 即认为是 hash
        return /#/.test(window.location.href) ? 'hash' : 'history';
    }

    function extractBase(router) {
        try {
            if (router.options?.base) return router.options.base;
            if (router.options?.history?.base) return router.options.history.base || '';
            if (router.history?.base) return router.history.base || '';
        } catch {}
        return '';
    }

    function collectRoutes(routes, base, out, parentPath) {
        if (!Array.isArray(routes)) return;
        routes.forEach(r => {
            if (!r) return;
            disableAuthMeta(r);
            let full;
            if (parentPath) full = joinPath(parentPath, r.path || '');
            else full = normalizePath(r.path || '', base || '');
            if (full && full !== '/') out.add(full);
            if (r.children && r.children.length) {
                collectRoutes(r.children, base, out, full);
            }
        });
    }

    function listAllRoutes(router, base) {
        const out = new Set();
        // 方案1：getRoutes()（VR4 已扁平化）
        if (typeof router.getRoutes === 'function') {
            try {
                const list = router.getRoutes();
                if (Array.isArray(list) && list.length) {
                    list.forEach(r => {
                        if (!r) return;
                        disableAuthMeta(r);
                        const p = r.path || (r.options && r.options.path) || '';
                        if (p && p !== '/') out.add(p);
                    });
                    if (out.size) return out;
                }
            } catch {}
        }
        // 方案2：options.routes 递归
        if (router.options?.routes && Array.isArray(router.options.routes)) {
            collectRoutes(router.options.routes, base, out, '');
            if (out.size) return out;
        }
        // 方案3：matcher.getRoutes()
        try {
            if (router.matcher && typeof router.matcher.getRoutes === 'function') {
                router.matcher.getRoutes().forEach(r => {
                    if (r && r.path) out.add(r.path);
                });
                if (out.size) return out;
            }
        } catch {}
        // 方案4：history.current.matched（已匹配的弱兜底）
        try {
            const matched = router.history?.current?.matched || router.currentRoute?.matched;
            if (Array.isArray(matched)) matched.forEach(r => { if (r && r.path) out.add(r.path); });
        } catch {}
        return out;
    }

    function scanVue(force) {
        if (vueScanned && !force) return;
        const candidates = [
            document.getElementById('app'),
            document.getElementById('root'),
            document.getElementById('__nuxt'),
            document.body,
            document.documentElement
        ];
        let rootEl = null;
        for (const c of candidates) {
            if (!c) continue;
            rootEl = findVueRoot(c);
            if (rootEl) break;
        }
        if (!rootEl) return;
        const { router, version, isV3 } = findVueRouter(rootEl);
        if (!router) return;
        currentVueRouter = router;
        try {
            clearGuards(router);
            const base = extractBase(router);
            const mode = detectRouterMode(router, isV3);
            const routes = listAllRoutes(router, base);
            if (routes.size === 0) return;
            vueScanned = true;
            postVue({ version: version || (isV3 ? '3.x' : '2.x'), routes: Array.from(routes), routerMode: mode, routerBase: base });
        } catch (e) { console.error('[LatentEye] Vue scan:', e); }
    }

    /* -------------------- React 路由提取 -------------------- */
    function findReactFiber(el) {
        if (!el) return null;
        const key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        return key ? el[key] : null;
    }

    function walkFiber(node, depth, seen, out) {
        if (!node || depth > 80 || seen.has(node)) return;
        seen.add(node);
        const props = node.memoizedProps;
        if (props && typeof props === 'object') {
            if (typeof props.path === 'string') {
                out.add(props.path.startsWith('/') ? props.path : '/' + props.path);
            }
            if (Array.isArray(props.routes)) {
                props.routes.forEach(r => {
                    if (r && r.path) out.add(r.path.startsWith('/') ? r.path : '/' + r.path);
                });
            }
            // React Router v6 <Route path> 的 children
            if (Array.isArray(props.children)) {
                props.children.forEach(() => {}); // 子节点会被 fiber 遍历覆盖
            }
        }
        walkFiber(node.child, depth + 1, seen, out);
        walkFiber(node.sibling, depth + 1, seen, out);
    }

    function scanReact(force) {
        if (reactScanned && !force) return;
        const containers = [
            document.getElementById('root'),
            document.getElementById('app'),
            document.getElementById('__next'),
            document.body
        ];
        let rootEl = null;
        for (const c of containers) {
            if (c && findReactFiber(c)) { rootEl = c; break; }
        }
        if (!rootEl) return;
        const fiber = findReactFiber(rootEl);
        if (!fiber) return;
        const out = new Set();
        walkFiber(fiber, 0, new Set(), out);
        // 补充：从 history/location 推断
        const mode = /#/.test(window.location.href) ? 'hash' : 'history';
        if (out.size > 0) {
            reactScanned = true;
            postReact({ routes: Array.from(out), routerMode: mode, routerBase: '', rootId: rootEl.id || 'root' });
        }
    }

    /* -------------------- 触发与延迟重试 -------------------- */
    function runVueScan() { try { scanVue(true); } catch {} }
    function runReactScan() { try { scanReact(true); } catch {} }

    function scheduleRetries() {
        // 多档延时重试，覆盖 SPA 异步挂载
        const delays = [300, 800, 1500, 3000, 6000];
        delays.forEach((d, i) => {
            setTimeout(() => {
                if (!vueScanned) runVueScan();
                if (!reactScanned) runReactScan();
            }, d);
        });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        runVueScan(); runReactScan();
    } else {
        document.addEventListener('DOMContentLoaded', () => { runVueScan(); runReactScan(); });
    }
    window.addEventListener('load', () => { runVueScan(); runReactScan(); });
    scheduleRetries();

    // SPA 路由切换后再扫一次
    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            vueScanned = false; reactScanned = false;
            runVueScan(); runReactScan();
        }
    }, 1500);

    // 接收 content 触发
    window.addEventListener('message', (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.source !== 'latenteye-content') return;
        if (d.type === 'TRIGGER_VUE_SCAN') runVueScan();
        if (d.type === 'TRIGGER_REACT_SCAN') runReactScan();

        // 清除路由守卫（可卸载）
        if (d.type === 'CLEAR_NAV_GUARDS') {
            const action = d.action || 'install';
            const result = action === 'uninstall' ? uninstallGuardBlocker() : installGuardBlocker();
            window.postMessage({
                type: 'NAV_GUARDS_RESULT', source: SOURCE, _id: d._id, action,
                result, blockedCount: navGuardsBlockedCount, installed: navGuardsInstalled
            }, '*');
            return;
        }
        // 清除跳转（可卸载）
        if (d.type === 'CLEAR_NAV') {
            const action = d.action || 'install';
            if (!currentVueRouter) { try { currentVueRouter = findRouterByBFS(); } catch {} }
            if (!currentVueRouter) {
                window.postMessage({
                    type: 'NAV_RESULT', source: SOURCE, _id: d._id, action,
                    result: { ok: false, error: '未找到 Vue Router，请等页面挂载完成或先刷新页面' },
                    blockedCount: navBlockedCount
                }, '*');
                return;
            }
            const result = action === 'uninstall' ? uninstallNavBlocker(currentVueRouter) : installNavBlocker(currentVueRouter);
            window.postMessage({
                type: 'NAV_RESULT', source: SOURCE, _id: d._id, action,
                result, blockedCount: navBlockedCount
            }, '*');
            return;
        }
    });
})();
