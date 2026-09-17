/* JsXray — MCP 桥接服务端到端测试（无需浏览器）
 * 覆盖：
 *   1. stdio MCP 握手（initialize / tools/list）
 *   2. 扩展未连接时 tools/call 的错误提示
 *   3. 模拟扩展接入后 tools/call 全链路（stdio → 桥 → WS → 扩展 → 回传）
 *   4. 错误令牌连接被拒
 *   5. 中继模式：第二个进程自动降级为中继并转发调用
 * 运行：node tools/test_mcp_bridge.js   （需 Node ≥ 22，内置 WebSocket）
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const PORT = 16001;
const TOKEN = 'test-token-123';
const SERVER = path.join(__dirname, '..', 'mcp', 'server.js');

let passed = 0, failed = 0;
function ok(cond, name, extra) {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- 启动一个桥接进程，封装 stdio JSON-RPC ---------- */
function startBridge(port) {
    const proc = spawn(process.execPath, [SERVER, '--port', String(port), '--token', TOKEN], {
        stdio: ['pipe', 'pipe', 'pipe']
    });
    proc.stderr.on('data', d => process.stderr.write(`    [bridge:${port}] ${d}`));
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
        proc,
        call(method, params, timeoutMs = 8000) {
            const id = ++seq;
            return new Promise((resolve, reject) => {
                waiters.set(id, resolve);
                setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error('stdio 响应超时: ' + method)); } }, timeoutMs);
                proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
            });
        },
        notify(method) { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); },
        kill() { try { proc.kill(); } catch {} }
    };
}

/* ---------- 模拟扩展（WebSocket 客户端） ---------- */
function fakeExtension(port, token) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const state = { ws, calls: [] };
        ws.onopen = () => ws.send(JSON.stringify({ role: 'extension', token, version: 'test' }));
        ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.type === 'hello') {
                if (msg.ok) resolve(state); else reject(new Error('扩展握手被拒'));
                return;
            }
            if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); return; }
            if (msg.type === 'call') {
                state.calls.push(msg);
                // 模拟 list_tabs 固定应答；其余工具回显
                const result = msg.tool === 'list_tabs'
                    ? { count: 1, tabs: [{ id: 7, active: true, title: '测试页', url: 'https://example.com/' }] }
                    : { echo: msg.tool, args: msg.args };
                ws.send(JSON.stringify({ id: msg.id, type: 'result', result }));
            }
        };
        ws.onerror = () => reject(new Error('扩展 WS 连接失败'));
    });
}

(async () => {
    console.log('=== 测试 1：桥启动 + MCP 握手 ===');
    const bridge = startBridge(PORT);
    await sleep(600);
    const init = await bridge.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    ok(init.result && init.result.serverInfo && init.result.serverInfo.name === 'happy-js', 'initialize 返回 serverInfo');
    bridge.notify('notifications/initialized');
    const list = await bridge.call('tools/list');
    const names = (list.result.tools || []).map(t => t.name);
    ok(names.length === 32, 'tools/list 返回 32 个工具', `实际 ${names.length}`);
    ok(['execute_js', 'get_scan_results', 'enable_hook', 'fetch_js'].every(n => names.includes(n)), '核心工具齐全');
    ok(['get_js_list', 'search_in_js', 'download_js', 'get_network_requests', 'get_console_logs', 'query_dom', 'beautify_js', 'get_storage', 'get_frame_tree', 'screenshot']
        .every(n => names.includes(n)), '新增工具齐全（JS 清单/检索/下载/网络/控制台/DOM）');
    ok(['list_sourcemaps', 'resolve_sourcemap', 'run_auth_bypass', 'get_info_leakage']
        .every(n => names.includes(n)), 'v1.5.0 借鉴工具齐全（SourceMap / 认证扫描 / 信息泄露）');
    ok(['get_bucket_risks', 'get_bucket_config'].every(n => names.includes(n)), '云存储桶只读工具齐全');
    ok(['predict_js_chunks', 'get_js_coverage', 'get_dynamic_code'].every(n => names.includes(n)),
        '预测补齐 / 覆盖对账 / 动态代码工具齐全');
    const abTool = (list.result.tools || []).find(t => t.name === 'run_auth_bypass');
    ok(abTool && abTool.inputSchema.properties.dryRun, 'run_auth_bypass 支持 dryRun 预览');
    const dlTool = (list.result.tools || []).find(t => t.name === 'download_js');
    ok(dlTool && /ZIP|zip/.test(dlTool.description) && dlTool.inputSchema.properties.format, 'download_js 提供了 format 选项说明');

    console.log('=== 测试 1b：参数校验与未知工具 ===');
    const bad1 = await bridge.call('tools/call', { name: 'fetch_js', arguments: {} });
    ok(bad1.result && bad1.result.isError === true && /参数缺失/.test(bad1.result.content[0].text),
        '缺少必填参数时返回明确提示', bad1.result && bad1.result.content[0].text);
    const bad2 = await bridge.call('tools/call', { name: 'no_such_tool', arguments: {} });
    ok(bad2.result && bad2.result.isError === true && /未知工具/.test(bad2.result.content[0].text), '未知工具被拒绝');

    console.log('=== 测试 2：扩展未连接时的错误提示 ===');
    const r1 = await bridge.call('tools/call', { name: 'list_tabs', arguments: {} });
    ok(r1.result && r1.result.isError === true && /扩展未连接/.test(r1.result.content[0].text), '返回“扩展未连接”引导');

    console.log('=== 测试 3：模拟扩展接入，tools/call 全链路 ===');
    const ext = await fakeExtension(PORT, TOKEN);
    await sleep(200);
    const r2 = await bridge.call('tools/call', { name: 'list_tabs', arguments: {} });
    const text2 = r2.result && r2.result.content && r2.result.content[0] && r2.result.content[0].text || '';
    ok(!r2.result.isError && text2.includes('example.com'), 'list_tabs 经扩展应答并回传', text2.slice(0, 120));
    const r3 = await bridge.call('tools/call', { name: 'execute_js', arguments: { code: '1+1' } });
    const text3 = r3.result.content[0].text;
    ok(text3.includes('"echo": "execute_js"') && text3.includes('1+1'), '工具参数正确透传到扩展');
    ok(ext.calls.some(c => c.tool === 'execute_js' && c.args.code === '1+1'), '扩展侧收到 call 帧');

    console.log('=== 测试 4：错误令牌被拒 ===');
    const bad = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        ws.onopen = () => ws.send(JSON.stringify({ role: 'extension', token: 'wrong-token' }));
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'hello') { resolve(msg.ok === false); ws.close(); }
        };
        ws.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 3000);
    });
    ok(bad, '桥拒绝令牌不匹配的连接');

    console.log('=== 测试 5：中继模式（第二实例转发） ===');
    const relay = startBridge(PORT);   // 同端口 → 自动降级为中继
    await sleep(800);
    const rinit = await relay.call('initialize', {});
    ok(rinit.result && rinit.result.serverInfo.name === 'happy-js', '中继实例 MCP 握手正常');
    const r4 = await relay.call('tools/call', { name: 'list_tabs', arguments: {} });
    const text4 = r4.result && r4.result.content && r4.result.content[0] && r4.result.content[0].text || '';
    ok(!r4.result.isError && text4.includes('example.com'), '中继 → 桥 → 扩展 链路回传成功', text4.slice(0, 120));

    relay.kill();
    bridge.kill();
    await sleep(200);
    console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
