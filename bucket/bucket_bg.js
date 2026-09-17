/* =====================================================================
 * JsXray — 云存储桶风险监测后台模块（BucketSentinel）
 * 融合自：谛听鉴-云存储桶风险监测 V1.1.0（By 狐狸）+ BucketTool
 *
 * 职责：
 *   - 被动检测：webRequest.onCompleted 命中云存储域名时节流触发漏洞探测
 *   - 主动检测：右键菜单 / popup 按钮打开日志窗口，流式输出检测过程
 *   - 页面扫描：接收 content_scan.js 上报的候选 URL 并检测（含"域名命中"）
 *   - 黑白名单：增删清空合并 + 通配符互斥冲突检测
 *
 * 设计要点：
 *   - 整体包进 IIFE，内部 const 不泄漏到 worker 全局，避免与 background.js
 *     的 API / HeimdallrModule 等顶层声明冲突；仅暴露 self.BucketSentinel。
 *   - 检测引擎来自 lib/bucket/bucket_core.js（self.BucketDetect）。
 *   - 不修改 action 徽章（JsXray 徽章已用于扫描分类计数），风险数在 popup 展示。
 *   - 消息由 background.js 主 onMessage 委派到 handle()，避免双 sendResponse。
 * ===================================================================== */

(function () {
    'use strict';

    const API = (typeof browser !== 'undefined') ? browser : chrome;

    /* ====================== 工具函数（移植自谛听鉴） ====================== */
    function getHostFromUrl(url) {
        try { return new URL(url).host; } catch { return url; }
    }

    function splitHostPort(host) {
        const s = String(host || '').toLowerCase();
        if (!s) return { host: '', port: '' };
        if (s.startsWith('[')) {
            const idx = s.indexOf(']');
            if (idx > 0) {
                const hostPart = s.slice(0, idx + 1);
                const rest = s.slice(idx + 1);
                if (rest.startsWith(':') && /^:\d+$/.test(rest)) return { host: hostPart, port: rest.slice(1) };
                return { host: hostPart, port: '' };
            }
        }
        const lastColon = s.lastIndexOf(':');
        if (lastColon > -1) {
            const portPart = s.slice(lastColon + 1);
            if (/^\d+$/.test(portPart)) return { host: s.slice(0, lastColon), port: portPart };
        }
        return { host: s, port: '' };
    }

    function matchBlacklistHost(host, list) {
        if (!Array.isArray(list)) return false;
        const h = String(host || '').toLowerCase();
        const hp = splitHostPort(h);
        return list.some(item => {
            const e = String(item || '').trim().toLowerCase();
            if (!e) return false;
            if (e.startsWith('*.')) {
                const apex = e.slice(2);
                return hp.host === apex || hp.host.endsWith(e.slice(1));
            }
            const ep = splitHostPort(e);
            if (ep.port) return h === e;
            return hp.host === e || hp.host.endsWith('.' + e);
        });
    }

    function matchWhitelistHost(host, list) {
        if (!Array.isArray(list) || list.length === 0) return false;
        return matchBlacklistHost(host, list);
    }

    function normalizePattern(str) { return String(str || '').trim().toLowerCase(); }

    function getPatternCoreHost(pattern) {
        const p = normalizePattern(pattern);
        if (!p) return '';
        if (p.startsWith('*.')) return p.slice(2);
        return splitHostPort(p).host;
    }

    function patternOverlaps(a, b) {
        const pa = normalizePattern(a);
        const pb = normalizePattern(b);
        if (!pa || !pb) return false;
        if (pa === pb) return true;
        const aStartsWildcard = pa.startsWith('*.');
        const bStartsWildcard = pb.startsWith('*.');
        const aParts = splitHostPort(aStartsWildcard ? pa.slice(2) : pa);
        const bParts = splitHostPort(bStartsWildcard ? pb.slice(2) : pb);
        const aHasPort = !aStartsWildcard && !!aParts.port;
        const bHasPort = !bStartsWildcard && !!bParts.port;
        if (aHasPort || bHasPort) {
            if (aHasPort && bHasPort) return pa === pb;
            const hostOnly = aHasPort ? aParts.host : bParts.host;
            const otherPattern = aHasPort ? pb : pa;
            return matchBlacklistHost(hostOnly, [otherPattern]);
        }
        const hostA = getPatternCoreHost(pa);
        const hostB = getPatternCoreHost(pb);
        if (!hostA || !hostB) return false;
        return matchBlacklistHost(hostA, [pb]) || matchBlacklistHost(hostB, [pa]);
    }

    function findConflicts(entry, otherList) {
        const conflicts = [];
        const v = normalizePattern(entry);
        if (!v) return conflicts;
        for (const it of (otherList || [])) {
            if (patternOverlaps(v, it)) conflicts.push(it);
        }
        return conflicts;
    }

    function getSourcePageUrlFromDetails(details) {
        const candidate = details && (details.documentUrl || details.initiator);
        return typeof candidate === 'string' ? candidate : '';
    }
    function getSourceSiteFromDetails(details) {
        const u = getSourcePageUrlFromDetails(details);
        if (!u) return '';
        return getHostFromUrl(u);
    }

    function vendorLabel(v) {
        return v === 'aliyun' ? '阿里云'
            : v === 'tencent' ? '腾讯云'
                : v === 'huawei' ? '华为云'
                    : (v === 'aws' || v === 'amazon' || v === 'amazons3' || v === 'amazonaws' || v === 'AmazonS3') ? 'AmazonS3'
                        : v === 'qiniu' ? '七牛云'
                            : v === 'qingcloud' ? '青云'
                                : v === 'upyun' ? '又拍云'
                                    : v === 'jdcloud' ? '京东云'
                                        : v === 'kingsoft' ? '金山云'
                                            : v === 'ctyun' ? '天翼云' : v;
    }

    const ALL_VENDORS = ['aliyun', 'tencent', 'huawei', 'AmazonS3', 'qiniu', 'qingcloud', 'upyun', 'jdcloud', 'kingsoft', 'ctyun'];

    // 漏洞类型全集（与引擎 TYPE 标签一一对应，日志窗口按此勾选）
    const ALL_VUL_TYPES = ['存储桶可遍历', 'PUT文件上传', 'DELETE文件删除', 'ACL可读', 'ACL可写', 'Policy可读', 'Policy可写', '桶接管'];

    /* ====================== 运行时节流状态 ====================== */
    const passiveInFlightHosts = new Set();
    const passiveLastCheckedAt = new Map();
    const PASSIVE_THROTTLE_MS = 6000;
    const pageScanSeen = new Map();
    const PAGE_SCAN_TTL_MS = 10 * 60 * 1000;

    let logWindowId = null;
    let initialized = false;

    function engine() {
        return (typeof self !== 'undefined' && self.BucketDetect) || null;
    }

    /* ====================== 日志窗口 ====================== */
    function openLogWindow() {
        return new Promise((resolve) => {
            if (logWindowId !== null) { resolve(logWindowId); return; }
            try {
                API.windows.create({
                    url: API.runtime.getURL('bucket/bucket_log.html'),
                    type: 'popup', width: 640, height: 560
                }, (win) => {
                    if (API.runtime.lastError) { console.warn('[BucketSentinel] openLogWindow:', API.runtime.lastError.message); resolve(null); return; }
                    logWindowId = win && win.id != null ? win.id : null;
                    resolve(logWindowId);
                });
            } catch (e) { console.warn('[BucketSentinel] openLogWindow ex:', e); resolve(null); }
        });
    }

    function sendLog(msg, result) {
        if (logWindowId == null) return;
        try {
            API.windows.get(logWindowId, { populate: true }, (win) => {
                if (API.runtime.lastError) return;
                if (win && win.tabs && win.tabs.length) {
                    for (const tab of win.tabs) {
                        try { API.tabs.sendMessage(tab.id, { type: 'bucketvul-log', msg, result }); } catch (e) { }
                    }
                }
            });
        } catch (e) { }
    }

    // 日志窗口关闭时复位 id
    function watchLogWindow() {
        try {
            API.windows.onRemoved.addListener((wid) => { if (wid === logWindowId) logWindowId = null; });
        } catch (e) { }
    }

    /* ====================== 被动检测 ====================== */
    function registerPassiveListener() {
        API.webRequest.onCompleted.addListener(async (details) => {
            try {
                const eng = engine();
                if (!eng) return;
                const url = details.url;
                if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return;
                if (details.tabId < 0) return;

                const host = getHostFromUrl(url);
                if (!host) return;
                const sourceSite = getSourceSiteFromDetails(details);
                if (!sourceSite) return;

                const throttleKey = sourceSite;
                if (passiveInFlightHosts.has(throttleKey)) return;
                const lastAt = passiveLastCheckedAt.get(throttleKey) || 0;
                if (Date.now() - lastAt < PASSIVE_THROTTLE_MS) return;
                passiveInFlightHosts.add(throttleKey);

                API.storage.local.get(['bucketPassiveEnabled', 'bucketVulHistory', 'flagAcl', 'flagPolicy', 'detectBlacklist', 'detectWhitelist', 'whitelistMode', 'safeModePassive', 'traverseBacktrack'], async (res) => {
                    try {
                        if (res.bucketPassiveEnabled === false) return; // 主开关（默认开启）
                        let history = res.bucketVulHistory || [];
                        const aclFlag = res.flagAcl ?? true;
                        const policyFlag = res.flagPolicy ?? true;
                        const safeMode = res.safeModePassive ?? true;
                        const traverseBacktrack = res.traverseBacktrack ?? false;
                        const bl = res.detectBlacklist || [];
                        const wl = res.detectWhitelist || [];
                        const whitelistMode = res.whitelistMode ?? false;
                        if (matchBlacklistHost(sourceSite, bl)) return;
                        if (whitelistMode && !matchWhitelistHost(sourceSite, wl)) return;

                        const vendor = eng.detectVendor(url);
                        const detectedTypes = new Set(
                            history
                                .filter(item => getHostFromUrl(item.url) === getHostFromUrl(url) && item.vendor === vendor)
                                .map(item => item.type)
                        );
                        const resultArr = await eng.detectBucketVul(url, { checkAcl: aclFlag, checkPolicy: policyFlag, safeMode, traverseBacktrack });
                        let changed = false;
                        const sourcePageUrl = getSourcePageUrlFromDetails(details);
                        for (const result of (resultArr || [])) {
                            if (!result || detectedTypes.has(result.type)) continue;
                            history.unshift({
                                id: Date.now() + Math.random(),
                                url, type: result.type, vendor: result.vendor, time: Date.now(),
                                request: result.request || '', response: result.response || '',
                                source: '被动', sourcePageUrl, sourceSite, tabId: details.tabId
                            });
                            changed = true;
                        }
                        if (changed) API.storage.local.set({ bucketVulHistory: history });
                    } catch (e) {
                        console.warn('[BucketSentinel] passive detect error:', e);
                    } finally {
                        passiveLastCheckedAt.set(throttleKey, Date.now());
                        passiveInFlightHosts.delete(throttleKey);
                    }
                });
            } catch (e) { /* 忽略单次监听异常 */ }
        }, { urls: ['<all_urls>'] });
    }

    /* ====================== 右键菜单 ====================== */
    function registerContextMenu() {
        try {
            API.runtime.onInstalled.addListener(() => {
                try {
                    API.contextMenus.create({
                        id: 'happyjs-bucket-detect',
                        title: '用 JsXray 检测存储桶',
                        contexts: ['link', 'selection', 'page']
                    });
                } catch (e) { /* 已存在则忽略 */ }
            });
            API.contextMenus.onClicked.addListener(async (info, tab) => {
                await openLogWindow();
                // 若右键的是链接/选中文本，尝试预填 URL
                let prefill = '';
                const candidate = info && (info.linkUrl || info.selectionText || info.pageUrl);
                if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate.trim())) prefill = candidate.trim();
                sendLog('请在日志窗口中输入存储桶 URL 并点击“开始检测”' + (prefill ? `（已识别候选：${prefill}）` : ''));
                if (prefill) sendLog({ event: 'prefill', url: prefill });
            });
        } catch (e) { console.warn('[BucketSentinel] contextMenu:', e); }
    }

    /* ====================== 主动检测 ====================== */
    async function runManualDetect(message) {
        const eng = engine();
        if (!eng) { await openLogWindow(); sendLog({ event: 'error', error: '检测引擎未加载' }); return; }
        const targetUrl = message.vulUrl;
        if (!targetUrl) { await openLogWindow(); sendLog('未输入URL，检测取消'); return; }
        const host = getHostFromUrl(targetUrl);
        API.storage.local.get(['flagAcl', 'flagPolicy', 'bucketVulHistory', 'detectBlacklist', 'detectWhitelist', 'whitelistMode', 'traverseBacktrack'], async (res) => {
            const bl = res.detectBlacklist || [];
            const wl = res.detectWhitelist || [];
            const whitelistMode = res.whitelistMode ?? false;
            const traverseBacktrack = res.traverseBacktrack ?? false;
            if (matchBlacklistHost(host, bl)) { await openLogWindow(); sendLog('目标在黑名单，跳过检测'); return; }
            if (whitelistMode && !matchWhitelistHost(host, wl)) { await openLogWindow(); sendLog('目标不在白名单，跳过检测'); return; }
            await openLogWindow();
            sendLog({ event: 'start', url: targetUrl });
            // 漏洞类型以日志窗口勾选为准（主动检测显式控制）；未传时回退检测策略页开关
            const vulTypes = (() => {
                const filtered = (Array.isArray(message.vulTypes) && message.vulTypes.length)
                    ? message.vulTypes.filter(t => ALL_VUL_TYPES.includes(t)) : [];
                return filtered.length ? filtered : null;
            })();
            const aclFlag = vulTypes ? (vulTypes.includes('ACL可读') || vulTypes.includes('ACL可写')) : (res.flagAcl ?? true);
            const policyFlag = vulTypes ? (vulTypes.includes('Policy可读') || vulTypes.includes('Policy可写')) : (res.flagPolicy ?? true);
            sendLog({ event: 'params', acl: aclFlag, policy: policyFlag, types: vulTypes || ALL_VUL_TYPES.slice() });
            try {
                const vendors = (message.vendors && message.vendors.length) ? message.vendors : ALL_VENDORS.slice();
                let history = res.bucketVulHistory || [];
                for (const v of vendors) {
                    const vendorName = vendorLabel(v);
                    sendLog({ event: 'vendor-start', vendor: vendorName });
                    const resultArr = await eng.detectBucketVul(targetUrl, { checkAcl: aclFlag, checkPolicy: policyFlag, vendors: [v], safeMode: false, traverseBacktrack, enabledTypes: vulTypes });
                    let foundAny = false;
                    for (const result of (resultArr || [])) {
                        let statusCode; let path = '';
                        if (result.url) { try { path = new URL(result.url).pathname + new URL(result.url).search; } catch { path = result.url; } }
                        if (result.response) { const m = result.response.match(/^HTTP\/1\.1 (\d{3})/); if (m) statusCode = m[1]; }
                        sendLog({
                            event: 'detect', vendor: result.vendor, type: result.type, path, statusCode,
                            found: result.found, detail: result.detail || '', url: result.url || '',
                            request: result.request, response: result.response, source: '主动'
                        });
                        if (result.found) {
                            foundAny = true;
                            const exists = history.some(item =>
                                getHostFromUrl(item.url) === getHostFromUrl(targetUrl) &&
                                item.type === result.type && item.vendor === result.vendor);
                            if (!exists) {
                                history.unshift({
                                    id: Date.now() + Math.random(), url: targetUrl, type: result.type,
                                    vendor: result.vendor, time: Date.now(), request: result.request || '',
                                    response: result.response || '', source: '主动'
                                });
                            }
                        }
                    }
                    if (!foundAny) sendLog({ event: 'vendor-result', vendor: vendorName, found: false });
                }
                API.storage.local.set({ bucketVulHistory: history });
                sendLog({ event: 'finish' });
            } catch (e) {
                sendLog({ event: 'error', error: e + '' });
            }
        });
    }

    /* ====================== 页面扫描候选检测 ====================== */
    function runPageScan(message, sender, sendResponse) {
        const eng = engine();
        if (!eng) { try { sendResponse({ ok: false, reason: 'no-engine' }); } catch (e) { } return; }
        const pageUrl = message.pageUrl;
        const candidates = Array.isArray(message.candidates) ? message.candidates : [];
        const sources = (message.sources && typeof message.sources === 'object') ? message.sources : {};
        if (!pageUrl || !candidates.length) { try { sendResponse({ ok: false, reason: 'empty' }); } catch (e) { } return; }
        const pageHost = getHostFromUrl(pageUrl);
        if (!pageHost) { try { sendResponse({ ok: false, reason: 'no-host' }); } catch (e) { } return; }

        const now = Date.now();
        for (const [k, v] of pageScanSeen.entries()) { if (now - v > PAGE_SCAN_TTL_MS) pageScanSeen.delete(k); }

        API.storage.local.get(['bucketPassiveEnabled', 'bucketVulHistory', 'flagAcl', 'flagPolicy', 'detectBlacklist', 'detectWhitelist', 'whitelistMode', 'safeModePassive', 'traverseBacktrack', 'scanMaxTotalCandidates'], async (res) => {
            try {
                if (res.bucketPassiveEnabled === false) { try { sendResponse({ ok: false, reason: 'disabled' }); } catch (e) { } return; }
                const bl = res.detectBlacklist || [];
                const wl = res.detectWhitelist || [];
                const whitelistMode = res.whitelistMode ?? false;
                if (matchBlacklistHost(pageHost, bl)) { try { sendResponse({ ok: false, reason: 'blacklisted' }); } catch (e) { } return; }
                if (whitelistMode && !matchWhitelistHost(pageHost, wl)) { try { sendResponse({ ok: false, reason: 'not_in_whitelist' }); } catch (e) { } return; }

                const aclFlag = res.flagAcl ?? true;
                const policyFlag = res.flagPolicy ?? true;
                const safeMode = res.safeModePassive ?? true;
                const traverseBacktrack = res.traverseBacktrack ?? false;
                let history = res.bucketVulHistory || [];
                const sourceSite = pageHost;

                const configuredMax = Number(res.scanMaxTotalCandidates);
                const maxCandidates = Math.min(200, Math.max(1, Number.isFinite(configuredMax) ? configuredMax : 60));
                const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : undefined;

                let processed = 0, found = 0;
                for (const c of candidates.slice(0, maxCandidates)) {
                    const key = `${pageHost}@@${c}`;
                    if (pageScanSeen.has(key)) continue;
                    pageScanSeen.set(key, now);
                    processed++;

                    let sourceHitUrl = pageUrl, sourceLine, sourceExcerpt = '';
                    const meta = sources[c];
                    if (typeof meta === 'string' && meta) sourceHitUrl = meta;
                    else if (meta && typeof meta === 'object') {
                        if (typeof meta.sourceUrl === 'string' && meta.sourceUrl) sourceHitUrl = meta.sourceUrl;
                        if (typeof meta.line === 'number') sourceLine = meta.line;
                        if (typeof meta.excerpt === 'string') sourceExcerpt = meta.excerpt;
                    }

                    // 域名命中记录（不计入风险数）
                    try {
                        const vendorName = eng.detectVendor(c);
                        if (vendorName && vendorName !== '未知') {
                            const exists = history.some(item => item && item.type === '域名命中' && item.vendor === vendorName &&
                                item.url === c && item.sourceHitUrl === sourceHitUrl && item.sourceLine === sourceLine);
                            if (!exists) {
                                history.unshift({
                                    id: Date.now() + Math.random(), url: c, type: '域名命中', vendor: vendorName, time: Date.now(),
                                    request: '', response: '', source: '被动-页面扫描', sourcePageUrl: pageUrl,
                                    sourceHitUrl, sourceSite, sourceLine, sourceExcerpt, tabId
                                });
                            }
                        }
                    } catch (e) { }

                    let resultArr = [];
                    try {
                        resultArr = await eng.detectBucketVul(c, { checkAcl: aclFlag, checkPolicy: policyFlag, safeMode, traverseBacktrack });
                    } catch (e) { continue; }
                    if (!Array.isArray(resultArr)) continue;

                    for (const result of resultArr) {
                        if (!result || !result.found) continue;
                        found++;
                        history.unshift({
                            id: Date.now() + Math.random(), url: c, type: result.type, vendor: result.vendor, time: Date.now(),
                            request: result.request || '', response: result.response || '', source: '被动-页面扫描',
                            sourcePageUrl: pageUrl, sourceHitUrl, sourceSite, sourceLine, sourceExcerpt, tabId
                        });
                    }
                }
                API.storage.local.set({ bucketVulHistory: history });
                try { sendResponse({ ok: true, processed, found }); } catch (e) { }
            } catch (e) {
                console.warn('[BucketSentinel] page-scan error:', e);
                try { sendResponse({ ok: false, reason: 'exception' }); } catch (e2) { }
            }
        });
    }

    /* ====================== 黑白名单更新 ====================== */
    function runListUpdate(message, sendResponse) {
        const key = message.key, action = message.action, value = message.value;
        if (key !== 'detectBlacklist' && key !== 'detectWhitelist') { try { sendResponse({ ok: false }); } catch (e) { } return; }
        const otherKey = key === 'detectBlacklist' ? 'detectWhitelist' : 'detectBlacklist';
        API.storage.local.get([key, otherKey], (res) => {
            const cur = Array.isArray(res[key]) ? res[key].slice() : [];
            const other = Array.isArray(res[otherKey]) ? res[otherKey].slice() : [];
            let next = cur;
            if (action === 'add') {
                const v = String(value || '').trim();
                if (!v) { try { sendResponse({ ok: false, reason: 'empty' }); } catch (e) { } return; }
                const conflicts = findConflicts(v, other);
                if (conflicts.length) { try { sendResponse({ ok: false, reason: 'conflict', entry: v, conflicts, otherKey }); } catch (e) { } return; }
                if (!cur.includes(v)) cur.push(v);
                next = cur;
            } else if (action === 'removeAt') {
                const idx = Number(value);
                if (!Number.isNaN(idx) && idx >= 0 && idx < cur.length) cur.splice(idx, 1);
                next = cur;
            } else if (action === 'clear') {
                next = [];
            } else if (action === 'merge') {
                const arr = Array.isArray(value) ? value : [];
                const skipped = [];
                for (const it of arr) {
                    const v = String(it || '').trim();
                    if (!v) continue;
                    const conflicts = findConflicts(v, other);
                    if (conflicts.length) { skipped.push({ entry: v, conflicts }); continue; }
                    if (!cur.includes(v)) cur.push(v);
                }
                next = cur;
                API.storage.local.set({ [key]: next }, () => { try { sendResponse({ ok: true, list: next, skipped }); } catch (e) { } });
                return;
            } else {
                try { sendResponse({ ok: false, reason: 'bad_action' }); } catch (e) { } return;
            }
            API.storage.local.set({ [key]: next }, () => { try { sendResponse({ ok: true, list: next }); } catch (e) { } });
        });
    }

    /* ====================== 对外接口 ====================== */
    const HANDLED = new Set(['list-update', 'manual-detect', 'page-scan-found', 'clear-badge', 'reset-runtime-state', 'bucket-open-log']);

    self.BucketSentinel = {
        init() {
            if (initialized) return;
            initialized = true;
            registerPassiveListener();
            registerContextMenu();
            watchLogWindow();
            // 主开关默认开启（首次安装写入，便于 popup 读取到确定值）
            API.storage.local.get(['bucketPassiveEnabled'], (res) => {
                if (res.bucketPassiveEnabled === undefined) API.storage.local.set({ bucketPassiveEnabled: true });
            });
            console.log('[BucketSentinel] init 完成（引擎:', !!engine(), '）');
        },
        handles(type) { return HANDLED.has(type); },
        handle(msg, sender, sendResponse) {
            try {
                switch (msg.type) {
                    case 'list-update':
                        runListUpdate(msg, sendResponse); return true;
                    case 'manual-detect':
                        runManualDetect(msg); try { sendResponse({ ok: true }); } catch (e) { } return true;
                    case 'page-scan-found':
                        runPageScan(msg, sender, sendResponse); return true;
                    case 'bucket-open-log':
                        openLogWindow().then(() => { try { sendResponse({ ok: true }); } catch (e) { } }); return true;
                    case 'clear-badge':
                        try { sendResponse({ ok: true }); } catch (e) { } return true;
                    case 'reset-runtime-state':
                        try { passiveInFlightHosts.clear(); passiveLastCheckedAt.clear(); pageScanSeen.clear(); } catch (e) { }
                        try { sendResponse({ ok: true }); } catch (e) { } return true;
                    default:
                        try { sendResponse(null); } catch (e) { } return true;
                }
            } catch (e) {
                console.error('[BucketSentinel] handle error:', e);
                try { sendResponse(null); } catch (e2) { } return true;
            }
        }
    };
})();
