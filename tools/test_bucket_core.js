/* JsXray — 存储桶检测核心 bundle 冒烟测试
 * 在 vm 沙箱里加载 lib/bucket/bucket_core.js，校验：
 *   1. self.BucketVendors 注册了 10 个厂商 check 函数；
 *   2. self.BucketDetect 暴露 4 个分发函数；
 *   3. detectVendor 域名判定正确；
 *   4. detectBucketVul 能按 vendors 分发（用桩 fetch，不发真实请求）。
 * 用法：node tools/test_bucket_core.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BUNDLE = path.resolve(__dirname, '..', 'lib', 'bucket', 'bucket_core.js');
const code = fs.readFileSync(BUNDLE, 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; console.log('  ✓ ' + msg); }
    else { fail++; console.error('  ✗ ' + msg); }
}

// 构造沙箱：self 指向全局；fetch/URL/URLSearchParams 提供桩实现
const calls = [];
const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextDecoder,
    fetch: async (url, opts) => {
        calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
        // 返回一个「桶不存在」的响应，避免命中任何漏洞分支
        return {
            status: 404,
            statusText: 'Not Found',
            url: String(url),
            headers: { get: () => null, entries: () => [][Symbol.iterator]() },
            text: async () => '<Error><Code>NoSuchBucket</Code></Error>'
        };
    }
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'bucket_core.js' });

console.log('[1] 厂商注册表');
const vendors = ['checkAliyun', 'checkTencent', 'checkHuawei', 'checkAWS', 'checkQiniu',
    'checkQingCloud', 'checkUpyun', 'checkJDCloud', 'checkKingsoft', 'checkCTYun'];
vendors.forEach(v => ok(typeof sandbox.BucketVendors[v] === 'function', 'BucketVendors.' + v + ' 是函数'));

console.log('[2] 分发入口');
['detectBucketVul', 'detectVendor', 'detectVendorByServerHeader', 'detectVendorByServer']
    .forEach(f => ok(typeof sandbox.BucketDetect[f] === 'function', 'BucketDetect.' + f + ' 是函数'));

console.log('[3] detectVendor 域名判定');
const cases = [
    ['https://b.oss-cn-hangzhou.aliyuncs.com/x', '阿里云'],
    ['https://b-1250000000.cos.ap-guangzhou.myqcloud.com/x', '腾讯云'],
    ['https://b.obs.cn-north-4.myhuaweicloud.com/x', '华为云'],
    ['https://b.s3.amazonaws.com/x', 'AmazonS3'],
    ['https://cdn.example.qiniucs.com/x', '七牛云'],
    ['https://b.qingstor.com/x', '青云'],
    ['https://b.upaiyun.com/x', '又拍云'],
    ['https://b.jcloudcs.com/x', '京东云'],
    ['https://b.ksyuncs.com/x', '金山云'],
    ['https://oos-cn.ctyunapi.cn/x', '天翼云'],
    ['https://example.com/x', '未知']
];
cases.forEach(([u, want]) => ok(sandbox.BucketDetect.detectVendor(u) === want, `${u} → ${want}`));

console.log('[4] detectBucketVul 按 vendors 分发（桩 fetch）');
(async () => {
    calls.length = 0;
    const res = await sandbox.BucketDetect.detectBucketVul('https://b.oss-cn-hangzhou.aliyuncs.com/x', {
        vendors: ['aliyun'], checkAcl: true, checkPolicy: true, safeMode: true, traverseBacktrack: false
    });
    ok(Array.isArray(res), '返回数组');
    ok(calls.length > 0, '触发了 fetch 请求（' + calls.length + ' 次）');
    ok(calls.every(c => /aliyuncs\.com/.test(c.url)), '所有请求都指向阿里云域名（未串厂商）');

    console.log('[5] enabledTypes 漏洞类型门控（桩 fetch）');
    const TARGET = 'https://b.oss-cn-hangzhou.aliyuncs.com/x';
    calls.length = 0;
    await sandbox.BucketDetect.detectBucketVul(TARGET, {
        vendors: ['aliyun'], checkAcl: true, checkPolicy: true, safeMode: false, traverseBacktrack: false,
        enabledTypes: ['ACL可读']
    });
    ok(calls.length === 1 && calls[0].method === 'GET' && /\?acl$/.test(calls[0].url),
        '仅勾选 ACL可读 → 只发 1 次 GET ?acl（实际 ' + calls.length + ' 次）');

    calls.length = 0;
    await sandbox.BucketDetect.detectBucketVul(TARGET, {
        vendors: ['aliyun'], checkAcl: true, checkPolicy: true, safeMode: false, traverseBacktrack: false,
        enabledTypes: ['桶接管']
    });
    ok(calls.length === 1 && calls[0].method === 'GET' && new URL(calls[0].url).pathname === '/' && !calls[0].url.includes('?'),
        '仅勾选 桶接管 → 只发 1 次根路径 GET（实际 ' + calls.length + ' 次）');

    calls.length = 0;
    await sandbox.BucketDetect.detectBucketVul(TARGET, {
        vendors: ['aliyun'], checkAcl: true, checkPolicy: true, safeMode: false, traverseBacktrack: false,
        enabledTypes: ['PUT文件上传']
    });
    ok(calls.some(c => c.method === 'PUT' && c.url.includes('bt_test_')), '勾选 PUT文件上传 → 发出 PUT 上传探测');
    ok(!calls.some(c => c.url.includes('?acl') || c.url.includes('?policy')), '未勾选 ACL/Policy → 不发任何 ?acl/?policy 请求');

    calls.length = 0;
    await sandbox.BucketDetect.detectBucketVul(TARGET, {
        vendors: ['aliyun'], checkAcl: true, checkPolicy: true, safeMode: false, traverseBacktrack: false
    });
    ok(calls.some(c => c.method === 'PUT' && c.url.includes('?policy')), '未传 enabledTypes → 保持全量检测（含 PUT ?policy，向后兼容）');

    console.log(`\n结果：${pass} 通过, ${fail} 失败`);
    process.exit(fail ? 1 : 0);
})();
