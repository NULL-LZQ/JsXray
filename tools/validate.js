/* JsXray — manifest 资源一致性校验 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
let errors = 0, ok = 0;
const check = (rel, label) => {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) { ok++; console.log(`  ✓ ${label}: ${rel}`); }
    else { errors++; console.error(`  ✗ ${label}: ${rel}  [MISSING]`); }
};

console.log('=== manifest.json 资源校验 ===');

// background
if (manifest.background?.service_worker) check(manifest.background.service_worker, 'background.service_worker');
(manifest.background?.scripts || []).forEach(f => check(f, 'background.scripts'));

// content_scripts
(manifest.content_scripts || []).forEach(cs => {
    (cs.js || []).forEach(f => check(f, 'content_scripts.js'));
});

// action
check(manifest.action?.default_popup, 'action.default_popup');
Object.values(manifest.action?.default_icon || {}).forEach(f => check(f, 'action.default_icon'));
Object.values(manifest.icons || {}).forEach(f => check(f, 'icons'));

// web_accessible_resources
(manifest.web_accessible_resources || []).forEach(group => {
    (group.resources || []).forEach(r => {
        // 通配符资源：检查目录是否存在
        if (r.includes('*')) {
            const dir = path.join(root, path.dirname(r));
            if (fs.existsSync(dir)) { ok++; console.log(`  ✓ war (dir): ${r}`); }
            else { errors++; console.error(`  ✗ war (dir): ${r}  [MISSING]`); }
        } else {
            check(r, 'war');
        }
    });
});

// hooks.json 与 hooks/*.js 一致性
console.log('\n=== hooks.json ↔ hooks/*.js 一致性 ===');
const hooksMeta = JSON.parse(fs.readFileSync(path.join(root, 'hooks.json'), 'utf8'));
const hookFiles = fs.readdirSync(path.join(root, 'hooks')).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, ''));
const used = new Set();
const missingFiles = [];
for (const h of hooksMeta) {
    const cands = [h.file, `${h.id}.js`, `a_${String(h.id).replace(/^hook_/, '')}.js`, `b_${String(h.id).replace(/^hook_/, '')}.js`]
        .filter(Boolean);
    const hit = cands.find(c => hookFiles.includes(c.replace(/\.js$/, '')));
    if (hit) used.add(hit.replace(/\.js$/, ''));
    else missingFiles.push(`${h.id}(候选: ${cands.join('/')})`);
}
if (missingFiles.length) { errors++; console.error(`  ✗ 以下 hook 找不到脚本文件: ${missingFiles.join(', ')}`); }
else { ok++; console.log(`  ✓ hooks.json 的 ${hooksMeta.length} 个 hook 均能解析到脚本文件`); }
const orphanFiles = hookFiles.filter(id => !used.has(id));
if (orphanFiles.length) console.warn(`  ! hooks/ 下有未被 hooks.json 引用的脚本（疑似改名残留，可删除或补登记）: ${orphanFiles.join(', ')}`);
else { ok++; console.log('  ✓ 无游离 hook 文件'); }

// Hook 生效前置条件：不得依赖「没人写入的 localStorage 标记」
// 历史事故：脚本开头写 `if (LatentEye_<id>_flag === '1')` 才运行，而全仓没有任何代码写这个键
// → 脚本静默失效（UI 上还显示已启用，不报错、无日志）。正确写法是「注入即启用、'0' 关闭」。
const flagGated = [];
for (const f of fs.readdirSync(path.join(root, 'hooks')).filter(x => x.endsWith('.js'))) {
    // 只检查「hooks.json 真正会注册」的脚本：游离文件（改名残留）不参与运行，报它没意义
    if (!used.has(f.replace(/\.js$/, ''))) continue;
    const src = fs.readFileSync(path.join(root, 'hooks', f), 'utf8');
    if (/LatentEye_[\w$]*_flag'\s*\)\s*===\s*'1'/.test(src)) flagGated.push(f);
}
if (flagGated.length) {
    errors++;
    console.error(`  ✗ 以下 Hook 以「标记 === '1'」作为运行前提（全仓没有写入方 → 会静默失效）: ${flagGated.join(', ')}`);
    console.error(`    请改为「默认启用、'0' 关闭」，或确保确有代码会写该标记`);
} else { ok++; console.log('  ✓ 无 Hook 依赖「无人写入的标记 === 1」这种失效写法'); }

console.log('\n=== Hook 激活行为（vm 中真实执行 hooks/*.js）===');
try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, [path.join(root, 'tools/test_hooks_activation.js')], { encoding: 'utf8' });
    const m = out.match(/结果: (\d+) 通过, (\d+) 失败/);
    if (m && Number(m[2]) === 0) { ok++; console.log(`  ✓ Hook 激活回归 ${m[1]} 项全通过`); }
    else { errors++; console.error(`  ✗ Hook 激活回归失败: ${m ? m[0] : out.slice(-200)}`); }
} catch (e) {
    errors++;
    console.error('  ✗ Hook 激活回归脚本执行失败:', String(e.message).slice(0, 200));
}

// popup 内部引用（popup.html / dlwriter.html）
console.log('\n=== popup 内部引用 ===');
const popupHtml = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
const popupPages = ['popup.html', 'dlwriter.html'].filter(f => fs.existsSync(path.join(root, 'popup', f)));
for (const page of popupPages) {
    const html = fs.readFileSync(path.join(root, 'popup', page), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])
        .filter(r => !/^(?:https?:|data:|#|mailto:)/i.test(r));
    const missingRefs = refs.filter(r => !fs.existsSync(path.join(root, 'popup', r)));
    if (missingRefs.length) { errors++; console.error(`  ✗ ${page} 引用文件不存在: ${missingRefs.join(', ')}`); }
    else { ok++; console.log(`  ✓ ${page} 的 ${refs.length} 个本地引用均存在`); }

    const jsName = page.replace(/\.html$/, '.js');
    const jsPath = path.join(root, 'popup', jsName);
    if (!fs.existsSync(jsPath)) continue;
    const js = fs.readFileSync(jsPath, 'utf8');
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
    const used = new Set([...js.matchAll(/\$\$?\('#([A-Za-z0-9_-]+)'|\$\('([A-Za-z0-9_-]+)'\)|getElementById\('([A-Za-z0-9_-]+)'/g)]
        .map(m => m[1] || m[2] || m[3])
        .filter(id => id && !/[-_]$/.test(id)));   // 形如 'scanner-section-' 的是动态拼接前缀，跳过
    const missingIds = [...used].filter(i => !ids.has(i));
    if (missingIds.length) { errors++; console.error(`  ✗ ${jsName} 引用了 ${page} 中不存在的元素 id: ${missingIds.join(', ')}`); }
    else { ok++; console.log(`  ✓ ${jsName} 的 ${used.size} 个元素 id 均存在于 ${page}`); }
}
// 直写本地目录：引擎脚本与下载面板必须成对存在
if (popupHtml.includes('fsdl.js') && fs.existsSync(path.join(root, 'popup/dlwriter.html'))
    && fs.existsSync(path.join(root, 'popup/dlwriter.js'))) {
    ok++; console.log('  ✓ 直写本地目录引擎（fsdl.js）与下载面板（dlwriter.html/js）齐备');
} else { errors++; console.error('  ✗ 缺少 fsdl.js / dlwriter.html / dlwriter.js（直写本地目录功能不完整）'); }

// background.js 必须 importScripts 加载其引用的 lib/ 模块
const bgJs = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
function walkJs(dir, prefix) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? prefix + '/' + e.name : e.name;
        if (e.isDirectory()) out.push(...walkJs(path.join(dir, e.name), rel));
        else if (e.name.endsWith('.js')) out.push(rel);
    }
    return out;
}
const libFiles = walkJs(path.join(root, 'lib'), '');
const loadedLibs = libFiles.filter(f => bgJs.includes(`lib/${f}`));
const orphanLibs = libFiles.filter(f => !bgJs.includes(`lib/${f}`));
const brokenImports = [...bgJs.matchAll(/importScripts\('([^']+)'\)/g)]
    .map(m => m[1])
    .filter(rel => !fs.existsSync(path.join(root, rel)));
if (brokenImports.length) { errors++; console.error(`  ✗ background.js importScripts 的目标不存在: ${brokenImports.join(', ')}`); }
else { ok++; console.log(`  ✓ background.js 的 importScripts 路径全部存在（lib 已加载 ${loadedLibs.length} 个）`); }
if (orphanLibs.length) console.warn(`  ! lib/ 下未被加载的文件（疑似历史残留）: ${orphanLibs.join(', ')}`);

console.log(`\n=== 结果: ${ok} OK, ${errors} 错误 ===`);
process.exit(errors ? 1 : 0);
