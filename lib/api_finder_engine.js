/*
 * Happy JS - API Finder Engine
 * ─────────────────────────────────────────────────────────────────────────
 *  多关键字 AND 规则匹配引擎
 *
 *  与 content.js 中 PATTERNS（29 类单正则）配合：作为高精度二轮扫描
 *  只在 PATTERNS 已经命中、或显式调用 match() 时触发，避免漏报与误报
 *
 *  核心能力：
 *    · match(target, location)  →  对 body / urlPath / header 跑全部启用规则
 *    · matchRule(rule, body, urlPath, header) →  跑单条规则
 *    · classifyByCategory(hits) →  按 category 分组
 *    · getWhitelist()           →  提取白名单（用于 URL 过滤）
 *    · 分块正则匹配：每个 chunk 50000 字符，避免回溯卡死
 *    · 命中上下文提取（前后 40 字符）
 *    · 规则 rule.enabled = false 可热禁用
 *
 *  参考：BurpAPIFinder FingerUtils.FingerFilter / Utils.java
 * ─────────────────────────────────────────────────────────────────────────
 */

(function (global) {
  'use strict';

  const MAX_CHUNK = 50000;             // 分块正则大小
  const CONTEXT_LEN = 40;              // 上下文长度
  const MAX_RESULT_LEN = 10000;        // 单条规则匹配结果最大长度

  // ────────────────────────── 核心入口 ──────────────────────────
  /**
   * 对一段内容跑全部启用规则
   * @param {Object} target - { body, urlPath, header }
   * @param {Object} [opts] - { rules, category, minAccuracy }
   * @returns {Array<Hit>}
   */
  function match(target, opts) {
    opts = opts || {};
    const rules = opts.rules || (global.API_FINDER_RULES || []);
    const body = target && target.body || '';
    const urlPath = target && target.urlPath || '';
    const header = target && target.header || '';
    const minAccuracy = opts.minAccuracy || 1;

    const hits = [];
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.enabled === false) continue;
      if (isWhitelist(rule)) continue;
      if (rule.accuracy < minAccuracy) continue;
      if (opts.category && rule.category !== opts.category) continue;

      const h = matchRule(rule, body, urlPath, header);
      if (h) hits.push(h);
    }
    return hits;
  }

  /**
   * 单规则匹配
   * @returns {Hit|null} - { rule, matched, location, keywords }
   */
  function matchRule(rule, body, urlPath, header) {
    // 1) 选择 location 内容
    let content;
    if (rule.location === 'urlPath') {
      content = urlPath;
    } else if (rule.location === 'header') {
      content = header;
    } else if (rule.location === 'all') {
      // 'all' 时分别跑 body/urlPath/header，取首个命中
      const r1 = runOnContent(rule, body);
      if (r1) return { rule: rule, matched: r1.matched, location: 'body', keywords: r1.keywords, context: r1.context };
      const r2 = runOnContent(rule, urlPath);
      if (r2) return { rule: rule, matched: r2.matched, location: 'urlPath', keywords: r2.keywords, context: r2.context };
      const r3 = runOnContent(rule, header);
      if (r3) return { rule: rule, matched: r3.matched, location: 'header', keywords: r3.keywords, context: r3.context };
      return null;
    } else {
      content = body;
    }

    const r = runOnContent(rule, content);
    if (!r) return null;
    return { rule: rule, matched: r.matched, location: rule.location, keywords: r.keywords, context: r.context };
  }

  // 单条内容上跑单条规则（含 AND/OR 关系 + 分块正则）
  function runOnContent(rule, content) {
    if (!content) return null;
    const isOr = (rule.relation === 'OR');
    const matched = [];
    const ctxs = [];

    if (rule.match === 'keyword') {
      // ── 关键字模式：每条 keyword 独立判断 ──
      const lc = content.toLowerCase();
      for (let k = 0; k < rule.keyword.length; k++) {
        const kw = rule.keyword[k];
        const kwLc = ('' + kw).toLowerCase();
        if (lc.indexOf(kwLc) >= 0) {
          matched.push(kw);
          ctxs.push(extractContextKeyword(content, kw));
        } else if (!isOr) {
          // AND 模式：有一个不命中就放弃
          return null;
        }
      }
      // AND 模式必须全部命中；OR 模式至少一个
      if (matched.length === 0) return null;
      if (!isOr && matched.length < rule.keyword.length) return null;
      return { matched: matched, context: ctxs.join(' ... ') };
    }

    if (rule.match === 'regex') {
      // ── 正则模式：分块匹配，避免大文本回溯卡死 ──
      let re;
      try {
        re = new RegExp(rule.regex, 'gi');
      } catch (e) {
        console.warn('[api_finder_engine] 正则语法错误:', rule.id, rule.regex);
        return null;
      }
      let foundAny = false;
      const len = content.length;
      for (let start = 0; start < len; start += MAX_CHUNK) {
        const end = Math.min(start + MAX_CHUNK, len);
        const chunk = content.substring(start, end);
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(chunk)) !== null) {
          foundAny = true;
          matched.push(m[0]);
          ctxs.push(extractContextIndex(chunk, m.index, m.index + m[0].length));
          if (ctxs.join('').length > MAX_RESULT_LEN) break;
          if (m[0].length === 0) re.lastIndex++;  // 防御零宽匹配
        }
        if (ctxs.join('').length > MAX_RESULT_LEN) break;
      }
      // 正则模式下，单个 regex 命中即视为规则命中（无 AND/OR 概念）
      if (!foundAny) return null;
      return { matched: matched, context: ctxs.join(' ... ') };
    }

    return null;
  }

  // ────────────────────────── 工具 ──────────────────────────
  function extractContextKeyword(content, keyword) {
    const lc = content.toLowerCase();
    const kwLc = ('' + keyword).toLowerCase();
    const idx = lc.indexOf(kwLc);
    if (idx < 0) return '';
    return extractContextIndex(content, idx, idx + keyword.length);
  }

  function extractContextIndex(content, start, end) {
    const ctxStart = Math.max(0, start - CONTEXT_LEN);
    const ctxEnd = Math.min(content.length, end + CONTEXT_LEN);
    const before = (ctxStart > 0 ? '…' : '') + content.substring(ctxStart, start);
    const match = content.substring(start, end);
    const after = content.substring(end, ctxEnd) + (ctxEnd < content.length ? '…' : '');
    return before + '【' + match + '】' + after;
  }

  function isWhitelist(rule) {
    return rule.category && rule.category.indexOf('白名单') >= 0;
  }

  /**
   * 从规则中提取白名单配置（用于 URL 过滤）
   */
  function getWhitelist(rules) {
    rules = rules || (global.API_FINDER_RULES || []);
    const ext = new Set();
    const path = new Set();
    const domain = new Set();
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (!isWhitelist(r)) continue;
      const list = r.keyword || [];
      for (let j = 0; j < list.length; j++) {
        const item = list[j].toLowerCase();
        if (r.category === '白名单URL后缀') ext.add(item);
        else if (r.category === '白名单路径') path.add(item);
        else if (r.category === '白名单域名') domain.add(item);
      }
    }
    return { ext: Array.from(ext), path: Array.from(path), domain: Array.from(domain) };
  }

  /**
   * URL 是否命中白名单
   */
  function isUrlWhitelisted(url, wl) {
    if (!url) return false;
    const lower = url.toLowerCase();
    // 后缀
    const dotIdx = lower.lastIndexOf('.');
    if (dotIdx >= 0) {
      const ext = lower.substring(dotIdx + 1).split(/[?#/]/)[0];
      if (wl.ext.indexOf(ext) >= 0) return true;
    }
    // 路径
    for (let i = 0; i < wl.path.length; i++) {
      if (lower.indexOf(wl.path[i]) >= 0) return true;
    }
    // 域名
    for (let i = 0; i < wl.domain.length; i++) {
      if (lower.indexOf(wl.domain[i]) >= 0) return true;
    }
    return false;
  }

  /**
   * 把命中按 category 分组（便于 UI 展示）
   */
  function classifyByCategory(hits) {
    const map = {};
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const c = h.rule.category;
      if (!map[c]) map[c] = [];
      map[c].push(h);
    }
    return map;
  }

  // ────────────────────────── 暴露 ──────────────────────────
  const Engine = {
    match: match,
    matchRule: matchRule,
    getWhitelist: getWhitelist,
    isUrlWhitelisted: isUrlWhitelisted,
    classifyByCategory: classifyByCategory,
    // 调试用
    _runOnContent: runOnContent,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Engine;
  } else {
    global.ApiFinderEngine = Engine;
  }
})(typeof self !== 'undefined' ? self : this);