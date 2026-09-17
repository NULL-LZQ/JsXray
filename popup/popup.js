/* JsXray — popup 逻辑 */
'use strict';
const API = (typeof browser !== 'undefined') ? browser : chrome;

const MODE_KEY = 'le_mode';
const GLOBAL_KEY = 'le_global_hooks';
const THEME_KEY = 'le_theme';

/* ====================== 主题切换 ====================== */
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const icon = document.getElementById('theme-icon');
    if (icon) {
        // 浅色显示月亮（点击切深色），深色显示太阳（点击切浅色）
        icon.innerHTML = theme === 'dark'
            ? '<path fill="currentColor" d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"/>'
            : '<path fill="currentColor" d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/>';
    }
}
function initTheme() {
    API.storage.local.get([THEME_KEY], (d) => {
        applyTheme(d[THEME_KEY] || 'light');
    });
    const btn = document.getElementById('theme-btn');
    if (btn) {
        btn.onclick = () => {
            const cur = document.documentElement.getAttribute('data-theme') || 'light';
            const next = cur === 'dark' ? 'light' : 'dark';
            applyTheme(next);
            API.storage.local.set({ [THEME_KEY]: next });
        };
    }
}

const State = {
    tabId: null, hostname: '', currentTab: null,
    page: 'scanner',
    frameResults: {}, currentFrame: '0',
    allHooks: [], enabledHooks: [], isGlobal: false,
    hookSub: 'antidebug', routeSub: 'vue',
    vueClear: { nav: false, guards: false },
    vueRoutes: null, reactRoutes: null,
    scannerSearch: ''
};

/* ====================== 工具 ====================== */
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));
function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1500);
}
async function getTab() {
    const tabs = await API.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
}
// 后台消息：Service Worker 冷启动 / 刚重载时首条消息可能找不到接收端，
// 对 "Receiving end does not exist" 做有限重试，避免一次抖动就把 UI 判成「后台未就绪」
function sendBg(type, payload = {}, retries = 3) {
    return new Promise((resolve) => {
        let attempt = 0;
        const once = () => {
            attempt++;
            let settled = false;
            const retryOr = (v) => {
                if (settled) return;
                settled = true;
                if (attempt < retries) setTimeout(once, 200 * attempt);
                else resolve(v);
            };
            try {
                API.runtime.sendMessage({ ...payload, type, to: 'background' }, (r) => {
                    const err = API.runtime.lastError;
                    if (err) { settled = false; return retryOr(null); }
                    if (settled) return;
                    settled = true;
                    resolve(r);
                });
            } catch (e) {
                retryOr(null);
            }
        };
        once();
    });
}
function sendTab(type, payload = {}) {
    if (!State.tabId) return Promise.resolve();
    return new Promise(r => API.tabs.sendMessage(State.tabId, { ...payload, type }, r));
}

/* ====================== 导航 ====================== */
$$('.nav-btn').forEach(btn => btn.addEventListener('click', () => switchPage(btn.dataset.page)));
function switchPage(page) {
    State.page = page;
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    $$('.page').forEach(p => p.classList.toggle('active', p.dataset.page === page));
    if (page === 'finger') renderFingerprints();
    if (page === 'hooks') renderHooks();
    if (page === 'routes') {
        renderRoutes();
        renderVueClearPanel();
        // 进入路由页时主动触发一次重扫（SPA 可能已变更）
        if (State.tabId) {
            sendTab('GET_RESULTS').catch(() => {});
        }
    }
    if (page === 'guard') initGuardPage();
    if (page === 'bucket') initBucketPage();
    if (page === 'settings') { loadConsoleLogs().catch(() => {}); loadHealth().catch(() => {}); }
}

/* ====================== 扫描结果页 ====================== */
const SECTION_DEFS = [
    ['domains', '域名'], ['routes', '页面路由'], ['absoluteApis', 'API(绝对路径)', true],
    ['apis', 'API(相对路径)', true], ['moduleFiles', '模块路径'], ['docFiles', '文档文件'],
    ['credentials', '用户名密码'], ['cookies', 'Cookie'], ['idKeys', 'ID密钥'],
    ['privateKeys', '私钥/证书'], ['dbConns', '数据库连接'], ['mqConns', '消息队列'], ['ossEndpoints', '对象存储'],
    ['phones', '手机号'], ['emails', '邮箱'], ['idcards', '身份证号'], ['ips', 'IP地址'],
    ['jwts', 'JWT Token'], ['companies', '公司机构'], ['windowsPaths', 'Windows路径'], ['linuxPaths', 'Linux路径'],
    ['sourceMaps', 'SourceMap'], ['githubUrls', 'GitHub链接'], ['vueFiles', 'Vue文件'], ['jsFiles', 'JS文件'],
    ['thirdPartyLibs', 'JS库'], ['imageFiles', '图片音频'], ['iframes', 'Iframe'], ['urls', 'URL'],
    ['fingers', '页面指纹'],
    // —— 借鉴 HAPPY.JS.v1.5.0 ——
    ['baseUrls', '接口 baseURL(识别)'], ['unauthApis', '接口未授权(绕过扫描)', true],
    ['infoLeakage', '信息泄露(多关键字 AND)']
];

API.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SCAN_UPDATE' && msg.tabId === State.tabId) onScanUpdate(msg);
    if (msg.type === 'VUE_ROUTER_DATA_UPDATE' && msg.hostname === State.hostname) { State.vueRoutes = msg.data; if (State.page === 'routes') renderRoutes(); }
    if (msg.type === 'REACT_ROUTER_DATA_UPDATE' && msg.hostname === State.hostname) { State.reactRoutes = msg.data; if (State.page === 'routes') renderRoutes(); }
    if (msg.type === 'MCP_STATUS') {
        McpState.status = { ...McpState.status, ...msg };
        renderMcpStatus();
    }
    if (msg.type === 'JS_DOWNLOAD_PROGRESS' && msg.tabId === State.tabId) updateDlProgress(msg.progress);
});

function onScanUpdate(msg) {
    State.frameResults[msg.frameId] = { results: msg.results, isInIframe: msg.isInIframe, frameUrl: msg.frameUrl };
    // 进度
    const pct = msg.results.progress ?? 0;
    $('#progress-badge').textContent = pct >= 100 ? '完成' : pct + '%';
    // 帧导航
    renderFrameNav();
    if (msg.frameId === State.currentFrame) renderScanner(msg.results, msg.isInIframe);
}

function renderFrameNav() {
    const ids = Object.keys(State.frameResults);
    const nav = $('#frame-nav');
    if (ids.length <= 1) { nav.style.display = 'none'; return; }
    nav.style.display = 'flex';
    nav.innerHTML = '';
    ids.sort((a, b) => a === '0' ? -1 : b === '0' ? 1 : a.localeCompare(b)).forEach(id => {
        const r = State.frameResults[id];
        let label = '主页面';
        try { if (id !== '0' && r.frameUrl) label = new URL(r.frameUrl).hostname; } catch {}
        const el = document.createElement('div');
        el.className = 'frame-tab' + (id === State.currentFrame ? ' active' : '');
        el.textContent = label; el.title = label;
        el.onclick = () => { State.currentFrame = id; renderFrameNav(); if (r) renderScanner(r.results, r.isInIframe); };
        nav.appendChild(el);
    });
}

function renderScanner(results, isInIframe) {
    const container = $('#scanner-sections');
    // 摘要
    const summary = $('#scanner-summary');
    const chips = SECTION_DEFS.filter(([k]) => Array.isArray(results[k]) && results[k].length)
        .map(([k, n]) => `<span class="summary-chip" data-key="${k}" title="点击跳到「${n}」">${n}<b>${results[k].length}</b></span>`).join('');
    summary.innerHTML = chips || '<span class="summary-chip">扫描中…</span>';

    const term = State.scannerSearch.toLowerCase();
    container.innerHTML = '';
    let any = false;
    for (const [key, name, hasUrl] of SECTION_DEFS) {
        const arr = results[key];
        if (!Array.isArray(arr) || !arr.length) continue;
        any = true;
        const sec = document.createElement('div');
        sec.className = 'section';
        sec.id = 'scanner-section-' + key;
        sec.innerHTML = `
            <div class="section-header">
                <div><span class="section-title">${name}</span><span class="section-count">(${arr.length})</span></div>
                <div class="section-actions">
                    <button class="mini-btn copy-all" data-key="${key}">复制全部</button>
                    ${hasUrl ? `<button class="mini-btn copy-url" data-key="${key}">复制URL</button>` : ''}
                </div>
            </div>
            <div class="section-items"></div>`;
        const items = $('.section-items', sec);
        arr.forEach(([v, src]) => {
            if (term && !String(v).toLowerCase().includes(term)) return;
            const it = document.createElement('div');
            it.className = 'item' + (key === 'unauthApis' ? ' item-unauth' : '');
            const isJsSrc = isJsSourceUrl(src);
            let valHtml = '';
            let clickValue = String(v);
            if (key === 'unauthApis') {
                // 值格式：/status 200 · ;.css｜完整 URL
                const m = String(v).match(/^\/status (\d+)\s*·\s*([^｜]+)｜([\s\S]+)$/);
                if (m) {
                    const code = Number(m[1]);
                    const cls = code >= 200 && code < 300 ? 'ok' : (code < 400 ? 'warn' : 'err');
                    clickValue = m[3];
                    valHtml = `<span class="item-val" title="点击复制接口 URL" data-url="${escapeHtml(m[3])}">` +
                        `<span class="res-tag ${cls}">${m[1]}</span>` +
                        `<span class="res-tag">${escapeHtml(m[2].trim())}</span>` +
                        `${escapeHtml(m[3])}</span>`;
                }
            }
            if (!valHtml) valHtml = `<span class="item-val" title="点击复制">${escapeHtml(String(v))}</span>`;
            it.innerHTML = valHtml +
                `<span class="item-src${isJsSrc ? ' item-src-link' : ''}" ` +
                `title="${isJsSrc ? '点击打开该 JS 文件' : escapeHtml(src || '')}">${escapeHtml(srcName(src))}</span>`;
            // 左侧值点击：复制（未授权行只复制 URL 本体）
            const valEl = $('.item-val', it);
            valEl.onclick = (e) => {
                e.stopPropagation();
                const raw = valEl.dataset && valEl.dataset.url ? valEl.dataset.url : clickValue;
                // Ctrl/Cmd 点击打开：相对路径先解析为绝对 URL 再开
                const t = (e.ctrlKey || e.metaKey) ? resolveUrl(raw) : raw;
                if (e.ctrlKey || e.metaKey) { API.tabs.create({ url: t }).catch(() => copy(raw)); }
                else copy(t);
            };
            // 右侧 JS 源点击：打开对应 JS 文件
            const srcEl = $('.item-src', it);
            if (srcEl) srcEl.onclick = (e) => {
                e.stopPropagation();
                if (src && isJsSourceUrl(src)) {
                    const jsUrl = resolveJsUrl(src);
                    if (jsUrl) { API.tabs.create({ url: jsUrl }).catch(() => copy(jsUrl)); }
                    else copy(String(src));
                } else if (src) {
                    copy(String(src));
                }
            };
            items.appendChild(it);
        });
        container.appendChild(sec);
    }
    if (!any) container.innerHTML = '<div class="no-results">未发现敏感信息</div>';

    // 绑定复制按钮
    // 借鉴 v1.5.0：点击顶部统计 chip 跳到对应分类（popup 内滚动容器是 .pages）
    $$('.summary-chip', container.parentElement).forEach(chip => {
        chip.onclick = () => {
            const key = chip.dataset.key;
            const target = key && document.getElementById('scanner-section-' + key);
            if (!target) return;
            const pagesEl = document.querySelector('main.pages');
            const top = target.offsetTop - ($('#scanner-summary').offsetHeight || 0) - 14;
            try {
                if (pagesEl && pagesEl.scrollHeight > pagesEl.clientHeight) pagesEl.scrollTo({ top, behavior: 'smooth' });
                else window.scrollTo({ top, behavior: 'smooth' });
            } catch { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
            target.classList.add('section-flash');
            setTimeout(() => target.classList.remove('section-flash'), 1200);
            $$('.summary-chip', container.parentElement).forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
        };
    });

    $$('.copy-all', container).forEach(b => b.onclick = () => {
        const arr = results[b.dataset.key] || [];
        copy(arr.map(x => x[0]).join('\n'));
    });
    $$('.copy-url', container).forEach(b => {
        b.onclick = async () => {
            const arr = results[b.dataset.key] || [];
            const base = State.currentTab?.url || '';
            const text = arr.map(x => {
                const v = String(x[0]).trim();
                if (!v) return '';
                // 只对看起来像路径的条目做解析，普通值（手机号/邮箱/口令等）原样输出
                if (/^https?:\/\//i.test(v)) return v;
                if (/^\/\/|^\/|^\.\.?\/|^[\w.-]+\/[\w./-]*$/.test(v)) return resolveUrl(v, base);
                return v;
            }).filter(Boolean).join('\n');
            copy(text);
        };
    });
}

/**
 * 相对路径解析（借鉴 v1.5.0）：把 '/path'、'path'、'./a'、'../a'、'?q'、'#h'、'//cdn.com/x'
 * 统一解析为绝对 URL，避免复制/打开时拼出错误地址
 */
function resolveUrl(v, base) {
    const val = String(v == null ? '' : v).trim();
    if (!val) return '';
    const b = base || State.currentTab?.url || '';
    try { return new URL(val, b).href; } catch { return val; }
}

// 判断 src 是否为可打开的源 URL（JS/页面等，排除图片字体媒体）
function isJsSourceUrl(src) {
    if (!src || typeof src !== 'string') return false;
    if (!/^https?:\/\//i.test(src)) return false;
    // 排除图片/字体/音视频（这些不宜作为"源"在新标签打开）
    return !/\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot|mp[34]|wav|webm|css)(\?|$)/i.test(src);
}
// 把 src 解析为可访问 URL（保留原样，已是绝对 URL）
function resolveJsUrl(src) {
    if (!src) return '';
    if (/^https?:\/\//i.test(src)) return src;
    return '';
}
// 给路由页/源跳转：在源 URL 上附加 source-map 友好的查看
function openJsViewer(src) {
    if (!src) return;
    API.tabs.create({ url: src }).catch(() => copy(src));
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function srcName(u) { try { return new URL(u).pathname } catch { return u || '' } }
function copy(text) { navigator.clipboard.writeText(text).then(() => toast('已复制')).catch(() => toast('复制失败')); }

$('#scanner-search').addEventListener('input', (e) => {
    State.scannerSearch = e.target.value;
    const r = State.frameResults[State.currentFrame];
    if (r) renderScanner(r.results, r.isInIframe);
});
$('#export-btn').addEventListener('click', () => {
    const all = {};
    Object.entries(State.frameResults).forEach(([fid, r]) => { all[fid] = r.results; });
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `happyjs_${State.hostname || 'scan'}.json`; a.click();
    URL.revokeObjectURL(url);
    toast('已导出');
});

/* ====================== 指纹页 ====================== */
async function renderFingerprints() {
    const c = $('#finger-list');
    c.innerHTML = '<div class="loading">采集中...</div>';
    const fp = await sendBg('GET_FINGERPRINTS', { tabId: State.tabId });
    if (!fp) { c.innerHTML = '<div class="loading">点击页面后刷新以采集指纹</div>'; return; }
    const groups = { server: '服务器', component: '组件', technology: '语言/技术', framework: '框架', os: '操作系统', security: '安全/WAF', cdn: 'CDN', analytics: '统计分析', builder: '构建工具', panel: '面板' };
    let any = false;
    c.innerHTML = '';
    for (const [type, label] of Object.entries(groups)) {
        const items = fp[type] || [];
        if (!items.length) continue;
        any = true;
        const g = document.createElement('div');
        g.className = 'finger-group';
        g.innerHTML = `<h3><span class="finger-tag">${label}</span> ${items.length} 项</h3>`;
        items.forEach(it => {
            const d = document.createElement('div');
            d.className = 'finger-item';
            d.innerHTML = `<div class="finger-name">${escapeHtml(it.name)}</div><div class="finger-desc">${escapeHtml(it.description || '')}</div>`;
            g.appendChild(d);
        });
        c.appendChild(g);
    }
    if (!any) c.innerHTML = '<div class="loading">暂未识别到指纹</div>';
}

/* ====================== Hook 页 ====================== */
async function loadHooks() {
    if (State.allHooks.length) return;
    State.allHooks = await fetch(API.runtime.getURL('hooks.json')).then(r => r.json());
}
async function loadHookState() {
    const data = await new Promise(r => API.storage.local.get([MODE_KEY, GLOBAL_KEY, State.hostname], r));
    State.isGlobal = data[MODE_KEY] === 'global';
    State.enabledHooks = State.isGlobal ? (data[GLOBAL_KEY] || []) : (data[State.hostname] || []);
    $('#global-mode').checked = State.isGlobal;
    updateModeBadge();
}
function updateModeBadge() { $('#mode-badge').textContent = State.isGlobal ? '全局模式' : '标准模式'; }

$$('.hooks-subtabs .subtab').forEach(b => b.onclick = () => {
    $$('.hooks-subtabs .subtab').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); State.hookSub = b.dataset.sub; renderHooks();
});
$('#hooks-search').addEventListener('input', () => renderHooks());

async function renderHooks() {
    await loadHooks();
    const health = await sendBg('GET_HOOK_HEALTH');
    renderHookHealth(health);
    const term = $('#hooks-search').value.toLowerCase().trim();
    const list = $('#hooks-list');
    list.innerHTML = '';
    const hooks = State.allHooks.filter(h => h.category === State.hookSub && !h.hidden)
        .filter(h => !term || h.name.toLowerCase().includes(term) || h.description.toLowerCase().includes(term));
    if (!hooks.length) { list.innerHTML = '<div class="empty-state">无匹配 Hook</div>'; return; }
    for (const h of hooks) list.appendChild(await buildHookCard(h));
}

// Hook 脚本文件健康检查：文件缺失时明确告警（历史上存在命名不一致导致 Hook 静默失效）
function renderHookHealth(health) {
    const el = $('#hook-health');
    if (!el) return;
    const missing = (health && health.missing) || [];
    if (!health || health.available === false && !missing.length) {
        el.style.display = 'block';
        el.innerHTML = '无法读取 Hook 元数据（hooks.json），请检查扩展文件完整性';
        el.className = 'hook-health err';
        return;
    }
    if (!missing.length) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.className = 'hook-health err';
    el.innerHTML = `⚠ ${missing.length} 个 Hook 脚本文件缺失，启用后不会生效：<b>${escapeHtml(missing.join(', '))}</b><br>` +
        `<span style="color:var(--text-mute)">请在扩展目录 hooks/ 下补齐对应脚本，或在 hooks.json 中修正 file 字段</span>`;
}

async function buildHookCard(h) {
    const enabled = State.enabledHooks.includes(h.id);
    const cfg = await new Promise(r => API.storage.local.get([`${h.id}_config`], d => r(d[`${h.id}_config`] || {})));
    const card = document.createElement('div');
    card.className = 'hook-card' + (enabled ? ' enabled' : '');

    const isFixed = h.fixed_variate === 1;
    const hasParam = h.has_Param === 1;
    const dynSwitches = Object.keys(h).filter(k => !['id', 'name', 'description', 'category', 'fixed_variate', 'has_Param', 'value'].includes(k) && h[k] === 1);

    let controls = '';
    if (isFixed) {
        controls += `<div class="hook-input-row"><label>固定值</label><input class="hook-value" value="${escapeHtml(cfg.value ?? h.value ?? '')}" placeholder="按Enter保存"></div>`;
    }
    if (hasParam) {
        const kwEnabled = cfg.keyword_filter_enabled === true;
        const kws = (cfg.param || []).map((k, i) => `<span class="keyword-tag">${escapeHtml(k)}<span data-i="${i}">×</span></span>`).join('');
        controls += `<div class="hook-controls"><label class="toggle"><input type="checkbox" class="kw-toggle" ${kwEnabled ? 'checked' : ''}><span class="slider"></span></label><span style="font-size:10px;color:var(--text-mute)">关键字过滤</span></div>`;
        controls += `<div class="keyword-wrap">${kws}<input class="kw-input" placeholder="关键字(回车添加)" style="flex:1;min-width:80px;padding:3px 6px;border-radius:4px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:11px"></div>`;
    }
    if (dynSwitches.length) {
        controls += `<div class="hook-controls">${dynSwitches.map(k => `<button class="hook-switch-btn ${cfg[k] === 1 ? 'active' : ''}" data-sw="${k}">${k}</button>`).join('')}</div>`;
    }

    card.innerHTML = `
        <div class="hook-head">
            <div><div class="hook-name">${escapeHtml(h.name)}</div></div>
            <label class="toggle"><input type="checkbox" class="hook-main" ${enabled ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="hook-desc">${escapeHtml(h.description)}</div>
        ${controls}`;

    // 主开关
    $('.hook-main', card).onchange = (e) => onHookToggle(h.id, e.target.checked, card);
    // 固定值
    const vInput = $('.hook-value', card);
    if (vInput) vInput.onkeypress = (e) => { if (e.key === 'Enter') { saveHookCfg(h.id, c => { c.value = e.target.value; }); toast('已保存'); } };
    // 关键字开关
    const kwTog = $('.kw-toggle', card);
    if (kwTog) kwTog.onchange = (e) => saveHookCfg(h.id, c => {
        c.keyword_filter_enabled = e.target.checked;
        c.flag = e.target.checked && (c.param || []).length ? 1 : 0;
    });
    // 关键字添加
    const kwIn = $('.kw-input', card);
    if (kwIn) kwIn.onkeypress = (e) => {
        if (e.key === 'Enter' && e.target.value.trim()) {
            saveHookCfg(h.id, c => {
                c.param = c.param || [];
                if (!c.param.includes(e.target.value.trim())) { c.param.push(e.target.value.trim()); c.flag = c.keyword_filter_enabled ? 1 : 0; }
            });
            e.target.value = ''; renderHooks();
        }
    };
    // 关键字删除
    $$('.keyword-tag span', card).forEach(s => s.onclick = () => {
        const i = parseInt(s.dataset.i);
        saveHookCfg(h.id, c => { c.param = c.param || []; c.param.splice(i, 1); c.flag = c.keyword_filter_enabled && c.param.length ? 1 : 0; });
        renderHooks();
    });
    // 动态开关
    $$('.hook-switch-btn', card).forEach(b => b.onclick = () => {
        if (!State.enabledHooks.includes(h.id)) return;
        const active = b.classList.toggle('active');
        saveHookCfg(h.id, c => { c[b.dataset.sw] = active ? 1 : 0; });
    });
    // 禁用态
    if (!enabled) {
        $$('.hook-value, .kw-input, .kw-toggle, .hook-switch-btn', card).forEach(el => el.disabled = true);
    }
    return card;
}

function saveHookCfg(id, mutator) {
    return new Promise(r => {
        const key = `${id}_config`;
        API.storage.local.get([key], d => {
            const cfg = d[key] || {};
            mutator(cfg);
            API.storage.local.set({ [key]: cfg }, r);
        });
    });
}

async function onHookToggle(id, on, card) {
    if (on) { if (!State.enabledHooks.includes(id)) State.enabledHooks.push(id); card.classList.add('enabled'); }
    else { State.enabledHooks = State.enabledHooks.filter(x => x !== id); card.classList.remove('enabled'); }
    await persistHooks();
    renderHooks();
}

function persistHooks() {
    const key = State.isGlobal ? GLOBAL_KEY : State.hostname;
    return new Promise(r => {
        API.storage.local.set({ [key]: [...State.enabledHooks] }, () => {
            sendBg('update_hooks_registration', { hostname: State.isGlobal ? '*' : State.hostname, enabledHooks: State.enabledHooks, isGlobal: State.isGlobal });
            // 通知 content 更新本地状态
            sendTab('scripts_updated', { hostname: State.hostname, enabledScripts: State.enabledHooks }).catch(() => {});
            r();
        });
    });
}

/* ====================== 路由页 ====================== */
$$('.routes-subtabs .subtab').forEach(b => b.onclick = () => {
    $$('.routes-subtabs .subtab').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); State.routeSub = b.dataset.routeSub; renderRoutes(); renderVueClearPanel();
});

function renderRoutes() {
    const data = State.routeSub === 'vue' ? State.vueRoutes : State.reactRoutes;
    const info = $('#routes-info');
    const list = $('#routes-list');
    const actions = $('#routes-actions');
    if (!data) {
        info.textContent = `等待检测 ${State.routeSub === 'vue' ? 'Vue' : 'React'} 路由（请在 Hook 页确认已开启对应能力并刷新页面）`;
        list.innerHTML = ''; actions.style.display = 'none'; return;
    }
    const routes = data.routes || [];
    if (!routes.length) {
        info.textContent = `未检测到 ${State.routeSub === 'vue' ? 'Vue' : 'React'} 路由`;
        list.innerHTML = ''; actions.style.display = 'none'; return;
    }
    info.innerHTML = `检测到 <b style="color:var(--accent)">${routes.length}</b> 条路由${data.version ? `（${data.version}）` : ''}`;
    actions.style.display = 'flex';
    list.innerHTML = '';
    const origin = State.currentTab?.url ? new URL(State.currentTab.url).origin : location.origin;
    routes.forEach(r => {
        const path = r.startsWith('/') ? r : '/' + r;
        const full = (data.routerMode === 'hash') ? `${origin}/#${path}` : `${origin}${path}`;
        const el = document.createElement('div');
        el.className = 'route-item';
        el.innerHTML = `<span class="route-url" title="${escapeHtml(full)}">${escapeHtml(full)}</span>
            <div class="route-actions"><button class="mini-btn r-copy">复制</button><button class="mini-btn r-open">打开</button></div>`;
        $('.r-copy', el).onclick = () => copy(full);
        $('.r-open', el).onclick = () => { if (State.tabId) API.tabs.update(State.tabId, { url: full }); };
        list.appendChild(el);
    });
    $('#copy-all-paths').onclick = () => copy(routes.map(r => r.startsWith('/') ? r : '/' + r).join('\n'));
    $('#copy-all-urls').onclick = () => copy(routes.map(r => {
        const p = r.startsWith('/') ? r : '/' + r;
        return (data.routerMode === 'hash') ? `${origin}/#${p}` : `${origin}${p}`;
    }).join('\n'));
}

/* ====================== 设置页 ====================== */
async function loadSettings() {
    const data = await new Promise(r => API.storage.local.get([
        'dynamicScan', 'deepScan', 'customWhitelist', MODE_KEY,
        'infoLeakage', 'infoLeakageAcc', 'infoLeakageSrc', 'customBaseUrl'
    ], r));
    $('#dynamic-scan').checked = data.dynamicScan === true;
    $('#deep-scan').checked = data.deepScan === true;
    $('#whitelist-input').value = (data.customWhitelist || []).join('\n');
    $('#global-mode').checked = data[MODE_KEY] === 'global';
    // 信息泄露（多关键字 AND）：默认开启，默认准确度 2
    $('#info-leakage').checked = data.infoLeakage !== false;
    $('#info-leakage-acc').value = String(data.infoLeakageAcc || 2);
    $('#info-leakage-src').value = data.infoLeakageSrc || 'all';
    $('#custom-baseurl').value = data.customBaseUrl || '';
    // 规则条数统计（让用户知道引擎/规则有没有加载成功）
    sendBg('INFO_LEAK_GET_CFG').then(r => {
        const el = $('#info-leak-stats');
        if (!el || !r || !r.stats) return;
        const st = r.stats;
        el.innerHTML = st.engine
            ? `规则已加载：内置 <b>${st.builtin}</b> 条 + BurpAPIFinder <b>${st.burpapi}</b> 条（共 ${st.total} 条）；接口 baseURL 识别结果见扫描页「接口 baseURL」分类。`
            : '<span class="err">信息泄露引擎未加载（请重载扩展）</span>';
    }).catch(() => {});
}

/* ---------- 信息泄露（多关键字 AND）配置 ---------- */
async function pushInfoLeakCfg() {
    const patch = {
        enabled: $('#info-leakage').checked,
        acc: parseInt($('#info-leakage-acc').value, 10) || 2,
        src: $('#info-leakage-src').value || 'all'
    };
    const r = await sendBg('INFO_LEAK_SET_CFG', { patch });
    // 同步到所有已打开页面（无需刷新）
    try {
        const tabs = await API.tabs.query({});
        for (const t of tabs) {
            if (t.id == null || !/^https?:/i.test(t.url || '')) continue;
            API.tabs.sendMessage(t.id, { to: 'content', type: 'UPDATE_INFO_LEAKAGE', ...patch }).catch(() => {});
        }
    } catch {}
    return r;
}
$('#info-leakage').onchange = async (e) => {
    await pushInfoLeakCfg();
    toast(e.target.checked ? '已开启信息泄露扫描（多关键字 AND）' : '已关闭信息泄露扫描');
};
['info-leakage-acc', 'info-leakage-src'].forEach(id => {
    $('#' + id).onchange = async () => { await pushInfoLeakCfg(); toast('信息泄露规则设置已更新'); };
});
$('#custom-baseurl-save').onclick = async () => {
    const url = ($('#custom-baseurl').value || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\//i.test(url)) { toast('请填写完整 URL（含 http(s)://）'); return; }
    await new Promise(r => API.storage.local.set({ customBaseUrl: url }, r));
    try {
        const tabs = await API.tabs.query({});
        for (const t of tabs) {
            if (t.id == null || !/^https?:/i.test(t.url || '')) continue;
            API.tabs.sendMessage(t.id, { to: 'content', type: 'UPDATE_BASEURL', url }).catch(() => {});
        }
    } catch {}
    toast(url ? '接口 baseURL 已保存并同步到已打开页面' : '已清除手动 baseURL');
};

/* ====================== 接口认证绕过扫描（借鉴 v1.5.0） ======================
 * 只发出「不带 Cookie 的只读 GET」，并且：
 *   · 自动跳过登出/删除/改名等破坏性接口（用户的会话与数据不受影响）
 *   · 过滤静态资源与日期格式等噪声候选
 *   · 读取响应体识别「请先登录 / code:401」类假阳性
 *   · 命中风控（429/503/412）立即停止
 * ========================================================================== */
const AuthUI = { busy: false };
function setAuthProgress(text, pct) {
    const box = $('#auth-progress');
    if (!box) return;
    if (text == null) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    $('#auth-progress-text').textContent = text;
    $('#auth-bar-i').style.width = (pct == null ? 100 : pct) + '%';
}
$('#auth-bypass-btn').onclick = async () => {
    if (!State.tabId) { toast('请在网页中使用'); return; }
    if (AuthUI.busy) { toast('认证扫描进行中…'); return; }
    AuthUI.busy = true;
    const btn = $('#auth-bypass-btn');
    btn.disabled = true;
    setAuthProgress('正在收集候选接口…', 5);
    try {
        const cand = await sendBg('GET_AUTH_BYPASS_CANDIDATES', { tabId: State.tabId, limit: 60 });
        if (!cand || !cand.ok) {
            setAuthProgress(null);
            toast('获取接口失败：' + ((cand && cand.error) || '页面未加载完成，可先刷新页面'));
            return;
        }
        if (!cand.apis || !cand.apis.length) {
            setAuthProgress(null);
            toast('未发现可探测的接口（可先等待扫描完成或开深度扫描）');
            return;
        }
        const cfg = ((await sendBg('AB_GET_CFG')) || {}).cfg || {};
        const limit = cfg.limit || 12;
        setAuthProgress(`探测中（最多 ${limit} 个接口 × 14 变体，只读 GET）…`, 30);
        const res = await sendBg('RUN_AUTH_BYPASS', { tabId: State.tabId, limit });
        if (!res || res.ok === false) {
            setAuthProgress(null);
            toast('探测失败：' + ((res && res.error) || '未知错误'));
            return;
        }
        setAuthProgress(null);
        const meta = res.meta || {};
        const parts = [`探测 ${res.probed || 0}/${res.total || 0} 个变体`];
        if (res.unauthCount) parts.push(`未授权 ${res.unauthCount} 个`);
        if (meta.skippedDanger && meta.skippedDanger.length) parts.push(`跳过危险接口 ${meta.skippedDanger.length} 个`);
        if (meta.skippedNoiseCount) parts.push(`跳过噪声候选 ${meta.skippedNoiseCount} 个`);
        toast(parts.join(' · '));
        if (res.abortReason) toast(res.abortReason);
        if (!res.unauthCount) showAuthHint('本次未发现未授权访问的接口（已过滤登录跳转与鉴权失败响应）');
        else showAuthHint(null);
    } catch (e) {
        setAuthProgress(null);
        toast('认证扫描异常：' + ((e && e.message) || e));
    } finally {
        AuthUI.busy = false;
        btn.disabled = false;
    }
};
function showAuthHint(text) {
    const el = $('#dl-stat-hint');
    if (!el) return;
    el.style.display = text ? 'block' : 'none';
    el.textContent = text || '';
}
$('#dynamic-scan').onchange = (e) => {
    API.storage.local.set({ dynamicScan: e.target.checked });
    sendTab('UPDATE_DYNAMIC_SCAN', { enabled: e.target.checked }).catch(() => {});
    toast(e.target.checked ? '已开启动态扫描' : '已关闭动态扫描');
};
$('#deep-scan').onchange = (e) => {
    API.storage.local.set({ deepScan: e.target.checked });
    sendTab('UPDATE_DEEP_SCAN', { enabled: e.target.checked }).catch(() => {});
    toast(e.target.checked ? '已开启深度扫描' : '已关闭深度扫描');
};
$('#global-mode').onchange = async (e) => {
    const wasGlobal = State.isGlobal;
    State.isGlobal = e.target.checked;
    API.storage.local.set({ [MODE_KEY]: State.isGlobal ? 'global' : 'standard' });
    sendBg('clear_mode_hooks', { clearGlobal: wasGlobal });
    // 切换数据源
    const key = State.isGlobal ? GLOBAL_KEY : State.hostname;
    const data = await new Promise(r => API.storage.local.get([key], r));
    State.enabledHooks = data[key] || [];
    updateModeBadge();
    persistHooks();
    toast(State.isGlobal ? '已切换全局模式' : '已切换标准模式');
};
$('#save-whitelist').onclick = () => {
    const wl = $('#whitelist-input').value.split('\n').map(s => s.trim()).filter(Boolean);
    API.storage.local.set({ customWhitelist: wl });
    toast('白名单已保存');
};

/* ====================== MCP 服务 ====================== */
const McpState = { status: null };
const MCP_STATUS_TEXT = {
    disabled: '未启用', connecting: '连接桥接中…',
    connected: '已连接桥接进程', error: '未连接（桥接未启动）',
    'no-bg': '后台未响应（点下方「重载扩展」）'
};

async function loadMcpSettings() {
    let st = await sendBg('MCP_GET_STATUS');
    if (!st) {
        // 后台完全没响应：从存储兜底渲染配置，并在自检区给出诊断入口
        const d = await new Promise(r => API.storage.local.get(['le_mcp_cfg'], r));
        const cfg = d.le_mcp_cfg || {};
        st = {
            enabled: !!cfg.enabled, port: cfg.port || 10087, token: cfg.token || '',
            status: 'no-bg', lastError: '后台 Service Worker 未响应（已自动重试 3 次）。点「运行状态自检 → 重载扩展」后重开本弹窗'
        };
    }
    McpState.status = st;
    $('#mcp-enabled').checked = !!st.enabled;
    $('#mcp-port').value = st.port || 10087;
    renderMcpStatus();
    renderMcpConfig();
}
function renderMcpStatus() {
    const el = $('#mcp-status');
    const st = McpState.status;
    if (!el || !st) return;
    el.dataset.state = st.status === 'no-bg' ? 'error' : (st.status || 'disabled');
    let text = MCP_STATUS_TEXT[st.status] || st.status;
    if (st.status === 'connected' && st.connectedPort) text += ` · ${st.connectedPort}`;
    else if (st.status === 'error' && (st.candidates || []).length) text += `（试过 ${st.candidates.join('/')}）`;
    el.textContent = text;
    el.title = st.lastError || '';
}
function renderMcpConfig() {
    const st = McpState.status;
    if (!st) return;
    const fmt = $('#mcp-config-fmt').value;
    const port = String($('#mcp-port').value || st.port || 10087);
    const token = st.token || '<开启服务后自动生成>';
    const serverPath = '<扩展目录>/mcp/server.js';
    let text;
    if (fmt === 'toml') {
        text = '# Codex：追加到 ~/.codex/config.toml\n' +
            '[mcp_servers.happy-js]\n' +
            'command = "node"\n' +
            `args = ["${serverPath}", "--port", "${port}", "--token", "${token}"]`;
    } else {
        text = JSON.stringify({
            mcpServers: {
                'happy-js': {
                    command: 'node',
                    args: [serverPath, '--port', port, '--token', token]
                }
            }
        }, null, 2);
    }
    $('#mcp-config-text').value = text;
}

$('#mcp-enabled').onchange = async (e) => {
    const st = await sendBg('MCP_SET_ENABLED', { enabled: e.target.checked });
    if (!st) {
        // 后台未重载/未响应：回退开关并提示
        e.target.checked = !e.target.checked;
        McpState.status = { ...(McpState.status || {}), status: 'no-bg', lastError: '后台未响应，请在 chrome://extensions 重载扩展' };
        renderMcpStatus();
        toast('后台未响应，请先重载扩展');
        return;
    }
    McpState.status = st;
    renderMcpStatus();
    renderMcpConfig();
    toast(e.target.checked ? 'MCP 服务已开启，等待桥接进程连接' : 'MCP 服务已关闭');
};
$('#mcp-port').onchange = async (e) => {
    const port = parseInt(e.target.value, 10);
    const st = await sendBg('MCP_SET_PORT', { port });
    if (!st || st.error) {
        toast((st && st.error) || '端口保存失败');
        e.target.value = (McpState.status && McpState.status.port) || 10087;
        return;
    }
    McpState.status = st;
    renderMcpStatus();
    renderMcpConfig();
    toast(`端口已保存为 ${st.port}，请同步修改 AI 工具配置里的 --port`);
    // 端口变更后配置片段要立即反映，并刷新自检
    loadHealth().catch(() => {});
};
$('#mcp-config-fmt').onchange = renderMcpConfig;
$('#mcp-copy-config').onclick = () => copy($('#mcp-config-text').value);
$('#mcp-regen-token').onclick = async () => {
    const st = await sendBg('MCP_REGEN_TOKEN');
    if (st) { McpState.status = st; renderMcpConfig(); toast('令牌已重置，请同步更新 AI 工具配置'); }
};

/* ====================== 一键下载 JS / JS 资源面板 ====================== */
const DL_DEFAULT_DIR = '{url}';              // 默认：以目标网站 URL 命名的文件夹
const DlUI = { cfg: null, resources: [], busy: false, hasApi: true, plan: null, previewTimer: null, excludedFailed: 0 };

/** 去掉首尾引号：从资源管理器「复制为路径」粘来的通常是 "D:////dir////js" */
function stripQuotes(raw) {
    let t = String(raw == null ? '' : raw).trim();
    const m = t.match(/^(["'`“”‘’])([\s\S]*)\1$/);
    if (m) t = m[2].trim();
    return t.replace(/^["'`“”‘’]+/, '').replace(/["'`“”‘’]+$/, '').trim();
}
function isAbsPath(p) {
    const t = stripQuotes(p);
    return /^[a-zA-Z]:[\\/]/.test(t) || /^[\\/]/.test(t);
}

/** 直写模式下目录模板作为「所选目录内的子路径」；绝对路径忽略并退回 {url} */
function fsSubTemplate(raw) {
    const d = stripQuotes(raw);
    if (!d) return DL_DEFAULT_DIR;
    if (isAbsPath(d)) return DL_DEFAULT_DIR;
    return d;
}

function setFsRowVisible(id, on) {
    const el = $('#' + id);
    if (el) el.style.display = on ? 'flex' : 'none';
}
async function refreshFsName() {
    const n = (typeof FsDl !== 'undefined' && FsDl.currentName && FsDl.currentName()) || '';
    if (FsDl && typeof FsDl.ensure === 'function' && !n) { try { await FsDl.ensure(false); } catch {} }
    const name = (typeof FsDl !== 'undefined' && FsDl.currentName && FsDl.currentName()) || '';
    const txt = name ? name + '（已记住）' : '未选择（点「开始下载」后在下载面板里选）';
    ['#dl-fs-name', '#dlcfg-fs-name'].forEach(sel => { const el = $(sel); if (el) el.textContent = txt; });
}

async function loadDownloadCfg() {
    const r = await sendBg('DL_GET_CFG');
    if (!r) return;
    DlUI.cfg = r.cfg || {};
    DlUI.hasApi = r.hasApi !== false;
    const c = DlUI.cfg;
    $('#dlcfg-dir').value = stripQuotes(c.dir) || DL_DEFAULT_DIR;
    $('#dlcfg-format').value = c.format || 'files';
    $('#dlcfg-conflict').value = c.conflictAction || 'uniquify';
    $('#dlcfg-max').value = c.maxCount || 500;
    $('#dlcfg-flatten').checked = c.flatten === true;
    $('#dlcfg-sitefolder').checked = c.siteFolder !== false;
    $('#dlcfg-saveas').checked = c.saveAs === true;
    $('#dlcfg-third').checked = c.includeThirdParty === true;
    $('#dlcfg-skipmin').checked = c.skipMin === true;
    $('#dlcfg-engine').value = c.engine === 'fs' ? 'fs' : 'downloads';
    setFsRowVisible('dlcfg-fs-row', c.engine === 'fs');
    syncDlModalFromCfg(c);
    refreshFsName().catch(() => {});
    updateCfgPreview().catch(() => {});
}

function syncDlModalFromCfg(c) {
    const engine = c.engine === 'fs' ? 'fs' : 'downloads';
    $('#dl-dir').value = stripQuotes(c.dir) || DL_DEFAULT_DIR;
    $('#dl-format').value = (c.format && c.format !== 'zip+list') ? c.format : 'files';
    $('#dl-flatten').checked = c.flatten === true;
    $('#dl-sitefolder').checked = c.siteFolder !== false;
    $('#dl-saveas').checked = c.saveAs === true;
    $('#dl-third').checked = c.includeThirdParty === true;
    $('#dl-skipmin').checked = c.skipMin === true;
    $('#dl-scope').value = c.includeThirdParty ? 'all' : 'sameOrigin';
    $('#dl-engine').value = engine;
    setFsRowVisible('dl-fs-row', engine === 'fs');
}

function collectDlFormCfg() {
    const scope = $('#dl-scope').value;
    return {
        dir: stripQuotes($('#dl-dir').value) || DL_DEFAULT_DIR,
        engine: $('#dl-engine').value === 'fs' ? 'fs' : 'downloads',
        format: $('#dl-format').value,
        flatten: $('#dl-flatten').checked,
        siteFolder: $('#dl-sitefolder').checked,
        saveAs: $('#dl-saveas').checked,
        includeThirdParty: scope === 'all' || scope === 'thirdParty' || $('#dl-third').checked,
        skipMin: $('#dl-skipmin').checked,
        conflictAction: (DlUI.cfg && DlUI.cfg.conflictAction) || 'uniquify',
        scope
    };
}

$('#dlcfg-save').onclick = async () => {
    const patch = {
        dir: stripQuotes($('#dlcfg-dir').value) || DL_DEFAULT_DIR,
        engine: $('#dlcfg-engine').value === 'fs' ? 'fs' : 'downloads',
        siteFolder: $('#dlcfg-sitefolder').checked,
        format: $('#dlcfg-format').value,
        conflictAction: $('#dlcfg-conflict').value,
        maxCount: Math.min(Math.max(1, parseInt($('#dlcfg-max').value, 10) || 500), 3000),
        flatten: $('#dlcfg-flatten').checked,
        saveAs: $('#dlcfg-saveas').checked,
        includeThirdParty: $('#dlcfg-third').checked,
        skipMin: $('#dlcfg-skipmin').checked
    };
    const r = await sendBg('DL_SET_CFG', { patch });
    if (r && r.cfg) { DlUI.cfg = r.cfg; syncDlModalFromCfg(r.cfg); setFsRowVisible('dlcfg-fs-row', r.cfg.engine === 'fs'); toast('下载设置已保存'); }
    else toast('保存失败');
};

/* ---------- 保存方式切换 / 实时路径预览 ---------- */
async function updateDlPreview() {
    const o = collectDlFormCfg();
    const el = $('#dl-dir-preview');
    const hint = $('#dl-engine-hint');
    const setHint = (msg) => {
        if (!hint) return;
        hint.style.display = msg ? 'block' : 'none';
        hint.textContent = msg || '';
    };
    if (o.engine === 'fs') {
        const rootName = (typeof FsDl !== 'undefined' && FsDl.currentName && FsDl.currentName()) || '<所选目录>';
        const plan = await sendBg('DL_PLAN', {
            tabId: State.tabId, pageUrl: State.currentTab?.url || '',
            noCollect: true,   // 预览只需要目录与站点名，不做全量采集
            dir: fsSubTemplate(o.dir), siteFolder: o.siteFolder, flatten: o.flatten
        });
        const sub = plan && plan.dir ? plan.dir + '/' : '';
        if (el) el.textContent = `真实路径：${rootName}\\${sub ? sub.replace(/\//g, '\\') : ''}…`;
        setHint(!DlUI.fsOk
            ? '当前浏览器不支持「直写本地目录」（需 Chrome / Edge 86+），将回退为浏览器下载。'
            : '直写模式：点「开始下载」会打开下载面板标签页，在那里选择任意文件夹；'
              + '扩展会自动在下面建出「目标网站 URL」文件夹，全程无需 downloads 权限，可以关掉本弹窗。');
        return;
    }
    const plan = await sendBg('DL_PLAN', {
        tabId: State.tabId, pageUrl: State.currentTab?.url || '',
        noCollect: true,
        dir: o.dir, siteFolder: o.siteFolder, flatten: o.flatten
    });
    if (plan && plan.error) { if (el) el.textContent = '真实路径：解析失败'; return; }
    const abs = plan && plan.absolute;
    if (el) {
        el.textContent = abs
            ? `真实路径：${plan.dir || '{url}'}/…（相对浏览器默认下载目录）`
            : `<浏览器默认下载目录>/` + (plan && plan.dir ? plan.dir + '/' : '') + '…';
    }
    if (abs) {
        setHint(`「${plan.absoluteRaw}」是绝对路径：浏览器下载接口只接受相对「默认下载目录」的路径。`
            + (DlUI.fsOk ? '已可改用「直写本地目录」模式真正写入该目录（点上面的保存方式切换）。' : ''));
    } else {
        setHint('');
    }
}

function scheduleDlPreview() {
    if (DlUI.previewTimer) clearTimeout(DlUI.previewTimer);
    DlUI.previewTimer = setTimeout(() => { updateDlPreview().catch(() => {}); }, 250);
}

$('#dl-engine').onchange = async () => {
    const fs = $('#dl-engine').value === 'fs';
    setFsRowVisible('dl-fs-row', fs);
    if (fs && !DlUI.fsOk) toast('当前浏览器不支持直写目录，将回退为浏览器下载');
    scheduleDlPreview();
    refreshFsName().catch(() => {});
    // 选择的保存方式记入默认配置，下次打开弹窗保持一致
    const r = await sendBg('DL_SET_CFG', { patch: { engine: fs ? 'fs' : 'downloads' } });
    if (r && r.cfg) {
        DlUI.cfg = r.cfg;
        const el = $('#dlcfg-engine');
        if (el) el.value = r.cfg.engine === 'fs' ? 'fs' : 'downloads';
        setFsRowVisible('dlcfg-fs-row', r.cfg.engine === 'fs');
    }
};
$('#dl-sitefolder').onchange = scheduleDlPreview;
$('#dl-flatten').onchange = scheduleDlPreview;
$('#dl-dir').oninput = () => {
    const v = stripQuotes($('#dl-dir').value);
    // 检测到绝对路径：浏览器下载写不进去 → 自动切到直写模式
    if (isAbsPath(v) && $('#dl-engine').value === 'downloads' && DlUI.fsOk) {
        $('#dl-engine').value = 'fs';
        setFsRowVisible('dl-fs-row', true);
        sendBg('DL_SET_CFG', { patch: { engine: 'fs' } }).catch(() => {});
        toast('已自动切换到「直写本地目录」模式');
    }
    scheduleDlPreview();
};
$('#dl-presets').onclick = (e) => {
    const tpl = e.target && e.target.dataset && e.target.dataset.tpl;
    if (!tpl) return;
    $('#dl-dir').value = tpl;
    scheduleDlPreview();
};

/* ---------- 设置页：保存方式与路径预览 ---------- */
async function updateCfgPreview() {
    const el = $('#dlcfg-dir-preview');
    if (!el) return;
    const dirTpl = ($('#dlcfg-dir').value || '').trim() || DL_DEFAULT_DIR;
    const engine = $('#dlcfg-engine').value === 'fs' ? 'fs' : 'downloads';
    const plan = await sendBg('DL_PLAN', {
        tabId: State.tabId, pageUrl: State.currentTab?.url || '',
        noCollect: true,
        dir: engine === 'fs' ? fsSubTemplate(dirTpl) : dirTpl,
        siteFolder: $('#dlcfg-sitefolder').checked,
        flatten: $('#dlcfg-flatten').checked
    });
    if (!plan || plan.error) { el.textContent = '真实路径：—'; return; }
    if (engine === 'fs') {
        const rootName = (typeof FsDl !== 'undefined' && FsDl.currentName && FsDl.currentName()) || '<所选目录>';
        el.textContent = `真实路径：${rootName}\\${(plan.dir || '').replace(/\//g, '\\')}\\…（自动创建）`;
    } else {
        el.textContent = `真实路径：<浏览器默认下载目录>/${plan.dir ? plan.dir + '/' : ''}…` +
            (plan.absolute ? '（绝对路径会被忽略，建议改用「直写本地目录」）' : '');
    }
}
$('#dlcfg-engine').onchange = () => {
    const fs = $('#dlcfg-engine').value === 'fs';
    setFsRowVisible('dlcfg-fs-row', fs);
    if (fs && !DlUI.fsOk) toast('当前浏览器不支持直写目录，将回退为浏览器下载');
    updateCfgPreview().catch(() => {});
    refreshFsName().catch(() => {});
};
$('#dlcfg-dir').oninput = () => {
    const v = stripQuotes($('#dlcfg-dir').value);
    if (isAbsPath(v) && $('#dlcfg-engine').value === 'downloads' && DlUI.fsOk) {
        $('#dlcfg-engine').value = 'fs';
        setFsRowVisible('dlcfg-fs-row', true);
        toast('已自动切换到「直写本地目录」模式');
    }
    updateCfgPreview().catch(() => {});
};
$('#dlcfg-sitefolder').onchange = () => updateCfgPreview().catch(() => {});
$('#dlcfg-flatten').onchange = () => updateCfgPreview().catch(() => {});

/* ---------- 资源列表 ---------- */
async function loadResources(usePredict) {
    if (!State.tabId || !State.hostname) return;
    const includeThirdParty = $('#res-third').checked;
    const skipMin = $('#res-skipmin').checked;
    $('#res-items').innerHTML = usePredict
        ? '<div class="loading">正在预测补齐（分析已采集 JS 源码 + 校验合成出的文件，可能需要十几秒）…</div>'
        : '<div class="loading">正在采集资源…</div>';
    $('#resource-panel').style.display = 'block';
    const r = await sendBg('GET_JS_RESOURCES', {
        tabId: State.tabId, includeThirdParty, skipMin,
        pageUrl: State.currentTab?.url || '',
        predict: !!usePredict,
        verify: true
    }, usePredict ? 120000 : 15000);
    DlUI.resources = (r && r.list) || [];
    DlUI.predict = (r && r.predict) || null;
    DlUI.excludedFailed = (r && r.excludedFailed) || 0;
    renderResources(r);
    // 动态代码数量（blob: / eval / Function）—— Hook 开启时才有值
    sendBg('GET_DYNAMIC_CODE', { limit: 1, withCode: false }).then(d => {
        const btn = $('#res-dyn');
        if (!btn || !d) return;
        btn.textContent = d.total ? `动态代码 ${d.total}` : '动态代码';
    }).catch(() => {});
    if (usePredict) {
        if (r && r.error) { toast('预测失败：' + r.error); return; }
        toast((DlUI.predict && DlUI.predict.note) || '预测补齐完成');
    }
}

function fmtSize(n) {
    if (!n) return '';
    if (n < 1024) return n + 'B';
    if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
    return (n / 1048576).toFixed(2) + 'MB';
}

function renderResources(r) {
    const list = DlUI.resources;
    const box = $('#res-items');
    $('#resource-panel').style.display = 'block';
    $('#res-count').textContent = `(${list.length})`;
    const bytes = list.reduce((n, x) => n + (x.size || 0), 0);
    $('#res-meta').textContent = bytes ? `约 ${fmtSize(bytes)}` : '';
    if (!list.length) {
        box.innerHTML = '<div class="empty-state">未捕获到 JS 资源，请刷新目标页面后重试</div>';
        return;
    }
    box.innerHTML = '';
    list.slice(0, 300).forEach(x => {
        const row = document.createElement('div');
        row.className = 'res-item';
        const tags = [];
        if (x.status) tags.push(`<span class="res-tag ${x.status >= 400 ? 'err' : 'ok'}">${x.status}</span>`);
        if (x.size) tags.push(`<span class="res-tag">${fmtSize(x.size)}</span>`);
        // 范围标签（借鉴 hybrid_capture_project2 的域分类）：比单纯「第三方」精确得多
        const SCOPE_TAG = { site: ['site', '自有'], cdn: ['cdn', 'CDN库'], noise: ['noise', '统计域'] };
        if (x.scope && SCOPE_TAG[x.scope]) {
            const [cls, label] = SCOPE_TAG[x.scope];
            tags.push(`<span class="res-tag ${cls}">${label}</span>`);
        } else if (x.thirdParty) {
            tags.push('<span class="res-tag third">第三方</span>');
        }
        if (/\.min\.js$/i.test(x.path || '')) tags.push('<span class="res-tag warn">min</span>');
        // 来源标签：让「这个文件是哪来的」一眼可见
        const SRC_TAG = {
            'chunk-predict': ['pred', 'chunk 合成'],
            'build-manifest': ['pred', '构建清单'],
            'mf-remote': ['pred', '联邦远程'],
            performance: ['', '页面采集'],
            'script-tag': ['', '页面采集']
        };
        if (x.source && SRC_TAG[x.source]) {
            const [cls, label] = SRC_TAG[x.source];
            tags.push(`<span class="res-tag ${cls}">${label}</span>`);
        }
        row.innerHTML = `<div class="res-main">
                <div class="res-path" title="${escapeHtml(x.url)}">${escapeHtml(x.path || x.url)}</div>
                <div class="res-tags">${tags.join('')}</div>
            </div>
            <div class="res-acts">
                <button class="mini-btn res-open">打开</button>
                <button class="mini-btn res-dl">下载</button>
            </div>`;
        $('.res-path', row).onclick = () => copy(x.url);
        $('.res-open', row).onclick = () => API.tabs.create({ url: x.url }).catch(() => copy(x.url));
        $('.res-dl', row).onclick = async () => {
            const o = collectDlFormCfg();
            if (o.engine === 'fs' && DlUI.fsOk) { await startFsDownload([x.url], o, true); return; }
            const res = await sendBg('JS_DOWNLOAD', {
                tabId: State.tabId,
                // 单条下载固定用 files 形式（zip/list 是批量概念）
                opts: {
                    urls: [x.url], format: 'files', dir: o.dir,
                    flatten: o.flatten, saveAs: o.saveAs, siteFolder: o.siteFolder,
                    pageUrl: State.currentTab?.url || ''
                }
            });
            toast(res && res.ok ? '已开始下载' : ((res && res.error) || '下载失败'));
        };
        box.appendChild(row);
    });
    if (list.length > 300) {
        const more = document.createElement('div');
        more.className = 'empty-state';
        more.textContent = `还有 ${list.length - 300} 条未展示（可「下载全部」）`;
        box.appendChild(more);
    }
    renderCoverage(list);
}

/** 覆盖对账（借鉴 hybrid_capture_project2 的 js_coverage）：观测 vs 预测补齐 */
function renderCoverage(list) {
    const el = $('#res-coverage');
    if (!el) return;
    const predicted = list.filter(x => x.predicted).length;
    const observed = list.length - predicted;
    const siteList = list.filter(x => x.scope === 'site' || x.scope == null);
    const sitePred = siteList.filter(x => x.predicted).length;
    const pct = list.length ? Math.round(observed / list.length * 100) : 100;
    const p = DlUI.predict && DlUI.predict.stats;
    const extra = p
        ? ` · 分析 ${p.analyzedFiles} 个源码 · 合成 ${p.chunksSynthesized} 个候选（校验通过 ${p.verified}，404 ${p.missing}）` +
          (p.manifests && p.manifests.length ? ` · 构建清单命中 ${p.manifests.length} 处` : '') +
          (p.routes ? ` · 路由 ${p.routes}` : '')
        : '';
    el.style.display = 'block';
    el.innerHTML = `可下载 JS <b>${list.length}</b> 个：浏览器观测 ${observed} + 预测补齐 <b>${predicted}</b>` +
        `　|　覆盖率 ${pct}%` +
        (sitePred ? `　|　自有域缺口 <b>${sitePred}</b> 个` : '') +
        (DlUI.excludedFailed ? `　|　已排除 <b>${DlUI.excludedFailed}</b> 个 4xx/5xx（避免把错误页当 JS 下载）` : '') +
        (extra ? `<br><span class="res-cov-dim">${escapeHtml(extra)}</span>` : '');
}

const DlUI_PREDICT_BTN = () => $('#res-predict');
$('#res-refresh').onclick = () => loadResources();
$('#res-predict').onclick = async () => {
    const btn = DlUI_PREDICT_BTN();
    if (btn.disabled) return;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '补齐中…';
    try {
        await loadResources(true);
    } catch (e) {
        toast('预测补齐异常：' + ((e && e.message) || e));
    } finally {
        btn.disabled = false;
        btn.textContent = old;
    }
};
$('#res-dyn').onclick = async () => {
    const btn = $('#res-dyn');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
        const d = await sendBg('GET_DYNAMIC_CODE', { limit: 120, withCode: false });
        if (!d || !d.total) {
            toast('暂无动态代码：请在 Hook 页启用「动态代码捕获」后刷新目标页面');
            return;
        }
        const kinds = Object.entries(d.kinds || {}).map(([k, n]) => `${k} ${n}`).join(' · ');
        if (!confirm(`已捕获 ${d.total} 段运行时脚本（${kinds}，共 ${fmtSize(d.bytes)}）。\n\n导出为 .js 文件？`)) return;
        const o = collectDlFormCfg();
        const r = await sendBg('DL_SAVE_DYNAMIC', {
            tabId: State.tabId,
            dir: o.dir, siteFolder: o.siteFolder, flatten: o.flatten,
            pageUrl: State.currentTab?.url || ''
        }, 60000);
        if (!r || r.ok === false) { toast('导出失败：' + ((r && r.error) || '未知错误')); return; }
        toast(`已导出 ${r.savedCount}/${r.count} 段动态代码` + (r.failedCount ? `（${r.failedCount} 段失败）` : ''));
    } catch (e) {
        toast('操作异常：' + ((e && e.message) || e));
    } finally {
        btn.disabled = false;
    }
};
$('#res-third').onchange = () => loadResources();
$('#res-skipmin').onchange = () => loadResources();
$('#res-copy').onclick = () => {
    if (!DlUI.resources.length) { toast('暂无资源'); return; }
    copy(DlUI.resources.map(x => x.url).join('\n'));
};
$('#res-download').onclick = () => openDlModal(true);

/* ---------- 下载弹层 ---------- */
function openDlModal(refreshStat) {
    if (!State.tabId) { toast('请在网页中使用'); return; }
    $('#dl-modal').style.display = 'flex';
    $('#dl-result').innerHTML = '';
    if (!DlUI.hasApi) {
        // 没有 downloads 权限时不阻断：会自动回退到「页面内 Blob 落盘」，
        // 只是子目录与「每次询问保存位置」不可用
        $('#dl-stat').innerHTML = '<span class="err">未获得 downloads 权限（重载扩展后可用）</span>：' +
            '仍可下载，将回退为页面内落盘，目录结构会被拍平；也可改用「直写本地目录」模式。';
    }
    refreshFsName().catch(() => {});
    // 保存目录填的是绝对路径（如 D://js）→ 浏览器下载接口写不进去，
    // 直接切到「直写本地目录」：点开始下载就会弹出系统目录选择器
    const dv = stripQuotes($('#dl-dir').value);
    if (isAbsPath(dv) && DlUI.fsOk && $('#dl-engine').value === 'downloads') {
        $('#dl-engine').value = 'fs';
        setFsRowVisible('dl-fs-row', true);
        sendBg('DL_SET_CFG', { patch: { engine: 'fs' } }).catch(() => {});
    }
    scheduleDlPreview();
    if (refreshStat !== false) updateDlStat();
}
function closeDlModal() { $('#dl-modal').style.display = 'none'; }
$('#download-js-btn').onclick = () => openDlModal(true);
$('#dl-close').onclick = closeDlModal;
$('#dl-modal').onclick = (e) => { if (e.target.id === 'dl-modal') closeDlModal(); };

function filteredUrls() {
    const o = collectDlFormCfg();
    return DlUI.resources
        .filter(x => {
            if (o.scope === 'thirdParty') return x.thirdParty;
            if (o.scope === 'sameOrigin') return !x.thirdParty;
            return true;
        })
        .filter(x => !o.skipMin || !/\.min\.js$/i.test(x.path || ''))
        .map(x => x.url);
}

async function updateDlStat() {
    if (!DlUI.resources.length) await loadResources();
    const urls = filteredUrls();
    const bytes = DlUI.resources.filter(x => urls.includes(x.url)).reduce((n, x) => n + (x.size || 0), 0);
    const max = (DlUI.cfg && DlUI.cfg.maxCount) || 500;
    $('#dl-stat').innerHTML = `可下载 <b style="color:var(--accent)">${urls.length}</b> 个 JS` +
        (bytes ? `（约 ${fmtSize(bytes)}）` : '') +
        (urls.length > max ? ` · 超过单次上限 ${max}，仅下载前 ${max} 个` : '');
}
['dl-scope', 'dl-third', 'dl-skipmin'].forEach(id => { $('#' + id).onchange = () => { updateDlStat(); scheduleDlPreview(); }; });

$('#dl-list-btn').onclick = () => {
    const urls = filteredUrls();
    if (!urls.length) { toast('没有可导出的 URL'); return; }
    copy(urls.join('\n'));
};
// 列表为空时的一键补救：刷新目标页面让扩展重新观测请求与 DOM
$('#dl-reload').onclick = async () => {
    if (!State.tabId) { toast('请在网页中使用'); return; }
    try {
        await API.tabs.reload(State.tabId);
        toast('已刷新页面，等待 3 秒后重新采集…');
        setTimeout(() => { loadResources().then(() => updateDlStat()).catch(() => {}); }, 3000);
    } catch (e) { toast('刷新失败：' + ((e && e.message) || e)); }
};
$('#dl-save-config').onclick = async () => {
    const o = collectDlFormCfg();
    delete o.scope;   // scope 是本次下载范围，不作为默认配置持久化
    const r = await sendBg('DL_SET_CFG', { patch: { ...o, maxCount: (DlUI.cfg && DlUI.cfg.maxCount) || 500 } });
    if (r && r.cfg) { DlUI.cfg = r.cfg; await loadDownloadCfg(); toast('已存为默认设置'); }
};

function updateDlProgress(p) {
    if (!p) return;
    const total = p.total || 1;
    const pct = Math.min(100, Math.round((p.done || 0) / total * 100));
    $('#dl-progress').style.display = 'block';
    $('#dl-bar-i').style.width = pct + '%';
    const phase = { download: '下载中', fetch: '抓取源码', zip: '打包 ZIP', list: '导出清单' }[p.phase] || '处理中';
    $('#dl-progress-text').textContent = `${phase} ${p.done || 0}/${total}（${pct}%）`;
}

/** 直写本地目录：把任务交给独立的下载面板标签页执行（弹窗关掉也不会中断） */
async function startFsDownload(urls, o, single) {
    try {
        if (!DlUI.fsOk) { toast('当前浏览器不支持直写本地目录，已回退为浏览器下载'); return false; }
        const conflict = o.conflictAction === 'overwrite' ? 'overwrite'
            : (o.conflictAction === 'skip' ? 'skip' : 'rename');
        const job = {
            urls,
            dir: fsSubTemplate(o.dir),
            absHint: isAbsPath(o.dir) ? stripQuotes(o.dir) : '',
            siteFolder: o.siteFolder,
            flatten: !!o.flatten,
            conflict,
            format: 'files',
            single: !!single,
            pageUrl: State.currentTab?.url || '',
            tabId: State.tabId,
            site: State.hostname || '',
            createdAt: Date.now()
        };
        await new Promise(r => API.storage.local.set({ le_fsdl_job: job }, r));
        await API.tabs.create({ url: API.runtime.getURL('popup/dlwriter.html') });
        toast('已打开下载面板：请选择目标文件夹后开始写入');
        setTimeout(() => { try { window.close(); } catch {} }, 700);
        return true;
    } catch (e) {
        toast('打开下载面板失败：' + ((e && e.message) || e));
        return false;
    }
}

$('#dl-run').onclick = async () => {
    if (DlUI.busy) { toast('正在下载中…'); return; }
    const o = collectDlFormCfg();
    const urls = filteredUrls();
    if (!urls.length) { toast('没有可下载的 JS'); return; }
    if (o.engine === 'fs' && DlUI.fsOk) {
        if (o.format !== 'files') toast('直写模式按逐个文件写入（ZIP/清单请用浏览器下载模式）');
        await startFsDownload(urls, o);
        return;
    }
    DlUI.busy = true;
    $('#dl-run').textContent = '下载中…';
    $('#dl-result').innerHTML = '';
    $('#dl-progress').style.display = 'block';
    $('#dl-bar-i').style.width = '0%';
    $('#dl-progress-text').textContent = '准备中…';
    try {
        const res = await sendBg('JS_DOWNLOAD', {
            tabId: State.tabId,
            opts: {
                urls, format: o.format, dir: o.dir,
                flatten: o.flatten, saveAs: o.saveAs,
                siteFolder: o.siteFolder,
                includeThirdParty: o.includeThirdParty, skipMin: o.skipMin,
                scope: o.scope, pageUrl: State.currentTab?.url || ''
            }
        });
        renderDlResult(res);
    } catch (e) {
        $('#dl-result').innerHTML = `<span class="err">下载失败：${escapeHtml(String(e && e.message || e))}</span>`;
    } finally {
        DlUI.busy = false;
        $('#dl-run').textContent = '开始下载';
    }
};

function renderDlResult(res) {
    if (!res) { $('#dl-result').innerHTML = '<span class="err">后台无响应，请重载扩展后重试</span>'; return; }
    if (res.error && !res.count) { $('#dl-result').innerHTML = `<span class="err">${escapeHtml(res.error)}</span>`; return; }
    const parts = [];
    if (res.format === 'files') {
        parts.push(`<b>${res.savedCount}</b> 个文件已加入下载队列` + (res.failedCount ? `，<span class="err">${res.failedCount} 个失败</span>` : ''));
    } else if (res.format === 'list') {
        parts.push(`清单已保存：<br>${escapeHtml(res.file || '')}`);
    } else {
        parts.push(`ZIP 已生成：<b>${fmtSize(res.zipBytes)}</b>（原始 ${fmtSize(res.rawBytes)}，含 ${res.packed} 个条目）<br>${escapeHtml(res.file || '')}`);
    }
    if (res.siteFolder) parts.push(`站点文件夹：<b>${escapeHtml(res.siteFolder)}</b>`);
    if (res.skipped) parts.push(`超出上限跳过 ${res.skipped} 个`);
    if (res.note) parts.push(`<span style="color:var(--text-mute)">${escapeHtml(res.note)}</span>`);
    if (res.failed && res.failed.length) {
        parts.push('<span class="err">失败示例：</span>' + res.failed.slice(0, 5).map(f => escapeHtml((f.url || '').slice(0, 90))).join('<br>'));
    }
    if (res.saved && res.saved.length) {
        parts.push(`<span style="color:var(--text-mute)">落盘示例：</span>` + res.saved.slice(0, 3).map(s => escapeHtml(s.file || '')).join('<br>'));
    }
    $('#dl-result').innerHTML = parts.join('<br>');
    toast(res.ok ? '下载完成' : '部分文件下载失败');
}

/* ====================== 调试捕获（console / 异常） ====================== */
let ConsoleUI = { state: {} };

async function loadConsoleSettings() {
    const st = await sendBg('GET_CONSOLE_CAPTURE');
    ConsoleUI.state = st || {};
    $('#console-capture').checked = !!st.userWanted;
    renderConsoleState();
}
function renderConsoleState() {
    const el = $('#console-state');
    if (!el) return;
    const st = ConsoleUI.state || {};
    if (!st.enabled) el.textContent = '未启用';
    else if (st.mcpWanted && !st.userWanted) el.textContent = '生效中（MCP 联动）';
    else el.textContent = '生效中';
}
$('#console-capture').onchange = async (e) => {
    const r = await sendBg('SET_CONSOLE_CAPTURE', { enabled: e.target.checked });
    if (!r || r.ok === false) { e.target.checked = !e.target.checked; toast((r && r.error) || '设置失败'); return; }
    ConsoleUI.state = r;
    renderConsoleState();
    toast(e.target.checked ? '已开启捕获，刷新目标页面后生效' : '已关闭捕获');
};
$('#console-refresh').onclick = () => loadConsoleLogs();
$('#console-clear').onclick = async () => {
    await sendBg('CLEAR_CONSOLE', { tabId: State.tabId });
    loadConsoleLogs();
    toast('已清空');
};

async function loadConsoleLogs() {
    if (!State.tabId) return;
    const r = await sendBg('GET_CONSOLE', { tabId: State.tabId, limit: 120 });
    const box = $('#console-logs');
    const logs = (r && r.logs) || [];
    $('#console-count').textContent = `${(r && r.total) || 0} 条`;
    if (!logs.length) {
        box.innerHTML = '<div class="empty-state">暂无日志（开启捕获后刷新页面）</div>';
        return;
    }
    box.innerHTML = '';
    logs.slice().reverse().forEach(e => {
        const el = document.createElement('div');
        el.className = 'clog-item';
        const d = new Date(e.ts);
        const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        el.innerHTML = `<span class="clog-lv ${escapeHtml(e.level)}">${escapeHtml(e.level)}</span>` +
            `<span class="clog-text">${escapeHtml(e.text)}</span>` +
            `<span class="clog-time">${t}</span>`;
        el.title = e.url || '';
        el.querySelector('.clog-text').onclick = () => copy(e.text);
        box.appendChild(el);
    });
}

/* ====================== 运行状态自检 / CDP ====================== */
let HealthUI = { last: null };

async function loadHealth() {
    const el = $('#health-summary');
    if (!el) return;
    const h = await sendBg('GET_HEALTH');
    HealthUI.last = h;
    if (!h) {
        el.className = 'health-box bad';
        el.innerHTML = '<b>后台 Service Worker 无响应</b><br>请点击「重载扩展」，然后重新打开本弹窗。';
        return;
    }
    if (h.error) {
        el.className = 'health-box bad';
        el.innerHTML = `<b>自检失败</b><br>${escapeHtml(h.error)}`;
        return;
    }
    const rows = [];
    rows.push(`版本 ${escapeHtml(h.version || '?')} · 已运行 ${Math.round((h.uptimeMs || 0) / 1000)}s`);
    if (h.missingModules && h.missingModules.length) {
        rows.push(`<span class="err">未加载模块：${escapeHtml(h.missingModules.join(', '))}</span>`);
    } else {
        rows.push('模块加载：<b>全部正常</b>');
    }
    const perm = h.permissions || {};
    rows.push(`权限：downloads ${perm.downloads ? '✓' : '✗（需重载扩展）'} · debugger ${perm.debugger ? '✓' : '未授权'}`);
    const mcp = h.mcp || {};
    rows.push(`MCP：${escapeHtml(MCP_STATUS_TEXT[mcp.status] || mcp.status || '未知')}${mcp.connectedPort ? ' · 端口 ' + mcp.connectedPort : (mcp.port ? ' · 配置端口 ' + mcp.port : '')}`);
    if (mcp.lastError) rows.push(`<span class="err">${escapeHtml(mcp.lastError)}</span>`);
    const hooks = h.hooks || {};
    rows.push(`Hook：${(hooks.missing && hooks.missing.length) ? '<span class="err">缺文件 ' + escapeHtml(hooks.missing.join(', ')) + '</span>' : '脚本齐全'}`);
    if (h.errors && h.errors.length) {
        rows.push('<span class="err">初始化异常：<br>' + h.errors.map(e => escapeHtml(e)).join('<br>') + '</span>');
    }
    el.className = 'health-box' + (h.ok ? '' : ' bad');
    el.innerHTML = rows.join('<br>');
    renderCdpState(h);
}

function renderCdpState(h) {
    const el = $('#cdp-state');
    if (!el) return;
    const perm = (h && h.permissions) || {};
    const granted = !!perm.debugger;
    $('#cdp-enabled').checked = granted;
    el.textContent = granted ? '已授权（自动化 CDP 兜底可用）' : '未授权';
    el.dataset.state = granted ? 'connected' : '';
}

$('#health-refresh').onclick = () => { loadHealth().catch(() => {}); toast('已重新检测'); };
$('#health-copy').onclick = () => {
    if (!HealthUI.last) { toast('请先检测'); return; }
    copy(JSON.stringify(HealthUI.last, null, 2));
};
$('#health-reload').onclick = () => {
    try { API.runtime.reload(); } catch (e) { toast('重载失败：' + (e && e.message)); }
};
$('#cdp-enabled').onchange = async (e) => {
    const want = e.target.checked;
    // 关键：permissions.request 必须在「用户手势」上下文里调用，
    // 经 background 转发会丢失手势导致直接失败 → 这里由 popup 自己申请。
    try {
        const granted = want
            ? await API.permissions.request({ permissions: ['debugger'] })
            : await API.permissions.remove({ permissions: ['debugger'] });
        if (want && !granted) {
            e.target.checked = false;
            toast('未授予 debugger 权限（用户取消或浏览器拒绝）');
        } else {
            if (!want) { try { await sendBg('CDP_REVOKE'); } catch {} }
            toast(want ? '已授权：严格 CSP 站点上 execute_js 会自动走 CDP 兜底' : '已撤销 debugger 权限');
        }
    } catch (err) {
        e.target.checked = !want;
        toast('权限操作失败：' + ((err && err.message) || err));
    }
    loadHealth().catch(() => {});
};

/* =====================================================================
 * 存储桶页（融合自 谛听鉴-云存储桶风险监测 V1.1.0 + BucketTool）
 * 交互：风险记录（展开请求/响应）/ 黑白名单（增删导入导出+冲突检测）
 *       / 检测策略开关 / 高级性能参数 / 主动检测（打开日志窗口）
 * 存储键与后台 BucketSentinel、content_scan.js 完全一致。
 * ===================================================================== */
let bucketBound = false;
let bucketHistory = [];

const BUCKET_KEYS = ['bucketPassiveEnabled', 'scanPageForBuckets', 'safeModePassive', 'flagAcl',
    'flagPolicy', 'traverseBacktrack', 'detectBlacklist', 'detectWhitelist', 'whitelistMode',
    'scanMaxExternalJs', 'scanMaxInlineJs', 'scanMaxFileSize', 'scanMaxTotalCandidates'];

function bucketGetHost(item) {
    try {
        return new URL(item.url).host
            .replace(/\.oss(-[a-z0-9-]+)?\.aliyuncs\.com$/, '')
            .replace(/\.cos(-[a-z0-9-]+)?\.myqcloud\.com$/, '')
            .replace(/\.obs\.[a-z0-9-]+\.myhuaweicloud\.com$/, '');
    } catch { return item.url || ''; }
}

function bucketNormalizeEntry(str) {
    const s = String(str || '').trim();
    if (!s) return '';
    if (s.startsWith('*.')) return s.toLowerCase();
    try { return new URL(s).host.toLowerCase(); }
    catch {
        let t = s;
        t = t.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
        t = t.replace(/\?.*$/, '').replace(/#.*$/, '').replace(/\/.*$/, '');
        return t.trim().toLowerCase();
    }
}

function bucketFormatTime(ts) {
    try { return new Date(ts).toLocaleString(); } catch { return ''; }
}

function bucketDownload(filename, text) {
    const blob = new Blob([text], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function bucketParseImported(text) {
    const t = String(text || '').trim();
    if (!t) return [];
    try { const j = JSON.parse(t); if (Array.isArray(j)) return j.map(x => String(x)); } catch { }
    return t.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
}

async function initBucketPage() {
    bindBucketSubtabs();
    if (!bucketBound) { bindBucketControls(); bucketBound = true; }
    await loadBucketSettings();
    await loadBucketHistory();
}

function bindBucketSubtabs() {
    if (window.__bucketSubtabBound) return;
    window.__bucketSubtabBound = true;
    $$('.bucket-subtabs .subtab').forEach(btn => btn.addEventListener('click', () => {
        const key = btn.dataset.bucketSub;
        $$('.bucket-subtabs .subtab').forEach(b => b.classList.toggle('active', b === btn));
        $$('.bucket-panel').forEach(p => p.classList.toggle('active', p.dataset.bucketPanel === key));
    }));
}

async function loadBucketSettings() {
    const res = await new Promise(r => API.storage.local.get(BUCKET_KEYS, r));
    const setChk = (id, val) => { const el = $('#' + id); if (el) el.checked = !!val; };
    setChk('bucket-passive-enabled', res.bucketPassiveEnabled ?? true);
    setChk('bucket-scan-page', res.scanPageForBuckets ?? false);
    setChk('bucket-safe-mode', res.safeModePassive ?? true);
    setChk('bucket-flag-acl', res.flagAcl ?? true);
    setChk('bucket-flag-policy', res.flagPolicy ?? true);
    setChk('bucket-traverse', res.traverseBacktrack ?? false);
    setChk('bucket-whitelist-mode', res.whitelistMode ?? false);
    const setNum = (id, val) => { const el = $('#' + id); if (el) el.value = val; };
    setNum('bucket-max-external', res.scanMaxExternalJs || 40);
    setNum('bucket-max-inline', res.scanMaxInlineJs || 20);
    setNum('bucket-max-filesize', Math.round((res.scanMaxFileSize || 1024 * 1024) / 1024));
    setNum('bucket-max-candidates', res.scanMaxTotalCandidates || 60);
    renderBucketList('detectBlacklist', res.detectBlacklist || []);
    renderBucketList('detectWhitelist', res.detectWhitelist || []);
}

function bindBucketControls() {
    const bindSwitch = (id, key) => {
        const el = $('#' + id); if (!el) return;
        el.addEventListener('change', () => {
            API.storage.local.set({ [key]: !!el.checked });
            toast(el.checked ? '已开启' : '已关闭');
        });
    };
    bindSwitch('bucket-passive-enabled', 'bucketPassiveEnabled');
    bindSwitch('bucket-scan-page', 'scanPageForBuckets');
    bindSwitch('bucket-safe-mode', 'safeModePassive');
    bindSwitch('bucket-flag-acl', 'flagAcl');
    bindSwitch('bucket-flag-policy', 'flagPolicy');
    bindSwitch('bucket-traverse', 'traverseBacktrack');
    bindSwitch('bucket-whitelist-mode', 'whitelistMode');

    // 数值框失焦仅做范围钳制回显，实际写入由「保存性能设置」按钮统一提交
    const clampNum = (id, mul) => {
        const el = $('#' + id); if (!el) return null;
        let v = Number(el.value);
        const min = Number(el.min), max = Number(el.max);
        if (!Number.isFinite(v)) v = min;
        v = Math.max(min, Math.min(max, Math.round(v)));
        el.value = v;
        return mul ? v * mul : v;
    };
    const bindNum = (id) => {
        const el = $('#' + id); if (!el) return;
        el.addEventListener('change', () => { clampNum(id); });
    };
    bindNum('bucket-max-external');
    bindNum('bucket-max-inline');
    bindNum('bucket-max-filesize');
    bindNum('bucket-max-candidates');

    bindBucketListBox('detectBlacklist', 'bl');
    bindBucketListBox('detectWhitelist', 'wl');

    const setReset = $('#bucket-settings-reset');
    if (setReset) setReset.onclick = () => {
        if (!confirm('确定恢复默认检测策略？（不影响历史记录）')) return;
        API.storage.local.set({
            bucketPassiveEnabled: true, scanPageForBuckets: false, safeModePassive: true,
            flagAcl: true, flagPolicy: true, traverseBacktrack: false
        }, () => { loadBucketSettings(); toast('已恢复默认策略'); });
    };
    const advReset = $('#bucket-advanced-reset');
    if (advReset) advReset.onclick = () => {
        if (!confirm('确定恢复默认性能设置？')) return;
        API.storage.local.set({
            scanMaxExternalJs: 40, scanMaxInlineJs: 20, scanMaxFileSize: 1024 * 1024, scanMaxTotalCandidates: 60
        }, () => { loadBucketSettings(); toast('已恢复默认性能设置'); });
    };
    const advSave = $('#bucket-advanced-save');
    if (advSave) advSave.onclick = () => {
        API.storage.local.set({
            scanMaxExternalJs: clampNum('bucket-max-external'),
            scanMaxInlineJs: clampNum('bucket-max-inline'),
            scanMaxFileSize: clampNum('bucket-max-filesize', 1024),
            scanMaxTotalCandidates: clampNum('bucket-max-candidates')
        }, () => { toast('已保存性能设置'); });
    };

    const manualBtn = $('#bucket-manual-detect');
    if (manualBtn) manualBtn.onclick = () => { sendBg('bucket-open-log'); toast('已打开检测日志窗口'); };
    const exportBtn = $('#bucket-export');
    if (exportBtn) exportBtn.onclick = exportBucketHistory;
    const clearBtn = $('#bucket-clear');
    if (clearBtn) clearBtn.onclick = clearBucketHistory;

    const hist = $('#bucket-history');
    if (hist) hist.addEventListener('click', onBucketHistoryClick);
}

function bindBucketListBox(storageKey, prefix) {
    const input = $('#bucket-' + prefix + '-input');
    const addBtn = $('#bucket-' + prefix + '-add');
    const listEl = $('#bucket-' + prefix + '-list');
    const importBtn = $('#bucket-' + prefix + '-import');
    const exportBtn = $('#bucket-' + prefix + '-export');
    const clearBtn = $('#bucket-' + prefix + '-clear');
    const fileEl = $('#bucket-' + prefix + '-file');
    const listName = storageKey === 'detectBlacklist' ? '黑名单' : '白名单';

    if (addBtn && input) addBtn.onclick = () => {
        const v = bucketNormalizeEntry(input.value);
        if (!v) { toast('请输入有效域名'); return; }
        updateBucketList(storageKey, 'add', v, (resp) => {
            if (showBucketConflict(resp)) return;
            if (resp && resp.ok && Array.isArray(resp.list)) { renderBucketList(storageKey, resp.list); input.value = ''; toast('已添加'); }
        });
    };
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (addBtn) addBtn.click(); } });
    if (listEl) listEl.onclick = (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement) || !t.classList.contains('bucket-del')) return;
        const idx = Number(t.getAttribute('data-idx'));
        if (Number.isNaN(idx)) return;
        updateBucketList(storageKey, 'removeAt', idx, (resp) => {
            if (resp && resp.ok && Array.isArray(resp.list)) renderBucketList(storageKey, resp.list);
        });
    };
    if (importBtn && fileEl) {
        importBtn.onclick = () => fileEl.click();
        fileEl.onchange = () => {
            const file = fileEl.files && fileEl.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                const normalized = bucketParseImported(reader.result).map(bucketNormalizeEntry).filter(Boolean);
                updateBucketList(storageKey, 'merge', normalized, (resp) => {
                    if (resp && resp.ok && Array.isArray(resp.list)) {
                        renderBucketList(storageKey, resp.list);
                        showBucketMergeSkipped(resp, listName);
                    }
                    fileEl.value = '';
                });
            };
            reader.readAsText(file);
        };
    }
    if (exportBtn) exportBtn.onclick = () => {
        API.storage.local.get([storageKey], (res) => {
            const list = res[storageKey] || [];
            bucketDownload((storageKey === 'detectBlacklist' ? 'blacklist' : 'whitelist') + '.json', JSON.stringify(list, null, 2));
            toast('已导出 ' + list.length + ' 条');
        });
    };
    if (clearBtn) clearBtn.onclick = () => {
        if (!confirm('确定清空' + listName + '？')) return;
        updateBucketList(storageKey, 'clear', null, (resp) => { if (resp && resp.ok) { renderBucketList(storageKey, []); toast('已清空'); } });
    };
}

function updateBucketList(key, action, value, cb) {
    sendBg('list-update', { key, action, value })
        .then(resp => { if (cb) cb(resp); })
        .catch(() => { if (cb) cb({ ok: false }); });
}

function renderBucketList(storageKey, list) {
    const prefix = storageKey === 'detectBlacklist' ? 'bl' : 'wl';
    const listEl = $('#bucket-' + prefix + '-list');
    if (!listEl) return;
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) { listEl.innerHTML = '<li class="bucket-mini-empty">暂无</li>'; return; }
    listEl.innerHTML = arr.map((item, idx) =>
        `<li><span class="bucket-pill">${escapeHtml(item)}</span><button class="bucket-del" data-idx="${idx}">删除</button></li>`
    ).join('');
}

function showBucketConflict(resp) {
    if (!resp || resp.reason !== 'conflict') return false;
    const otherName = resp.otherKey === 'detectBlacklist' ? '黑名单' : '白名单';
    const conflicts = Array.isArray(resp.conflicts) ? resp.conflicts : [];
    const shown = conflicts.slice(0, 8).join(', ');
    const more = conflicts.length > 8 ? ` 等${conflicts.length}条` : '';
    alert(`不允许添加：${resp.entry}\n原因：与${otherName}存在互斥/覆盖关系（含通配符匹配）\n冲突项：${shown}${more}`);
    return true;
}

function showBucketMergeSkipped(resp, listName) {
    const skipped = resp && Array.isArray(resp.skipped) ? resp.skipped : [];
    if (!skipped.length) return;
    const lines = skipped.slice(0, 10).map(x => `- ${x.entry}  (冲突: ${(x.conflicts || []).slice(0, 3).join(', ')}${(x.conflicts || []).length > 3 ? '...' : ''})`);
    const more = skipped.length > 10 ? `\n... 还有 ${skipped.length - 10} 条` : '';
    alert(`${listName}导入完成，但部分条目与另一侧名单互斥，已跳过：\n${lines.join('\n')}${more}`);
}

async function loadBucketHistory() {
    const res = await new Promise(r => API.storage.local.get(['bucketVulHistory'], r));
    bucketHistory = res.bucketVulHistory || [];
    renderBucketHistory();
}

function renderBucketHistory() {
    const el = $('#bucket-history');
    const statsEl = $('#bucket-stats');
    if (!el) return;
    const arr = Array.isArray(bucketHistory) ? bucketHistory : [];
    const riskCount = arr.filter(it => it && it.type && it.type !== '域名命中').length;
    const hitCount = arr.length - riskCount;
    if (statsEl) {
        statsEl.innerHTML =
            `<span class="bucket-stat-chip danger">风险<b>${riskCount}</b></span>` +
            `<span class="bucket-stat-chip">域名命中<b>${hitCount}</b></span>` +
            `<span class="bucket-stat-chip">总计<b>${arr.length}</b></span>`;
    }
    if (!arr.length) {
        el.innerHTML = '<div class="empty-state">暂无检测记录（访问命中云存储域名的资源时会自动被动检测）</div>';
        return;
    }
    el.innerHTML = arr.map((item, idx) => {
        const host = bucketGetHost(item);
        const sourceShown = item.sourceHitUrl || item.sourcePageUrl || item.sourceSite;
        const isRisk = item.type && item.type !== '域名命中';
        const srcCls = item.source === '主动' ? 'active' : '';
        return `<div class="bucket-item${isRisk ? ' risk' : ''}">` +
            `<div class="bucket-item-main">` +
            `<span class="bucket-seq">${idx + 1}</span>` +
            `<span class="bucket-host" title="${escapeHtml(host)}">${escapeHtml(host)}</span>` +
            `<span class="bucket-type">${escapeHtml(item.type || '未知')}</span>` +
            (item.vendor ? `<span class="bucket-vendor">${escapeHtml(item.vendor)}</span>` : '') +
            `<span class="bucket-src ${srcCls}">${escapeHtml(item.source || '被动')}</span>` +
            `<span class="bucket-time">${bucketFormatTime(item.time)}</span>` +
            `<span class="bucket-item-btns">` +
            `<button class="mini-btn bucket-detail" data-idx="${idx}">细节</button>` +
            `<button class="mini-btn danger bucket-delete" data-id="${escapeHtml(String(item.id))}">✕</button>` +
            `</span></div>` +
            (sourceShown ? `<div class="bucket-hit" title="${escapeHtml(sourceShown)}">命中来源：${escapeHtml(sourceShown)}${(typeof item.sourceLine === 'number' && item.sourceLine > 0) ? ':L' + item.sourceLine : ''}</div>` : '') +
            `</div>`;
    }).join('');
}

function onBucketHistoryClick(e) {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.classList.contains('bucket-delete')) {
        const id = t.getAttribute('data-id');
        bucketHistory = bucketHistory.filter(it => String(it.id) !== String(id));
        API.storage.local.set({ bucketVulHistory: bucketHistory }, () => renderBucketHistory());
        return;
    }
    if (t.classList.contains('bucket-detail')) {
        const idx = Number(t.getAttribute('data-idx'));
        const item = bucketHistory[idx];
        const itemEl = t.closest('.bucket-item');
        if (!item || !itemEl) return;
        const existing = itemEl.querySelector('.bucket-reqresp');
        if (existing) { existing.remove(); t.textContent = '细节'; return; }
        const div = document.createElement('div');
        div.className = 'bucket-reqresp';
        div.innerHTML =
            `<div class="bucket-rr-block"><div class="bucket-rr-title">请求 <button class="mini-btn bucket-copy" data-type="request" data-idx="${idx}">复制</button></div><pre>${escapeHtml(item.request || '(无内容)')}</pre></div>` +
            `<div class="bucket-rr-block"><div class="bucket-rr-title">响应 <button class="mini-btn bucket-copy" data-type="response" data-idx="${idx}">复制</button></div><pre>${escapeHtml(item.response || '(无内容)')}</pre></div>`;
        itemEl.appendChild(div);
        t.textContent = '收起';
        return;
    }
    if (t.classList.contains('bucket-copy')) {
        const idx = Number(t.getAttribute('data-idx'));
        const type = t.getAttribute('data-type');
        const item = bucketHistory[idx];
        if (!item) return;
        copy(type === 'request' ? (item.request || '') : (item.response || ''));
    }
}

function exportBucketHistory() {
    const arr = Array.isArray(bucketHistory) ? bucketHistory : [];
    const risks = arr.filter(it => it && it.type && it.type !== '域名命中');
    if (!risks.length) { toast('暂无风险记录可导出'); return; }
    const ts = new Date();
    const pad = n => String(n).padStart(2, '0');
    const filename = `happyjs_bucket_risks_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.json`;
    bucketDownload(filename, JSON.stringify(risks, null, 2));
    toast('已导出 ' + risks.length + ' 条风险');
}

function clearBucketHistory() {
    if (!confirm('确定要清空所有检测历史吗？')) return;
    API.storage.local.set({ bucketVulHistory: [] }, () => {
        bucketHistory = [];
        renderBucketHistory();
        sendBg('clear-badge');
        sendBg('reset-runtime-state');
        toast('已清空历史记录');
    });
}


/* ====================== Vue 路由对抗面板（借鉴 v1.5.0 / AntiDebug_Breaker） ======================
 * 两个能力均可在页面上即时生效、且**可卸载**（再次点击恢复原函数）：
 *   · 清除跳转：把 router.push/replace/go/back/forward 换成 noop，阻止鉴权重定向
 *   · 清除路由守卫：hook Array.prototype.push，丢弃 beforeEach/beforeResolve 注册的守卫
 * ========================================================================== */
function renderVueClearPanel() {
    const panel = $('#vue-counter-panel');
    if (!panel) return;
    panel.style.display = (State.routeSub === 'vue') ? '' : 'none';
    updateVueClearBtns();
}
async function toggleVueClear(type, stateKey, label) {
    if (!State.tabId) { toast('未关联到当前标签页'); return; }
    const installed = !!State.vueClear[stateKey];
    const action = installed ? 'uninstall' : 'install';
    const btn = $('#vue-clear-' + stateKey);
    if (btn) btn.disabled = true;
    try {
        const r = await sendTab(type, { action });
        if (!r || !r.ok) { toast(`${label}失败：${(r && (r.error || (r.result && r.result.error))) || '未知错误'}`); return; }
        State.vueClear[stateKey] = !installed;
        updateVueClearBtns();
        const cnt = r.blockedCount || 0;
        toast(`${label}：${installed ? '已恢复' : '已开启'}${cnt ? `（累计拦截 ${cnt} 次）` : ''}`);
    } catch (e) {
        toast(`${label}异常：${(e && e.message) || e}`);
    } finally {
        if (btn) { btn.disabled = false; updateVueClearBtns(); }
    }
}
function updateVueClearBtns() {
    const navBtn = $('#vue-clear-nav');
    const gBtn = $('#vue-clear-guards');
    if (navBtn) {
        const on = !!State.vueClear.nav;
        navBtn.dataset.on = on ? 'true' : 'false';
        navBtn.title = on ? '点击恢复 router.push/replace 为原函数（逆向完成后记得恢复）'
            : '点击后：把 router.push/replace/go/back/forward 替换为空函数，拦截路由跳转（绕过鉴权重定向）';
        const txt = navBtn.querySelector('.counter-text');
        if (txt) txt.textContent = on ? '已拦截跳转' : '清除跳转';
    }
    if (gBtn) {
        const on = !!State.vueClear.guards;
        gBtn.dataset.on = on ? 'true' : 'false';
        gBtn.title = on ? '点击恢复 Array.prototype.push 为原函数（逆向完成后记得恢复）'
            : '点击后：Hook Array.prototype.push，拦截 Vue Router 的 beforeEach/beforeResolve 守卫注册';
        const txt = gBtn.querySelector('.counter-text');
        if (txt) txt.textContent = on ? '已拦截守卫' : '清除路由守卫';
    }
}
$('#vue-clear-nav').onclick = () => toggleVueClear('VUE_CLEAR_NAV', 'nav', '清除跳转');
$('#vue-clear-guards').onclick = () => toggleVueClear('VUE_CLEAR_GUARDS', 'guards', '清除路由守卫');

/* ====================== 初始化 ====================== */
async function init() {
    initTheme(); // 先应用主题，避免闪烁
    DlUI.fsOk = (typeof FsDl !== 'undefined' && typeof FsDl.supported === 'function' && FsDl.supported());
    State.currentTab = await getTab();
    State.tabId = State.currentTab?.id || null;
    if (State.currentTab?.url) {
        try { State.hostname = new URL(State.currentTab.url).hostname; } catch {}
    }
    await loadHookState();
    await loadSettings();
    await loadMcpSettings();
    await loadDownloadCfg();
    await loadConsoleSettings();
    await loadHealth();
    await initGuardPage();
    $('#mode-badge').textContent = State.isGlobal ? '全局模式' : '标准模式';

    // 请求扫描结果
    if (State.tabId && State.hostname) {
        const wl = await new Promise(r => API.storage.local.get(['customWhitelist'], r));
        const whitelisted = (wl.customWhitelist || []).some(d => State.hostname === d || State.hostname.endsWith(`.${d}`));
        if (whitelisted) {
            $('#scanner-sections').innerHTML = '<div class="whitelisted">当前域名在白名单中，已跳过扫描</div>';
        } else {
            sendTab('GET_RESULTS').catch(() => {});
        }
        // JS 资源面板（一键下载的数据源）
        loadResources().catch(() => {});
    } else {
        $('#scanner-sections').innerHTML = '<div class="no-results">请在网页中使用</div>';
    }
}
document.addEventListener('DOMContentLoaded', init);

/* ====================== 防护页（整合自 Heimdallr） ====================== */
const TYPE_LABELS = { 1: '指纹', 2: '关键字', 3: '蜜罐URL', 4: '蜜罐JSONP', 5: '蜜罐JS' };

async function initGuardPage() {
    // 加载配置与统计
    const res = await sendBg('HEIMDALLR_GET_CFG');
    if (!res) return;
    const { cfg, stats } = res;

    // 绑定开关
    const bind = (id, key) => {
        const el = $('#' + id);
        if (!el) return;
        el.checked = !!cfg[key];
        el.onchange = async () => {
            await sendBg('HEIMDALLR_SET_OPTION', { key, enabled: el.checked });
            toast(el.checked ? '已开启' : '已关闭');
        };
    };
    bind('hd-block-honeypot', 'blockHoneypot');
    bind('hd-jsonp-alert', 'jsonpAlert');
    bind('hd-no-page-cache', 'noPageCache');

    // 渲染统计
    renderGuardStats(stats);

    // 加载命中结果
    await loadGuardResults();

    // 监听实时更新
    if (!window.__hdListenerBound) {
        window.__hdListenerBound = true;
        API.runtime.onMessage.addListener((msg) => {
            if (msg.type === 'HEIMDALLR_UPDATE' && msg.tabId === State.tabId) {
                renderGuardResults(msg.results);
            }
            return false;
        });
    }
}

function renderGuardStats(stats) {
    if (!stats) return;
    const el = $('#hd-honeypot-stats');
    if (el) {
        el.innerHTML = `
            <span class="guard-stat-chip">规则总数<b>${stats.total}</b></span>
            <span class="guard-stat-chip danger">蜜罐JSONP拦截<b>${stats.blockJsonp}</b></span>
            <span class="guard-stat-chip warn">蜜罐JS告警<b>${stats.alert}</b></span>
            <span class="guard-stat-chip">拦截规则<b>${stats.blockingRules}</b></span>
        `;
    }
    const fEl = $('#hd-fingerprint-stats');
    if (fEl) {
        fEl.innerHTML = `
            <span class="guard-stat-chip">指纹规则<b>${stats.fingerprint}</b></span>
            <span class="guard-stat-chip">关键字规则<b>${stats.keyword}</b></span>
        `;
    }
}

async function loadGuardResults() {
    if (!State.tabId) return;
    const res = await sendBg('HEIMDALLR_GET_RESULTS', { tabId: State.tabId });
    if (res) renderGuardResults(res.results);
}

function renderGuardResults(results) {
    const items = results?.items || [];
    // 蜜罐类（type 3/4/5）
    const honeypotItems = items.filter(it => it.type >= 3);
    // 指纹类（type 1/2）
    const fingerItems = items.filter(it => it.type <= 2);

    const hEl = $('#hd-honeypot-results');
    if (hEl) {
        hEl.innerHTML = honeypotItems.length
            ? honeypotItems.map(it => `
                <div class="guard-result-item">
                    <span class="gr-type gr-type-${it.type}">${TYPE_LABELS[it.type] || ''}</span>
                    <span class="gr-msg">${escapeHtml(it.msg)}</span>
                    <span class="gr-rule">${escapeHtml(it.rulename || '')}</span>
                </div>`).join('')
            : '<div class="empty-state">暂无蜜罐命中</div>';
    }
    const fEl = $('#hd-fingerprint-results');
    if (fEl) {
        fEl.innerHTML = fingerItems.length
            ? fingerItems.map(it => `
                <div class="guard-result-item">
                    <span class="gr-type gr-type-${it.type}">${TYPE_LABELS[it.type] || ''}</span>
                    <span class="gr-msg">${escapeHtml(it.msg)}</span>
                    <span class="gr-rule">${escapeHtml(it.rulename || '')}</span>
                </div>`).join('')
            : '<div class="empty-state">暂无指纹命中</div>';
    }
}
