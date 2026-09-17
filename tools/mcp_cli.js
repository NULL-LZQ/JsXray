#!/usr/bin/env node
/* =====================================================================
 * JsXray — tools/mcp_cli.js
 * 命令行直调 MCP 工具（无需 AI 客户端）：本进程自己拉起 mcp/server.js，
 * 等浏览器扩展连入后，用 stdio JSON-RPC 调用任意工具并打印结果。
 *
 * 用法：
 *   node tools/mcp_cli.js [--port 10087] [--token <令牌>] [--accept-any-token]
 *                         [--wait 20] [--tab <id>] <工具名> ['<JSON 参数>']
 *
 * 示例：
 *   node tools/mcp_cli.js --accept-any-token --wait 20 list_tabs
 *   node tools/mcp_cli.js --accept-any-token get_js_list '{"includeThirdParty":false}'
 *   node tools/mcp_cli.js --accept-any-token download_js '{"format":"zip","dir":"happyjs-js"}'
 *
 * 说明：--accept-any-token 为排障模式（桥接会跳过令牌校验并回显扩展令牌），
 *       用于「扩展令牌与配置不一致」时临时取回控制权；正常使用请配 --token。
 * ===================================================================== */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'mcp', 'server.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
    const out = { port: 10087, token: '', anyToken: false, wait: 20, tab: null, tool: null, args: {} };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--port') out.port = parseInt(argv[++i], 10) || out.port;
        else if (a === '--token') out.token = argv[++i] || '';
        else if (a === '--accept-any-token') out.anyToken = true;
        else if (a === '--wait') out.wait = Math.max(0, parseInt(argv[++i], 10) || 0);
        else if (a === '--tab') out.tab = parseInt(argv[++i], 10);
        else rest.push(a);
    }
    out.tool = rest[0] || 'list_tabs';
    if (rest[1]) { try { out.args = JSON.parse(rest[1]); } catch (e) { throw new Error('参数不是合法 JSON: ' + rest[1]); } }
    if (out.tab != null && out.args.tabId == null) out.args.tabId = out.tab;
    return out;
}

function startBridge(cfg) {
    const argv = [SERVER, '--port', String(cfg.port)];
    if (cfg.anyToken) argv.push('--accept-any-token');
    if (cfg.token) argv.push('--token', cfg.token);
    const proc = spawn(process.execPath, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    const logs = [];
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', d => { logs.push(String(d)); process.stderr.write('  [bridge] ' + d); });

    let buf = '';
    const waiters = new Map();
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id !== undefined && waiters.has(msg.id)) {
                waiters.get(msg.id)(msg);
                waiters.delete(msg.id);
            }
        }
    });
    let seq = 0;
    return {
        proc, logs,
        call(method, params, timeoutMs = 60000) {
            const id = ++seq;
            return new Promise((resolve, reject) => {
                waiters.set(id, resolve);
                setTimeout(() => {
                    if (waiters.has(id)) { waiters.delete(id); reject(new Error(`超时 ${timeoutMs}ms: ${method}`)); }
                }, timeoutMs);
                proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
            });
        },
        kill() { try { proc.kill(); } catch {} }
    };
}

async function callTool(bridge, name, args, timeoutMs = 120000) {
    const r = await bridge.call('tools/call', { name, arguments: args || {} }, timeoutMs);
    const c = r && r.result && r.result.content && r.result.content[0];
    const text = (c && c.text) || JSON.stringify(r);
    const isError = !!(r && r.result && r.result.isError);
    return { isError, text };
}

(async () => {
    const cfg = parseArgs(process.argv.slice(2));
    const bridge = startBridge(cfg);
    const stop = () => bridge.kill();
    process.on('exit', stop);

    // 1) 等待扩展连入（轮询 list_tabs 判断是否已有扩展应答）
    const deadline = Date.now() + cfg.wait * 1000;
    let connected = false, lastErr = '';
    while (Date.now() < deadline) {
        try {
            const r = await callTool(bridge, 'list_tabs', {}, 8000);
            if (!r.isError) { connected = true; break; }
            lastErr = r.text;
        } catch (e) { lastErr = String(e.message || e); }
        await sleep(1500);
    }
    if (!connected) {
        console.log('\n✗ 扩展未连接到本次桥接（等待 ' + cfg.wait + 's）');
        console.log('  最后一次响应：' + String(lastErr).slice(0, 200));
        console.log('  请确认：① 扩展已重载；② 设置页「启用 MCP 服务」已打开；③ 端口与令牌与本次一致（本次端口 ' + cfg.port + '）');
        bridge.kill();
        process.exit(2);
    }
    console.log(`✓ 扩展已连接（端口 ${cfg.port}）`);

    // 2) 调用目标工具
    const r = await callTool(bridge, cfg.tool, cfg.args, 180000);
    console.log(`\n=== ${cfg.tool} ${r.isError ? '(错误)' : ''} ===`);
    console.log(r.text);
    bridge.kill();
    process.exit(r.isError ? 1 : 0);
})().catch(e => { console.error('执行失败:', e.message); process.exit(1); });
