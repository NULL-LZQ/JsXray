/* =====================================================================
 * JsXray — lib/recorder.js
 * 运行时记录：控制台/错误日志、JS 源码缓存、轻量代码美化
 *
 *   ConsoleStore  —— 页面 console.* / 未捕获错误 的按标签页环形缓冲
 *   JsTextCache   —— 已抓取 JS 源码的 LRU 缓存（供 search_in_js 等内容检索）
 *   JsBeautifier  —— 无依赖的 JS 美化器（供 AI 阅读压缩代码）与压缩度评估
 * ===================================================================== */

'use strict';

/* =====================================================================
 * 1. 控制台 / 错误日志
 * ===================================================================== */
const ConsoleStore = {
    LIMIT: 1000,
    tabs: new Map(),   // tabId -> entry[]

    push(tabId, entry) {
        if (tabId == null || tabId < 0 || !entry) return;
        let arr = this.tabs.get(tabId);
        if (!arr) { arr = []; this.tabs.set(tabId, arr); }
        arr.push({
            ts: Date.now(),
            level: String(entry.level || 'log'),
            text: String(entry.text == null ? '' : entry.text).slice(0, 4000),
            url: entry.url || '',
            line: entry.line || 0,
            col: entry.col || 0,
            frameId: entry.frameId != null ? entry.frameId : 0
        });
        if (arr.length > this.LIMIT) arr.splice(0, arr.length - this.LIMIT);
    },

    get(tabId, opts = {}) {
        let arr = this.tabs.get(tabId) || [];
        if (opts.level) {
            const lv = String(opts.level).split(',').map(s => s.trim()).filter(Boolean);
            arr = arr.filter(e => lv.includes(e.level));
        }
        if (opts.keyword) {
            const kw = String(opts.keyword).toLowerCase();
            arr = arr.filter(e => e.text.toLowerCase().includes(kw) || String(e.url).toLowerCase().includes(kw));
        }
        if (opts.since) arr = arr.filter(e => e.ts >= opts.since);
        const limit = Math.min(Math.max(1, opts.limit || 200), 2000);
        const total = arr.length;
        return { total, truncated: total > limit, logs: arr.slice(-limit) };
    },

    clear(tabId) { this.tabs.delete(tabId); },
    count(tabId) { return (this.tabs.get(tabId) || []).length; }
};

/* =====================================================================
 * 2. JS 源码缓存（LRU）
 * ===================================================================== */
const JsTextCache = {
    MAX_BYTES: 24 * 1024 * 1024,
    MAX_ENTRY: 6 * 1024 * 1024,
    tabs: new Map(),   // tabId -> Map<url, {text, bytes, ts}>

    _map(tabId) {
        let m = this.tabs.get(tabId);
        if (!m) { m = new Map(); this.tabs.set(tabId, m); }
        return m;
    },
    _total(m) { let n = 0; for (const v of m.values()) n += v.bytes; return n; },

    put(tabId, url, text) {
        if (tabId == null || !url || typeof text !== 'string') return;
        const m = this._map(tabId);
        const entry = { text, bytes: text.length, ts: Date.now() };
        if (entry.bytes > this.MAX_ENTRY) return;
        m.delete(url);
        m.set(url, entry);
        // 逐出最旧，直到满足容量
        while (this._total(m) > this.MAX_BYTES && m.size > 1) {
            const oldest = m.keys().next().value;
            m.delete(oldest);
        }
    },
    get(tabId, url) { return this.tabs.get(tabId)?.get(url)?.text ?? null; },
    has(tabId, url) { return !!this.tabs.get(tabId)?.has(url); },
    size(tabId) { const m = this.tabs.get(tabId); return m ? { files: m.size, bytes: this._total(m) } : { files: 0, bytes: 0 }; },
    clear(tabId) { this.tabs.delete(tabId); },
    keys(tabId) { return Array.from(this.tabs.get(tabId)?.keys() || []); },

    /**
     * 确保一批 JS 已进缓存（并发抓取）
     * @returns {Promise<{fetched:number, failed:string[]}>}
     */
    async ensure(tabId, urls, opts = {}) {
        const conc = Math.min(Math.max(1, opts.concurrency || 6), 12);
        const maxFiles = Math.min(Math.max(1, opts.maxFiles || 300), 1000);
        const list = (urls || []).slice(0, maxFiles);
        const failed = [];
        let fetched = 0;
        let idx = 0;
        await Promise.all(Array.from({ length: Math.min(conc, list.length || 1) }, async () => {
            while (idx < list.length) {
                const url = list[idx++];
                if (this.has(tabId, url)) continue;
                let text = null;
                try {
                    const r = await JsFetcher.handle({ url, tabId, frameId: '0' });
                    text = r && r.content;
                } catch {}
                if (typeof text === 'string') { this.put(tabId, url, text); fetched++; }
                else failed.push(url);
                if (opts.onProgress) { try { opts.onProgress({ done: fetched + failed.length, total: list.length, url }); } catch {} }
            }
        }));
        return { fetched, failed };
    }
};

/* =====================================================================
 * 3. JS 美化 / 压缩度评估（零依赖）
 * ===================================================================== */
const JsBeautifier = {
    /** 粗略判断是否为压缩代码：平均行长 > 200 或超长行占比高 */
    analyze(code) {
        const s = String(code || '');
        if (!s) return { bytes: 0, lines: 0, avgLine: 0, maxLine: 0, minified: false };
        let lines = 1, maxLine = 0, cur = 0;
        for (let i = 0; i < s.length; i++) {
            if (s.charCodeAt(i) === 10) { lines++; if (cur > maxLine) maxLine = cur; cur = 0; }
            else cur++;
        }
        if (cur > maxLine) maxLine = cur;
        const avgLine = Math.round(s.length / lines);
        return { bytes: s.length, lines, avgLine, maxLine, minified: avgLine > 200 || maxLine > 500 };
    },

    /**
     * 轻量美化：不改语义，仅按 ; { } 换行缩进。
     * 保留字符串 / 模板串 / 注释 / 正则字面量原样。
     */
    beautify(code, indentSize = 4) {
        const src = String(code || '');
        const IND = ' '.repeat(Math.max(1, Math.min(8, indentSize || 4)));
        let out = '';
        let indent = 0;
        let paren = 0, bracket = 0;
        let prevSig = '';       // 上一个有效字符（用于正则判定）
        let prevWord = '';      // 上一个标识符
        let pendingNL = false;

        const nl = (force) => {
            if (force) { out = out.replace(/[ \t]+$/, ''); if (!out.endsWith('\n')) out += '\n'; out += IND.repeat(Math.max(0, indent)); pendingNL = false; return; }
            pendingNL = true;
        };
        const flushNL = () => { if (pendingNL) { out = out.replace(/[ \t]+$/, ''); out += '\n' + IND.repeat(Math.max(0, indent)); pendingNL = false; } };

        const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '^', '~']);
        const WORD_PREV = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await']);

        for (let i = 0; i < src.length; i++) {
            const c = src[i];
            const c2 = src.slice(i, i + 2);

            // 行注释
            if (c2 === '//') {
                const end = src.indexOf('\n', i);
                const seg = end < 0 ? src.slice(i) : src.slice(i, end);
                flushNL(); out += seg; i = end < 0 ? src.length : end - 1; nl(true); prevSig = ';'; continue;
            }
            // 块注释（含 license 头）
            if (c2 === '/*') {
                const end = src.indexOf('*/', i + 2);
                const seg = end < 0 ? src.slice(i) : src.slice(i, end + 2);
                flushNL(); out += seg; i = end < 0 ? src.length : end + 1; nl(true); continue;
            }
            // 字符串
            if (c === '"' || c === "'" || c === '`') {
                flushNL();
                const quote = c;
                let j = i + 1;
                while (j < src.length) {
                    if (src[j] === '\\') { j += 2; continue; }
                    if (src[j] === quote) break;
                    if (quote !== '`' && src[j] === '\n') break;
                    j++;
                }
                out += src.slice(i, Math.min(j + 1, src.length));
                i = j; prevSig = quote; prevWord = ''; continue;
            }
            // 正则字面量
            if (c === '/' && (REGEX_PREV.has(prevSig) || WORD_PREV.has(prevWord))) {
                let j = i + 1, inClass = false, ok = false;
                while (j < src.length) {
                    const ch = src[j];
                    if (ch === '\\') { j += 2; continue; }
                    if (ch === '\n') break;
                    if (ch === '[') inClass = true;
                    else if (ch === ']') inClass = false;
                    else if (ch === '/' && !inClass) { ok = true; break; }
                    j++;
                }
                if (ok) {
                    j++;
                    while (j < src.length && /[a-z]/i.test(src[j])) j++;
                    flushNL(); out += src.slice(i, j);
                    i = j - 1; prevSig = '/'; prevWord = ''; continue;
                }
            }

            switch (c) {
                case '{':
                    if (!/\s$/.test(out) && out) out += ' ';
                    out += '{';
                    indent++; paren = 0; nl(true); prevSig = '{'; prevWord = ''; break;
                case '}': {
                    indent = Math.max(0, indent - 1);
                    out = out.replace(/[ \t]*$/, '');
                    if (!out.endsWith('\n') && out) out += '\n' + IND.repeat(indent);
                    out += '}';
                    prevSig = '}'; prevWord = ''; break;
                }
                case ';':
                    out += ';';
                    if (paren > 0) { out += ' '; prevSig = ';'; prevWord = ''; break; }
                    nl(true); prevSig = ';'; prevWord = ''; break;
                case '(':
                    paren++; out += '('; prevSig = '('; prevWord = ''; break;
                case ')':
                    paren = Math.max(0, paren - 1); out += ')'; prevSig = ')'; prevWord = ''; break;
                case '[':
                    bracket++; out += '['; prevSig = '['; prevWord = ''; break;
                case ']':
                    bracket = Math.max(0, bracket - 1); out += ']'; prevSig = ']'; prevWord = ''; break;
                case '\n':
                case '\r':
                    if (paren > 0) { out += ' '; break; }
                    if (!pendingNL) nl(true);
                    break;
                case ' ':
                case '\t':
                    if (!/[\s]$/.test(out)) out += ' ';
                    break;
                case ',':
                    out += ', '; prevSig = ','; prevWord = ''; break;
                default: {
                    if (pendingNL) flushNL();
                    out += c;
                    prevSig = c;
                    if (/[A-Za-z0-9_$]/.test(c)) prevWord += c;
                    else prevWord = '';
                }
            }
        }
        return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    }
};
