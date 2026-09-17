/* =====================================================================
 * JsXray — Webpack chunk 合成 与 Module Federation 远程入口发现
 * =====================================================================
 * 借鉴自 hybrid_capture_project2（extension/chunk_discovery.js，其自身注释
 * 说明参考了 JS-Chunk-Downloader 的 parseChunks 流程）。
 *
 * 解决的问题：扩展的「一键下载站点 JS」目前只能下到**已经被浏览器请求过**的
 * 文件。而 webpack/Vite 的懒加载 chunk 只有在对应路由被访问时才会请求，
 * 未访问到的 chunk 永远进不了网络清单 → 下载不完整、接口提取漏掉一大片。
 *
 * 本模块从 runtime 脚本里**静态合成**这些 chunk 的 URL：
 *   ① 语义映射    __webpack_require__.u = e => "chunk-" + chunkId + "." + hash + ".js"
 *   ② 名称映射    {860:"LoginReset"}[e] || e        （chunkId → 可读名字）
 *   ③ 哈希映射    {860:"a1b2c3d4e5"}[e]             （chunkId → 内容哈希）
 *   ④ 后缀试探    .js / .chunk.js / .bundle.js / .esm.js ...
 *   ⑤ 分隔符试探  名称 . - _ 哈希
 *   ⑥ 兜底直取    静态出现的 hashed 文件名（assets/index-6223ea2e.js）
 * 并附带 Module Federation 的 remoteEntry.js 发现（可能在**另一个源**上）。
 *
 * 该文件由 background.js 通过 importScripts 加载，纯函数、无浏览器 API 依赖。
 * ===================================================================== */
const ChunkFinder = (function () {
    'use strict';

    /* 合成时的候选后缀与分隔符（顺序即优先级，前者更常见） */
    const SUFFIX_PATTERNS = [
        '.js', '.chunk.js', '.bundle.js', '.min.js', '.esm.js',
        '.async.js', '.lazy.js', '.vendor.js', '.app.js', '.runtime.js'
    ];
    const SEPARATORS = ['.', '-', '_'];

    /* 单次分析的最大源码长度：超大 bundle 上的惰性量词正则会退化，必须封顶 */
    const MAX_SOURCE = 3 * 1024 * 1024;
    /* 上下文片段数量上限，防止在畸形脚本上无限枚举 */
    const MAX_CONTEXTS = 400;
    /* 每个上下文最多合成的候选数（1 个 chunk 最多产生 3 分隔符 + 1 value-only） */
    const MAX_CHUNKS = 1500;

    /* ------------------------------------------------------------------
     * 一、定位「含映射表」的代码片段
     * ------------------------------------------------------------------ */

    /** 找到可能承载 chunk 映射（.u 生成函数 / 映射表取值表达式）的片段
     *  注意：真实构建产物不一定经过压缩，`||` 两侧、`[e]` 前后、`function(` 之间
     *  都可能带空白，所以所有模式都做了空白容错，且不要求后缀恰好是 ".js"
     *  （可能是 ".chunk.js" / ".bundle.js" / "chunk.js"）。 */
    function extractMappingContexts(source) {
        const contexts = [];
        const JS_SUFFIX = '["\'][^"\']{0,32}js["\']';   // 匹配 ".js" / ".chunk.js" / "chunk.js" …
        const patterns = [
            // __webpack_require__.u = function (e) { ... return ... }
            /\.u\s*=\s*function\s*\([^)]*\)\s*\{[\s\S]{0,2000}?return[\s\S]{0,1000}?\}/g,
            // .u = e => ...xxx.js
            new RegExp('\\.u\\s*=\\s*\\([^)]*\\)\\s*=>[\\s\\S]{0,1500}?' + JS_SUFFIX, 'g'),
            new RegExp('\\.u\\s*=\\s*[^=]+=>[\\s\\S]{0,1500}?' + JS_SUFFIX, 'g'),
            // 具名/匿名函数里 return ... + "xxx.js"（function 与 ( 之间可能无空格）
            new RegExp('function\\s*\\w*\\s*\\([^)]*\\)\\s*\\{[\\s\\S]{0,2000}?return[\\s\\S]{0,1000}?\\+\\s*' + JS_SUFFIX, 'g'),
            // ("860"===e ? ... : ...) + ".js"
            new RegExp('\\(["\'][^"\']+["\']\\s*===\\s*\\w+\\s*\\?[\\s\\S]{0,800}?\\+\\s*' + JS_SUFFIX, 'g'),
            // ({...})[e] + ".js"
            new RegExp('\\(\\{[\\s\\S]{0,10000}?\\}\\)\\s*\\[\\s*\\w+\\s*\\]\\s*\\+\\s*' + JS_SUFFIX, 'g'),
            new RegExp('["\']=>\\(\\{[\\s\\S]{0,10000}?\\}\\)\\s*\\[\\s*\\w+\\s*\\]\\s*\\+\\s*' + JS_SUFFIX, 'g')
        ];

        for (const pattern of patterns) {
            if (contexts.length >= MAX_CONTEXTS) break;
            pattern.lastIndex = 0;
            for (const match of source.matchAll(pattern)) {
                contexts.push(match[0]);
                if (contexts.length >= MAX_CONTEXTS) break;
            }
        }

        // 独立映射表达式：({...})[e] + ".js"
        const standalone = new RegExp('\\(?\\{[\\s\\S]{5,100000}?\\}\\)?\\s*\\[\\s*\\w+\\s*\\]\\s*\\+\\s*' + JS_SUFFIX, 'g');
        for (const match of source.matchAll(standalone)) {
            if (contexts.length >= MAX_CONTEXTS) break;
            contexts.push(match[0]);
        }

        // 名称/哈希分离写法：( {...}[e] || e ) + "." + { ... }[e] + "…js"
        const separated =
            /\(\{[\s\S]{1,100000}?\}\s*\[\s*\w+\s*\]\s*\|\|\s*\w+\s*\)\s*\+\s*["']\.?["']\s*\+\s*\{[\s\S]{1,100000}?\}\s*\[\s*\w+\s*\]\s*\+\s*["'][^"']*\.(?:async\.|chunk\.|lazy\.|bundle\.)?js["']/g;
        for (const match of source.matchAll(separated)) {
            if (contexts.length >= MAX_CONTEXTS) break;
            contexts.push(match[0]);
        }

        return contexts;
    }

    /** 该片段使用的是哪一个后缀（"xxx.chunk.js" → ".chunk.js"） */
    function detectSuffix(text) {
        for (const suffix of SUFFIX_PATTERNS) {
            const escaped = suffix.replace(/\./g, '\\.');
            if (new RegExp('["\']' + escaped + '["\']', 'g').test(text)) return suffix;
        }
        return '.js';
    }

    /* ------------------------------------------------------------------
     * 二、名称表 / 哈希表
     * ------------------------------------------------------------------ */

    /** chunkId → 可读名（过滤掉纯哈希值，那是哈希表的内容） */
    function extractNameMapping(text) {
        const nameMap = {};

        // 三元表达式：("860"===e?"LoginReset":e)
        for (const m of text.matchAll(/\(["']([^"']+)["']\s*===\s*\w+\s*\?\s*["']([^"']+)["']\s*:\s*\w+\)/g)) {
            nameMap[m[1]] = m[2];
        }

        const patterns = [
            /\(\s*\{([^}]+)\}\s*\[[\w\s]+\]\s*\|\|/g,
            /\{\s*\{([^}]+)\}\s*\[[\w\s]+\]\s*\|\|/g,
            /\(\s*\{([^}]+)\}\)\s*\[[\w\s]+\]\s*\|\|/g,
            /\(\(\{([\s\S]*?)\}\)\[[^\]]+\]\s*\|\|[^)]+\)/g,
            /\(\(\{([\s\S]{0,100000}?)\}\)\[[^\]]+\]\s*\|\|/g,
            new RegExp('["\'][^"\']*["\']\\s*\\+\\s*\\(\\(\\{([\\s\\S]{0,30000}?)\\}\\s*\\)\\s*\\[[^\\]]+\\]\\s*\\+\\s*["\'][^"\']{0,32}js["\']', 'g')
        ];

        const collect = (content) => {
            for (const entry of content.matchAll(/(\d+)\s*:\s*["']([^"']+)["']/g)) {
                if (!/^[a-f0-9]{6,32}$/i.test(entry[2])) nameMap[entry[1]] = entry[2];
            }
            for (const entry of content.matchAll(/["']([^"']+)["']\s*:\s*["']([^"']+)["']/g)) {
                if (!/^[a-f0-9]{6,32}$/i.test(entry[2])) nameMap[entry[1]] = entry[2];
            }
        };

        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            for (const match of text.matchAll(pattern)) collect(match[1]);
        }

        // 分离写法专用一轮
        const separated =
            /\(\{([\s\S]{0,50000}?)\}\s*\[\s*[^\]]+\s*\]\s*\|\|\s*[^)]+\)\s*\+\s*["']\.?["']\s*\+\s*\{([\s\S]{0,50000}?)\}\s*\[\s*[^\]]+\s*\]\s*\+\s*["'][^"']*\.(?:async\.|chunk\.|lazy\.|bundle\.)?js["']/g;
        for (const match of text.matchAll(separated)) collect(match[1]);

        return nameMap;
    }

    /** chunkId → 内容哈希 */
    function extractHashMapping(text) {
        const hashMap = {};
        const HEX_SUFFIX = '["\'][^"\']{0,32}js["\']';
        const patterns = [
            /\{([^}]+)\}\s*\[[\w\s]+\]\s*\+\s*["']/g,
            /\+\s*\{([^}]+)\}\s*\[[\w\s]+\]\s*\+/g,
            /\{\s*([^}]+)\}\s*\[[\w\s]+\]/g,
            /\+\s*\(\{([\s\S]*?)\}\)\s*\[[^\]]+\]\s*\+\s*["']\.js["']/g,
            /\{([\s\S]*?)\}\s*\[[^\]]+\]\s*\+\s*["']\.js["']/g,
            new RegExp('["\'][^"\']*["\']\\s*\\+\\s*\\(\\{([\\s\\S]{0,100000}?)\\}\\s*\\)\\s*\\[[^\\]]+\\]\\s*\\+\\s*' + HEX_SUFFIX, 'g'),
            /\+\s*["']\.?["']\s*\+\s*\{([\s\S]{0,50000}?)\}\s*\[[^\]]+\]\s*\+\s*["'][^"']*\.(?:async\.|chunk\.|lazy\.|bundle\.)?js["']/g
        ];

        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            for (const match of text.matchAll(pattern)) {
                const content = match[1];
                for (const entry of content.matchAll(/(\d+(?:e\d+)?)\s*:\s*["']([a-f0-9A-F]{6,40})["']/gi)) {
                    // 科学计数法形式的 chunkId（1e3）要还原成 1000
                    const id = /[eE]/.test(entry[1]) ? String(Number(entry[1])) : entry[1];
                    if (!hashMap[id]) hashMap[id] = entry[2];
                }
                for (const entry of content.matchAll(/["']([^"']+)["']\s*:\s*["']([a-f0-9A-F]{6,40})["']/gi)) {
                    if (!hashMap[entry[1]]) hashMap[entry[1]] = entry[2];
                }
            }
        }
        return hashMap;
    }

    /* ------------------------------------------------------------------
     * 三、URL 解析
     * ------------------------------------------------------------------ */

    function sanitizeChunkName(name) {
        if (!name) return '';
        return String(name).replace(/[^A-Za-z0-9._-]/g, '');
    }

    /** 把候选相对路径解析为绝对 URL（脚本同目录 → 站点根兜底） */
    function resolveChunkUrl(rawPath, scriptUrl, baseUrl) {
        if (!rawPath) return '';
        const clean = String(rawPath).replace(/^['"]|['"]$/g, '').trim();
        if (!clean) return '';
        try {
            if (/^https?:\/\//i.test(clean)) return new URL(clean).toString();
            if (clean.startsWith('//')) {
                let scheme = 'https:';
                try { scheme = new URL(scriptUrl).protocol || 'https:'; } catch {}
                return scheme + clean;
            }
            return new URL(clean, scriptUrl).toString();
        } catch {
            try {
                const last = clean.split('/').pop();
                return baseUrl ? baseUrl + last : '';
            } catch {
                return '';
            }
        }
    }

    /** 脚本 URL 所在目录（合成 chunk 的基准） */
    function dirOf(scriptUrl) {
        try {
            const u = new URL(scriptUrl);
            const parts = u.pathname.split('/');
            parts.pop();
            u.pathname = parts.join('/') + '/';
            u.search = '';
            u.hash = '';
            return u.toString();
        } catch {
            return '';
        }
    }

    /* ------------------------------------------------------------------
     * 四、对外主入口
     * ------------------------------------------------------------------ */

    /**
     * 从 runtime 脚本源码合成懒加载 chunk URL。
     * @returns [{ url, fileName, chunkId, chunkName, hash, strategy }]
     */
    function discoverChunks(source, scriptUrl, opts = {}) {
        if (!source || typeof source !== 'string' || source.length < 80) return [];
        if (!source.includes('.js')) return [];
        if (source.length > MAX_SOURCE) source = source.slice(0, MAX_SOURCE);

        const baseUrl = dirOf(scriptUrl);
        if (!baseUrl) return [];

        const chunks = [];
        const processed = new Set();
        const contexts = extractMappingContexts(source);

        for (const context of contexts) {
            if (chunks.length >= MAX_CHUNKS) break;
            const suffix = detectSuffix(context);
            const nameMap = extractNameMapping(context);
            const hashMap = extractHashMapping(context);

            for (const chunkId of Object.keys(hashMap)) {
                if (chunks.length >= MAX_CHUNKS) break;
                const hash = hashMap[chunkId];
                const key = chunkId + ':' + hash + ':' + suffix;
                if (processed.has(key)) continue;
                processed.add(key);

                const chunkName = sanitizeChunkName(nameMap[chunkId] || chunkId) || String(chunkId);

                // 策略 A：名称 + 分隔符 + 哈希 + 后缀
                for (const sep of SEPARATORS) {
                    const fileName = chunkName + sep + hash + suffix;
                    chunks.push({
                        url: baseUrl + fileName, fileName, chunkId, chunkName, hash,
                        strategy: 'semantic-' + sep
                    });
                }
                // 策略 B：仅哈希 + 后缀（无名称映射时的常见形态）
                const valueOnly = hash + suffix;
                chunks.push({
                    url: baseUrl + valueOnly, fileName: valueOnly,
                    chunkId, chunkName: hash, hash, strategy: 'semantic-value-only'
                });
            }
        }

        // 策略 C：源码里静态写死的 hashed 文件名
        const fallbackPatterns = [
            /["']([^"']*\/)?(\d+)[.\-_]([a-f0-9A-F]{6,})\.(?:chunk\.)?js["']/g,
            /["']static\/js\/(\d+)[.\-_]([a-f0-9A-F]{6,})\.(?:chunk\.)?js["']/g,
            /["']([^"']*[A-Za-z0-9_-]+[.\-_][a-f0-9A-F]{6,40}\.(?:chunk\.|async\.|lazy\.|bundle\.|vendor\.|runtime\.)?(?:m?js))["']/g
        ];
        for (const pattern of fallbackPatterns) {
            pattern.lastIndex = 0;
            for (const match of source.matchAll(pattern)) {
                if (chunks.length >= MAX_CHUNKS) break;
                const raw = (match[1] || match[0]).replace(/["']/g, '');
                const fileName = raw.split('/').pop();
                if (!fileName) continue;
                const url = resolveChunkUrl(raw, scriptUrl, baseUrl);
                if (!url) continue;
                chunks.push({
                    url, fileName,
                    chunkId: match[2] || match[1] || '',
                    chunkName: match[2] || match[1] || '',
                    hash: match[3] || match[2] || '',
                    strategy: 'fallback'
                });
            }
        }

        // 去重（合成时会产出大量近似候选，交给调用方按存在性筛选）
        const seen = new Set();
        const out = chunks.filter((c) => {
            if (!c || !c.url) return false;
            if (seen.has(c.url)) return false;
            seen.add(c.url);
            return true;
        });

        const limit = opts.limit > 0 ? Math.min(opts.limit, MAX_CHUNKS) : MAX_CHUNKS;
        return out.slice(0, limit);
    }

    /**
     * 发现 Module Federation 的远程入口（remoteEntry.js）。
     * 这些文件可能**托管在另一个源**上，且只有真正 import 远程模块时才会被
     * 浏览器加载 —— 未触发的远程容器对 webRequest 完全不可见。
     * @returns [{ url, remoteName, strategy }]
     */
    function discoverFederationRemotes(source, scriptUrl) {
        if (!source || typeof source !== 'string' || source.length < 40) return [];
        if (source.length > MAX_SOURCE) source = source.slice(0, MAX_SOURCE);
        // 快速排除：不含任何联邦特征就直接返回，避免无谓的正则扫描
        if (!source.includes('remoteEntry') && !source.includes('Federation') &&
            !source.includes('federation') && !source.includes('.remotes') &&
            !source.includes('__webpack_require__.l')) {
            return [];
        }

        const remotes = [];
        const seen = new Set();
        const push = (rawUrl, remoteName, strategy) => {
            if (!rawUrl) return;
            const resolved = resolveChunkUrl(rawUrl, scriptUrl, '');
            if (!resolved || seen.has(resolved)) return;
            seen.add(resolved);
            remotes.push({ url: resolved, remoteName: remoteName || '', strategy });
        };

        const patterns = [
            { re: /["'](https?:\/\/[^"']+?\/[^"']*remoteEntry[^"']*\.js)["']/gi, url: 1, name: null, s: 'remoteEntry-abs' },
            // 相对形式：排除 ':' 与 '@'，避免和下面两种（绝对 / name@url）重复匹配
            { re: /["']((?:[^"':@]*\/)?[^"'\/:@]*remoteEntry[^"':@]*\.js)["']/gi, url: 1, name: null, s: 'remoteEntry-rel' },
            { re: /["']([\w.-]+)@(https?:\/\/[^"']+?\.js)["']/gi, url: 2, name: 1, s: 'name@url' },
            { re: /entry\s*:\s*["'](https?:\/\/[^"']+?\.js)["']/gi, url: 1, name: null, s: 'vite-entry' },
            { re: /__federation_[\w$]*\([^)]*["'](https?:\/\/[^"']+?\.js)["']/gi, url: 1, name: null, s: 'federation-helper' }
        ];

        for (const p of patterns) {
            p.re.lastIndex = 0;
            for (const m of source.matchAll(p.re)) {
                push(m[p.url], p.name ? m[p.name] : '', p.s);
            }
        }
        return remotes.slice(0, 60);
    }

    /** 是否为 Vite 构建产物（assets/index-<hash>.js），用于触发 manifest 探测 */
    function looksLikeViteAsset(url) {
        if (!url) return false;
        return /\/assets\/[^"'?]*[-.][a-f0-9]{6,}\.(?:m?js)(?:$|\?)/i.test(url);
    }

    return {
        discoverChunks,
        discoverFederationRemotes,
        looksLikeViteAsset,
        resolveChunkUrl,
        sanitizeChunkName,
        detectSuffix,
        extractNameMapping,
        extractHashMapping,
        extractMappingContexts,
        MAX_SOURCE,
        MAX_CHUNKS
    };
})();
