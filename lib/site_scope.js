/* =====================================================================
 * JsXray — 站点范围判定（自有 / 同主体 / CDN 库 / 统计噪声）
 * =====================================================================
 * 借鉴自 hybrid_capture_project2（extension/background.js 的域过滤体系）。
 *
 * 我们原先只做最朴素的判断：`hostname !== 页面 hostname` 就算第三方。
 * 这个判定在真实站点上有两个明显的坑：
 *   ① 站点自己的接口域（api.example.com / static.example.com）被算成第三方，
 *      「仅本站 JS」一勾就漏掉一大半自家代码；
 *   ② cdn.jsdelivr.net 上的通用库、google-analytics 这种统计脚本被算成
 *      「有价值的目标」，下载下来一堆噪声、接口提取全是误报。
 *
 * 本模块把域分成四类，供下载清单与扫描结果过滤使用：
 *   site       —— 与页面同主体（含子域、同组织名的不同 TLD，如 a.com / a.net）
 *   cdn        —— 公共 CDN 上的通用前端库（jQuery / Vue / Element 等）
 *   noise      —— 统计 / 广告 / 错误上报 / 验证码，通常无分析价值
 *   thirdparty —— 其余外部域（可能是合作方、也可能是站点自己的另一套域）
 *
 * 纯函数、无浏览器 API 依赖，由 background.js 通过 importScripts 加载。
 * ===================================================================== */
const SiteScope = (function () {
    'use strict';

    /* 统计 / 广告 / 错误上报 / 验证码：默认排除，几乎没有安全分析价值 */
    const NOISE_DOMAINS = new Set([
        /* 统计与行为分析 */
        'google-analytics.com', 'googletagmanager.com', 'analytics.google.com',
        'hotjar.com', 'mixpanel.com', 'segment.com', 'segment.io',
        'amplitude.com', 'heapanalytics.com', 'fullstory.com',
        'clarity.ms', 'mouseflow.com', 'crazyegg.com',
        'matomo.org', 'piwik.org', 'plausible.io',
        'baidu.com', 'hm.baidu.com', 'cnzz.com', 'umeng.com', 'umengcloud.com',
        'talkingdata.com', 'growingio.com', 'sensorsdata.cn', 'zhugeio.com',
        /* 广告联盟 */
        'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
        'facebook.net', 'connect.facebook.net', 'fbcdn.net',
        'ads-twitter.com', 'adservice.google.com',
        /* 社交组件 */
        'platform.twitter.com', 'platform.linkedin.com',
        /* 错误上报 */
        'sentry.io', 'browser.sentry-cdn.com', 'bugsnag.com', 'rollbar.com',
        'fundebug.com', 'fundebug.net',
        /* A/B 与标签管理 */
        'optimizely.com', 'abtasty.com', 'vwo.com',
        /* 验证码与机器人对抗 */
        'recaptcha.net', 'gstatic.com', 'hcaptcha.com', 'challenges.cloudflare.com',
        'geetest.com', 'gtimg.com', 'yidun.com'
    ]);

    /* 公共 CDN：托管的是通用库而非站点自身代码 */
    const CDN_DOMAINS = new Set([
        'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com',
        'ajax.googleapis.com', 'code.jquery.com',
        'stackpath.bootstrapcdn.com', 'maxcdn.bootstrapcdn.com',
        'cdn.bootcdn.net', 'lib.baomitu.com', 'cdn.staticfile.org',
        'cdn.bootcss.com', 'at.alicdn.com', 'npm.elemecdn.com',
        'cdn.skypack.dev', 'esm.sh', 'cdn.tailwindcss.com', 'polyfill.io'
    ]);

    /* 两级公共后缀：用于正确切出「注册主体」而非「最后两段」
     * 例：dns2.example.edu.cn → example.edu.cn（不这样处理会得到 edu.cn） */
    const TWO_LEVEL_SUFFIXES = new Set([
        'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'mil.cn',
        'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
        'com.hk', 'org.hk', 'edu.hk', 'gov.hk',
        'com.tw', 'org.tw', 'edu.tw', 'gov.tw',
        'com.mo', 'edu.mo', 'gov.mo',
        'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp'
    ]);

    /* 不能用来做「组织名匹配」的通用词（否则 a.com 与 a.net 会误判成同主体） */
    const GENERIC_ORGS = new Set([
        'www', 'api', 'cdn', 'static', 'img', 'assets', 'mail', 'smtp', 'pop',
        'web', 'app', 'test', 'dev', 'demo', 'local', 'admin', 'portal', 'cloud',
        'com', 'net', 'org', 'gov', 'edu', 'cn', 'uk', 'jp', 'hk', 'tw', 'mo'
    ]);

    function normalizeHost(hostname) {
        return String(hostname == null ? '' : hostname).trim().toLowerCase().replace(/\.$/, '');
    }

    /** 取注册主体域（含两级后缀处理） */
    function baseDomain(hostname) {
        const host = normalizeHost(hostname);
        if (!host) return '';
        // IP 直接返回自身
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return host;
        const parts = host.split('.');
        if (parts.length <= 2) return host;
        const tail2 = parts.slice(-2).join('.');
        if (TWO_LEVEL_SUFFIXES.has(tail2) && parts.length >= 3) return parts.slice(-3).join('.');
        return tail2;
    }

    /** 组织名（用于跨 TLD 同主体判定：meituan.com ↔ meituan.net） */
    function orgName(hostname) {
        const base = baseDomain(hostname);
        if (!base) return '';
        const first = base.split('.')[0];
        if (!first || first.length < 3) return '';          // 太短容易误判
        if (GENERIC_ORGS.has(first)) return '';
        if (/^\d/.test(first)) return '';                    // 纯数字开头（IP 段 / 编号域）
        return first;
    }

    function isIpLike(hostname) {
        const host = normalizeHost(hostname);
        return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
    }

    function isNoise(hostname) {
        const host = normalizeHost(hostname);
        if (!host) return false;
        return NOISE_DOMAINS.has(host) || NOISE_DOMAINS.has(baseDomain(host));
    }

    function isCdn(hostname) {
        const host = normalizeHost(hostname);
        if (!host) return false;
        return CDN_DOMAINS.has(host) || CDN_DOMAINS.has(baseDomain(host));
    }

    /**
     * 是否与页面同主体。
     * @param hostname 待判定域
     * @param pageHost 页面域（或额外指定域列表）
     * @param extraHosts 额外认定的自有域（如用户手动配置的接口域）
     */
    function isSiteRelated(hostname, pageHost, extraHosts) {
        const host = normalizeHost(hostname);
        const page = normalizeHost(pageHost);
        if (!host) return false;
        if (!page) return false;

        // ① 完全相等或为页面域的子域
        if (host === page || host.endsWith('.' + page)) return true;
        // ② 页面域是待判定域的子域（页面在子域上，同主体域应包含父域）
        if (page.endsWith('.' + host)) return true;
        // ③ 同一注册主体
        const hb = baseDomain(host);
        const pb = baseDomain(page);
        if (hb && pb && hb === pb) return true;
        // ④ 同组织名跨 TLD
        const ho = orgName(host);
        const po = orgName(page);
        if (ho && po && ho === po) return true;

        // ⑤ 用户显式配置的自有域
        for (const extra of (Array.isArray(extraHosts) ? extraHosts : [])) {
            const ex = normalizeHost(extra);
            if (!ex) continue;
            if (host === ex || host.endsWith('.' + ex) || baseDomain(host) === baseDomain(ex)) return true;
            const eo = orgName(ex);
            if (eo && eo === ho) return true;
        }
        return false;
    }

    /**
     * 对单个 URL 分类。
     * @returns { scope, host, base, siteRelated, reason }
     *   scope: 'site' | 'cdn' | 'noise' | 'thirdparty'
     */
    function classify(url, pageHost, extraHosts) {
        let host = '';
        try { host = normalizeHost(new URL(String(url || ''), 'http://x/').hostname); } catch { host = ''; }
        const base = baseDomain(host);
        const siteRelated = isSiteRelated(host, pageHost, extraHosts);

        if (siteRelated) return { scope: 'site', host, base, siteRelated: true, reason: '同主体' };
        if (isNoise(host)) return { scope: 'noise', host, base, siteRelated: false, reason: '统计/上报/验证码域' };
        if (isCdn(host)) return { scope: 'cdn', host, base, siteRelated: false, reason: '公共 CDN 通用库' };
        return { scope: 'thirdparty', host, base, siteRelated: false, reason: '外部域' };
    }

    /** 便捷判定：是否应当纳入「本站 JS」范围（第三方/噪声/CDN 都算否） */
    function isSiteOwnedUrl(url, pageHost, extraHosts) {
        return classify(url, pageHost, extraHosts).scope === 'site';
    }

    return {
        NOISE_DOMAINS,
        CDN_DOMAINS,
        TWO_LEVEL_SUFFIXES,
        normalizeHost,
        baseDomain,
        orgName,
        isIpLike,
        isNoise,
        isCdn,
        isSiteRelated,
        classify,
        isSiteOwnedUrl
    };
})();
