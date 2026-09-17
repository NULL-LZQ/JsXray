#!/usr/bin/env node
/* =====================================================================
 * JsXray — tools/mcp_relay.js
 * 以「中继(relay)」身份直连**正在运行**的桥接进程，用来：
 *   1) 读出桥接进程自己的版本号（= mcp/server.js 的 VERSION）
 *   2) 直接调用任意工具（绕过 AI 客户端里可能过期的工具索引）
 *
 * 为什么需要它：
 *   MCP 客户端在**启动桥接进程时**固定工具清单，之后再改 mcp/server.js，
 *   即使重启会话，若客户端把工具定义缓存住（或会话内的索引不刷新），
 *   AI 侧看到的仍是旧工具集。此时只能绕过客户端、直接问桥接进程。
 *
 * 用法：
 *   node tools/mcp_relay.js --port 10086 --token <令牌> --version
 *   node tools/mcp_relay.js --port 10086 --token <令牌> get_js_list '{"tabId":123}'
 *   node tools/mcp_relay.js --port 10086 --token <令牌> get_dynamic_code '{"limit":5}'
 *
 * 说明：relay 是 server.js 内置的合法角色（只转发调用、不影响扩展连接），
 *       接上后读完结果即断开，不留副作用。
 * ===================================================================== */
'use strict';
const net = require('net');
const crypto = require('crypto');

function parseArgs(argv) {
    const out = { port: 10086, token: '', host: '127.0.0.1', timeout: 30000, tool: null, args: {}, versionOnly: false };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--port') out.port = parseInt(argv[++i], 10) || out.port;
        else if (a === '--token') out.token = argv[++i] || '';
        else if (a === '--host') out.host = argv[++i] || out.host;
        else if (a === '--timeout') out.timeout = parseInt(argv[++i], 10) || out.timeout;
        else if (a === '--version') out.versionOnly = true;
        else rest.push(a);
    }
    out.tool = rest[0] || null;
    if (rest[1]) {
        try { out.args = JSON.parse(rest[1]); }
        catch (e) { throw new Error('参数不是合法 JSON：' + rest[1]); }
    }
    return out;
}

/* ---------------- 极简 WebSocket 客户端（客户端帧必须加掩码） ---------------- */
function encodeFrame(str) {
    const payload = Buffer.from(str, 'utf8');
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(6);
        header[0] = 0x81; header[1] = 0x80 | len;
        mask.copy(header, 2);
    } else if (len < 65536) {
        header = Buffer.alloc(8);
        header[0] = 0x81; header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
        mask.copy(header, 4);
    } else {
        header = Buffer.alloc(14);
        header[0] = 0x81; header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
        mask.copy(header, 10);
    }
    const body = Buffer.alloc(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, body]);
}

/** 帧解析器：累积字节流，逐个吐出完整文本帧（服务器→客户端不加掩码） */
function makeFrameParser(onText, onPing) {
    let buf = Buffer.alloc(0);
    return (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
            if (buf.length < 2) return;
            const opcode = buf[0] & 0x0f;
            const masked = (buf[1] & 0x80) !== 0;
            let len = buf[1] & 0x7f;
            let off = 2;
            if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
            let maskKey = null;
            if (masked) { if (buf.length < off + 4) return; maskKey = buf.slice(off, off + 4); off += 4; }
            if (buf.length < off + len) return;
            let payload = buf.slice(off, off + len);
            if (maskKey) {
                const cp = Buffer.from(payload);
                for (let i = 0; i < cp.length; i++) cp[i] ^= maskKey[i & 3];
                payload = cp;
            }
            buf = buf.slice(off + len);
            if (opcode === 0x1) onText(payload.toString('utf8'));
            else if (opcode === 0x9) onPing && onPing(payload);
            // 0x8 close / 0xa pong：忽略
        }
    };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------- 主流程 ------------------------------- */
function connect(cfg) {
    return new Promise((resolve, reject) => {
        const key = crypto.randomBytes(16).toString('base64');
        let handshakeDone = false;
        let handshakeBuf = Buffer.alloc(0);
        const sock = net.connect(cfg.port, cfg.host);
        const api = { sock, send: (o) => sock.write(encodeFrame(JSON.stringify(o))) };

        sock.setTimeout(cfg.timeout, () => reject(new Error('连接/响应超时')));
        sock.on('error', reject);
        sock.on('connect', () => {
            sock.write(
                'GET / HTTP/1.1\r\n' +
                `Host: ${cfg.host}:${cfg.port}\r\n` +
                'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
            );
        });
        sock.on('data', (chunk) => {
            if (!handshakeDone) {
                handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
                const idx = handshakeBuf.indexOf('\r\n\r\n');
                if (idx < 0) return;
                const head = handshakeBuf.slice(0, idx).toString('latin1');
                if (!/^HTTP\/1\.1 101/.test(head)) return reject(new Error('握手失败：' + head.split('\r\n')[0]));
                handshakeDone = true;
                const rest = handshakeBuf.slice(idx + 4);
                api.parse = makeFrameParser((t) => api.onText && api.onText(t), (p) => sock.write(encodeFrame('')) /* ping 忽略 */);
                if (rest.length) api.parse(rest);
                resolve(api);
                return;
            }
            api.parse(chunk);
        });
    });
}

(async () => {
    const cfg = parseArgs(process.argv.slice(2));
    const conn = await connect(cfg);

    let hello = null;
    const helloP = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 5000);
        conn.onText = (t) => {
            let m; try { m = JSON.parse(t); } catch { return; }
            if (m.type === 'hello' && !hello) { clearTimeout(timer); hello = m; resolve(m); }
        };
    });
    conn.send({ role: 'relay', token: cfg.token });

    const h = await helloP;
    if (!h) { console.error('未收到 hello（令牌可能不匹配）'); process.exit(2); }
    if (h.ok === false) { console.error('桥接拒绝连接：', h.error); process.exit(3); }

    console.log(`桥接进程版本: v${h.version}`);

    if (cfg.versionOnly || !cfg.tool) { conn.sock.end(); return; }

    const id = 1;
    const resP = new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ __timeout: true }), cfg.timeout);
        conn.onText = (t) => {
            let m; try { m = JSON.parse(t); } catch { return; }
            if (m.id !== id) return;
            clearTimeout(timer);
            resolve(m);
        };
    });
    conn.send({ id, type: 'call', tool: cfg.tool, args: cfg.args });
    const res = await resP;
    if (res.__timeout) { console.error('调用超时'); process.exit(4); }
    if (res.type === 'error') { console.error('调用失败：', res.error); process.exit(5); }

    const out = res.result;
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
    conn.sock.end();
})().catch(e => { console.error('异常：', e.message); process.exit(1); });
