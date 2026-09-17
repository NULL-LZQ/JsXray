/* =====================================================================
 * JsXray — popup/fsdl.js
 * 「直写本地目录」引擎（File System Access API）
 *
 * 解决的问题：
 *   chrome.downloads 只接受「相对浏览器默认下载目录」的路径，绝对路径直接报
 *   Invalid filename；因此想把 JS 存到 D:\某目录\<站点URL>\ 里，靠下载接口做不到。
 *
 * 做法：
 *   在弹窗里用 showDirectoryPicker() 让用户任选一个根目录（有用户手势才行），
 *   再由扩展逐文件取字节（经目标标签页，保留登录态）直接写入磁盘，中间层目录
 *   （含「目标网站 URL」文件夹）自动 create:true 建出来，无 downloads 权限也能用。
 *
 * 注意：
 *   · 文件写入发生在弹窗内，下载过程中请勿关闭弹窗（关闭即中断）。
 *   · 目录句柄通过 IndexedDB 记住，下次只需重新授权（仍是一次点击）。
 * ===================================================================== */
'use strict';

const FsDl = {
    DB: 'happyjs_fs',
    STORE: 'kv',
    KEY: 'rootDir',
    BATCH_TIMEOUT: 60000,

    _handle: null,
    _rootName: '',

    /* -------------------- 能力探测 -------------------- */
    supported() {
        return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
    },

    /* -------------------- 目录句柄持久化（IndexedDB） -------------------- */
    _db() {
        return new Promise((resolve, reject) => {
            try {
                const req = indexedDB.open(this.DB, 1);
                req.onupgradeneeded = () => {
                    try { if (!req.result.objectStoreNames.contains(this.STORE)) req.result.createObjectStore(this.STORE); } catch {}
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            } catch (e) { reject(e); }
        });
    },
    async _idbGet(key) {
        try {
            const db = await this._db();
            return await new Promise((resolve) => {
                const tx = db.transaction(this.STORE, 'readonly');
                const q = tx.objectStore(this.STORE).get(key);
                q.onsuccess = () => resolve(q.result || null);
                q.onerror = () => resolve(null);
            });
        } catch { return null; }
    },
    async _idbSet(key, val) {
        try {
            const db = await this._db();
            return await new Promise((resolve) => {
                const tx = db.transaction(this.STORE, 'readwrite');
                tx.objectStore(this.STORE).put(val, key);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            });
        } catch { return false; }
    },

    async _ensurePerm(h, interactive) {
        try {
            let p = await h.queryPermission({ mode: 'readwrite' });
            if (p !== 'granted' && interactive) p = await h.requestPermission({ mode: 'readwrite' });
            return p;
        } catch { return 'denied'; }
    },

    /** 弹出系统目录选择器（必须在用户手势回调里调用） */
    async pick() {
        if (!this.supported()) {
            throw new Error('当前浏览器不支持「直写本地目录」（需 Chrome / Edge 86+）；可改用「浏览器下载（相对默认下载目录）」模式');
        }
        const h = await window.showDirectoryPicker({ id: 'happyjs-js', mode: 'readwrite', startIn: 'downloads' });
        if (await this._ensurePerm(h, true) !== 'granted') throw new Error('未获得该目录的写入授权');
        this._handle = h;
        this._rootName = h.name || '';
        await this._idbSet(this.KEY, h);
        return h;
    },

    /** 取回已记住的目录句柄（interactive=true 时可重新申请权限，需要用户手势） */
    async ensure(interactive) {
        if (!this.supported()) return null;
        let h = this._handle;
        if (!h) h = await this._idbGet(this.KEY);
        if (!h) return null;
        this._handle = h;
        this._rootName = h.name || this._rootName;
        const p = await this._ensurePerm(h, !!interactive);
        return p === 'granted' ? h : null;
    },

    /** 当前已选目录（仅名字，用于界面回显） */
    currentName() {
        return this._rootName || (this._handle && this._handle.name) || '';
    },

    async forget() {
        this._handle = null;
        this._rootName = '';
        await this._idbSet(this.KEY, null);
    },

    /* -------------------- 写文件 -------------------- */
    async _writeFile(dir, name, data, conflict) {
        if (conflict === 'skip') {
            try { await dir.getFileHandle(name); return null; }   // 已存在 → 跳过
            catch { /* 不存在 → 继续写入 */ }
        }
        let finalName = name;
        if (conflict === 'rename') {
            let i = 1;
            for (; i <= 500; i++) {
                try { await dir.getFileHandle(finalName); } catch { break; }   // 不存在 → 名字可用
                const dot = name.lastIndexOf('.');
                finalName = dot > 0 ? `${name.slice(0, dot)}(${i})${name.slice(dot)}` : `${name}(${i})`;
            }
        }
        const fh = await dir.getFileHandle(finalName, { create: true });
        const w = await fh.createWritable();
        await w.write(data);
        await w.close();
        return finalName;
    },

    /** 按相对路径写文件，中间目录（含站点URL文件夹）自动创建 */
    async writeRel(root, rel, data, conflict) {
        const segs = String(rel || '').split('/').filter(Boolean);
        const name = segs.pop();
        if (!root || !name) throw new Error('非法目标路径: ' + rel);
        // 防目录穿越：'.' / '..' 在浏览器里会抛错，这里提前拦掉并拒绝写入
        if (segs.some(s => s === '.' || s === '..') || name === '.' || name === '..') {
            throw new Error('非法目标路径（不允许相对跳转）: ' + rel);
        }
        let dir = root;
        for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: true });
        return this._writeFile(dir, name, data, conflict);
    },

    async writeText(root, rel, text, conflict) {
        return this.writeRel(root, rel, new TextEncoder().encode(String(text)), conflict || 'overwrite');
    },

    async sha256(u8) {
        try {
            const buf = await crypto.subtle.digest('SHA-256', u8);
            return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch { return ''; }
    },

    /**
     * 批量落盘
     * @param {object} o
     * @param {FileSystemDirectoryHandle} o.root
     * @param {Array<{url:string, rel:string}>} o.files
     * @param {(url:string)=>Promise<{ok:boolean,base64?:string,error?:string,status?:number}>} o.fetchOne
     * @param {string} [o.conflict]  overwrite | rename
     * @param {number} [o.concurrency]
     * @param {(p:object)=>void} [o.onProgress]
     */
    async run(o) {
        const files = Array.isArray(o.files) ? o.files : [];
        const total = files.length;
        const stats = { ok: 0, skipped: 0, failedCount: 0, bytes: 0, saved: [], failed: [], hashes: {}, stopped: false };
        if (!o.root) throw new Error('未选择目标目录');
        if (!total) throw new Error('没有要写入的文件');

        const CONC = Math.min(4, Math.max(1, o.concurrency || 3));
        let idx = 0, done = 0;
        const one = async (f) => {
            let r = null;
            try { r = await o.fetchOne(f.url); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
            if (!r || !r.ok || !r.base64) {
                stats.failedCount++;
                stats.failed.push({ url: f.url, file: f.rel, error: (r && r.error) || '取内容失败' });
            } else {
                try {
                    const bin = atob(r.base64);
                    const u8 = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                    const name = await this.writeRel(o.root, f.rel, u8, o.conflict);
                    if (name === null) {
                        stats.skipped++;
                    } else {
                        stats.ok++;
                        stats.bytes += u8.length;
                        stats.saved.push({ url: f.url, file: f.rel, bytes: u8.length, status: r.status || 0, name });
                        const h = await this.sha256(u8);
                        if (h) stats.hashes[f.rel] = h.slice(0, 16);
                    }
                } catch (e) {
                    stats.failedCount++;
                    stats.failed.push({ url: f.url, file: f.rel, error: String((e && e.message) || e) });
                }
            }
            done++;
            try { o.onProgress && o.onProgress({ phase: 'write', done, total, last: f.rel, ok: !!(r && r.ok) }); } catch {}
        };
        await Promise.all(Array.from({ length: Math.min(CONC, total) }, async () => {
            while (idx < total) {
                if (o.shouldStop && o.shouldStop()) { stats.stopped = true; return; }
                const i = idx++;
                await one(files[i]);
            }
        }));
        return stats;
    }
};

if (typeof window !== 'undefined') window.FsDl = FsDl;
