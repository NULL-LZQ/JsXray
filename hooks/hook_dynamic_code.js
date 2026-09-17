/*
 * 动态代码捕获 Hook
 *
 * 作用：在主世界 Hook 几处「代码不是通过网络请求、而是运行时凭空造出来」的入口，
 *       把这些代码抓出来交给 content → background，用于接口与敏感信息提取。
 *
 *   ① Blob + URL.createObjectURL —— 动态打包成 blob: 的脚本
 *      （webpack 的 chunk 加载、某些 CDN 的模块注入、前端加密库运行时常量都会走这条）
 *   ② eval                      —— 字符串求值出的代码
 *   ③ Function / 函数构造器      —— new Function(...) 拼出的代码
 *      这三类在 webRequest 里**完全不可见**（不是网络请求），是目前采集的盲区。
 *
 * 配置：注入本身就是启用信号（扩展只在 Hook 被启用时才注册本脚本）。
 *       仅当显式写入 LatentEye_hook_dynamic_code_flag = '0' 时作为「关闭开关」生效。
 *
 * 注意：本脚本运行在主世界（MAIN world），document_start 注入。
 *       单个片段最多上报 512KB，总量最多 80 段，避免拖垮页面。
 */
(function () {
    'use strict';

    /* 历史坑：早期实现是「必须 === '1' 才运行」，但全仓没有任何代码会写这个标记
     * （popup 存的是 {debugger:1} 这类字段，content.js 判的却是 cfg.flag，永远 undefined），
     * 于是脚本 100% 静默失效。改为「默认启用、'0' 关闭」—— 注入即启用。 */
    function isEnabled() {
        try {
            const get = Storage.prototype.getItem;
            return get.call(localStorage, 'LatentEye_hook_dynamic_code_flag') !== '0';
        } catch { return true; }
    }

    if (!isEnabled()) return;
    if (window.__happyjsDynamicCodeHooked) return;
    window.__happyjsDynamicCodeHooked = true;

    const MAX_ONE = 512 * 1024;   // 单段上限
    const MAX_SEGMENTS = 80;      // 本次页面累计上报段数
    const MAX_TOTAL = 4 * 1024 * 1024;
    let sent = 0;
    let sentBytes = 0;
    const seen = new Set();

    /** 是否为本扩展自己的探针代码（MCP execute_js 在页面打的标记）——不应算作「站点动态代码」 */
    function isOwnProbe(source) {
        try {
            if (window.__happyjs_probe_active) return true;
            // 第二道防线：万一标记被清理时序错过，按魔法串识别
            const t = String(source || '');
            return t.indexOf('__happyjs_probe_marker__') !== -1;
        } catch { return false; }
    }

    function emit(kind, code, meta) {
        try {
            if (!code || typeof code !== 'string') return;
            if (isOwnProbe(code)) return;
            if (sent >= MAX_SEGMENTS || sentBytes >= MAX_TOTAL) return;
            const text = code.length > MAX_ONE ? code.slice(0, MAX_ONE) : code;
            // 去重：同一段代码被重复求值时只上报一次（取前 240 字符做指纹）
            const fpr = (kind + '|' + text.length + '|' + text.slice(0, 240));
            if (seen.has(fpr)) return;
            seen.add(fpr);
            sent++;
            sentBytes += text.length;
            window.postMessage({
                type: 'HAPPYJS_DYNAMIC_CODE',
                kind: kind,
                code: text,
                truncated: text.length < code.length,
                originalLength: code.length,
                meta: meta || {}
            }, '*');
        } catch {}
    }

    function str(v) {
        try { return typeof v === 'string' ? v : String(v == null ? '' : v); } catch { return ''; }
    }

    /* ---------- ① Blob + URL.createObjectURL（blob: 脚本） ---------- */
    try {
        const OriginalBlob = window.Blob;
        const blobText = new WeakMap();   // Blob → 文本内容

        function hybridBlob(parts, options) {
            const blob = new OriginalBlob(parts, options);
            try {
                let joined = '';
                if (Array.isArray(parts)) {
                    for (const p of parts) {
                        if (typeof p === 'string') joined += p;
                        else if (p instanceof ArrayBuffer) joined += new TextDecoder().decode(p);
                        else if (ArrayBuffer.isView(p)) joined += new TextDecoder().decode(p);
                    }
                } else if (typeof parts === 'string') {
                    joined = parts;
                }
                if (joined) blobText.set(blob, { text: joined, mime: (options && options.type) || '' });
            } catch {}
            return blob;
        }
        hybridBlob.prototype = OriginalBlob.prototype;
        // 静态方法（Blob.prototype 上没有，但有的库会用到）
        Object.defineProperty(hybridBlob, 'name', { value: 'Blob' });
        window.Blob = hybridBlob;

        const originalCreateObjectURL = URL.createObjectURL.bind(URL);
        let blobSeq = 0;
        URL.createObjectURL = function (obj) {
            let url = '';
            try { url = originalCreateObjectURL(obj); } catch (e) { throw e; }
            try {
                const rec = obj && blobText.get(obj);
                if (rec && rec.text && looksLikeCode(rec.text, rec.mime)) {
                    emit('blob-url', rec.text, { blobUrl: url, mime: rec.mime, seq: ++blobSeq });
                }
            } catch {}
            return url;
        };
        Object.defineProperty(URL.createObjectURL, 'toString', { value: () => 'function createObjectURL() { [native code] }' });
    } catch {}

    /** 判断 Blob 内容像不像脚本（避免把图片/字体二进制也当代码上报） */
    function looksLikeCode(text, mime) {
        if (!text || text.length < 16) return false;
        if (/javascript|ecmascript/i.test(mime || '')) return true;
        // 无 mime 时按特征判断：不能有太多不可打印字符，且含代码特征词
        let ctrl = 0;
        const probe = text.length > 4000 ? text.slice(0, 4000) : text;
        for (let i = 0; i < probe.length; i++) {
            const c = probe.charCodeAt(i);
            if (c === 0 || (c < 9) || (c > 13 && c < 32)) ctrl++;
        }
        if (ctrl / probe.length > 0.02) return false;
        return /function\s|=>|var\s|let\s|const\s|import\s|export\s|return\s|window\.|document\./.test(probe);
    }

    /* ---------- ② eval ---------- */
    try {
        const originalEval = window.eval;
        if (typeof originalEval === 'function') {
            const hybridEval = function (source) {
                try { emit('eval', str(source), {}); } catch {}
                return originalEval.apply(this, arguments);
            };
            Object.defineProperty(hybridEval, 'toString', { value: () => 'function eval() { [native code] }' });
            window.eval = hybridEval;
        }
    } catch {}

    /* ---------- ③ Function 构造器 ---------- */
    try {
        const OriginalFunction = window.Function;
        if (typeof OriginalFunction === 'function') {
            const hybridFunction = function () {
                try {
                    // 最后一个参数是函数体，前面的都是形参
                    const args = Array.prototype.slice.call(arguments);
                    const body = args.length ? str(args[args.length - 1]) : '';
                    if (body && body.length >= 12) {
                        emit('function-constructor', body, { argCount: args.length });
                    }
                } catch {}
                return OriginalFunction.apply(this, arguments);
            };
            hybridFunction.prototype = OriginalFunction.prototype;
            Object.defineProperty(hybridFunction, 'name', { value: 'Function' });
            Object.defineProperty(hybridFunction, 'toString', { value: () => 'function Function() { [native code] }' });
            window.Function = hybridFunction;
        }
    } catch {}
})();
