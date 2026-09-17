#!/usr/bin/env node
/* =====================================================================
 * JsXray — tools/pack_release.js
 * 一键产出「完整干净」的发行包：目录 + ZIP。
 *
 * 用法：
 *   node tools/pack_release.js                 # 只产出目录（默认，GitHub 直接上传用）
 *   node tools/pack_release.js --zip           # 额外打一个 ZIP
 *   node tools/pack_release.js --no-verify     # 跳过包内校验/测试（快）
 *   node tools/pack_release.js --out D:\x      # 指定输出目录（默认 ./release）
 *
 * 做什么：
 *   1. 读 manifest.json 的 version → release/JsXray.v<version>/
 *   2. 只拷贝扩展运行时 + MCP 桥接 + 开发工具 + 文档（白名单），
 *      排除 js/（下载快照）、同源其它版本目录、.workbuddy/ 等一切非产品文件
 *   3. **孤儿文件根本不进包**：hooks/ 里未被 hooks.json 引用的、
 *      lib/ 里未被 background.js importScripts 的 —— 不会被执行，只会让包不干净
 *   4. 在包内跑 validate.js + test_all.js，证明这个包是自洽的
 *   5. 打成 ZIP（**正斜杠路径 + deflate**）。PowerShell 的 Compress-Archive 在 Windows
 *      上会写入反斜杠分隔符，跨平台解压会变成一个怪文件名，所以这里自己写 ZIP
 *
 * 设计取舍：目录采用**增量同步**（只写该有的、只删不再需要的少量文件），
 * 不做「清空重建」—— 一是更快，二是避免触发宿主的批量删除安全护栏。
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/* ------------------------------- 参数 ------------------------------- */
const argv = process.argv.slice(2);
const verify = !argv.includes('--no-verify');
const wantZip = argv.includes('--zip');   // 默认只出目录（上传 GitHub 直接用文件夹）
const outIdx = argv.indexOf('--out');
const OUT_BASE = outIdx >= 0 && argv[outIdx + 1] ? argv[outIdx + 1] : path.join(ROOT, 'release');
const MAX_STALE_DELETE = 20;   // 单次允许自动清理的旧文件数上限（超过就让人工确认）

/* --------------------- 进包白名单（顶层条目） --------------------- */
const INCLUDE = [
    // 扩展运行时
    'manifest.json', 'background.js', 'content.js', 'hooks.json', 'hooks', 'inject',
    'lib', 'data', 'bucket', 'popup', 'icons',
    // MCP 桥接（AI 工具直连扩展，属于交付物）
    'mcp',
    // 源码不引用、但对使用者有价值的东西
    '.gitignore', '.gitattributes', 'README.md', 'docs', 'tools'
];

/* ----------------- 不进包的文件（发行包 ≠ 私有工作区） -----------------
 * 这些文件留在源码树里自用，但**发行包要排除**，否则一旦推到公开仓库就是事故：
 *   · QA 记录里有真实目标站点的信息（域名、登录加密链路、接口清单、扩展 ID）
 * 排除后 README 里指向它的链接会被自动降级成文字说明，避免出现断链。 */
const PRIVATE = [
    // 用通配：不要在这里硬编码真实目标的文件名，否则打包脚本自己也会带上目标域名
    'docs/qa-*.md',
    // 图标工作文件：_preview.png 是生成时的自检预览，不进发行包
    'icons/_preview.png'
];
const isPrivate = (rel) => PRIVATE.some(p =>
    rel === p || (p.includes('*') && rel.startsWith(p.slice(0, p.indexOf('*')))));

/* --------------------------- 小工具 --------------------------- */
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}
function dosTime(d) {
    return {
        time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
        date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
    };
}
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
function walk(dir, rel, acc) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r, acc);
        else if (e.isFile()) acc.push(r);
    }
    return acc;
}

/* ------------------------- 1. 计算「该进包的文件」 ------------------------- */
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const pkgName = `JsXray.v${version}`;
const pkgDir = path.join(OUT_BASE, pkgName);
const zipPath = path.join(OUT_BASE, `${pkgName}.zip`);

console.log(`\n打包 ${pkgName}`);
console.log(`  源: ${ROOT}`);
console.log(`  出: ${OUT_BASE}`);

// 防呆：从「已打包的目录」里再跑一次会得到 release/release/… 的嵌套结构
if (fs.existsSync(path.join(ROOT, '_CHECKSUMS.txt')) && !argv.includes('--force')) {
    console.error('\n  ✗ 当前目录看起来已经是一个打包产物（存在 _CHECKSUMS.txt）。');
    console.error('    请从源码目录（含 js/、release/ 的那个）运行；确实要重复打包请加 --force。');
    process.exit(1);
}

// 孤儿判定依据
const hooksMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks.json'), 'utf8'));
const referencedHooks = new Set();
for (const h of hooksMeta) {
    for (const c of [h.file, `${h.id}.js`]) {
        if (c && fs.existsSync(path.join(ROOT, 'hooks', c))) referencedHooks.add(c);
    }
}
const bgSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

const orphans = [];
function isOrphan(rel) {
    if (rel.startsWith('hooks/') && rel.endsWith('.js') && !referencedHooks.has(rel.slice(6))) {
        orphans.push(`${rel}（未被 hooks.json 引用）`);
        return true;
    }
    if (rel.startsWith('lib/') && rel.endsWith('.js') && !bgSrc.includes('lib/' + rel.slice(4))) {
        orphans.push(`${rel}（background.js 未 importScripts）`);
        return true;
    }
    return false;
}

const all = [];
for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) { console.warn(`  ! 白名单条目不存在，已跳过: ${item}`); continue; }
    if (fs.statSync(src).isDirectory()) walk(src, item, all);
    else all.push(item);
}
const wanted = all.filter(rel => !isOrphan(rel) && !isPrivate(rel));

/* ------------------------- 2. 增量同步到包目录 ------------------------- */
fs.mkdirSync(pkgDir, { recursive: true });
const wantedSet = new Set(wanted);

// 2a. 清掉「上次有、这次不该有」的文件（正常情况下很少）
let stale = [];
if (fs.existsSync(pkgDir)) {
    // 忽略 .git：这个目录本身就是要被 git 管理的仓库，不能把它当成"多余的旧文件"
    stale = walk(pkgDir, '', []).filter(rel => !wantedSet.has(rel) && rel !== '_CHECKSUMS.txt' && !rel.startsWith('.git/'));
}
if (stale.length > MAX_STALE_DELETE) {
    console.error(`\n  ✗ 目标目录里有 ${stale.length} 个不再需要的文件（超过自动清理上限 ${MAX_STALE_DELETE}）：`);
    console.error(`    ${stale.slice(0, 8).join(', ')}${stale.length > 8 ? ' …' : ''}`);
    console.error(`    请先手动清空 ${pkgDir} 后重跑。`);
    process.exit(1);
}
for (const rel of stale) {
    const full = path.join(pkgDir, rel);
    try { fs.rmSync(full); } catch { /* 宿主可能装了删除护栏，以「是否真的消失」为准 */ }
    if (fs.existsSync(full)) {
        console.error(`\n  ✗ 无法自动删除 ${full}，请手动删除后重跑。`);
        process.exit(1);
    }
}

// 2b. 写入/覆盖该有的文件
let totalBytes = 0;
for (const rel of wanted) {
    const dst = path.join(pkgDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dst);
    totalBytes += fs.statSync(dst).size;
}
console.log(`  文件 ${wanted.length} 个（上线 ${kb(totalBytes)}）` + (stale.length ? `，清理旧文件 ${stale.length} 个` : ''));
if (orphans.length) orphans.forEach(o => console.log(`  已排除孤儿 ${o}`));
else console.log('  无孤儿文件');
for (const p of PRIVATE) {
    if (all.includes(p)) console.log(`  已排除私有文件 ${p}（留在源码树，不进发行包）`);
}

// README 里指向「未随包发布」文件的链接会变成断链 → 降级为文字说明
{
    const readmePath = path.join(pkgDir, 'README.md');
    if (fs.existsSync(readmePath)) {
        let r = fs.readFileSync(readmePath, 'utf8');
        let touched = 0;
        // 用「实际匹配到的文件名」构造正则，而不是通配模式本身（否则匹配不上）
        for (const p of all.filter(isPrivate)) {
            const baseEsc = path.basename(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`\\[([^\\]]*${baseEsc}[^\\]]*)\\]\\([^)]*\\)`, 'g');
            // 替换文案里也不要带文件名（文件名本身可能含真实目标域名）
            r = r.replace(re, () => { touched++; return '内部审计记录（含真实目标信息，未随发行包发布）'; });
        }
        if (touched) {
            fs.writeFileSync(readmePath, r, 'utf8');
            console.log(`  README 中 ${touched} 处指向私有文件的链接已降级为文字`);
        }
    }
}

/* ------------------------- 3. SHA256 清单 ------------------------- */
const finalFiles = walk(pkgDir, '', [])
    .filter(r => r !== '_CHECKSUMS.txt' && !r.startsWith('.git/')).sort();
const lines = [
    `# ${pkgName} 文件清单（sha256 前 16 位）`,
    `# 生成时间: ${new Date().toISOString()}`,
    `# 文件数: ${finalFiles.length}`,
    ''
];
for (const rel of finalFiles) {
    const buf = fs.readFileSync(path.join(pkgDir, rel));
    lines.push(`${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}  ${String(buf.length).padStart(9)}  ${rel}`);
}
fs.writeFileSync(path.join(pkgDir, '_CHECKSUMS.txt'), lines.join('\n') + '\n', 'utf8');

/* ------------------------- 4. 包内验证 ------------------------- */
if (verify) {
    console.log('\n包内验证：');
    for (const script of ['tools/validate.js', 'tools/test_all.js']) {
        const r = spawnSync(process.execPath, [script], { cwd: pkgDir, encoding: 'utf8' });
        const out = String(r.stdout || '') + String(r.stderr || '');
        // 抓「结论行」：测试脚本最后打印的汇总；抓不到就退回最后一行（可能是 bridge 噪声）
        const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
        const summary = lines.filter(l => /共 \d+ 个测试脚本|结果: \d+|OK, \d+ 错误|全部通过/.test(l)).slice(-1)[0]
            || lines.slice(-1)[0] || '';
        if (r.status === 0) console.log(`  ✓ ${script}  ${summary}`);
        else {
            console.error(`  ✗ ${script} 失败（exit ${r.status}）`);
            console.error(out.slice(-1500));
            process.exit(1);
        }
    }
}

/* ------------------------- 5. 打 ZIP（正斜杠 + deflate） ------------------------- */
function buildZip(dir, files, out) {
    const chunks = [], central = [];
    let offset = 0;
    for (const rel of files) {
        const full = path.join(dir, rel);
        const data = fs.readFileSync(full);
        const nameBuf = Buffer.from(`${pkgName}/${rel}`, 'utf8');
        const comp = zlib.deflateRawSync(data, { level: 9 });
        const crc = crc32(data);
        const { time, date } = dosTime(fs.statSync(full).mtime);

        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
        lh.writeUInt16LE(8, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
        lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
        chunks.push(lh, nameBuf, comp);

        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14);
        ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
        ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
        ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
        ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);   // >>>0：否则左移会溢出成负数
        ch.writeUInt32LE(offset, 42);
        central.push(ch, nameBuf);

        offset += lh.length + nameBuf.length + comp.length;
    }
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
    fs.writeFileSync(out, Buffer.concat([...chunks, cdBuf, eocd]));
}

// 重新 walk 一次以把 _CHECKSUMS.txt 也算进来（.git 不进包）
const zipFiles = walk(pkgDir, '', []).filter(r => !r.startsWith('.git/')).sort();

// 只有显式 --zip 才打包；直接覆盖写（不需要先删，避开宿主的删除护栏）
if (wantZip) buildZip(pkgDir, zipFiles, zipPath);
else if (fs.existsSync(zipPath)) {
    // 上一次生成过 ZIP、这次不要了 → 顺手清掉（删不掉就提示，不静默留垃圾）
    try { fs.rmSync(zipPath); } catch { /* 见下 */ }
    if (fs.existsSync(zipPath)) console.warn(`  ! 旧 ZIP 未能自动删除，请手动删除: ${zipPath}`);
}

/* ------------------------- 6. 汇总 ------------------------- */
console.log('\n──────────────── 打包完成 ────────────────');
console.log(`  目录: ${pkgDir}`);
console.log(`  文件: ${zipFiles.length} 个（含 _CHECKSUMS.txt） | 原始 ${kb(totalBytes)}`);
if (wantZip) console.log(`  ZIP : ${zipPath}（${kb(fs.statSync(zipPath).size)}）`);
console.log('\n上传 GitHub：进入上面那个目录，git init → add → commit → push');
console.log('      （目录内的 .gitignore 已配置好）');
console.log('\n使用：chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选上面那个目录');
console.log('      MCP 配置指向 <目录>/mcp/server.js（令牌在扩展「设置 → MCP 服务」里看）\n');
