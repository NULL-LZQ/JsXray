/* JsXray — 下载引擎 / 资源索引 / 记录器 单元测试（无需浏览器）
 *
 * 覆盖：
 *   1. HappyZip：CRC32 已知值、ZIP 结构（本地头 / 中央目录 / EOCD）、base64 编解码
 *   2. DownloadManager：文件名与目录模板、非法字符与长路径处理、扁平化、冲突去重
 *   3. ResourceIndex：资源记录、JS 过滤（同源/第三方/min）、网络清单过滤与截断
 *   4. ConsoleStore / JsTextCache：环形缓冲上限、LRU 淘汰
 *   5. JsBeautifier：压缩度判定、美化不改动字符串内容
 *
 * 运行：node tools/test_download_lib.js
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
function eq(actual, expected, name) {
    ok(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ---------------- 构造浏览器环境桩 ---------------- */
function makeSandbox() {
    const store = {};
    const API = {
        storage: {
            local: {
                get(keys, cb) {
                    const out = {};
                    const list = Array.isArray(keys) ? keys : (keys && typeof keys === 'object' ? Object.keys(keys) : [keys]);
                    for (const k of list) if (k in store) out[k] = store[k];
                    if (typeof cb === 'function') { cb(out); return; }
                    return Promise.resolve(out);
                },
                set(obj, cb) { Object.assign(store, obj); if (cb) cb(); return Promise.resolve(); }
            }
        },
        runtime: { getManifest: () => ({ version: '1.2.0' }), lastError: null },
        tabs: { get: async () => ({ url: 'https://example.com/a/b' }) },
        downloads: { download: () => 1, onChanged: { addListener() {} } }
    };
    const sandbox = {
        API,
        __store: store,
        console,
        TextEncoder,
        TextDecoder,
        URL,
        Date,
        Math,
        JSON,
        Promise,
        Map,
        Set,
        Array,
        Object,
        String,
        Number,
        RegExp,
        Error,
        setTimeout,
        clearTimeout,
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        // 抓取器桩：返回可预测内容
        JsFetcher: { handle: async ({ url }) => ({ content: `/* stub ${url} */\nvar a = 1;\n` }) }
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const f of ['lib/zip.js', 'lib/downloader.js', 'lib/recorder.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
    }
    return sandbox;
}

const S = makeSandbox();
// 顶层 const 在 vm 中属于全局词法环境而非 global 对象属性，需用表达式取回
const { HappyZip, DownloadManager, ResourceIndex, ConsoleStore, JsTextCache, JsBeautifier } =
    vm.runInContext('({ HappyZip, DownloadManager, ResourceIndex, ConsoleStore, JsTextCache, JsBeautifier })', S);

console.log('=== 1. HappyZip ===');
eq(HappyZip.crc32(new TextEncoder().encode('123456789')), 0xCBF43926, 'CRC32("123456789") = 0xCBF43926');

const zipFiles = [
    { name: 'static/js/app.js', data: 'console.log("hello");\n' },
    { name: 'static/js/vendor.js', data: 'var v = 1;\n' },
    { name: '_manifest.json', data: '{"a":1}' }
];
const zip = HappyZip.build(zipFiles);
const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
eq(dv.getUint32(0, true), 0x04034b50, 'ZIP 起始为本地文件头签名');
eq(dv.getUint32(zip.length - 22, true), 0x06054b50, 'ZIP 结尾为 EOCD 签名');
eq(dv.getUint16(zip.length - 22 + 10, true), zipFiles.length, 'EOCD 记录文件数正确');
eq(dv.getUint32(zip.length - 22 + 12, true) > 0, true, 'EOCD 中央目录大小 > 0');
ok(zip.length > 100, 'ZIP 体积合理', zip.length);

const b64 = HappyZip.toBase64(zip);
ok(/^[A-Za-z0-9+/=]+$/.test(b64), 'base64 输出字符集合法');
eq(Buffer.from(b64, 'base64').length, zip.length, 'base64 解码后长度一致');

console.log('\n=== 2. DownloadManager 命名与目录 ===');
const D = DownloadManager;
eq(D.sanitizeSeg('a*b?c'), 'a_b_c', 'sanitizeSeg 过滤非法字符');
eq(D.sanitizeSeg('  ..name..  '), 'name', 'sanitizeSeg 去除首尾点与空格');
eq(D.sanitizeSeg('con'), '_con', 'sanitizeSeg 处理 Windows 保留名');
ok(D.sanitizeSeg('x'.repeat(300)).length <= 100, 'sanitizeSeg 限制单段长度');

eq(D.relName('https://a.com/static/js/app.js?v=1'), 'static/js/app.js', 'relName 去掉 query 保留目录');
eq(D.relName('https://a.com/static/js/app.js?v=1', { flatten: true }), 'static__js__app.js', 'relName 扁平化');
eq(D.relName('https://a.com/api/js'), 'api/js.js', 'relName 无扩展名时补 .js');
ok(/^api\/js_[a-z0-9]+\.js$/.test(D.relName('https://a.com/api/js?id=1')),
    'relName 带 query 时追加短哈希', D.relName('https://a.com/api/js?id=1'));
ok(/\/?index.*\.js$/.test(D.relName('https://a.com/')), 'relName 根路径生成 index 名');

const vars = { host: 'a.com', date: '2026-09-16', time: '10-00-00', page: 'root', tab: '7', ts: '1' };
eq(D.expandDir('HAPPYJS/{host}/{date}', vars), 'HAPPYJS/a.com/2026-09-16', 'expandDir 展开占位符');
eq(D.expandDir('{host}/{time}/{tab}', vars), 'a.com/10-00-00/7', 'expandDir 支持 time/tab');
eq(D.buildFilename('https://a.com/static/js/app.js?v=1', vars, { dir: 'HAPPYJS/{host}/{date}' }),
    'HAPPYJS/a.com/2026-09-16/static/js/app.js', 'buildFilename 组装完整路径');
ok(D.buildFilename('https://a.com/' + 'deep/'.repeat(60) + 'x.js', vars, { dir: 'H' }).length < 300,
    'buildFilename 超长路径被收敛');

console.log('\n=== 2b. 站点文件夹 / 绝对路径 ===');
const V = D._vars(7, 'http://dns2.example.edu.cn/index.html#/home');
eq(V.url, 'dns2.example.edu.cn', '_vars 生成以目标网站URL命名的文件夹名');
eq(V.host, 'dns2.example.edu.cn', '_vars 保留 host');
eq(V.urlfull, 'http_dns2.example.edu.cn_index.html_home', '_vars 生成完整URL安全名');
eq(D._vars(7, 'https://a.com:8443/x').url, 'a.com_8443', '非默认端口并入站点文件夹名');
eq(D._vars(7, 'https://a.com:443/x').url, 'a.com', '默认端口不并入');
eq(D._vars(7, '').url, 'unknown-host', '无 pageUrl 时回退 unknown-host');

eq(D.expandDir('{url}', V), 'dns2.example.edu.cn', 'expandDir 支持 {url}');
eq(D.expandDir('HAPPYJS/{url}/{date}', { ...V, date: '2026-09-16' }), 'HAPPYJS/dns2.example.edu.cn/2026-09-16',
    'expandDir 站点文件夹 + 日期');
eq(D.expandDir('{urlfull}', V), 'http_dns2.example.edu.cn_index.html_home', 'expandDir 支持 {urlfull}');
eq(D.expandDir('D:/x/{host}', V), 'D_/x/dns2.example.edu.cn', 'expandDir 逐段清洗非法字符（: 与盘符）');
eq(D.expandDir('a//{date}/b', { date: '' }), 'a/b', 'expandDir 去掉空段');

eq(D.withSiteFolder('{url}', true), '{url}', 'withSiteFolder 已含 {url} 时不重复追加');
eq(D.withSiteFolder('HAPPYJS/{host}/{date}', true), 'HAPPYJS/{host}/{date}', 'withSiteFolder 已含 {host} 时不追加');
eq(D.withSiteFolder('myjs', true), 'myjs/{url}', 'withSiteFolder 自动补上站点文件夹');
eq(D.withSiteFolder('myjs', false), 'myjs', 'siteFolder=false 时不追加');
eq(D.withSiteFolder('myjs/', true), 'myjs/{url}', 'withSiteFolder 去掉尾部分隔符');
eq(D.withSiteFolder('', true), '{url}', 'withSiteFolder 空模板回退 {url}');

ok(D.isAbsolutePath('D:\\JsXray\\js'), 'isAbsolutePath 识别 Windows 绝对路径');
ok(D.isAbsolutePath('/home/u/js'), 'isAbsolutePath 识别 POSIX 绝对路径');
ok(!D.isAbsolutePath('HAPPYJS/{url}'), 'isAbsolutePath 不误判相对模板');
eq(D.relativizePath('D:\\JsXray\\js\\'), 'JsXray/js', 'relativizePath 去掉盘符并统一分隔符');
eq(D.relativizePath('/home/u/js'), 'home/u/js', 'relativizePath 去掉根斜杠');

// 从资源管理器「复制为路径」粘来的带引号路径（v1.3.0 线上实测踩到的坑：
// 首字符是引号 → 绝对路径判断失效 → 被清洗成 _D_/JsXray/js_）
eq(D.normalizeDirTemplate('"D:\\JsXray\\js"'), 'D:\\JsXray\\js', 'normalizeDirTemplate 去掉成对引号');
eq(D.normalizeDirTemplate('  \u201cD:\\x\u201d  '), 'D:\\x', 'normalizeDirTemplate 支持中文引号与空白');
ok(D.isAbsolutePath('"D:\\JsXray\\js"'), '带引号的绝对路径也能被识别');
eq(D.relativizePath('"D:\\JsXray\\js"'), 'JsXray/js', '带引号绝对路径正确降级');
eq(D.withSiteFolder('"D:\\x"', true), 'D:\\x/{url}', 'withSiteFolder 处理带引号模板');
const quotedPlan = D.planFiles(['https://dns2.example.edu.cn/js/app.js'],
    { tabId: 7, pageUrl: 'http://dns2.example.edu.cn/', dir: '"D:\\JsXray\\js"' });
ok(quotedPlan.absolute === true, 'planFiles 识别带引号的绝对路径');
eq(quotedPlan.dir, 'JsXray/js/dns2.example.edu.cn', '带引号绝对路径不再产出 _D_ 之类的脏目录');
ok(!/_D_/.test(quotedPlan.dir), '落盘目录里不再出现 _D_ 脏段');

const plan = D.planFiles([
    'https://dns2.example.edu.cn/js/app.js',
    'https://dns2.example.edu.cn/js/app.js?v=2',
    'https://cdn.x.com/lib.js'
], { tabId: 7, pageUrl: 'http://dns2.example.edu.cn/index.html#/home', dir: 'HAPPYJS/{url}/{date}', flatten: false });
eq(plan.site, 'dns2.example.edu.cn', 'planFiles 返回站点文件夹名');
eq(plan.files.length, 3, 'planFiles 规划全部 URL');
eq(plan.files[0].rel, `HAPPYJS/dns2.example.edu.cn/${plan.date}/js/app.js`, 'planFiles 路径含站点文件夹与目录结构（日期取规划当天）');
ok(plan.files[1].rel !== plan.files[0].rel, '同一路径不同 query 文件名不冲突');
const planAbs = D.planFiles(['https://dns2.example.edu.cn/js/app.js'],
    { tabId: 7, pageUrl: 'http://dns2.example.edu.cn/', dir: 'D:\\JsXray\\js', siteFolder: true });
ok(planAbs.absolute === true, 'planFiles 标记绝对路径');
eq(planAbs.dir, 'JsXray/js/dns2.example.edu.cn', 'planFiles 绝对路径降级 + 自动站点文件夹');

console.log('\n=== 3. ResourceIndex ===');
const TAB = 42;
ResourceIndex.record(TAB, { url: 'https://a.com/static/app.js', type: 'script', frameId: 0, initiator: 'https://a.com/' });
ResourceIndex.record(TAB, { url: 'https://cdn.other.com/lib.min.js', type: 'script', frameId: 0, initiator: 'https://a.com/' });
ResourceIndex.record(TAB, { url: 'https://a.com/api/user/list', type: 'xmlhttprequest', frameId: 0, initiator: 'https://a.com/', method: 'POST' });
ResourceIndex.record(TAB, { url: 'chrome-extension://x/y.js', type: 'script', frameId: 0, initiator: 'https://a.com/' });
ResourceIndex.complete(TAB, 'https://a.com/static/app.js', { status: 200 });
ResourceIndex.head(TAB, 'https://a.com/static/app.js', [
    { name: 'Content-Length', value: '2048' },
    { name: 'Content-Type', value: 'application/javascript; charset=utf-8' }
]);

eq(ResourceIndex.get(TAB).length, 3, '非 http(s) 资源不入索引');
const rec = ResourceIndex.get(TAB).find(r => r.url.endsWith('app.js'));
eq(rec.status, 200, 'onCompleted 状态码写回');
eq(rec.size, 2048, 'Content-Length 解析为字节数');
eq(rec.mime, 'application/javascript', 'Content-Type 去参数');
eq(rec.thirdParty, false, '同源资源 thirdParty=false');

let js = ResourceIndex.listJs(TAB, {});
eq(js.length, 1, '默认 JS 清单排除第三方');
js = ResourceIndex.listJs(TAB, { includeThirdParty: true });
eq(js.length, 2, '含第三方时返回 2 条');
js = ResourceIndex.listJs(TAB, { includeThirdParty: true, skipMin: true });
eq(js.length, 1, 'skipMin 过滤 .min.js');

const net = ResourceIndex.listRequests(TAB, {});
eq(net.total, 3, '网络清单总数');
eq(net.requests[2].method, 'POST', '请求方法记录');
eq(ResourceIndex.listRequests(TAB, { keyword: 'api' }).total, 1, 'keyword 过滤');
eq(ResourceIndex.listRequests(TAB, { type: 'script' }).total, 2, 'type 过滤');
eq(ResourceIndex.listRequests(TAB, { limit: 2 }).truncated, true, 'limit 截断标记');

console.log('\n=== 4. ConsoleStore / JsTextCache ===');
for (let i = 0; i < 1200; i++) ConsoleStore.push(TAB, { level: i % 3 === 0 ? 'error' : 'log', text: 'line ' + i });
eq(ConsoleStore.count(TAB), ConsoleStore.LIMIT, '控制台缓冲上限生效');
const logs = ConsoleStore.get(TAB, { level: 'error', limit: 50 });
eq(logs.logs.length, 50, '按级别过滤 + limit');
ok(logs.truncated, '截断标记正确');
eq(ConsoleStore.get(TAB, { keyword: 'line 1199' }).total, 1, '关键字过滤命中最新一条');

JsTextCache.MAX_BYTES = 1000;
JsTextCache.put(TAB, 'u1', 'a'.repeat(400));
JsTextCache.put(TAB, 'u2', 'b'.repeat(400));
JsTextCache.put(TAB, 'u3', 'c'.repeat(400));
ok(JsTextCache.size(TAB).bytes <= 1000, 'LRU 容量约束生效', JsTextCache.size(TAB).bytes);
eq(JsTextCache.has(TAB, 'u1'), false, '最旧条目被逐出');
eq(JsTextCache.get(TAB, 'u3'), 'c'.repeat(400), '最新条目可读');

console.log('\n=== 5. JsBeautifier ===');
const minified = 'function a(){var b=1;return b+2}console.log(a());' + 'var x=1;'.repeat(200);
const info = JsBeautifier.analyze(minified);
ok(info.minified === true, '压缩代码被判定为 minified', JSON.stringify(info));
ok(JsBeautifier.analyze('var a = 1;\nvar b = 2;\n').minified === false, '正常代码不误判');

const pretty = JsBeautifier.beautify('function a(){var b="a;b{c}d";return b}');
ok(pretty.includes('"a;b{c}d"'), '字符串内容未被破坏');
ok(pretty.split('\n').length > 2, '美化后产生换行缩进');
ok(pretty.includes('function a()'), '函数头保持完整');

const withComment = JsBeautifier.beautify('// note: {x}\nvar r=/a{2,3}b/g;var t=`tpl ${1+1}`;');
ok(withComment.includes('// note: {x}'), '行注释保留');
ok(withComment.includes('/a{2,3}b/g'), '正则字面量保留');
ok(withComment.includes('`tpl ${1+1}`'), '模板字符串保留');

console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
