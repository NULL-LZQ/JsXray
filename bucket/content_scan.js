/* =====================================================================
 * JsXray — 云存储桶页面扫描内容脚本（content_scan.js）
 * 融合自：谛听鉴-云存储桶风险监测 V1.1.0（By 狐狸）content/content.js
 *
 * 职责：
 *   - document_idle 时扫描当前页面 HTML / 外链 JS / 内联 JS，
 *     提取疑似云存储桶 URL（10 厂商域名特征）；
 *   - 可选目录回溯（traverseBacktrack）：逐级父目录 + 默认首页爆破；
 *   - 把候选 URL 及命中来源（文件/行号/摘录）上报后台做被动检测。
 *
 * 设计要点：
 *   - 整体包进 IIFE，避免与 JsXray 主 content.js 的顶层函数重名冲突；
 *   - 兼容 chrome / browser 双 API；
 *   - 消息带 to:'background'，由 background.js 主 onMessage 委派给 BucketSentinel；
 *   - 默认关闭（scanPageForBuckets!==true 时立即返回，几乎零开销）。
 * ===================================================================== */

(function () {
    'use strict';

    const API = (typeof browser !== 'undefined') ? browser : chrome;

    function getPageHtmlSample(maxChars) {
        try {
            const html = document && document.documentElement ? (document.documentElement.outerHTML || '') : '';
            if (!html) return '';
            if (html.length <= maxChars) return html;
            return html.slice(0, maxChars);
        } catch {
            return '';
        }
    }

    function uniq(arr) {
        return Array.from(new Set(arr));
    }

    function countLineNumber(text, index) {
        try {
            const t = String(text || '');
            if (!t) return 1;
            const idx = typeof index === 'number' && index >= 0 ? index : 0;
            let line = 1;
            for (let i = 0; i < idx && i < t.length; i++) {
                if (t.charCodeAt(i) === 10) line++;
            }
            return line;
        } catch {
            return 1;
        }
    }

    function getLineExcerpt(text, lineNo, maxLen) {
        try {
            const t = String(text || '');
            if (!t) return '';
            const lines = t.split(/\r?\n/);
            const l = Math.max(1, Math.min(lines.length, Number(lineNo) || 1));
            const s = String(lines[l - 1] || '');
            if (s.length <= maxLen) return s;
            return s.slice(0, maxLen);
        } catch {
            return '';
        }
    }

    function looksLikeCloudStorageHost(host) {
        const h = String(host || '').toLowerCase();
        if (!h) return false;
        return (
            h.includes('aliyuncs.com') ||
            h.includes('myqcloud.com') ||
            h.includes('myhuaweicloud.com') ||
            h.includes('amazonaws.com') ||
            h.includes('qiniucs.com') ||
            h.includes('clouddn.com') ||
            h.includes('qcloudcdn.com') ||
            h.includes('qingstor.com') ||
            h.includes('upaiyun.com') ||
            h.includes('upyun.com') ||
            h.includes('upcdn.net') ||
            h.includes('jcloudcs.com') ||
            h.includes('ksyuncs.com') ||
            h.includes('ks3-cn-') ||
            ((h.includes('ctyun.cn') && h.includes('.obs.')) || (h.includes('ctyunapi.cn') && h.startsWith('oos-')))
        );
    }

    function extractCandidateUrlsFromText(text) {
        const t = String(text || '');
        if (!t) return [];
        const out = [];

        const urlRe = /https?:\/\/[^\s"'<>\\)]+/gi;
        const urls = t.match(urlRe) || [];
        for (const u of urls) {
            try {
                const parsed = new URL(u);
                if (looksLikeCloudStorageHost(parsed.host)) out.push(parsed.toString());
            } catch { }
        }

        const escapedUrlRe = /https?:\\\/\\\/[^\s"'<>\\)]+/gi;
        const escapedUrls = t.match(escapedUrlRe) || [];
        for (const eu of escapedUrls) {
            try {
                const normalized = eu.replace(/\\\//g, '/');
                const parsed = new URL(normalized);
                if (looksLikeCloudStorageHost(parsed.host)) out.push(parsed.toString());
            } catch { }
        }

        const schemeRelativeRe = /\/\/[^\s"'<>\\)]+/g;
        const schemeRelative = t.match(schemeRelativeRe) || [];
        for (const su of schemeRelative) {
            const candidate = `https:${su}`;
            try {
                const parsed = new URL(candidate);
                if (looksLikeCloudStorageHost(parsed.host)) out.push(parsed.toString());
            } catch { }
        }

        const hostWithPathRe = /\b([a-zA-Z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@\/-]+)?)\b/g;
        const matches = t.match(hostWithPathRe) || [];
        for (const m of matches) {
            const raw = String(m || '').trim();
            if (!raw) continue;
            const hostOnly = raw.split('/')[0];
            if (!looksLikeCloudStorageHost(hostOnly)) continue;
            out.push(`https://${raw.replace(/^\/+/, '')}`);
        }
        return uniq(out);
    }

    function addCandidatesFromTextToMap(text, sourceUrl, outMap) {
        const arr = extractCandidateUrlsFromText(text);
        for (const c of arr) {
            if (!outMap.has(c)) {
                let idx = -1;
                try {
                    idx = String(text || '').indexOf(c);
                    if (idx < 0) {
                        const host = new URL(c).host;
                        if (host) idx = String(text || '').indexOf(host);
                    }
                } catch { }
                const line = idx >= 0 ? countLineNumber(text, idx) : 1;
                const excerpt = getLineExcerpt(text, line, 240);
                outMap.set(c, { sourceUrl, line, excerpt });
            }
        }
    }

    async function fetchText(url, maxLen) {
        try {
            const resp = await fetch(url, { credentials: 'omit', mode: 'cors' });
            if (!resp.ok) return '';
            const txt = await resp.text();
            if (!txt) return '';
            return txt.length > maxLen ? txt.slice(0, maxLen) : txt;
        } catch { return ''; }
    }

    async function fetchHtmlAndExtractCandidates(targetUrl, maxFileSize, maxExternalJs, maxInlineJs) {
        const htmlText = await fetchText(targetUrl, maxFileSize);
        if (!htmlText) return { candidates: [], sources: {} };

        const hitMap = new Map();
        addCandidatesFromTextToMap(htmlText, targetUrl, hitMap);

        const { external, inline } = parseScriptsFromHtml(htmlText, targetUrl);
        for (const jsUrl of external.slice(0, maxExternalJs)) {
            const jsText = await fetchText(jsUrl, maxFileSize);
            if (!jsText) continue;
            addCandidatesFromTextToMap(jsText, jsUrl, hitMap);
        }
        for (let i = 0; i < inline.slice(0, maxInlineJs).length; i++) {
            const jsText = inline[i];
            const src = `${targetUrl}#inline-script-${i + 1}`;
            addCandidatesFromTextToMap(String(jsText).slice(0, maxFileSize), src, hitMap);
        }

        const candidates = Array.from(hitMap.keys());
        const sources = Object.fromEntries(hitMap.entries());
        return { candidates, sources };
    }

    function parseScriptsFromHtml(htmlText, baseUrl) {
        const external = [];
        const inline = [];
        try {
            const doc = new DOMParser().parseFromString(String(htmlText || ''), 'text/html');

            external.push(
                ...Array.from(doc.querySelectorAll('script[src]'))
                    .map(s => s.getAttribute('src'))
                    .filter(Boolean)
            );
            inline.push(
                ...Array.from(doc.querySelectorAll('script:not([src])'))
                    .map(s => s.textContent || '')
                    .filter(Boolean)
            );
        } catch { }

        const absExternal = [];
        for (const src of external) {
            try {
                absExternal.push(new URL(src, baseUrl).toString());
            } catch { }
        }
        return { external: absExternal, inline };
    }

    function buildBacktrackDirUrls(pageUrl) {
        try {
            const u = new URL(pageUrl);
            const origin = u.origin;
            let path = u.pathname || '/';
            if (!path.startsWith('/')) path = '/' + path;

            let dirPath = path.endsWith('/') ? path : path.replace(/\/[^\/]*$/, '/');
            if (!dirPath.startsWith('/')) dirPath = '/' + dirPath;

            const seg = dirPath.split('/').filter(Boolean);
            const out = [];
            for (let i = seg.length; i >= 0; i--) {
                const p = i === 0 ? '/' : `/${seg.slice(0, i).join('/')}/`;
                out.push(origin + p);
            }

            return uniq(out);
        } catch {
            return [];
        }
    }

    function buildDefaultIndexPageUrls(dirUrl, refPageUrl) {
        const out = [];
        try {
            const u = new URL(dirUrl);
            let base = u.toString();
            if (!base.endsWith('/')) base += '/';

            out.push(base);

            const prefixes = ['index', 'default', 'main', 'home', 'system'];

            const extSet = new Set();
            try {
                const ref = new URL(refPageUrl || base);
                const m = (ref.pathname || '').match(/\.([a-zA-Z0-9]{1,6})$/);
                if (m && m[1]) extSet.add('.' + m[1].toLowerCase());
            } catch { }

            const commonExts = ['.html', '.htm', '.php', '.asp', '.aspx', '.jsp', '.jspx', '.shtml', '.phtml', '.do', '.action', 'php3', 'php5', 'php7', 'php8'];
            for (const e of commonExts) extSet.add(e);

            const exts = Array.from(extSet);
            for (const p of prefixes) {
                out.push(base + p);
                for (const e of exts) {
                    out.push(base + p + e);
                }
            }
        } catch { }
        return uniq(out);
    }

    let hasSentForThisPage = false;

    async function scanHtmlAndJsAndSend() {
        if (hasSentForThisPage) return;
        API.storage.local.get(['scanPageForBuckets', 'scanMaxExternalJs', 'scanMaxInlineJs', 'scanMaxFileSize', 'scanMaxTotalCandidates', 'traverseBacktrack'], async (res) => {
            const enabled = res && res.scanPageForBuckets === true;
            if (!enabled) return;

            const html = getPageHtmlSample(800000);
            const hitMap = new Map();
            addCandidatesFromTextToMap(html, location.href, hitMap);

            const scripts = Array.from(document.querySelectorAll('script[src]'))
                .map(s => s.getAttribute('src')).filter(Boolean);
            const inlineJs = Array.from(document.querySelectorAll('script:not([src])'))
                .map(s => s.textContent || '').filter(Boolean);
            const maxExternalJs = res.scanMaxExternalJs || 80;
            const maxInlineJs = res.scanMaxInlineJs || 40;
            const maxFileSize = res.scanMaxFileSize || 5 * 1024 * 1024;
            const maxTotalCandidates = res.scanMaxTotalCandidates || 100;
            const traverseBacktrack = res.traverseBacktrack === true;

            for (const jsUrl of scripts) {
                if (scripts.indexOf(jsUrl) >= maxExternalJs) break;
                let absUrl = jsUrl;
                try {
                    absUrl = new URL(jsUrl, location.href).toString();
                } catch { }
                const jsText = await fetchText(absUrl, maxFileSize);
                if (jsText) {
                    addCandidatesFromTextToMap(jsText, absUrl, hitMap);
                }
            }
            for (let i = 0; i < inlineJs.length && i < maxInlineJs; i++) {
                const jsText = inlineJs[i];
                const src = `${location.href}#inline-script-${i + 1}`;
                addCandidatesFromTextToMap(String(jsText).slice(0, maxFileSize), src, hitMap);
            }

            if (traverseBacktrack) {
                const backtrackUrls = buildBacktrackDirUrls(location.href);
                for (const u of backtrackUrls) {
                    if (u === location.href) continue;
                    const tryPages = buildDefaultIndexPageUrls(u, location.href);
                    for (const pageUrl of tryPages) {
                        const more = await fetchHtmlAndExtractCandidates(pageUrl, maxFileSize, maxExternalJs, maxInlineJs);
                        const moreCandidates = (more && Array.isArray(more.candidates)) ? more.candidates : [];
                        const moreSources = (more && more.sources && typeof more.sources === 'object') ? more.sources : {};
                        if (moreCandidates && moreCandidates.length) {
                            for (const c of moreCandidates) {
                                if (!hitMap.has(c)) hitMap.set(c, moreSources[c] || pageUrl);
                            }
                            break;
                        }
                    }
                    if (hitMap.size >= maxTotalCandidates) break;
                }
            }

            const candidates = Array.from(hitMap.keys()).slice(0, maxTotalCandidates);
            const sources = {};
            for (const c of candidates) sources[c] = hitMap.get(c);

            if (!candidates.length) return;
            hasSentForThisPage = true;
            try {
                API.runtime.sendMessage({
                    type: 'page-scan-found',
                    to: 'background',
                    pageUrl: location.href,
                    candidates,
                    sources
                }, (response) => {
                    const err = API.runtime && API.runtime.lastError ? API.runtime.lastError.message : '';
                    if (err) {
                        // 后台未就绪或未监听时属正常情况，降级为 debug
                        console.debug('[BucketScan] page-scan-found lastError:', err);
                        return;
                    }
                    if (response && response.ok) {
                        console.log('[BucketScan] 已上报', response.processed || 0, '个候选，命中', response.found || 0, '个风险');
                    }
                });
            } catch (e) {
                console.debug('[BucketScan] sendMessage error:', e);
            }
        });
    }

    // 仅在 http/https 页面运行，跳过扩展内部页/空白页
    try {
        if (/^https?:\/\//i.test(location.href)) {
            setTimeout(scanHtmlAndJsAndSend, 800);
        }
    } catch (e) { /* 忽略 */ }
})();
