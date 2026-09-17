/* =====================================================================
 * JsXray — inject/capture_main.js（主世界 / MAIN world）
 *
 * 作用：捕获页面 console.* 输出与未捕获异常，转发给 content script，
 *       再由 content 转发 background 环形缓冲，供 popup「调试」面板
 *       与 MCP 工具 get_console_logs 使用。
 *
 * 设计要点：
 *   - 只读观测，不改变页面行为；原始 console 方法一定被调用
 *   - 批量 + 节流上报（200ms / 或累积 40 条），避免高频日志拖慢页面
 *   - 参数序列化带深度与长度限制，循环引用安全
 *   - 由 background 动态注册（开关 / MCP 状态联动），非默认注入
 * ===================================================================== */
(function () {
    'use strict';
    if (window.__happyjsConsoleCapture) return;
    window.__happyjsConsoleCapture = true;

    const MAX_STR = 2000;
    const MAX_ARGS = 12;
    const MAX_DEPTH = 3;
    const FLUSH_MS = 200;
    const FLUSH_SIZE = 40;

    let queue = [];
    let timer = null;
    let sending = false;

    function fmt(v, depth) {
        try {
            if (v === null) return 'null';
            if (v === undefined) return 'undefined';
            const t = typeof v;
            if (t === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) + '…' : v;
            if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
            if (t === 'symbol') return v.toString();
            if (t === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
            if (v instanceof Error) return (v.name || 'Error') + ': ' + v.message + (v.stack ? '\n' + String(v.stack).split('\n').slice(0, 4).join('\n') : '');
            if (v instanceof Element) {
                const id = v.id ? '#' + v.id : '';
                const cls = v.className && typeof v.className === 'string' ? '.' + v.className.split(/\s+/).filter(Boolean).join('.') : '';
                return '<' + v.tagName.toLowerCase() + id + cls + '>';
            }
            if (depth <= 0) return t === 'object' ? '[Object]' : String(v);
            if (Array.isArray(v)) {
                const head = v.slice(0, 20).map(x => fmt(x, depth - 1));
                return '[' + head.join(', ') + (v.length > 20 ? ', …+' + (v.length - 20) : '') + ']';
            }
            if (t === 'object') {
                const keys = Object.keys(v).slice(0, 20);
                const body = keys.map(k => {
                    let val;
                    try { val = fmt(v[k], depth - 1); } catch { val = '[getter error]'; }
                    return k + ': ' + val;
                }).join(', ');
                return '{' + body + (Object.keys(v).length > 20 ? ', …' : '') + '}';
            }
            return String(v);
        } catch (e) { return '[unserializable]'; }
    }

    function push(level, args, extra) {
        try {
            const text = args.slice(0, MAX_ARGS).map(a => fmt(a, MAX_DEPTH)).join(' ');
            queue.push({
                level,
                text,
                url: (extra && extra.url) || location.href,
                line: (extra && extra.line) || 0,
                col: (extra && extra.col) || 0
            });
            if (queue.length >= FLUSH_SIZE) flush();
            else if (!timer) timer = setTimeout(flush, FLUSH_MS);
        } catch {}
    }

    function flush() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (sending || !queue.length) return;
        const batch = queue;
        queue = [];
        sending = true;
        try {
            window.postMessage({ type: 'HAPPYJS_CONSOLE', source: 'happyjs-capture', entries: batch }, '*');
        } catch {}
        // 简单节流：留给 content 转发
        setTimeout(() => { sending = false; if (queue.length) flush(); }, 50);
    }

    // ---- console.* ----
    const LEVELS = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
    for (const lv of LEVELS) {
        try {
            const orig = console[lv];
            if (typeof orig !== 'function') continue;
            const wrapped = function (...args) {
                try { push(lv === 'debug' ? 'debug' : lv, args); } catch {}
                try { return orig.apply(console, args); } catch (e) { /* 页面自定义 console 可能抛错 */ }
            };
            try { Object.defineProperty(wrapped, 'name', { value: lv }); } catch {}
            console[lv] = wrapped;
        } catch {}
    }

    // ---- 未捕获异常 ----
    try {
        const prevOnError = window.onerror;
        window.addEventListener('error', (e) => {
            try {
                if (e && e.message) {
                    push('error', [e.message + (e.filename ? ' @ ' + e.filename : '')], { url: e.filename, line: e.lineno, col: e.colno });
                } else if (e && e.target && e.target.tagName) {
                    push('error', ['资源加载失败: <' + e.target.tagName.toLowerCase() + '> ' + (e.target.src || e.target.href || '')]);
                }
            } catch {}
        }, true);
        window.addEventListener('unhandledrejection', (e) => {
            try {
                const r = e && e.reason;
                push('error', ['UnhandledRejection: ' + fmt(r, MAX_DEPTH)]);
            } catch {}
        });
        if (typeof prevOnError === 'function') { /* 保留页面自身的 onerror */ }
    } catch {}

    // ---- 页面卸载前尽量送出 ----
    try {
        window.addEventListener('pagehide', flush);
        window.addEventListener('beforeunload', flush);
    } catch {}
})();
