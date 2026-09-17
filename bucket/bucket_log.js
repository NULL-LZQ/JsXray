/* =====================================================================
 * JsXray — 云存储桶主动检测日志窗口脚本（bucket_log.js）
 * 融合自：谛听鉴 fox_popup/fox_log.js
 *
 * 职责：
 *   - 提供 URL 输入 + 10 厂商勾选 + 8 漏洞类型勾选 + 开始检测；
 *   - 发起 'manual-detect'（带 to:'background'），后台流式回推 'bucketvul-log'；
 *   - 渲染检测事件（start/params/vendor-start/detect/vendor-result/finish/error）；
 *   - 支持右键菜单 prefill 预填 URL；Enter 快捷提交；检测中禁用按钮。
 * ===================================================================== */

(function () {
    'use strict';

    const API = (typeof browser !== 'undefined') ? browser : chrome;

    const logDiv = document.getElementById('log');
    const urlInput = document.getElementById('target-url');
    const startBtn = document.getElementById('start-detect');

    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"]|'/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
    }

    function getSelectedVendors() {
        const checkboxes = document.querySelectorAll('.vendor-checkbox');
        const selected = [];
        checkboxes.forEach(cb => { if (cb.checked) selected.push(cb.value); });
        return selected;
    }

    function getSelectedVulTypes() {
        const checkboxes = document.querySelectorAll('.vtype-checkbox');
        const selected = [];
        checkboxes.forEach(cb => { if (cb.checked) selected.push(cb.value); });
        return selected;
    }

    function scrollBottom() {
        try { logDiv.scrollTop = logDiv.scrollHeight; } catch (e) { }
    }

    function addLogDetail(result) {
        const line = document.createElement('div');
        line.className = 'logline';
        line.innerHTML =
            `<span class="tag tag-vendor">${escapeHtml(result.vendor)}</span>` +
            `<span class="tag tag-type">${escapeHtml(result.type)}</span>` +
            (result.found ? `<span class="tag tag-found">发现风险</span>` : '') + `<br>` +
            `URL: <span style="color:var(--accent)">${escapeHtml(result.url || '')}</span><br>` +
            (result.statusCode ? `响应码: <span style="color:var(--warn)">${escapeHtml(result.statusCode + '')}</span><br>` : '') +
            (result.detail ? `详情: <span>${escapeHtml(result.detail)}</span><br>` : '') +
            `<details><summary>请求 / 响应</summary><pre>${escapeHtml(result.request || '')}\n\n${escapeHtml(result.response || '')}</pre></details>`;
        logDiv.appendChild(line);
        scrollBottom();
    }

    function addLog(msg) {
        if (msg && typeof msg === 'object' && msg.event) {
            if (msg.event === 'detect') { addLogDetail(msg); return; }

            const line = document.createElement('div');
            line.className = 'logline';
            if (msg.event === 'start') {
                line.innerHTML = `<span style="color:var(--accent)">[检测开始]</span> 目标 URL：<b>${escapeHtml(msg.url)}</b>`;
            } else if (msg.event === 'params') {
                line.innerHTML = `<span class="muted">[参数]</span> ACL：<b>${msg.acl ? '检测' : '不检测'}</b>　Policy：<b>${msg.policy ? '检测' : '不检测'}</b>` +
                    (Array.isArray(msg.types) && msg.types.length ? `<br><span class="muted">[类型]</span> ${escapeHtml(msg.types.join('、'))}` : '');
            } else if (msg.event === 'vendor-start') {
                line.innerHTML = `<span class="tag tag-vendor">${escapeHtml(msg.vendor)}</span> <span style="color:#16a085">开始检测…</span>`;
            } else if (msg.event === 'vendor-result') {
                line.innerHTML = `<span class="tag tag-vendor">${escapeHtml(msg.vendor)}</span> <span class="tag tag-notfound">未发现风险</span>`;
            } else if (msg.event === 'finish') {
                line.innerHTML = `<span style="color:var(--ok)">[检测完成]</span>`;
                setBusy(false);
            } else if (msg.event === 'error') {
                line.innerHTML = `<span style="color:var(--danger)">[检测失败]</span> ${escapeHtml(msg.error)}`;
                setBusy(false);
            } else if (msg.event === 'prefill') {
                if (urlInput && !urlInput.value && msg.url) urlInput.value = msg.url;
                line.innerHTML = `<span class="muted">[已识别候选]</span> ${escapeHtml(msg.url || '')}`;
            } else {
                line.textContent = `[${new Date().toLocaleTimeString()}] ` + JSON.stringify(msg);
            }
            logDiv.appendChild(line);
            scrollBottom();
            return;
        }
        const line = document.createElement('div');
        line.className = 'logline';
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logDiv.appendChild(line);
        scrollBottom();
    }

    function setBusy(busy) {
        if (!startBtn) return;
        startBtn.disabled = !!busy;
        startBtn.textContent = busy ? '检测中…' : '开始检测';
    }

    function startDetect() {
        const vendors = getSelectedVendors();
        const vulTypes = getSelectedVulTypes();
        const vulUrl = (urlInput && urlInput.value || '').trim();
        if (!vulUrl) {
            addLog('未输入 URL，检测取消');
            if (urlInput) urlInput.focus();
            return;
        }
        if (!/^https?:\/\//i.test(vulUrl)) {
            addLog('URL 需以 http:// 或 https:// 开头');
            return;
        }
        if (!vulTypes.length) {
            addLog('未勾选任何漏洞类型，检测取消');
            return;
        }
        setBusy(true);
        API.runtime.sendMessage({ type: 'manual-detect', to: 'background', vendors, vulUrl, vulTypes }, () => {
            // 忽略 lastError：后台流式日志通过 onMessage 回推
            if (API.runtime && API.runtime.lastError) { /* noop */ }
        });
        addLog('已发起检测，厂商：' + (vendors.length ? vendors.join(', ') : '全部') + '；类型：' + vulTypes.join('、'));
    }

    if (startBtn) startBtn.addEventListener('click', startDetect);
    if (urlInput) urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startDetect(); } });

    const allBtn = document.getElementById('vendor-all');
    const noneBtn = document.getElementById('vendor-none');
    if (allBtn) allBtn.addEventListener('click', () => document.querySelectorAll('.vendor-checkbox').forEach(cb => cb.checked = true));
    if (noneBtn) noneBtn.addEventListener('click', () => document.querySelectorAll('.vendor-checkbox').forEach(cb => cb.checked = false));

    const vtypeAllBtn = document.getElementById('vtype-all');
    const vtypeNoneBtn = document.getElementById('vtype-none');
    if (vtypeAllBtn) vtypeAllBtn.addEventListener('click', () => document.querySelectorAll('.vtype-checkbox').forEach(cb => cb.checked = true));
    if (vtypeNoneBtn) vtypeNoneBtn.addEventListener('click', () => document.querySelectorAll('.vtype-checkbox').forEach(cb => cb.checked = false));

    API.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message && message.type === 'bucketvul-log') {
            addLog(message.msg);
        }
    });

    addLog('日志窗口已就绪，输入存储桶 URL 后点击“开始检测”。');
    if (urlInput) urlInput.focus();
})();
