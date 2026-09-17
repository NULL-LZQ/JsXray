/*
 * Worker / Service Worker 脚本捕获 Hook
 *
 * 作用：在主世界 Hook 工作线程的创建入口，把线程脚本 URL 抓出来。
 *
 *   ① new Worker(url)           —— 独立线程脚本（常见于加密、加解密、大计算）
 *   ② new SharedWorker(url)     —— 共享线程
 *   ③ navigator.serviceWorker.register(url) —— Service Worker 脚本
 *
 * 为什么需要它：Worker 脚本走的是**独立的资源请求上下文**，普通脚本类 Hook
 * 覆盖不到；而这三类文件里经常藏着站点自己的业务逻辑与接口定义，
 * 是 JS 接口提取的常见遗漏点。
 *
 * 配置：注入本身就是启用信号（扩展只在 Hook 被启用时才注册本脚本）。
 *       仅当显式写入 LatentEye_hook_worker_flag = '0' 时作为「关闭开关」生效。
 *
 * 注意：本脚本运行在主世界（MAIN world）。只上报 URL 与元信息，不改写行为，
 *       并且严格保留原构造器的原型与返回值，避免影响页面。
 */
(function () {
    'use strict';

    /* 同 hook_dynamic_code：早期「必须 === '1'」的写法因无人写入该标记而永久失效，
     * 改为「默认启用、'0' 关闭」。 */
    function isEnabled() {
        try {
            const get = Storage.prototype.getItem;
            return get.call(localStorage, 'LatentEye_hook_worker_flag') !== '0';
        } catch { return true; }
    }

    if (!isEnabled()) return;
    if (window.__happyjsWorkerHooked) return;
    window.__happyjsWorkerHooked = true;

    const seen = new Set();

    function emit(kind, url, meta) {
        try {
            const u = String(url || '');
            if (!u) return;
            const key = kind + '|' + u;
            if (seen.has(key)) return;
            seen.add(key);
            // 相对路径解析成绝对地址，便于下载
            let abs = u;
            try { abs = new URL(u, location.href).href; } catch {}
            window.postMessage({
                type: 'HAPPYJS_WORKER_SCRIPT',
                kind: kind,
                url: abs,
                meta: meta || {}
            }, '*');
        } catch {}
    }

    /* ---------- Worker ---------- */
    try {
        const OriginalWorker = window.Worker;
        if (typeof OriginalWorker === 'function') {
            const hybridWorker = function (scriptURL, options) {
                try {
                    emit('worker', scriptURL, {
                        type: (options && options.type) || '',
                        name: (options && options.name) || ''
                    });
                } catch {}
                return new OriginalWorker(scriptURL, options);
            };
            hybridWorker.prototype = OriginalWorker.prototype;
            Object.defineProperty(hybridWorker, 'name', { value: 'Worker' });
            Object.defineProperty(hybridWorker, 'toString', { value: () => 'function Worker() { [native code] }' });
            window.Worker = hybridWorker;
        }
    } catch {}

    /* ---------- SharedWorker ---------- */
    try {
        const OriginalSharedWorker = window.SharedWorker;
        if (typeof OriginalSharedWorker === 'function') {
            const hybridShared = function (scriptURL, options) {
                try {
                    emit('shared-worker', scriptURL, {
                        name: (options && options.name) || '',
                        type: (options && options.type) || ''
                    });
                } catch {}
                return new OriginalSharedWorker(scriptURL, options);
            };
            hybridShared.prototype = OriginalSharedWorker.prototype;
            Object.defineProperty(hybridShared, 'name', { value: 'SharedWorker' });
            Object.defineProperty(hybridShared, 'toString', { value: () => 'function SharedWorker() { [native code] }' });
            window.SharedWorker = hybridShared;
        }
    } catch {}

    /* ---------- Service Worker 注册 ---------- */
    try {
        if (navigator.serviceWorker && typeof navigator.serviceWorker.register === 'function') {
            const originalRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
            const hybridRegister = function (scriptURL, options) {
                try {
                    emit('service-worker', scriptURL, {
                        scope: (options && options.scope) || '',
                        type: (options && options.type) || ''
                    });
                } catch {}
                return originalRegister(scriptURL, options);
            };
            Object.defineProperty(hybridRegister, 'toString', { value: () => 'function register() { [native code] }' });
            navigator.serviceWorker.register = hybridRegister;
        }
    } catch {}
})();
