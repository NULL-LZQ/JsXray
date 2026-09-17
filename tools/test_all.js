/* JsXray — 一键跑全部离线测试与校验
 * 运行：node tools/test_all.js
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const scripts = [
    ['manifest / hooks / popup 一致性校验', 'validate.js'],
    ['下载引擎 · 资源索引 · 记录器 单测', 'test_download_lib.js'],
    ['直写本地目录引擎 单测（假目录树）', 'test_fsdl.js'],
    ['background + MCP 工具层 冒烟测试', 'test_bg_smoke.js'],
    ['MCP 桥接 端到端测试（stdio ↔ WS ↔ 扩展）', 'test_mcp_bridge.js'],
    ['chunk 合成 · 路由提取 · 站点范围 单测', 'test_chunk_finder.js'],
    ['Hook 激活与探针隔离（vm 真跑 hooks/*.js）', 'test_hooks_activation.js'],
    ['Vue 路由对抗（清守卫/清跳转）', 'test_vue_clear.js'],
    ['云存储桶检测引擎（10 厂商）', 'test_bucket_core.js'],
    ['云存储桶 MCP 只读工具', 'test_bucket_mcp.js'],
    ['扫描过滤与指纹版本回归', 'test_scan_filters.js'],
    ['扫描规则回归', 'test_rules.js'],
    ['扫描 API 过滤回归', 'test_api_fixes.js'],
    ['Storage Hook 递归回归', 'test_storage_hook_recursion.js']
];

let failed = 0;
for (const [label, file] of scripts) {
    console.log(`\n──────── ${label} (${file}) ────────`);
    const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
    if (r.status !== 0) { failed++; console.error(`✗ ${file} 失败（exit ${r.status}）`); }
}
console.log(`\n════════ 共 ${scripts.length} 个测试脚本，失败 ${failed} 个 ════════`);
process.exit(failed ? 1 : 0);
