/* =====================================================================
 * JsXray — lib/zip.js
 * 纯 JS ZIP 打包器（store 模式，无压缩、零依赖）
 *
 * 用途：把「当前网站全部 JS 源码」打成单个 zip 交付给人工/AI 分析。
 * 说明：
 *   - MV3 Service Worker 中无法稳定使用 URL.createObjectURL，
 *     因此压缩结果统一通过 base64 data URL 交给 chrome.downloads。
 *   - store 模式（method=0）体积≈原始大小，但无需引入 deflate 依赖，
 *     对小体积源码包（<30MB）完全够用。
 * ===================================================================== */

'use strict';

const HappyZip = (() => {
    /* ---------- CRC32 ---------- */
    const TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(u8) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < u8.length; i++) c = TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function concat(list) {
        let total = 0;
        for (const b of list) total += b.length;
        const out = new Uint8Array(total);
        let off = 0;
        for (const b of list) { out.set(b, off); off += b.length; }
        return out;
    }

    function dosDateTime(d) {
        const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
        const date = ((((d.getFullYear() - 1980) & 0x7F) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
        return { time, date };
    }

    /**
     * 打包为 zip 字节流
     * @param {Array<{name:string, data:(Uint8Array|string)}>} files
     * @param {{compression?:boolean}} [opts]
     * @returns {Uint8Array}
     */
    function build(files, opts) {
        const encoder = new TextEncoder();
        const { time, date } = dosDateTime(new Date());
        const localParts = [];
        const centralParts = [];
        let offset = 0;
        let count = 0;

        for (const f of files || []) {
            if (!f || !f.name) continue;
            const nameBytes = encoder.encode(String(f.name).replace(/\\/g, '/'));
            const data = (f.data instanceof Uint8Array)
                ? f.data
                : encoder.encode(f.data == null ? '' : String(f.data));
            const crc = crc32(data);

            const lh = new Uint8Array(30 + nameBytes.length);
            const lv = new DataView(lh.buffer);
            lv.setUint32(0, 0x04034b50, true);
            lv.setUint16(4, 20, true);        // version needed
            lv.setUint16(6, 0x0800, true);    // general purpose flags: UTF-8 名
            lv.setUint16(8, 0, true);         // method: store
            lv.setUint16(10, time, true);
            lv.setUint16(12, date, true);
            lv.setUint32(14, crc, true);
            lv.setUint32(18, data.length, true);
            lv.setUint32(22, data.length, true);
            lv.setUint16(26, nameBytes.length, true);
            lv.setUint16(28, 0, true);
            lh.set(nameBytes, 30);

            const ch = new Uint8Array(46 + nameBytes.length);
            const cv = new DataView(ch.buffer);
            cv.setUint32(0, 0x02014b50, true);
            cv.setUint16(4, 20, true);
            cv.setUint16(6, 20, true);
            cv.setUint16(8, 0x0800, true);
            cv.setUint16(10, 0, true);
            cv.setUint16(12, time, true);
            cv.setUint16(14, date, true);
            cv.setUint32(16, crc, true);
            cv.setUint32(20, data.length, true);
            cv.setUint32(24, data.length, true);
            cv.setUint16(28, nameBytes.length, true);
            cv.setUint32(42, offset, true);
            ch.set(nameBytes, 46);

            localParts.push(lh, data);
            centralParts.push(ch);
            offset += lh.length + data.length;
            count++;
        }

        const centralSize = centralParts.reduce((a, c) => a + c.length, 0);
        const eocd = new Uint8Array(22);
        const ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(8, count, true);
        ev.setUint16(10, count, true);
        ev.setUint32(12, centralSize, true);
        ev.setUint32(16, offset, true);

        return concat(localParts.concat(centralParts, [eocd]));
    }

    /* ---------- base64（分块，避免超长参数） ---------- */
    function toBase64(u8) {
        const CH = 0x8000;
        let bin = '';
        for (let i = 0; i < u8.length; i += CH) {
            bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        }
        return btoa(bin);
    }

    return { build, crc32, toBase64 };
})();
