/* =====================================================================
 * JsXray — lib/downloader.js
 * 资源索引 + 下载引擎（一键下载当前网站 JS）
 *
 * 组成：
 *   ResourceIndex    —— 按标签页记录 webRequest 观测到的全部资源
 *                       （JS/CSS/JSON/HTML/XHR…，含第三方、状态码、大小、MIME），
 *                       同时作为 MCP get_network_requests / get_js_list 的数据源
 *   DownloadManager  —— 文件名/目录模板、批量下载、清单导出、ZIP 打包
 *
 * 目录与命名：
 *   保存路径 = <下载目录模板>/<站点目录>/<URL 相对路径>
 *   模板支持占位符 {url} {urlfull} {host} {date} {time} {ts} {page} {tab}
 *     {url}     目标网站 URL 的目录名（host[:port]，如 dns2.example.edu.cn）← 默认模板
 *     {urlfull} 完整 URL 的安全化名（如 http_dns2.example.edu.cn_index.html_home）
 *   例：{url}                    →  dns2.example.edu.cn/static/js/app.js
 *       HAPPYJS/{url}/{date}     →  HAPPYJS/dns2.example.edu.cn/2026-09-16/static/js/app.js
 *
 *   站点文件夹自动创建：目录模板里没有 {url}/{host} 时，会自动把 {url} 追加为
 *   最内层目录（cfg.siteFolder 可关），因此「自定义目录」同样会得到
 *   <自定义目录>/<目标网站URL>/… 的结构。
 *
 * 说明：MV3 Service Worker 无稳定 URL.createObjectURL，二进制/文本落盘统一走
 *       base64 data URL；原始 JS 文件优先用 downloads API 直接下载（保留 Cookie）。
 * ===================================================================== */

'use strict';

/* =====================================================================
 * 1. 资源索引
 * ===================================================================== */
const ResourceIndex = {
    LIMIT: 4000,                 // 单标签页最大记录条数（超出丢弃最旧）
    tabs: new Map(),             // tabId -> Map<url, rec>

    _map(tabId) {
        let m = this.tabs.get(tabId);
        if (!m) { m = new Map(); this.tabs.set(tabId, m); }
        return m;
    },

    record(tabId, d) {
        if (tabId == null || tabId < 0 || !d || !d.url) return;
        if (!/^https?:/i.test(d.url)) return;
        const m = this._map(tabId);
        let host = '', path = '';
        try { const u = new URL(d.url); host = u.hostname.toLowerCase(); path = u.pathname; } catch { return; }
        let iniHost = '';
        try { if (d.initiator) iniHost = new URL(d.initiator).hostname.toLowerCase(); } catch {}
        const thirdParty = !!(iniHost && iniHost !== host);
        const prev = m.get(d.url);
        const rec = prev || { url: d.url, ts: Date.now() };
        rec.host = host;
        rec.path = path;
        rec.type = d.type || rec.type || 'other';
        rec.method = d.method || rec.method || 'GET';
        if (d.frameId != null) rec.frameId = d.frameId;
        if (iniHost) rec.initiator = iniHost;
        rec.thirdParty = thirdParty;
        if (!prev) {
            if (m.size >= this.LIMIT) {
                // 简单 FIFO 淘汰：删除最早的 1/8，避免频繁 O(n)
                let n = Math.max(1, Math.floor(this.LIMIT / 8));
                for (const k of m.keys()) { m.delete(k); if (--n <= 0) break; }
            }
            m.set(d.url, rec);
        }
    },

    complete(tabId, url, patch) {
        if (tabId == null) return;
        const rec = this.tabs.get(tabId)?.get(url);
        if (!rec) return;
        // ts 保留为「请求发起时间」（用于按时间排序），完成时间单独记 doneTs
        Object.assign(rec, patch, { done: true, doneTs: Date.now() });
    },

    head(tabId, url, headers) {
        if (tabId == null || !headers) return;
        const rec = this.tabs.get(tabId)?.get(url);
        if (!rec) return;
        let size = 0, mime = '';
        for (const h of headers) {
            const n = String(h.name || '').toLowerCase();
            if (n === 'content-length') { const v = parseInt(h.value, 10); if (v > 0) size = v; }
            else if (n === 'content-type') mime = String(h.value || '').split(';')[0].trim();
        }
        if (size) rec.size = size;
        if (mime) rec.mime = mime;
    },

    get(tabId) { return Array.from(this.tabs.get(tabId)?.values() || []); },
    clear(tabId) { this.tabs.delete(tabId); },

    /** JS 资源清单（get_js_list / 一键下载 的数据源） */
    listJs(tabId, opts = {}) {
        const out = [];
        for (const r of this.get(tabId)) {
            const isJs = r.type === 'script' || /\.(?:js|mjs|jsx|ts|tsx)(\?|$)/i.test(r.path);
            if (!isJs) continue;
            if (!opts.includeThirdParty && r.thirdParty) continue;
            if (opts.sameOriginOnly && r.thirdParty) continue;
            if (opts.skipMin && /\.min\.js$/i.test(r.path)) continue;
            if (opts.frameId != null && r.frameId != null && String(r.frameId) !== String(opts.frameId)) continue;
            out.push({
                url: r.url, host: r.host, path: r.path, frameId: r.frameId,
                thirdParty: !!r.thirdParty, status: r.status || 0,
                size: r.size || 0, mime: r.mime || '', min: /\.min\.js$/i.test(r.path)
            });
        }
        return out;
    },

    /** 网络请求清单（get_network_requests） */
    listRequests(tabId, opts = {}) {
        let list = this.get(tabId);
        const kw = String(opts.keyword || '').toLowerCase();
        if (kw) list = list.filter(r => r.url.toLowerCase().includes(kw));
        if (opts.type) {
            const types = String(opts.type).split(',').map(s => s.trim()).filter(Boolean);
            list = list.filter(r => types.includes(r.type));
        }
        if (opts.onlyThirdParty) list = list.filter(r => r.thirdParty);
        if (opts.minStatus) list = list.filter(r => (r.status || 0) >= opts.minStatus);
        list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        const limit = Math.min(Math.max(1, opts.limit || 200), 2000);
        const truncated = list.length > limit;
        return { total: list.length, truncated, requests: list.slice(-limit) };
    }
};

/* =====================================================================
 * 2. 下载引擎
 * ===================================================================== */
const DL_CFG_KEY = 'le_download_cfg';
const DL_DEFAULT_CFG = {
    dir: '{url}',                 // 默认即「以目标网站 URL 命名的文件夹」
    siteFolder: true,             // 模板未含 {url}/{host} 时自动追加站点文件夹
    engine: 'downloads',          // downloads（浏览器下载，相对默认下载目录）| fs（直写本地目录，popup 侧执行）
    fsDirName: '',                // 直写模式最近选定的目录名（仅用于界面回显）
    flatten: false,
    saveAs: false,
    includeThirdParty: false,
    skipMin: false,
    conflictAction: 'uniquify',
    maxCount: 500,
    zipMaxBytes: 30 * 1024 * 1024,
    format: 'files'          // files | zip | list | zip+list
};
const DL_PLACEHOLDER_HELP = '{url} 目标网站URL（文件夹名）· {urlfull} 完整URL安全名 · {host} 域名 · {date} 日期 · {time} 时刻 · {page} 页面路径 · {tab} 标签页ID';

const DownloadManager = {
    cfg: { ...DL_DEFAULT_CFG },
    _loaded: false,
    _waiters: new Map(),     // downloadId -> {resolve, timer}
    _recent: [],             // 最近落盘记录 {id, filename, url, state, ts}

    async load() {
        try {
            const d = await API.storage.local.get([DL_CFG_KEY]);
            if (d[DL_CFG_KEY]) Object.assign(this.cfg, d[DL_CFG_KEY]);
        } catch {}
        this._loaded = true;
        return { ...this.cfg };
    },
    async save(patch) {
        Object.assign(this.cfg, patch || {});
        try { await API.storage.local.set({ [DL_CFG_KEY]: this.cfg }); } catch {}
        return { ...this.cfg };
    },
    getCfg() { return { ...this.cfg }; },

    /* -------------------- 下载完成监听 -------------------- */
    init() {
        if (this._inited) return;
        this._inited = true;
        try {
            API.downloads.onChanged.addListener((delta) => {
                const id = delta.id;
                const st = delta.state && delta.state.current;
                this._recent.forEach(r => {
                    if (r.id === id && st) { r.state = st; r.err = delta.error && delta.error.current || r.err; }
                });
                if (st !== 'complete' && st !== 'interrupted') return;
                const w = this._waiters.get(id);
                if (!w) return;
                this._waiters.delete(id);
                clearTimeout(w.timer);
                if (st === 'complete') w.resolve({ ok: true, id, path: w.path || '' });
                else w.resolve({ ok: false, id, error: (delta.error && delta.error.current) || '下载中断' });
            });
        } catch (e) { console.error('[HAPPYJS] downloads.onChanged:', e); }
        this.load();
    },

    hasApi() {
        return !!(API.downloads && typeof API.downloads.download === 'function');
    },

    _download(opts) {
        return new Promise((resolve, reject) => {
            if (!this.hasApi()) { reject(new Error('缺少 downloads 权限：请在扩展详情中重新加载扩展（已更新 manifest）')); return; }
            let settled = false;
            const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
            try {
                const ret = API.downloads.download(opts, (id) => {
                    if (API.runtime.lastError) done(reject, new Error(API.runtime.lastError.message));
                    else done(resolve, id);
                });
                if (ret && typeof ret.then === 'function') ret.then(v => done(resolve, v), e => done(reject, e));
            } catch (e) { done(reject, e); }
        });
    },

    _wait(id, path, timeoutMs = 30000) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this._waiters.delete(id);
                resolve({ ok: true, id, path, note: '已提交下载（等待完成确认超时，文件通常已在下载中）' });
            }, timeoutMs);
            this._waiters.set(id, { resolve, timer, path });
        });
    },

    _remember(rec) {
        this._recent.unshift(rec);
        if (this._recent.length > 200) this._recent.length = 200;
    },
    recent(limit = 20) { return this._recent.slice(0, limit); },

    /* -------------------- 路径与命名 -------------------- */
    sanitizeSeg(s) {
        let t = String(s || '').replace(/[\x00-\x1f<>:"|?*\\]/g, '_').replace(/\s+/g, ' ').trim();
        t = t.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
        if (!t) t = '_';
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(t)) t = '_' + t;
        if (t.length > 100) {
            const ext = (t.match(/\.[a-z0-9]{1,8}$/i) || [''])[0];
            t = t.slice(0, 100 - ext.length) + ext;
        }
        return t;
    },

    expandDir(tpl, vars) {
        const base = (tpl == null ? DL_DEFAULT_CFG.dir : String(tpl)) || '';
        const out = base.replace(/\{(host|url|urlfull|date|time|ts|page|tab)\}/g, (m, k) => {
            const v = vars && vars[k];
            return v == null ? '' : String(v);
        });
        // 逐段清洗：用户模板里的非法字符（: ? * | " < > 等）会让浏览器报 "Invalid filename"
        // 注意必须在替换之后做，且不能把分隔符一起吃掉
        return out.split(/[\\/]+/).map(s => this.sanitizeSeg(s)).filter(Boolean).join('/');
    },

    /**
     * 规范化目录模板：
     *   · 去掉首尾空白
     *   · 去掉成对/多余的引号 —— 从资源管理器「复制为路径」粘过来通常带引号
     *     （`"D:\JsXray\js"`），若不清掉，首字符会让绝对路径判断失效，
     *     还会被当作普通目录名清洗成 `_D_/JsXray/js_`（v1.3.0 实测踩到）
     */
    normalizeDirTemplate(tpl) {
        let t = String(tpl == null ? '' : tpl).trim();
        const m = t.match(/^(["'`“”‘’])([\s\S]*)\1$/);
        if (m) t = m[2].trim();
        t = t.replace(/^["'`“”‘’]+/, '').replace(/["'`“”‘’]+$/, '').trim();
        return t;
    },

    /** 是否绝对路径（Windows 盘符 / UNC / POSIX 根） */
    isAbsolutePath(p) {
        const t = this.normalizeDirTemplate(p);
        return /^[a-zA-Z]:[\\/]/.test(t) || /^\\\\/.test(t) || /^[\\/]/.test(t);
    },

    /** 绝对路径 → 相对「默认下载目录」的路径（downloads 接口不接受绝对路径） */
    relativizePath(p) {
        return this.normalizeDirTemplate(p)
            .replace(/^[a-zA-Z]:[\\/]?/, '')
            .replace(/^[\\/]+/, '')
            .split(/[\\/]+/)
            .filter(s => s && s !== '.' && s !== '..')
            .join('/');
    },

    /** 模板里是否已含站点占位符（含则不再自动追加站点文件夹） */
    hasSitePlaceholder(tpl) { return /\{(?:url|host|urlfull)\}/i.test(String(tpl || '')); },

    /**
     * 确保目录模板里有一个「以目标网站 URL 命名的文件夹」。
     * 未包含站点占位符时，把 {url} 追加为最内层目录（即文件结构的直接父目录）。
     */
    withSiteFolder(tpl, enabled) {
        const t = this.normalizeDirTemplate(tpl == null ? DL_DEFAULT_CFG.dir : tpl)
            .replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
        if (enabled === false) return t;
        if (!t) return '{url}';
        if (this.hasSitePlaceholder(t)) return t;
        return `${t}/{url}`;
    },

    /**
     * 目录与文件名规划（不做任何 IO）：
     * 供「直写本地目录」模式与界面预览使用，保证与下载引擎命名完全一致。
     * @returns {{dir:string, site:string, host:string, files:Array<{url:string,rel:string,name:string}>, absolute:boolean, absoluteRaw:string}}
     */
    planFiles(urls, opts = {}) {
        const vars = this._vars(opts.tabId, opts.pageUrl);
        const rawTpl = this.normalizeDirTemplate(opts.dir != null ? opts.dir : this.cfg.dir);
        const siteFolder = opts.siteFolder != null ? opts.siteFolder : (this.cfg.siteFolder !== false);
        const absolute = this.isAbsolutePath(rawTpl);
        const dir = this.expandDir(this.withSiteFolder(absolute ? this.relativizePath(rawTpl) : rawTpl, siteFolder), vars);
        const used = new Set();
        const files = [];
        for (const url of (Array.isArray(urls) ? urls : [])) {
            if (!/^https?:/i.test(url)) continue;
            let rel = [dir, this.relName(url, { flatten: opts.flatten })].filter(Boolean).join('/');
            if (used.has(rel)) {
                const i = rel.lastIndexOf('.');
                rel = i > 0 ? rel.slice(0, i) + '_' + this._hash(url + '|' + rel) + rel.slice(i)
                    : rel + '_' + this._hash(url + '|' + rel);
            }
            used.add(rel);
            files.push({ url, rel, name: rel.split('/').pop() });
        }
        return {
            dir, site: vars.url, host: vars.host, page: vars.page,
            date: vars.date, time: vars.time, tab: vars.tab,
            siteFolder: !!siteFolder, flatten: !!opts.flatten,
            absolute, absoluteRaw: absolute ? String(rawTpl) : '',
            files
        };
    },

    /** 由 URL 生成相对文件名（不含目录） */
    relName(rawUrl, opts = {}) {
        let u;
        try { u = new URL(rawUrl); } catch { return this.sanitizeSeg('unknown.js'); }
        let p = '';
        try { p = decodeURIComponent(u.pathname); } catch { p = u.pathname; }
        const segs = p.split('/').filter(Boolean).map(s => this.sanitizeSeg(s));
        if (!segs.length) segs.push('index');
        let last = segs[segs.length - 1];
        if (!/\.[a-z0-9]{1,8}$/i.test(last)) {
            const q = u.search ? '_' + this._hash(u.search) : '';
            segs[segs.length - 1] = last + q + '.js';
        }
        const rel = opts.flatten ? segs.join('__') : segs.join('/');
        return rel.length > 220 ? rel.slice(0, 210) + '_' + this._hash(rel) + '.js' : rel;
    },

    _hash(s) {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
        return h.toString(36).slice(0, 6);
    },

    /** 组装完整 filename（相对默认下载目录） */
    buildFilename(rawUrl, vars, opts = {}) {
        const dir = this.expandDir(opts.dir, vars);
        const rel = this.relName(rawUrl, opts);
        const parts = [dir, rel].filter(Boolean);
        return parts.join('/').replace(/\/{2,}/g, '/').replace(/^\//, '');
    },

    _vars(tabId, pageUrl) {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        let host = '', port = '', page = '', urlfull = '';
        try {
            const u = new URL(pageUrl);
            host = u.hostname.toLowerCase();
            const defPort = (u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443');
            if (u.port && !defPort) port = u.port;
            page = u.pathname.split('/').filter(Boolean).join('__') || 'root';
            // {urlfull}：完整 URL 的安全化名，例如 http_dns2.example.edu.cn_index.html_home
            urlfull = `${u.protocol.replace(':', '')}_${u.hostname}${u.port ? '_' + u.port : ''}${u.pathname}${u.search}${u.hash}`
                .replace(/[^\w.@-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
        } catch {}
        const siteName = host ? (port ? `${host}_${port}` : host) : '';
        return {
            host: this.sanitizeSeg(host || 'unknown-host'),
            url: this.sanitizeSeg(siteName || 'unknown-host'),   // ← 以目标网站 URL 命名的文件夹
            urlfull: this.sanitizeSeg(urlfull || siteName || 'unknown-host'),
            page: this.sanitizeSeg(page),
            tab: tabId == null ? '0' : String(tabId),
            date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
            time: `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`,
            ts: String(Date.now())
        };
    },

    /* -------------------- 单文件下载 -------------------- */
    /**
     * 页面内落盘回退：在目标页隔离世界用 Blob + <a download> 触发下载。
     * 不需要 downloads 权限、不使用 data: URL，因此权限缺失 / data URL 被拒时仍可工作。
     * 代价：浏览器只接受文件名（子目录会被拍平），目录模板在该路径下失效。
     */
    async _downloadViaPage(tabId, { url, filename, text, base64, mime }) {
        if (tabId == null) throw new Error('缺少 tabId，无法使用页面下载回退');
        const name = String(filename || '').split('/').pop() || 'download.bin';
        let r;
        try {
            r = await API.scripting.executeScript({
                target: { tabId, frameIds: [0] },
                world: 'ISOLATED',
                args: [url || '', text || '', base64 || '', mime || 'application/octet-stream', name],
                func: (u, txt, b64, mime2, fname) => {
                    const click = (blob) => {
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = fname;
                        a.style.display = 'none';
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        setTimeout(() => URL.revokeObjectURL(a.href), 20000);
                    };
                    try {
                        if (b64) {
                            const bin = atob(b64);
                            const u8 = new Uint8Array(bin.length);
                            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                            click(new Blob([u8], { type: mime2 }));
                            return { ok: true, name: fname, via: 'page-blob' };
                        }
                        if (txt) {
                            click(new Blob([txt], { type: mime2 }));
                            return { ok: true, name: fname, via: 'page-blob' };
                        }
                        if (u) {
                            // 由页面自己请求（带 Cookie），拿到 blob 再落盘
                            return fetch(u, { credentials: 'include' })
                                .then(res => res.blob())
                                .then(b => { click(b); return { ok: true, name: fname, via: 'page-fetch' }; })
                                .catch(e => ({ ok: false, error: '页面请求失败: ' + String((e && e.message) || e) }));
                        }
                        return { ok: false, error: '无内容可下载' };
                    } catch (e) {
                        return { ok: false, error: String((e && e.message) || e) };
                    }
                }
            });
        } catch (e) {
            throw new Error('页面下载回退注入失败：' + ((e && e.message) || e));
        }
        const res = r && r[0] && r[0].result;
        if (!res || !res.ok) throw new Error((res && res.error) || '页面下载回退失败');
        this._remember({ id: -1, filename: name, url: url || '(page-blob)', state: 'complete', ts: Date.now(), via: res.via });
        return { ok: true, path: name, viaPage: true, url };
    },

    /** 直接交给浏览器下载原始 URL（保留 Cookie/Referer，最稳）；失败则回退页面内落盘 */
    async downloadUrl({ url, filename, saveAs, conflictAction, referrer, tabId }) {
        try {
            const opts = {
                url,
                conflictAction: conflictAction || this.cfg.conflictAction || 'uniquify'
            };
            if (filename) opts.filename = filename;
            if (saveAs != null ? saveAs : this.cfg.saveAs) opts.saveAs = true;
            // 不指定 referrer：让浏览器按默认策略处理（部分站点校验 Referer 时可显式传入）
            if (referrer && /^https?:/i.test(referrer)) opts.headers = [{ name: 'Referer', value: referrer }];
            const id = await this._download(opts);
            this._remember({ id, filename, url, state: 'in_progress', ts: Date.now() });
            const r = await this._wait(id, filename);
            if (r && r.ok) return { ...r, url };
            // downloads API 明确失败 → 回退
            const fb = await this._downloadViaPage(tabId, { url, filename });
            return { ...fb, viaPage: true, note: 'downloads 接口失败，已改用页面内落盘（子目录会被拍平）', error: r && r.error };
        } catch (e) {
            if (tabId == null) return { ok: false, url, error: String((e && e.message) || e) };
            try {
                const fb = await this._downloadViaPage(tabId, { url, filename });
                return { ...fb, viaPage: true, note: 'downloads 接口不可用，已改用页面内落盘（子目录会被拍平）', error: String((e && e.message) || e) };
            } catch (e2) {
                return { ok: false, url, error: `${(e && e.message) || e} ｜ 回退也失败：${(e2 && e2.message) || e2}` };
            }
        }
    },

    /** 文本内容落盘（清单 / 报告） */
    async downloadText(text, filename, mime = 'text/plain', tabId) {
        const u8 = new TextEncoder().encode(String(text));
        return this.downloadBytes(u8, filename, mime, tabId);
    },

    /** 二进制落盘（ZIP 等），走 base64 data URL；失败回退页面内落盘 */
    async downloadBytes(u8, filename, mime = 'application/octet-stream', tabId) {
        const b64 = HappyZip.toBase64(u8);
        const url = `data:${mime};base64,${b64}`;
        try {
            const opts = {
                url,
                conflictAction: this.cfg.conflictAction || 'uniquify'
            };
            if (filename) opts.filename = filename;
            if (this.cfg.saveAs) opts.saveAs = true;
            const id = await this._download(opts);
            this._remember({ id, filename, url: '(data)', state: 'in_progress', ts: Date.now() });
            const r = await this._wait(id, filename, 60000);
            if (r && r.ok) return { ...r, size: u8.length };
            const fb = await this._downloadViaPage(tabId, { filename, base64: b64, mime });
            return { ...fb, size: u8.length, viaPage: true, error: r && r.error };
        } catch (e) {
            if (tabId == null) return { ok: false, filename, error: String((e && e.message) || e) };
            try {
                const fb = await this._downloadViaPage(tabId, { filename, base64: b64, mime });
                return { ...fb, size: u8.length, viaPage: true, error: String((e && e.message) || e) };
            } catch (e2) {
                return { ok: false, filename, error: `${(e && e.message) || e} ｜ 回退也失败：${(e2 && e2.message) || e2}` };
            }
        }
    },

    /* -------------------- 批量下载入口 -------------------- */
    /**
     * @param {object} o
     * @param {number} o.tabId
     * @param {string[]} o.urls       显式 URL 列表（为空则按 scope 从 ResourceIndex 取）
     * @param {string} [o.scope]      all | sameOrigin | thirdParty
     * @param {string} [o.format]     files | zip | list | zip+list
     * @param {string} [o.dir]        目录模板
     * @param {boolean}[o.flatten]
     * @param {boolean}[o.saveAs]
     * @param {number} [o.maxCount]
     * @param {boolean}[o.skipMin]
     * @param {boolean}[o.includeThirdParty]
     * @param {string} [o.pageUrl]
     * @param {(p:object)=>void} [o.onProgress]
     */
    async downloadJs(o = {}) {
        const tabId = o.tabId;
        if (!this._loaded) await this.load();
        const cfg = {
            dir: this.normalizeDirTemplate(o.dir != null ? o.dir : this.cfg.dir),
            siteFolder: o.siteFolder != null ? o.siteFolder : (this.cfg.siteFolder !== false),
            flatten: o.flatten != null ? o.flatten : this.cfg.flatten,
            saveAs: o.saveAs != null ? o.saveAs : this.cfg.saveAs,
            conflictAction: o.conflictAction || this.cfg.conflictAction,
            includeThirdParty: o.includeThirdParty != null ? o.includeThirdParty : this.cfg.includeThirdParty,
            skipMin: o.skipMin != null ? o.skipMin : this.cfg.skipMin,
            maxCount: Math.min(Math.max(1, o.maxCount || this.cfg.maxCount || 500), 3000)
        };
        const format = o.format || this.cfg.format || 'files';

        // 目录模板：绝对路径降级 + 自动创建「目标网站 URL」文件夹
        let dirNote = '';
        let dirAbsolute = false;
        if (this.isAbsolutePath(cfg.dir)) {
            dirAbsolute = true;
            const rel = this.relativizePath(cfg.dir);
            dirNote = `目录「${cfg.dir}」是绝对路径：浏览器下载接口只接受相对「默认下载目录」的路径，本次已按「${rel}」保存。` +
                `要真正写入该绝对目录，请改用弹窗里的「直写本地目录」模式（可选任意文件夹，会自动创建），或把浏览器默认下载目录设为该路径。`;
            cfg.dir = rel;
        }
        const dirTpl = this.withSiteFolder(cfg.dir, cfg.siteFolder);
        cfg.dir = dirTpl;

        /* 1) 收集目标 URL
         * includeFailed 默认 false：站点自己的失败回退请求（404 等）会让浏览器把 HTML 错误页
         * 当 JS 落盘，所以「已知状态码 >= 400」的 URL 一律先剔除（status 0 = 未知，保留）。 */
        const includeFailed = o.includeFailed === true;
        let excludedFailed = Number(o.preExcludedFailed) || 0;
        let urls = Array.isArray(o.urls) ? o.urls.filter(u => /^https?:/i.test(u)) : [];
        if (!includeFailed && tabId != null) {
            const bad = new Set();
            for (const r of ResourceIndex.get(tabId)) {
                if ((r.status || 0) >= 400) bad.add(r.url);
            }
            if (bad.size && urls.length) {
                const before = urls.length;
                urls = urls.filter(u => !bad.has(u));
                excludedFailed += before - urls.length;
            }
        }
        if (!urls.length) {
            if (tabId == null) throw new Error('缺少 tabId，无法自动收集当前网站 JS');
            const all = ResourceIndex.listJs(tabId, {
                includeThirdParty: cfg.includeThirdParty || o.scope === 'thirdParty',
                skipMin: cfg.skipMin
            }).filter(x => (o.scope === 'thirdParty' ? x.thirdParty : true));
            const usable = includeFailed ? all : all.filter(x => !((x.status || 0) >= 400));
            excludedFailed += all.length - usable.length;
            urls = usable.map(x => x.url);
        }
        urls = Array.from(new Set(urls));
        const skipped = Math.max(0, urls.length - cfg.maxCount);
        urls = urls.slice(0, cfg.maxCount);
        if (!urls.length) {
            return {
                ok: false, count: 0, excludedFailed,
                error: '未收集到可下载的 JS 资源：请先刷新目标页面让扩展完成请求观测（或显式传入 urls）' +
                    (excludedFailed ? `；另有 ${excludedFailed} 个 URL 因状态码 >= 400 被排除（可传 includeFailed:true 强制包含）` : '')
            };
        }

        // 「每次询问保存位置」在批量场景会弹出 N 个对话框 → 超过 20 个文件时自动关闭并提示
        let saveAsNote = '';
        if (cfg.saveAs && format === 'files' && urls.length > 20) {
            cfg.saveAs = false;
            saveAsNote = '文件数超过 20，「每次询问保存位置」已自动关闭（避免弹出大量对话框）；如需自选目录，可先用 zip 形式或分批下载';
        }

        let pageUrl = o.pageUrl || '';
        if (!pageUrl && tabId != null) {
            try { pageUrl = (await API.tabs.get(tabId))?.url || ''; } catch {}
        }
        const vars = this._vars(tabId, pageUrl);
        const progress = (p) => { try { o.onProgress && o.onProgress(p); } catch {} };

        /* ---------- 模式 A：仅导出清单 ---------- */
        if (format === 'list') {
            const dir = this.expandDir(cfg.dir, vars);
            const txt = this.buildListText(urls, tabId, pageUrl);
            const name = dir ? `${dir}/js-list_${vars.url}_${vars.date}.txt` : `js-list_${vars.url}_${vars.date}.txt`;
            progress({ phase: 'list', done: 0, total: 1 });
            const r = await this.downloadText(txt, name, 'text/plain', tabId);
            progress({ phase: 'list', done: 1, total: 1 });
            return {
                ok: r.ok, format, count: urls.length, file: r.path || name, saved: [r.path || name],
                siteFolder: vars.url, skipped, excludedFailed, dirAbsolute,
                dirRaw: this.normalizeDirTemplate(o.dir != null ? o.dir : this.cfg.dir),
                error: r.ok ? null : r.error,
                note: [dirNote, excludedFailed ? `已排除 ${excludedFailed} 个状态码 >= 400 的 URL（避免把 404 页面当 JS 落盘）` : '']
                    .filter(Boolean).join(' ｜ ') || undefined
            };
        }

        /* ---------- 模式 B/C：打包 ZIP ---------- */
        if (format === 'zip' || format === 'zip+list') {
            return this._downloadZip({
                urls, vars, cfg, pageUrl, tabId, format, skipped, progress,
                maxBytes: this.cfg.zipMaxBytes, dirNote, dirAbsolute, excludedFailed,
                dirRaw: this.normalizeDirTemplate(o.dir != null ? o.dir : this.cfg.dir)
            });
        }

        /* ---------- 模式 D：逐文件下载（默认） ---------- */
        const used = new Set();
        const saved = [];
        const failed = [];
        let done = 0;
        const CONC = 4;
        progress({ phase: 'download', done: 0, total: urls.length });

        const one = async (url) => {
            let filename = this.buildFilename(url, vars, { dir: cfg.dir, flatten: cfg.flatten });
            if (used.has(filename)) {
                // 同名（多为带不同 query 的同一路径）：插入短哈希区分
                const i = filename.lastIndexOf('.');
                filename = i > 0
                    ? filename.slice(0, i) + '_' + this._hash(url + '|' + filename) + filename.slice(i)
                    : filename + '_' + this._hash(url + '|' + filename);
            }
            used.add(filename);
            try {
                const r = await this.downloadUrl({ url, filename, saveAs: cfg.saveAs, conflictAction: cfg.conflictAction, tabId });
                if (r.ok) saved.push({ url, file: r.path || filename });
                else failed.push({ url, error: r.error, file: filename });
            } catch (e) {
                failed.push({ url, error: String((e && e.message) || e), file: filename });
            }
            done++;
            progress({ phase: 'download', done, total: urls.length, last: filename });
        };

        let idx = 0;
        await Promise.all(Array.from({ length: Math.min(CONC, urls.length) }, async () => {
            while (idx < urls.length) {
                const i = idx++;
                await one(urls[i]);
            }
        }));

        return {
            ok: failed.length === 0,
            format: 'files',
            dir: this.expandDir(cfg.dir, vars),
            siteFolder: vars.url,
            dirAbsolute, dirRaw: this.normalizeDirTemplate(o.dir != null ? o.dir : this.cfg.dir),
            count: urls.length,
            savedCount: saved.length,
            failedCount: failed.length,
            skipped,
            excludedFailed,
            saved: saved.slice(0, 50),
            failed: failed.slice(0, 20),
            note: '保存位置（相对浏览器默认下载目录）：' + (this.expandDir(cfg.dir, vars) || '.') +
                (cfg.siteFolder ? '　·　已自动创建以目标网站 URL 命名的文件夹「' + vars.url + '」' : '') +
                (cfg.saveAs ? '　·　已开启「每次询问保存位置」' : '') +
                (dirNote ? '　·　' + dirNote : '') +
                (excludedFailed ? `　·　已排除 ${excludedFailed} 个状态码 >= 400 的 URL（避免把 404 页面当 JS 落盘）` : '') +
                (saveAsNote ? '　·　' + saveAsNote : '')
        };
    },

    buildListText(urls, tabId, pageUrl) {
        const lines = [`# JsXray — JS 资源清单`, `# 站点: ${pageUrl || '-'}`, `# 时间: ${new Date().toISOString()}`, `# 数量: ${urls.length}`, ''];
        const idx = new Map();
        if (tabId != null) for (const r of ResourceIndex.get(tabId)) idx.set(r.url, r);
        for (const u of urls) {
            const r = idx.get(u);
            const meta = r ? `\t${r.status || 0}\t${r.size || 0}\t${r.thirdParty ? 'third-party' : 'same-origin'}` : '';
            lines.push(u + meta);
        }
        return lines.join('\n') + '\n';
    },

    /* -------------------- ZIP 打包 -------------------- */
    async _downloadZip({ urls, vars, cfg, pageUrl, tabId, format, skipped, progress, maxBytes, dirNote, dirAbsolute, dirRaw, excludedFailed }) {
        const files = [];
        const failed = [];
        let bytes = 0;
        let done = 0;
        const used = new Set();
        progress({ phase: 'fetch', done: 0, total: urls.length });

        for (const url of urls) {
            let text = null;
            try {
                const r = await JsFetcher.handle({ url, tabId, frameId: '0' });
                text = r && r.content;
            } catch {}
            if (text == null) { failed.push({ url, error: '抓取失败（跨域/CSP/需登录）' }); done++; continue; }
            if (bytes + text.length > maxBytes) {
                failed.push({ url, error: `超出单包上限 ${(maxBytes / 1048576).toFixed(0)}MB，已跳过` });
                done++; continue;
            }
            bytes += text.length;
            let name = this.relName(url, { flatten: cfg.flatten });
            while (used.has(name)) name = name.replace(/(\.[a-z0-9]{1,8})?$/i, (m) => '_' + this._hash(url + Math.random()) + (m || ''));
            used.add(name);
            files.push({ name, data: text });
            done++;
            progress({ phase: 'fetch', done, total: urls.length, last: url });
        }

        if (!files.length) {
            return { ok: false, format: 'zip', count: 0, failedCount: failed.length, failed: failed.slice(0, 20),
                error: '全部 JS 抓取失败：目标资源可能需要登录态，建议先在同一浏览器打开该站点后重试，或改用 format=files 由浏览器直接下载（保留 Cookie）' };
        }

        const manifest = {
            generator: 'JsXray',
            version: (API.runtime.getManifest && API.runtime.getManifest().version) || '',
            page: pageUrl,
            siteFolder: vars.url,
            generatedAt: new Date().toISOString(),
            count: files.length,
            failed,
            files: files.map(f => ({ name: f.name, bytes: (typeof f.data === 'string' ? f.data.length : 0) }))
        };
        files.push({ name: '_manifest.json', data: JSON.stringify(manifest, null, 2) });
        files.push({ name: '_list.txt', data: this.buildListText(urls, tabId, pageUrl) });

        progress({ phase: 'zip', done: 0, total: 1 });
        const zip = HappyZip.build(files);
        const base = this.expandDir(cfg.dir, vars);
        const zipName = (base ? base + '/' : '') + `happyjs-js_${vars.url}_${vars.date}_${vars.time}.zip`;
        const r = await this.downloadBytes(zip, zipName, 'application/zip', tabId);
        progress({ phase: 'zip', done: 1, total: 1 });

        return {
            ok: r.ok,
            format: 'zip',
            count: urls.length,
            packed: files.length,
            rawBytes: bytes,
            zipBytes: zip.length,
            file: r.path || zipName,
            dir: base,
            siteFolder: vars.url,
            dirAbsolute, dirRaw: dirRaw || '',
            failedCount: failed.length,
            failed: failed.slice(0, 20),
            skipped,
            excludedFailed: Number(excludedFailed) || 0,
            note: '已打包为 ZIP（含 _manifest.json 与 _list.txt）' +
                (cfg.siteFolder ? '　·　站点文件夹「' + vars.url + '」' : '') +
                (dirNote ? '　·　' + dirNote : '') +
                (excludedFailed ? `　·　已排除 ${excludedFailed} 个状态码 >= 400 的 URL` : ''),
            error: r.ok ? null : r.error
        };
    }
};
