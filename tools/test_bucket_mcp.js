/* JsXray — MCP 存储桶只读工具单元测试（无需浏览器）
 * 覆盖 mcp/ext_client.js 中新增的两个只读工具：
 *   - toolGetBucketRisks  (get_bucket_risks)：厂商过滤 / limit 截断 / includeReqResp / 空历史
 *   - toolGetBucketConfig (get_bucket_config)：开关透传 / 名单模式 / 默认值兜底 / 文件大小 KB 换算
 * 手法：用 vm 沙箱注入假 API.storage.local，真实执行方法体（非仅语法检查）
 * 运行：node tools/test_bucket_mcp.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'ext_client.js'), 'utf8');

/* ---------------- 假 storage.local 数据 ---------------- */
const fakeStore = {
    bucketVulHistory: [
        { id: 1, url: 'https://b.oss-cn-hangzhou.aliyuncs.com/x', type: '存储桶可遍历', vendor: '阿里云', time: Date.now(), request: 'GET / HTTP/1.1', response: 'HTTP/1.1 200 OK', source: '被动' },
        { id: 2, url: 'https://b-125.cos.ap-guangzhou.myqcloud.com/y', type: '桶接管', vendor: '腾讯云', time: Date.now() - 1000, request: '', response: '', source: '主动' }
    ],
    bucketPassiveEnabled: true, scanPageForBuckets: false, safeModePassive: true,
    flagAcl: true, flagPolicy: false, traverseBacktrack: true,
    detectBlacklist: ['*.example.com'], detectWhitelist: [], whitelistMode: false,
    scanMaxExternalJs: 80, scanMaxInlineJs: 40, scanMaxFileSize: 5 * 1024 * 1024, scanMaxTotalCandidates: 100
};

const sandbox = {
    console,
    API: {
        storage: {
            local: {
                get: async (keys) => {
                    const out = {};
                    const list = Array.isArray(keys) ? keys : [keys];
                    for (const k of list) if (k in fakeStore) out[k] = fakeStore[k];
                    return out;
                }
            }
        }
    }
};
vm.createContext(sandbox);
// 追加导出：ext_client.js 顶层 const MCPClient 不会挂到 global，这里显式引出
vm.runInContext(SRC + '\n;globalThis.__C = MCPClient;', sandbox, { filename: 'ext_client.js' });

let pass = 0, fail = 0;
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

(async () => {
    const C = sandbox.__C;

    console.log('=== get_bucket_config ===');
    const cfg = await C.toolGetBucketConfig();
    ok(cfg.switches.passiveEnabled === true, 'switches.passiveEnabled 透传');
    ok(cfg.switches.flagPolicy === false, 'switches.flagPolicy=false 透传（未被默认值覆盖）');
    ok(cfg.switches.traverseBacktrack === true, 'switches.traverseBacktrack=true 透传');
    ok(cfg.listMode === 'blacklist', 'listMode=blacklist（whitelistMode=false）');
    ok(Array.isArray(cfg.blacklist) && cfg.blacklist[0] === '*.example.com', 'blacklist 数组透传');
    ok(cfg.scanLimits.maxFileSizeKB === 5120, 'scanLimits.maxFileSizeKB=5120（5MB→KB 换算）', `实际 ${cfg.scanLimits.maxFileSizeKB}`);
    ok(cfg.scanLimits.maxExternalJs === 80, 'scanLimits.maxExternalJs=80 透传');

    console.log('=== get_bucket_config 默认值兜底（空 storage）===');
    for (const k of Object.keys(fakeStore)) delete fakeStore[k];
    const def = await C.toolGetBucketConfig();
    ok(def.switches.passiveEnabled === true && def.switches.safeMode === true, '默认 passive/safeMode=true');
    ok(def.switches.scanPage === false && def.switches.traverseBacktrack === false, '默认 scanPage/traverse=false');
    ok(def.listMode === 'blacklist' && def.blacklist.length === 0, '默认 blacklist 模式 + 空名单');
    ok(def.scanLimits.maxFileSizeKB === 1024 && def.scanLimits.maxExternalJs === 40, '默认 maxFileSizeKB=1024 / maxExternalJs=40');

    // 恢复历史数据
    fakeStore.bucketVulHistory = [
        { id: 1, url: 'https://b.oss-cn-hangzhou.aliyuncs.com/x', type: '存储桶可遍历', vendor: '阿里云', time: Date.now(), request: 'GET / HTTP/1.1', response: 'HTTP/1.1 200 OK', source: '被动' },
        { id: 2, url: 'https://b-125.cos.ap-guangzhou.myqcloud.com/y', type: '桶接管', vendor: '腾讯云', time: Date.now() - 1000, request: '', response: '', source: '主动' }
    ];

    console.log('=== get_bucket_risks ===');
    const r0 = await C.toolGetBucketRisks({});
    ok(r0.count === 2 && r0.returned === 2, '默认返回全部 2 条');
    ok(r0.includeReqResp === false && r0.risks[0].request === undefined, '默认不含 request/response 原文');
    ok(typeof r0.risks[0].timeText === 'string' && r0.risks[0].timeText.length > 0, 'timeText 已格式化', r0.risks[0].timeText);
    ok(r0.risks[0].url && r0.risks[0].type && r0.risks[0].vendor, 'risks 条目含 url/type/vendor');

    const r1 = await C.toolGetBucketRisks({ vendor: '腾讯' });
    ok(r1.count === 1 && r1.risks[0].vendor === '腾讯云', '按厂商过滤=腾讯云（1 条）');

    const r2 = await C.toolGetBucketRisks({ includeReqResp: true });
    ok(r2.risks[0].request === 'GET / HTTP/1.1' && r2.risks[0].response === 'HTTP/1.1 200 OK', 'includeReqResp=true 附带 Burp 原文');

    const r3 = await C.toolGetBucketRisks({ limit: 1 });
    ok(r3.count === 2 && r3.returned === 1 && /limit/.test(r3.note || ''), 'limit=1 截断 + note 提示');

    console.log('=== get_bucket_risks 空历史 ===');
    fakeStore.bucketVulHistory = [];
    const r4 = await C.toolGetBucketRisks({});
    ok(r4.count === 0 && r4.risks.length === 0 && !!r4.note, '空历史返回 count=0 + note 引导');

    console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('验证异常:', e); process.exit(1); });
