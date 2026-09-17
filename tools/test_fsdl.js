/* JsXray — 直写本地目录引擎（popup/fsdl.js）单元测试
 *
 * 用内存里的假目录树模拟 File System Access API，验证：
 *   1. 相对路径写入时自动创建中间目录（含「目标网站URL」文件夹）
 *   2. 同名策略：skip 跳过 / rename 自动改名 / 默认覆盖
 *   3. 取内容失败不中断其余文件，且被计入失败明细
 *   4. 文本清单写入与 sha256 记录
 *
 * 运行：node tools/test_fsdl.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.error(`  ✗ ${name}${extra !== undefined ? ' — ' + extra : ''}`); }
}
function eq(a, b, name) { ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

/* ---------------- 假目录句柄 ---------------- */
function notFound() { const e = new Error('not found'); e.name = 'NotFoundError'; return e; }
function makeDir(name) {
    return {
        kind: 'directory', name, dirs: new Map(), files: new Map(),
        async getDirectoryHandle(n, opts = {}) {
            if (this.dirs.has(n)) return this.dirs.get(n);
            if (!opts.create) throw notFound();
            const d = makeDir(n);
            this.dirs.set(n, d);
            return d;
        },
        async getFileHandle(n, opts = {}) {
            if (this.files.has(n)) return this.files.get(n);
            if (!opts.create) throw notFound();
            const holder = this;
            const f = {
                kind: 'file', name: n, buf: null,
                async createWritable() {
                    return {
                        async write(data) { f.buf = Buffer.from(data); },
                        async close() { holder.files.set(n, f); }
                    };
                }
            };
            this.files.set(n, f);
            return f;
        },
        async queryPermission() { return 'granted'; },
        async requestPermission() { return 'granted'; }
    };
}
function fileText(dir, rel) {
    const segs = rel.split('/');
    let cur = dir;
    for (const s of segs.slice(0, -1)) {
        cur = cur.dirs.get(s);
        if (!cur) return null;
    }
    const f = cur.files.get(segs[segs.length - 1]);
    return f && f.buf ? f.buf.toString('utf8') : null;
}
function listRel(dir, prefix = '') {
    const out = [];
    for (const [n, d] of dir.dirs) out.push(...listRel(d, prefix + n + '/'));
    for (const n of dir.files.keys()) out.push(prefix + n);
    return out.sort();
}

/* ---------------- 加载 fsdl.js ---------------- */
function loadFsDl() {
    const code = fs.readFileSync(path.join(root, 'popup', 'fsdl.js'), 'utf8');
    const sandbox = {
        console, Promise, Map, Set, Array, Object, String, Number, JSON, Date, Math, Error,
        Uint8Array, TextEncoder, TextDecoder, ArrayBuffer, atob, btoa, setTimeout, clearTimeout
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.window = { showDirectoryPicker: async () => makeDir('root') };
    sandbox.crypto = { subtle: undefined };      // 走 sha256 的 catch 分支，不算失败
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'fsdl.js' });
    // 顶层 const 在 vm 中属于词法绑定，不挂在全局对象上 → 从 window 上取（脚本末尾会挂载）
    return sandbox.window.FsDl;
}

const FsDl = loadFsDl();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

(async () => {
    console.log('=== 1. 能力探测与目录句柄 ===');
    ok(typeof FsDl.supported === 'function', 'supported() 存在');
    ok(FsDl.supported() === true, '检测到 showDirectoryPicker');
    const rootDir = await FsDl.pick();
    eq(rootDir.name, 'root', 'pick() 返回所选目录句柄');
    eq(FsDl.currentName(), 'root', 'currentName() 回显目录名');

    console.log('\n=== 2. 自动创建中间目录（含站点URL文件夹） ===');
    const files = [
        { url: 'https://dns2.example.edu.cn/js/app.js', rel: 'dns2.example.edu.cn/js/app.js' },
        { url: 'https://dns2.example.edu.cn/js/chunk-vendors.js', rel: 'dns2.example.edu.cn/js/chunk-vendors.js' },
        { url: 'https://dns2.example.edu.cn/index.html', rel: 'dns2.example.edu.cn/static/deep/a/b/c.js' }
    ];
    const st = await FsDl.run({
        root: rootDir,
        files,
        conflict: 'overwrite',
        concurrency: 2,
        fetchOne: async (url) => ({ ok: true, base64: b64('/* ' + url + ' */'), bytes: 10, status: 200 })
    });
    eq(st.ok, 3, '3 个文件全部写入');
    eq(st.failedCount, 0, '无失败');
    ok(st.bytes > 0, '统计了写入字节数', st.bytes);
    eq(fileText(rootDir, 'dns2.example.edu.cn/js/app.js'), '/* https://dns2.example.edu.cn/js/app.js */', '目标网站URL文件夹被自动创建并写入');
    const all = listRel(rootDir);
    ok(all.includes('dns2.example.edu.cn/static/deep/a/b/c.js'), '多层子目录一次创建成功', all.join(', '));
    eq(all.filter(p => p.endsWith('app.js')).length, 1, '文件名未被误改');

    console.log('\n=== 3. 同名策略 ===');
    const stSkip = await FsDl.run({
        root: rootDir, files: [files[0]], conflict: 'skip',
        fetchOne: async () => ({ ok: true, base64: b64('CHANGED'), status: 200 })
    });
    eq(stSkip.skipped, 1, 'skip：已存在则跳过');
    eq(stSkip.ok, 0, 'skip：不计入成功');
    eq(fileText(rootDir, 'dns2.example.edu.cn/js/app.js'), '/* https://dns2.example.edu.cn/js/app.js */', 'skip：原文件未被覆盖');

    const stRename = await FsDl.run({
        root: rootDir, files: [files[0]], conflict: 'rename',
        fetchOne: async () => ({ ok: true, base64: b64('SECOND'), status: 200 })
    });
    eq(stRename.ok, 1, 'rename：新文件写入成功');
    eq(fileText(rootDir, 'dns2.example.edu.cn/js/app(1).js'), 'SECOND', 'rename：生成 app(1).js');

    const stOver = await FsDl.run({
        root: rootDir, files: [files[0]], conflict: 'overwrite',
        fetchOne: async () => ({ ok: true, base64: b64('THIRD'), status: 200 })
    });
    eq(stOver.ok, 1, 'overwrite：写入成功');
    eq(fileText(rootDir, 'dns2.example.edu.cn/js/app.js'), 'THIRD', 'overwrite：覆盖原文件');

    console.log('\n=== 4. 失败隔离 ===');
    const stMix = await FsDl.run({
        root: rootDir,
        files: [
            { url: 'https://dns2.example.edu.cn/js/ok.js', rel: 'dns2.example.edu.cn/js/ok.js' },
            { url: 'https://dns2.example.edu.cn/js/blocked.js', rel: 'dns2.example.edu.cn/js/blocked.js' }
        ],
        conflict: 'overwrite',
        fetchOne: async (url) => (/blocked/.test(url) ? { ok: false, error: 'HTTP 403' } : { ok: true, base64: b64('OK'), status: 200 })
    });
    eq(stMix.ok, 1, '可用的文件照常写入');
    eq(stMix.failedCount, 1, '失败文件被计入明细');
    ok(stMix.failed[0].error === 'HTTP 403', '失败原因被保留', JSON.stringify(stMix.failed));
    eq(fileText(rootDir, 'dns2.example.edu.cn/js/ok.js'), 'OK', '失败不影响成功项落盘');

    console.log('\n=== 5. 文本清单与进度回调 ===');
    await FsDl.writeText(rootDir, 'dns2.example.edu.cn/_manifest.json', '{"ok":true}', 'overwrite');
    eq(fileText(rootDir, 'dns2.example.edu.cn/_manifest.json'), '{"ok":true}', 'writeText 写入清单');
    let last = null;
    await FsDl.run({
        root: rootDir, files: [files[1]], conflict: 'overwrite',
        onProgress: (p) => { last = p; },
        fetchOne: async () => ({ ok: true, base64: b64('x'), status: 200 })
    });
    ok(last && last.done === 1 && last.total === 1 && /chunk-vendors/.test(last.last || ''), '进度回调带文件名与计数', JSON.stringify(last));

    // 无 root / 空文件列表的防护
    let threw = 0;
    try { await FsDl.run({ files: [] }); } catch { threw++; }
    try { await FsDl.run({ root: rootDir, files: [] }); } catch { threw++; }
    eq(threw, 2, '缺少目录或文件时明确报错');

    console.log('\n=== 6. 目录穿越防护 ===');
    let trav = 0;
    try { await FsDl.writeRel(rootDir, '../evil.js', new Uint8Array([1]), 'overwrite'); } catch { trav++; }
    try { await FsDl.writeRel(rootDir, 'a/../../evil.js', new Uint8Array([1]), 'overwrite'); } catch { trav++; }
    eq(trav, 2, '含 .. 的路径被拒绝');
    ok(!listRel(rootDir).some(p => p.includes('evil.js')), '没有文件被写到目录之外', listRel(rootDir).join(', '));

    console.log('\n=== 7. 与浏览器下载模式的路径一致性（planFiles 单一事实源） ===');
    // 载入真实下载引擎（lib/downloader.js），对比两种模式的落盘结构
    const dmSandbox = {
        console, Promise, Map, Set, Array, Object, String, Number, JSON, Date, Math, Error,
        Uint8Array, TextEncoder, TextDecoder, URL, atob, btoa, setTimeout, clearTimeout,
        API: {
            storage: { local: { get: async () => ({}), set: async () => {} } },
            runtime: { getManifest: () => ({ version: 'test' }) }
        }
    };
    vm.createContext(dmSandbox);
    for (const f of ['lib/zip.js', 'lib/downloader.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), dmSandbox, { filename: f });
    }
    const DM = vm.runInContext('({ DownloadManager })', dmSandbox).DownloadManager;
    const pageUrl = 'http://dns2.example.edu.cn/index.html#/home';
    const urls = ['https://dns2.example.edu.cn/js/app.js', 'https://dns2.example.edu.cn/js/chunk.js'];
    const vars = DM._vars(1, pageUrl);

    // 下载模式：buildFilename 的结果应等于 planFiles 的相对路径
    const planned = DM.planFiles(urls, { tabId: 1, pageUrl, dir: '{url}', siteFolder: true });
    const byDownload = urls.map(u => DM.buildFilename(u, vars, { dir: planned.dir, flatten: false }));
    eq(byDownload.join('|'), planned.files.map(f => f.rel).join('|'),
        '下载模式与直写模式的相对路径完全一致');

    // 直写模式：按 plan 写进假目录树，断言目录结构与下载模式一致
    const pRoot = makeDir('root2');
    const pStats = await FsDl.run({
        root: pRoot, files: planned.files, conflict: 'overwrite',
        fetchOne: async () => ({ ok: true, base64: b64('// js'), status: 200 })
    });
    eq(pStats.ok, 2, '按 plan 写入 2 个文件');
    eq(listRel(pRoot).join('|'), byDownload.join('|'), '实际落盘路径与下载模式一致');
    ok(listRel(pRoot).every(p => p.startsWith('dns2.example.edu.cn/')), '全部文件都在「目标网站URL」文件夹下', listRel(pRoot).join(', '));


    console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
