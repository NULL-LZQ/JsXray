/* =====================================================================
 * JsXray — SPA 路由提取器（Vue / React / Angular / 通用路径列表）
 * =====================================================================
 * 借鉴自 hybrid_capture_project2（extension/route_exhaustion.js）。
 *
 * 用途：
 *   ① 让「路由」分类不只依赖运行时 __vue_app__ / React Router 实例探测，
 *      而是直接从 JS 源码静态提取 —— 前端路由守卫再严也挡不住源码里的定义；
 *   ② 未访问过的路由对应的懒加载 chunk 不会出现在网络清单里，
 *      拿到路由清单后可据此逐条访问，把懒加载 JS 补齐（提高下载覆盖率）。
 *
 * 纯函数、无浏览器 API 依赖，由 background.js 通过 importScripts 加载。
 * ===================================================================== */
const RouteFinder = (function () {
    'use strict';

    const MAX_SOURCE = 3 * 1024 * 1024;
    const MAX_ROUTES = 2000;
    /* 路径必须以 / 开头且第二字符是字母数字下划线（排除 /* 注释、// 协议等） */
    const PATH_LIKE_RE = /^\/\w/;

    /* 候选路由正则，从最具体到最宽松排列 */
    const ROUTE_PATTERNS = [
        /* --- Vue Router --- */
        // createRouter({ routes: [{path:'/foo', component: ...}] })
        /routes\s*(?::\s*(?:Array<(?:RouteRecordRaw|RouteRecord\w*)>|[A-Za-z_$][\w$]*\s*[?=]))?\s*[:=]\s*\[([\s\S]{0,20000}?)\]\s*(?:\)|\]|,|;|\n)/g,
        // 懒加载 import：() => import('./views/Foo.vue')
        /\(\s*\)\s*=>\s*import\s*\(\s*["']([^"']+)["']\s*\)/g,
        // () => import(/* webpackChunkName: "foo" */ './Foo.vue')
        /import\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?["']([^"']+)["']/g,

        /* --- React Router --- */
        // <Route path="/foo" element={...} />
        /<(?:Route|IndexRoute)[\s>][\s\S]{0,800}?path\s*=\s*["']([^"']+)["']/gi,
        // { path: '/foo', element: ... }
        /\{\s*path\s*:\s*["'](\/[^"']+)["'][\s\S]{0,200}?\}/g,
        // lazy(() => import('./Foo'))
        /lazy\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*["']([^"']+)["']/g,

        /* --- Angular Router --- */
        // { path: 'foo', loadChildren: () => import('./foo/foo.module')... }
        /path\s*:\s*["']([^"']+)["'][\s\S]{0,400}?(?:loadChildren|component)[\s\S]{0,300}?import\s*\(/g,

        /* --- 通用路径字面量 --- */
        /["'](\/[A-Za-z0-9/_-]{2,200})["']/g,
        // 动态路径：/user/:id、/post/[slug]、/product/{id}
        /["'](\/[A-Za-z0-9/_{}:.[\]-]{2,200})["']/g,
        // hash 路由：href="#/user/profile"
        /href\s*=\s*["']#(\/[^"']+)["']/g
    ];

    /* 明显不是路由的路径：源文件名、依赖目录、静态资源 */
    const NOT_ROUTE_RE = /\.(?:vue|jsx?|tsx?|css|scss|less|png|svg|jpg|gif|woff2?)(?:["')\s]|$)/i;
    const SKIP_SEGMENTS = /(?:^|\/)(?:node_modules|webpack|dist|build|static|assets?|css|js|fonts?|images?|img|media|skins?|plugins?|libs?|vendor|uploads?)(?:\/|$)/i;

    /** 单段且以 / 结尾的路径（如 /skins/）是静态目录，不是 SPA 路由 */
    function isBareDir(path) {
        return /^\/[^/]+\/$/.test(path);
    }

    function isDynamicPath(path) {
        return /[:\[*?]/.test(path);
    }

    function isLikelyRoute(path) {
        if (!path || path.length < 2) return false;
        if (path === '/') return true;
        if (isBareDir(path)) return false;   // /skins/ 这类是静态目录，实测误报过
        return PATH_LIKE_RE.test(path);
    }

    function sanitizePath(path) {
        return String(path || '').replace(/^["']|["']$/g, '').trim();
    }

    /** 补齐缺失的前导斜杠：Angular 的 `path: 'orders'`、React 的 `path="dashboard"`
     *  都是合法路由，但采集到的字面量没有前导 `/`。 */
    function normalizeRoutePath(path) {
        const p = sanitizePath(path);
        if (!p) return '';
        if (p.startsWith('#') || p.startsWith('/') || /^https?:\/\//i.test(p)) return p;
        return '/' + p;
    }

    /**
     * 从 JS 源码提取去重后的路由。
     * @returns [{ path, raw, isDynamic, pattern }]
     */
    function extractRoutes(source, scriptUrl) {
        if (!source || typeof source !== 'string' || source.length < 24) return [];
        if (source.length > MAX_SOURCE) source = source.slice(0, MAX_SOURCE);

        const routes = new Map();

        for (const pattern of ROUTE_PATTERNS) {
            if (routes.size >= MAX_ROUTES) break;
            pattern.lastIndex = 0;
            for (const match of source.matchAll(pattern)) {
                const raw = match[1] || '';
                const path = normalizeRoutePath(raw);
                if (!path || !isLikelyRoute(path)) continue;
                if (NOT_ROUTE_RE.test(raw)) continue;
                if (SKIP_SEGMENTS.test(path)) continue;
                if (!routes.has(path)) {
                    routes.set(path, {
                        path,
                        raw,
                        isDynamic: isDynamicPath(path),
                        pattern: String(pattern).slice(0, 80)
                    });
                }
                if (routes.size >= MAX_ROUTES) break;
            }
        }

        return Array.from(routes.values());
    }

    /** 把路由路径解析为可访问的绝对 URL（支持 hash 路由） */
    function resolveRouteUrl(route, baseUrl) {
        try {
            const base = new URL(baseUrl);
            base.hash = '';
            if (String(route).startsWith('#')) {
                base.hash = route;
                return base.toString();
            }
            if (/^https?:\/\//i.test(route)) return new URL(route).toString();
            base.pathname = route.startsWith('/') ? route : '/' + route;
            base.search = '';
            return base.toString();
        } catch {
            return '';
        }
    }

    /**
     * 路由 → 绝对 URL 列表。默认只返回**静态路由**：
     * 动态路由（/:id、/[...slug]）缺少具体参数，盲目访问只会得到 404 或错误页。
     */
    function routesToUrls(routes, baseUrl, opts = {}) {
        const urls = new Set();
        for (const r of routes) {
            const path = typeof r === 'string' ? r : (r && r.path);
            if (!path) continue;
            const dynamic = typeof r === 'string' ? isDynamicPath(path) : !!r.isDynamic;
            if (dynamic && !opts.includeDynamic) continue;
            const url = resolveRouteUrl(path, baseUrl);
            if (url) urls.add(url);
        }
        return Array.from(urls);
    }

    /**
     * 合并多份提取结果并做整体去重排序（供 background 汇总多脚本用）。
     * @returns { routes: [...], stats: { total, static: n, dynamic: n } }
     */
    function mergeRoutes(bags) {
        const map = new Map();
        for (const bag of bags || []) {
            for (const r of bag || []) {
                if (!r || !r.path || map.has(r.path)) continue;
                map.set(r.path, r);
            }
        }
        const routes = Array.from(map.values());
        const dynamic = routes.filter(r => r.isDynamic).length;
        return { routes, stats: { total: routes.length, static: routes.length - dynamic, dynamic } };
    }

    return {
        extractRoutes,
        routesToUrls,
        resolveRouteUrl,
        mergeRoutes,
        isDynamicPath,
        isLikelyRoute,
        MAX_ROUTES
    };
})();
