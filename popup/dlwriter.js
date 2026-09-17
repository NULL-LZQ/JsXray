/* =====================================================================
 * JsXray — popup/dlwriter.js
 * 直写本地目录面板（独立标签页）
 *
 * 为什么单独开一个标签页：
 *   ① 弹窗（popup）在下载期间被关闭就会连带销毁执行环境，写盘会中途断掉；
 *   ② 系统目录选择器弹出时弹窗可能失焦关闭；
 *   ③ 几十个文件的进度与逐条结果在弹窗里显示不下。
 *
 * 流程：popup 把任务写进 storage → 打开本页面 → 用户选目录（只需一次，
 *       之后会被记住）→ 逐文件取字节并写入磁盘 → 落 _manifest.json / _list.txt。
 * ===================================================================== */
'use strict';

const API = (typeof browser !== 'undefined') ? browser : chrome;
const JOB_KEY = 'le_fsdl_job';
const $ = (id) => document.getElementById(id);

const W = { job: null, root: null, running: false, stop: false, plan: null, stats: null };

function sendBg(type, payload = {}) {
    return new Promise(r => API.runtime.sendMessage({ ...payload, type, to: 'background' }, r));
}
function logLine(text, cls) {
    const box = $('log');
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = text;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
    if (box.childNodes.length > 800) box.removeChild(box.firstChild);
}
function setProgress(done, total, text) {
    const pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
    $('bar-i').style.width = pct + '%';
    $('progress-text').textContent = text || `${done}/${total}（${pct}%）`;
}
function renderRoot() {
    const name = W.root ? (W.root.name || '(已选目录)') : (FsDl.currentName() || '');
    W.rootName = name;
    $('root-name').textContent = name || '未选择';
    $('start').disabled = !(W.root && W.job && W.job.urls && W.job.urls.length) || W.running;
}
function bytesText(n) {
    if (!n) return '0B';
    if (n < 1024) return n + 'B';
    if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
    return (n / 1048576).toFixed(2) + 'MB';
}

/* -------------------- 初始化 -------------------- */
async function init() {
    API.storage.local.get(['le_theme'], (d) => {
        document.documentElement.setAttribute('data-theme', d.le_theme || 'light');
    });

    if (!FsDl.supported()) {
        $('job-summary').innerHTML = '当前浏览器不支持 File System Access API（需 Chrome / Edge 86+）。' +
            '请改用「浏览器下载（相对默认下载目录）」模式。';
        $('pick').disabled = true;
        return;
    }

    const d = await new Promise(r => API.storage.local.get([JOB_KEY], r));
    W.job = d[JOB_KEY] || null;
    if (!W.job || !Array.isArray(W.job.urls) || !W.job.urls.length) {
        $('job-summary').innerHTML = '没有待执行的下载任务：请回到扩展弹窗，在「一键下载 JS」里选好范围后点「开始下载」。';
        return;
    }

    const j = W.job;
    $('job-summary').innerHTML = `目标站点 <b class="mono">${escapeHtml(j.site || '-')}</b> · 共 <b>${j.urls.length}</b> 个 JS` +
        (j.pageUrl ? `<br><span class="mono muted">${escapeHtml(j.pageUrl)}</span>` : '');
    // 目录模板在直写模式下作为「所选目录内的子路径」
    $('target-preview').textContent = (j.dir || '{url}') + '/…';
    if (j.conflict) $('conflict').value = j.conflict;
    logLine('任务已载入：' + j.urls.length + ' 个文件');

    // 尝试复用上次记住的目录（只需重新授权一次点击）
    const h = await FsDl.ensure(false);
    if (h) {
        W.root = h;
        logLine('已恢复上次使用的目录：' + (h.name || ''), 'ok');
    } else if (FsDl.currentName()) {
        logLine('上次使用的目录「' + FsDl.currentName() + '」需要重新授权，请点「选择文件夹…」');
    }
    renderRoot();
    // 弹窗里配的是绝对目录（如 D:\JsXray\js）时，提醒别选错文件夹
    if (j.absHint) {
        logLine('提示：你在弹窗里配置的目录是「' + j.absHint + '」，请在下面选中该文件夹或其父目录。');
    }
    if (!W.root) setTimeout(() => $('pick').focus(), 100);
}

$('pick').onclick = async () => {
    try {
        const h = await FsDl.pick();      // 用户手势内直接调用，避免 transient activation 过期
        W.root = h;
        logLine('已选择目录：' + (h.name || ''), 'ok');
        // 与配置的绝对目录比对：只比最后一段名字，避免选错文件夹却毫无察觉
        const want = W.job && W.job.absHint ? String(W.job.absHint).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
        if (want && h.name && want.toLowerCase() !== String(h.name).toLowerCase()) {
            logLine('注意：你配置的目录名是「' + want + '」，当前选中的是「' + h.name + '」，确认无误再点「开始写入」。', 'err');
        }
        renderRoot();
    } catch (e) {
        if (String(e && e.name) === 'AbortError') { logLine('已取消选择'); return; }
        logLine('选择目录失败：' + ((e && e.message) || e), 'err');
    }
};

$('cancel').onclick = () => {
    if (!W.running) { logLine('当前没有进行中的任务'); return; }
    W.stop = true;
    logLine('已请求停止，正在收尾…');
};

$('start').onclick = async () => {
    if (W.running) return;
    if (!W.root) {
        try { W.root = await FsDl.pick(); } catch (e) { logLine('未选择目录：' + ((e && e.message) || e), 'err'); return; }
        renderRoot();
        if (!W.root) return;
    }
    W.running = true;
    W.stop = false;
    $('start').disabled = true;
    $('pick').disabled = true;
    $('start').textContent = '写入中…';
    const j = W.job;

    try {
        // 1) 规划相对路径（与浏览器下载模式共用同一套命名规则，自动含「目标网站 URL」文件夹）
        logLine('正在规划文件路径…');
        const plan = await sendBg('DL_PLAN', {
            tabId: j.tabId, pageUrl: j.pageUrl, urls: j.urls,
            dir: j.dir, siteFolder: j.siteFolder !== false, flatten: !!j.flatten
        });
        if (!plan || plan.error) throw new Error((plan && plan.error) || '路径规划失败');
        if (!plan.files || !plan.files.length) throw new Error('没有规划出可写入的文件');
        W.plan = plan;
        $('target-preview').textContent = ((W.root.name || '所选目录') + '/' + (plan.dir ? plan.dir + '/' : '') + '…');
        logLine(`目标路径：${W.root.name || ''}/${plan.dir ? plan.dir + '/' : ''}（站点文件夹「${plan.site}」）`, 'ok');

        // 2) 逐文件写入
        setProgress(0, plan.files.length, `准备写入 ${plan.files.length} 个文件…`);
        const stats = await FsDl.run({
            root: W.root,
            files: plan.files,
            conflict: $('conflict').value,
            concurrency: 3,
            shouldStop: () => W.stop,
            onProgress: (p) => {
                setProgress(p.done, p.total, `写入 ${p.done}/${p.total} · ${p.last || ''}`);
                if (p.last) logLine(`${p.ok === false ? '✗' : '✓'} ${p.last}`, p.ok === false ? 'err' : 'ok');
            },
            fetchOne: (url) => sendBg('DL_FETCH_B64', { tabId: j.tabId, url })
        });
        W.stats = stats;

        // 3) 清单落盘（与 ZIP 模式同一份结构，便于后续比对）
        const manifest = {
            generator: 'JsXray',
            version: API.runtime.getManifest().version,
            page: j.pageUrl,
            site: plan.site,
            dir: plan.dir,
            writtenAt: new Date().toISOString(),
            total: plan.files.length,
            ok: stats.ok, skipped: stats.skipped, failedCount: stats.failedCount,
            bytes: stats.bytes,
            hashes: stats.hashes,
            files: stats.saved.map(s => ({ url: s.url, file: s.file, bytes: s.bytes, status: s.status })),
            failed: stats.failed
        };
        const listTxt = ['# JsXray — JS 资源清单', '# 站点: ' + (j.pageUrl || '-'),
            '# 时间: ' + new Date().toISOString(), '# 数量: ' + j.urls.length, ''].concat(j.urls).join('\n') + '\n';
        try {
            await FsDl.writeText(W.root, joinRel(plan.dir, '_manifest.json'), JSON.stringify(manifest, null, 2), 'overwrite');
            await FsDl.writeText(W.root, joinRel(plan.dir, '_list.txt'), listTxt, 'overwrite');
        } catch (e) { logLine('清单写入失败：' + ((e && e.message) || e), 'err'); }

        // 4) 结果
        $('result-card').classList.remove('hidden');
        $('result-summary').innerHTML = `<b class="path">${stats.ok}</b> 个已写入` +
            (stats.skipped ? ` · ${stats.skipped} 个已存在跳过` : '') +
            (stats.failedCount ? ` · <span class="err">${stats.failedCount} 个失败</span>` : '') +
            ` · 共 ${bytesText(stats.bytes)}`;
        const dirPath = `${W.root.name || ''}/${plan.dir ? plan.dir + '/' : ''}`;
        $('result-note').innerHTML = `文件位置：<span class="mono path">${escapeHtml(dirPath)}</span>` +
            (stats.stopped ? '<br>已按你的要求提前停止（其余文件未写入）。' : '') +
            (stats.failedCount ? `<br>失败明细见 _manifest.json 的 failed 字段（前 3 条：${escapeHtml(stats.failed.slice(0, 3).map(f => f.file + ' → ' + f.error).join('；'))}）` : '') +
            '<br>本次目录已被记住，下次下载只需重新点一次授权。';
        logLine('完成：成功 ' + stats.ok + '，跳过 ' + stats.skipped + '，失败 ' + stats.failedCount, stats.failedCount ? 'err' : 'ok');
    } catch (e) {
        logLine('写入失败：' + ((e && e.message) || e), 'err');
        $('progress-text').textContent = '已中断：' + ((e && e.message) || e);
    } finally {
        W.running = false;
        $('pick').disabled = false;
        $('start').textContent = '开始写入';
        renderRoot();
    }
};

/** 拼相对路径（不产生空段 / 双斜杠） */
function joinRel(dir, name) {
    return [String(dir || '').replace(/^\/+|\/+$/g, ''), name].filter(Boolean).join('/');
}
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
