/* JsXray — chunk 合成 / 路由提取 / 站点范围单元测试（无需浏览器）
 *
 * 覆盖（借鉴 hybrid_capture_project2 的三个模块）：
 *   1. ChunkFinder：webpack runtime 映射解析、名称/哈希表、后缀与分隔符试探、
 *      私有上下文边界、Module Federation 远程入口、Vite 产物识别
 *   2. RouteFinder：Vue/React/Angular 路由、动态路由识别、hash 路由、噪声排除
 *   3. SiteScope：两级后缀基础域、组织名跨 TLD 同主体、CDN 库与统计域识别
 *
 * 负向断言（不该命中 / 不该产生）与正向断言数量相当。
 * 运行：node tools/test_chunk_finder.js
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

/* ---------------- 沙箱：只放这三个模块直接用到的东西 ---------------- */
function makeSandbox() {
    const sandbox = {
        console, URL, Set, Map, Array, Object, String, Number, Boolean,
        RegExp, Error, JSON, Math, Date, TextDecoder
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    for (const f of ['lib/chunk_finder.js', 'lib/route_finder.js', 'lib/site_scope.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
    }
    return sandbox;
}
const S = makeSandbox();
// 顶层 const 在 vm 里属于全局词法环境，需用表达式取回
const { ChunkFinder, RouteFinder, SiteScope } =
    vm.runInContext('({ ChunkFinder, RouteFinder, SiteScope })', S);

/* ================================================================
 * 1. ChunkFinder
 * ================================================================ */
console.log('\n=== 1. ChunkFinder — webpack chunk 合成 ===');

// 典型 webpack runtime：.u 生成函数 + 名称表 + 哈希表（两个 chunk）
const RUNTIME = `
__webpack_require__.u = function(e) {
  return "static/js/" + ({"860":"LoginReset","12":"Home"}[e] || e) + "." +
         {"860":"a1b2c3d4e5f6a7b8","12":"f6e7d8c9b0a1b2c3"}[e] + ".chunk.js";
};
`;
const chunks = ChunkFinder.discoverChunks(RUNTIME, 'https://a.edu.cn/static/js/runtime.abc123.js');

ok(chunks.length > 0, '从 .u 映射合成出候选', String(chunks.length));
ok(chunks.some(c => c.fileName === 'LoginReset.a1b2c3d4e5f6a7b8.chunk.js'),
    '名称表 + 哈希表 + 点分隔符组合正确',
    JSON.stringify(chunks.slice(0, 3).map(c => c.fileName)));
ok(chunks.some(c => c.fileName === 'LoginReset-a1b2c3d4e5f6a7b8.chunk.js'), '连字符分隔符同样尝试');
ok(chunks.some(c => c.fileName === 'LoginReset_a1b2c3d4e5f6a7b8.chunk.js'), '下划线分隔符同样尝试');
ok(chunks.some(c => c.fileName === 'a1b2c3d4e5f6a7b8.chunk.js'), '仅有哈希的形态也尝试（无名称映射的站点）');
ok(chunks.every(c => c.url.startsWith('https://a.edu.cn/static/js/')),
    '候选 URL 以脚本同目录为基准', chunks[0] && chunks[0].url);
ok(chunks.every(c => c.strategy.startsWith('semantic') || c.strategy === 'fallback'), '候选带策略标签');
eq(ChunkFinder.detectSuffix(RUNTIME), '.chunk.js', '后缀识别为 .chunk.js');

// 默认后缀
eq(ChunkFinder.detectSuffix('var a = "x" + e + ".js";'), '.js', '无特殊后缀时回落 .js');

// 科学计数法 chunkId 还原
const sciRuntime = '__webpack_require__.u=function(e){return "a/"+e+"."+{1e3:"abcdef123456"}[e]+".js";};';
const sciChunks = ChunkFinder.discoverChunks(sciRuntime, 'https://a.com/main.js');
ok(sciChunks.some(c => c.chunkId === '1000'), '科学计数法 chunkId(1e3) 还原为 1000',
    JSON.stringify(sciChunks.map(c => c.chunkId)));

// fallback：源码里直接写死的 hashed 文件名
const fallbackSrc = 'var buildInfo = { env: "production", tag: "release-2026" }; ' +
    'var p = "assets/index-6223ea2e.js"; var q = "static/js/12.a1b2c3d4e5.chunk.js";';
const fb = ChunkFinder.discoverChunks(fallbackSrc, 'https://a.com/assets/main.js');
ok(fb.some(c => /6223ea2e/.test(c.fileName)), 'fallback 捕获 Vite 风格 hashed 文件名',
    JSON.stringify(fb.map(c => c.fileName)));
ok(fb.some(c => /a1b2c3d4e5/.test(c.fileName) && c.strategy === 'fallback'), 'fallback 捕获 webpack 数字-哈希名');

// 负向
eq(ChunkFinder.discoverChunks('', 'https://a.com/x.js').length, 0, '空源码不产出候选');
eq(ChunkFinder.discoverChunks('var a=1;', 'https://a.com/x.js').length, 0, '短源码不产出候选');
eq(ChunkFinder.discoverChunks('var a="' + 'x'.repeat(90) + '";', 'https://a.com/x.js').length, 0,
    '不含 .js 字样的源码不产出候选（快速排除）');
eq(ChunkFinder.discoverChunks(RUNTIME, 'not-a-url').length, 0, '脚本 URL 非法时不产出（无法定基准目录）');
ok(ChunkFinder.discoverChunks(RUNTIME, 'https://a.com/' + 'd/'.repeat(200) + 'r.js', { limit: 5 }).length <= 5,
    'limit 参数生效');

/* ---------------- Module Federation ---------------- */
console.log('\n=== 2. ChunkFinder — Module Federation 远程入口 ===');
const mfSrc = `var r={ app1:'app1@https://cdn.other.com/remoteEntry.js' };
var r2={ 'mf-app':'https://mf.partner.cn/assets/remoteEntry.9a8b7c.js' };
__webpack_require__.l("x", "https://static.example.com/remoteEntry.js");`;
const remotes = ChunkFinder.discoverFederationRemotes(mfSrc, 'https://a.com/main.js');
ok(remotes.length >= 2, '发现多个远程入口', JSON.stringify(remotes.map(r => r.url)));
ok(remotes.some(r => r.remoteName === 'app1' && r.strategy === 'name@url'),
    'name@url 形式解析出远程名', JSON.stringify(remotes.find(r => r.remoteName === 'app1')));
ok(remotes.some(r => r.url === 'https://mf.partner.cn/assets/remoteEntry.9a8b7c.js'),
    '绝对 URL 形式的跨源 remoteEntry 被捕获');
ok(remotes.every(r => /^https?:/.test(r.url)), '远程入口全部为绝对 URL');

// vite-plugin-federation：entry 指向的文件名不含 remoteEntry，只能靠 entry: 特征命中
const viteFed = ChunkFinder.discoverFederationRemotes(
    `{ name:'remoteApp', entry:'https://fed.example.com/assets/remote.js', shareScope:'default', federation: true }`,
    'https://a.com/m.js');
ok(viteFed.some(r => r.strategy === 'vite-entry' && r.url === 'https://fed.example.com/assets/remote.js'),
    'vite-plugin-federation 的 entry 形式被捕获（文件名不含 remoteEntry 时也能识别）',
    JSON.stringify(viteFed));
ok(viteFed.every(r => !/remoteEntry\.js-abs/.test(r.strategy)), '未误标为 remoteEntry 策略');

// 负向：不含联邦特征不应扫描
eq(ChunkFinder.discoverFederationRemotes('var a=1;'.repeat(20), 'https://a.com/m.js').length, 0,
    '无联邦特征的源码快速返回空');
eq(ChunkFinder.discoverFederationRemotes('', 'https://a.com/m.js').length, 0, '空源码返回空');

/* ---------------- Vite 产物识别 ---------------- */
console.log('\n=== 3. ChunkFinder — Vite 产物识别 ===');
ok(ChunkFinder.looksLikeViteAsset('https://a.com/assets/index-6f3a2b1c.js'), 'assets/index-<hash>.js 识别为 Vite 产物');
ok(ChunkFinder.looksLikeViteAsset('https://a.com/assets/Foo.vue_vue_type-a1b2c3.js'), 'Vue SFC 产物识别');
ok(!ChunkFinder.looksLikeViteAsset('https://a.com/static/js/app.js'), '普通路径不算 Vite 产物');
ok(!ChunkFinder.looksLikeViteAsset('https://a.com/assets/index.js'), '无哈希的 assets 文件不算（避免误触发清单探测）');

/* ================================================================
 * 4. RouteFinder
 * ================================================================ */
console.log('\n=== 4. RouteFinder — SPA 路由提取 ===');

const vueRoutes = RouteFinder.extractRoutes(
    `createRouter({ routes: [ {path:'/home'}, {path:'/user/:id'}, {path:'/score/teacher'}, {path:'/live/index'} ] })`,
    'https://a.edu.cn/js/app.js');
const vuePaths = vueRoutes.map(r => r.path);
ok(vuePaths.includes('/home'), 'Vue routes 数组提取到 /home', JSON.stringify(vuePaths));
ok(vuePaths.includes('/score/teacher'), '多级路径提取正确');
ok(vueRoutes.find(r => r.path === '/user/:id') && vueRoutes.find(r => r.path === '/user/:id').isDynamic === true,
    '动态路由 /user/:id 标记为 dynamic');

const reactRoutes = RouteFinder.extractRoutes(
    `<Route path="/dashboard" element={<D/>} /><Route path="/report/list" element={<R/>} />`,
    'https://a.com/app.js');
ok(reactRoutes.some(r => r.path === '/dashboard'), 'React <Route path> 提取到');
ok(reactRoutes.some(r => r.path === '/report/list'), 'React 多级路径提取到');

const angRoutes = RouteFinder.extractRoutes(
    `const routes = [ { path: 'orders', loadChildren: () => import('./orders/orders.module').then(m => m.O) } ];`,
    'https://a.com/main.js');
ok(angRoutes.some(r => r.path === '/orders'), 'Angular loadChildren 路由提取到（无前导斜杠自动补齐）',
    JSON.stringify(angRoutes.map(r => r.path)));

const hashRoutes = RouteFinder.extractRoutes(`<a href="#/user/profile">p</a>`, 'https://a.com/i.html');
ok(hashRoutes.some(r => r.path === '/user/profile'), 'hash 路由 (#/user/profile) 提取到');

// 负向：噪声
const noise = RouteFinder.extractRoutes(
    `var a="${'/static/js/app.js'}"; var b="${'/node_modules/vue/dist/vue.js'}"; var c="${'/assets/logo.png'}";`,
    'https://a.com/app.js');
eq(noise.length, 0, '静态资源 / node_modules 路径被排除', JSON.stringify(noise.map(r => r.path)));
eq(RouteFinder.extractRoutes('', 'https://a.com/x.js').length, 0, '空源码不产出路由');
eq(RouteFinder.extractRoutes('var a=1;', 'https://a.com/x.js').length, 0, '短源码不产出路由');

/* ---------------- 路由 → URL ---------------- */
console.log('\n=== 5. RouteFinder — 路由转 URL ===');
const urls = RouteFinder.routesToUrls(vueRoutes, 'https://a.edu.cn/index.html#/home');
ok(urls.includes('https://a.edu.cn/home'), '静态路由转为绝对 URL（清掉原 hash）', JSON.stringify(urls));
ok(!urls.some(u => u.includes(':id')), '动态路由默认不进 URL 列表（缺参数会 404）');
const urlsWithDyn = RouteFinder.routesToUrls(vueRoutes, 'https://a.edu.cn/index.html#/home', { includeDynamic: true });
ok(urlsWithDyn.length > urls.length, 'includeDynamic=true 时才纳入动态路由');
const hashUrl = RouteFinder.routesToUrls([{ path: '/user/profile' }], 'https://a.com/index.html#/home');
ok(hashUrl.length === 1, '单路由产出单 URL');

const merged = RouteFinder.mergeRoutes([[{ path: '/a', isDynamic: false }], [{ path: '/a', isDynamic: false }, { path: '/b/:x', isDynamic: true }]]);
eq(merged.stats.total, 2, 'mergeRoutes 跨批次去重');
eq(merged.stats.dynamic, 1, 'mergeRoutes 统计动态路由数');

/* ================================================================
 * 6. SiteScope
 * ================================================================ */
console.log('\n=== 6. SiteScope — 站点范围判定 ===');

eq(SiteScope.baseDomain('dns2.example.edu.cn'), 'example.edu.cn', '两级后缀 .edu.cn 正确切出注册主体');
eq(SiteScope.baseDomain('www.example.com.cn'), 'example.com.cn', '.com.cn 同样处理');
eq(SiteScope.baseDomain('a.b.example.com'), 'example.com', '普通域取最后两段');
eq(SiteScope.baseDomain('127.0.0.1'), '127.0.0.1', 'IP 原样返回');
eq(SiteScope.orgName('www.meituan.com'), 'meituan', '组织名提取');
eq(SiteScope.orgName('www.api.com'), '', '通用词/过短名不作为组织名（避免误判同主体）');

// 静态目录不是路由（实测 demo.example.edu.cn 上 /skins/ 被误报为 SPA 路由）
ok(!RouteFinder.isLikelyRoute('/skins/'), '单段以 / 结尾的路径不算路由（如 /skins/）');
ok(!RouteFinder.extractRoutes("var a='/skins/';var b='/static/js/';", 'https://a.com/main.js')
    .some(r => /skins|static/.test(r.path)), '路由提取结果里不含静态资源目录');

ok(SiteScope.isSiteRelated('api.example.com', 'example.com'), '子域视为同主体');
ok(!SiteScope.isSiteRelated('a.net', 'a.com'), '过短组织名不做跨 TLD 同主体判定（避免 a.com/a.net 误合并）');
ok(SiteScope.isSiteRelated('www.meituan.net', 'meituan.com'), '同组织名跨 TLD（真实站点形态）');
ok(!SiteScope.isSiteRelated('evil.com', 'example.com'), '无关域不算同主体');
ok(!SiteScope.isSiteRelated('example.com', ''), '页面域未知时不瞎判');
ok(SiteScope.isSiteRelated('m.example.com', 'example.com', ['m.example.com']), '用户配置的自有域被承认');

eq(SiteScope.classify('https://api.example.com/x', 'example.com').scope, 'site', '站点自有接口域分类为 site');
eq(SiteScope.classify('https://cdn.jsdelivr.net/npm/vue.js', 'example.com').scope, 'cdn', '公共 CDN 分类为 cdn');
eq(SiteScope.classify('https://www.google-analytics.com/ga.js', 'example.com').scope, 'noise', '统计域分类为 noise');
eq(SiteScope.classify('https://hm.baidu.com/hm.js', 'example.com').scope, 'noise', '国内统计域同样识别');
eq(SiteScope.classify('https://partner.com/x.js', 'example.com').scope, 'thirdparty', '其余外部域分类为 thirdparty');
eq(SiteScope.classify('not a url', 'example.com').scope, 'thirdparty', '非法 URL 不抛异常，按外部域处理');

ok(SiteScope.isNoise('sentry.io'), '错误上报域识别为噪声');
ok(!SiteScope.isNoise('example.com'), '站点自己的域不是噪声');
ok(SiteScope.isCdn('cdn.bootcdn.net'), '国内 CDN 识别');
ok(!SiteScope.isCdn('example.com'), '站点自己的域不是 CDN');
ok(SiteScope.isSiteOwnedUrl('https://static.example.com/a.js', 'example.com'), '站点静态域算自有');
ok(!SiteScope.isSiteOwnedUrl('https://cdn.jsdelivr.net/a.js', 'example.com'), 'CDN 库不算自有');

// 真实目标形态（用户当前在测的 edu 站点）
eq(SiteScope.classify('http://dns2.example.edu.cn/js/app.js', 'dns2.example.edu.cn').scope, 'site',
    'edu 目标站自身 JS 分类正确');
eq(SiteScope.classify('http://other.example.edu.cn/x.js', 'dns2.example.edu.cn').scope, 'site',
    '同校其它子域视为同主体（不会当成第三方漏掉）');

console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
