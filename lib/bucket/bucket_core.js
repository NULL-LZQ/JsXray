/* =====================================================================
 * JsXray — 云存储桶检测核心（自动生成，请勿手改）
 * 来源：谛听鉴-云存储桶风险监测 V1.1.0（By 狐狸）10 厂商检测引擎 + 分发入口
 * 生成：node tools/build_bucket_core.js
 * 说明：每个源文件包进独立 IIFE，厂商函数挂到 self.BucketVendors，
 *       分发函数挂到 self.BucketDetect，供非模块 Service Worker 使用。
 * ===================================================================== */
'use strict';
self.BucketVendors = self.BucketVendors || {};
self.BucketDetect = self.BucketDetect || {};

/* ===== 厂商检测：aliyun.js ===== */
(function () {
const TYPE = {
    TRAVERSABLE: '存储桶可遍历',
    UPLOAD: 'PUT文件上传',
    DELETE: 'DELETE文件删除',
    ACL_READ: 'ACL可读',
    ACL_WRITE: 'ACL可写',
    POLICY_READ: 'Policy可读',
    POLICY_WRITE: 'Policy可写',
    BUCKET_TAKEOVER: '桶接管',
};

function buildBurpRequest(method, url, headers, body) {
    const u = new URL(url);
    let req = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
    req += `Host: ${u.host}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        if (k.toLowerCase() !== 'host') req += `${k}: ${v}\r\n`;
    }
    req += '\r\n';
    if (body) req += body;
    return req;
}

function buildBurpResponse(status, statusText, headers, body) {
    let resp = `HTTP/1.1 ${status} ${statusText}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        resp += `${k}: ${v}\r\n`;
    }
    resp += '\r\n';
    if (body) resp += body;
    return resp;
}

async function checkAliyun(url, options = { checkAcl: true, checkPolicy: true }) {
    const results = [];
    const enabledTypes = Array.isArray(options && options.enabledTypes) ? options.enabledTypes : null;
    const want = (t) => !enabledTypes || enabledTypes.indexOf(t) !== -1;
    const { checkAcl, checkPolicy, safeMode, traverseBacktrack } = options;
    const listUrl = removeAllParameters(url);
    const bucketBaseUrl = getBucketBase(url);

    const testObjectName = `bt_test_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`;

    let traversableFound = false;
    let traversableReqHeaders = {};
    let traversableReqBody = undefined;
    let traversableResp, traversableText, traversableRespHeaders;
    let matchedTraverseUrl = '';

    if (want(TYPE.TRAVERSABLE)) try {
        const candidates = buildListingCandidates(url, bucketBaseUrl, 'oss', traverseBacktrack);
        for (const c of candidates) {
            try {
                traversableResp = await fetch(c.url, { method: 'GET' });
                traversableText = await traversableResp.text();
                traversableRespHeaders = Object.fromEntries(traversableResp.headers.entries());

                if (
                    traversableResp.status >= 200 && traversableResp.status < 300 &&
                    traversableText.includes('<ListBucketResult') && traversableText.includes('<Name>')
                ) {
                    traversableFound = true;
                    matchedTraverseUrl = c.url;
                    break;
                }
            } catch (e) { }
        }
    } catch (e) { }
    if (traversableFound) {
        results.push({
            type: TYPE.TRAVERSABLE,
            vendor: '阿里云',
            url: matchedTraverseUrl || bucketBaseUrl,
            found: traversableFound,
            request: buildBurpRequest('GET', matchedTraverseUrl || bucketBaseUrl, traversableReqHeaders, traversableReqBody),
            response: traversableResp ? buildBurpResponse(traversableResp.status, traversableResp.statusText, traversableRespHeaders, traversableText) : '',
            detail: matchedTraverseUrl ? `存储桶可遍历 (${matchedTraverseUrl})` : '存储桶可遍历'
        });
    }

    if (!safeMode && want(TYPE.UPLOAD)) {
        let uploadFound = false;
        const uploadUrl = listUrl + '/' + testObjectName;
        let uploadReqHeaders = {};
        let uploadReqBody = 'test fileUpload';
        let uploadResp, uploadRespBody, uploadRespHeaders;
        try {
            uploadResp = await fetch(uploadUrl, {
                method: 'PUT',
                body: uploadReqBody
            });
            uploadRespBody = await uploadResp.text();
            uploadRespHeaders = Object.fromEntries(uploadResp.headers.entries());
            if (uploadResp.status >= 200 && uploadResp.status < 300) {
                uploadFound = true;
            }
        } catch (e) { }
        if (uploadFound) {
            results.push({
                type: TYPE.UPLOAD,
                vendor: '阿里云',
                url: uploadUrl,
                found: uploadFound,
                request: buildBurpRequest('PUT', uploadUrl, uploadReqHeaders, uploadReqBody),
                response: uploadResp ? buildBurpResponse(uploadResp.status, uploadResp.statusText, uploadRespHeaders, uploadRespBody) : '',
                detail: 'PUT文件上传成功'
            });
        }

        if (uploadFound) {
            let deleteFound = false;
            const delUrl = uploadUrl;
            const delReqHeaders = {};
            let delResp, delRespBody, delRespHeaders;
            try {
                delResp = await fetch(delUrl, { method: 'DELETE' });
                delRespBody = await delResp.text();
                delRespHeaders = Object.fromEntries(delResp.headers.entries());
                if (delResp.status >= 200 && delResp.status < 300) {
                    deleteFound = true;
                }
            } catch (e) { }
            if (deleteFound && want(TYPE.DELETE)) {
                results.push({
                    type: TYPE.DELETE,
                    vendor: '阿里云',
                    url: delUrl,
                    found: deleteFound,
                    request: buildBurpRequest('DELETE', delUrl, delReqHeaders, undefined),
                    response: delResp ? buildBurpResponse(delResp.status, delResp.statusText, delRespHeaders, delRespBody) : '',
                    detail: 'DELETE文件删除成功'
                });
            }
        }
    }

    if (checkAcl) {
        let aclReadFound = false;
        const aclUrl = listUrl + '?acl';
        let aclReadReqHeaders = {};
        let aclReadReqBody = undefined;
        let aclResp, aclRespBody, aclRespHeaders;
        if (want(TYPE.ACL_READ)) try {
            aclResp = await fetch(aclUrl, { method: 'GET' });
            aclRespBody = await aclResp.text();
            aclRespHeaders = Object.fromEntries(aclResp.headers.entries());
            if (
                aclResp.status >= 200 && aclResp.status < 300 &&
                aclRespBody &&
                aclRespBody.includes('<AccessControlPolicy')
            ) {
                aclReadFound = true;
            }
        } catch (e) { }
        if (aclReadFound || (aclResp && aclResp.status === 403 && aclRespBody && aclRespBody.includes('<Code>AccessDenied</Code>'))) {
            results.push({
                type: TYPE.ACL_READ,
                vendor: '阿里云',
                url: aclUrl,
                found: aclReadFound,
                request: buildBurpRequest('GET', aclUrl, aclReadReqHeaders, aclReadReqBody),
                response: aclResp ? buildBurpResponse(aclResp.status, aclResp.statusText, aclRespHeaders, aclRespBody) : '',
                detail: aclReadFound ? 'ACL匿名可读' : 'ACL禁止访问 (AccessDenied)'
            });
        }

        if (!safeMode && want(TYPE.ACL_WRITE)) {
            let aclWriteFound = false;
            const putAclHeaders = { 'x-oss-object-acl': 'default' };
            let putAclResp, putAclRespBody, putAclRespHeaders;
            try {
                putAclResp = await fetch(aclUrl, {
                    method: 'PUT',
                    headers: putAclHeaders
                });
                putAclRespBody = await putAclResp.text();
                putAclRespHeaders = Object.fromEntries(putAclResp.headers.entries());
                if (putAclResp.status >= 200 && putAclResp.status < 300) {
                    aclWriteFound = true;
                }
            } catch (e) { }
            if (aclWriteFound) {
                results.push({
                    type: TYPE.ACL_WRITE,
                    vendor: '阿里云',
                    url: aclUrl,
                    found: aclWriteFound,
                    request: buildBurpRequest('PUT', aclUrl, putAclHeaders, undefined),
                    response: putAclResp ? buildBurpResponse(putAclResp.status, putAclResp.statusText, putAclRespHeaders, putAclRespBody) : '',
                    detail: 'ACL可写'
                });
            }
        }
    }

    if (checkPolicy) {
        let policyReadFound = false;
        const policyReadUrl = listUrl + '/?policy';
        let policyReadResp, policyReadBody, policyReadHeaders;
        if (want(TYPE.POLICY_READ)) try {
            policyReadResp = await fetch(policyReadUrl, { method: 'GET' });
            policyReadBody = await policyReadResp.text();
            policyReadHeaders = Object.fromEntries(policyReadResp.headers.entries());
            if (
                policyReadResp.status >= 200 && policyReadResp.status < 300 &&
                policyReadBody &&
                policyReadBody.includes('Statement')
            ) {
                policyReadFound = true;
            }
        } catch (e) { }
        if (policyReadFound || (policyReadResp && policyReadResp.status === 403 && policyReadBody && policyReadBody.includes('<Code>AccessDenied</Code>'))) {
            results.push({
                type: TYPE.POLICY_READ,
                vendor: '阿里云',
                url: policyReadUrl,
                found: policyReadFound,
                request: buildBurpRequest('GET', policyReadUrl, {}, undefined),
                response: policyReadResp ? buildBurpResponse(policyReadResp.status, policyReadResp.statusText, policyReadHeaders, policyReadBody) : '',
                detail: policyReadFound ? 'Policy匿名可读' : 'Policy禁止访问 (AccessDenied)'
            });
        }

        if (!safeMode && want(TYPE.POLICY_WRITE)) {
            let policyFound = false;
            const policyUrl = listUrl + '/?policy';
            const policyBody = JSON.stringify({
                Version: '1',
                Statement: [{
                    Action: ['oss:PutObject', 'oss:GetObject'],
                    Effect: 'Allow',
                    Principal: ['1234567890'],
                    Resource: ['acs:oss:*:*/*']
                }]
            });
            let policyReqHeaders = {};
            let policyResp, policyRespBody, policyRespHeaders;
            try {
                policyResp = await fetch(policyUrl, {
                    method: 'PUT',
                    body: policyBody
                });
                policyRespBody = await policyResp.text();
                policyRespHeaders = Object.fromEntries(policyResp.headers.entries());
                if (policyResp.status >= 200 && policyResp.status < 300) {
                    policyFound = true;
                }
            } catch (e) { }
            if (policyFound) {
                results.push({
                    type: TYPE.POLICY_WRITE,
                    vendor: '阿里云',
                    url: policyUrl,
                    found: policyFound,
                    request: buildBurpRequest('PUT', policyUrl, policyReqHeaders, policyBody),
                    response: policyResp ? buildBurpResponse(policyResp.status, policyResp.statusText, policyRespHeaders, policyRespBody) : '',
                    detail: 'Policy可写'
                });
            }
        }
    }

    let takeoverFound = false;
    let takeoverResp, takeoverText, takeoverRespHeaders;
    if (want(TYPE.BUCKET_TAKEOVER)) try {
        const takeoverUrl = bucketBaseUrl + '/';
        takeoverResp = await fetch(takeoverUrl, { method: 'GET' });
        takeoverText = await takeoverResp.text();
        takeoverRespHeaders = Object.fromEntries(takeoverResp.headers.entries());

        if (
            takeoverResp &&
            takeoverResp.status >= 400 && takeoverResp.status < 500 &&
            takeoverText &&
            takeoverText.includes('<Error') &&
            takeoverText.includes('<Code>NoSuchBucket</Code>')
        ) {
            takeoverFound = true;
        }
    } catch (e) { }
    if (takeoverFound) {
        results.push({
            type: TYPE.BUCKET_TAKEOVER,
            vendor: '阿里云',
            url: bucketBaseUrl,
            found: takeoverFound,
            request: buildBurpRequest('GET', bucketBaseUrl + '/', {}, undefined),
            response: takeoverResp ? buildBurpResponse(takeoverResp.status, takeoverResp.statusText, takeoverRespHeaders, takeoverText) : '',
            detail: takeoverResp && takeoverResp.url ? `存在桶接管风险 (${takeoverResp.url})` : '存在桶接管风险'
        });
    }

    return results;
}

function removeAllParameters(url) {
    try {
        const u = new URL(url);
        u.search = '';
        return u.toString();
    } catch {
        return url;
    }
}

function getBucketBase(url) {
    try {
        const u = new URL(url);
        u.pathname = '/';
        u.search = '';
        u.hash = '';
        return u.toString().replace(/\/$/, '');
    } catch {
        return removeAllParameters(url).replace(/\/.+$/, '');
    }
}

function buildPrefixCandidates(url, backtrack) {
    const out = [''];
    try {
        const u = new URL(url);
        let p = u.pathname || '/';
        if (!p || p === '/') return out;
        p = p.replace(/^\/+/, '');
        if (!p) return out;
        const isDir = p.endsWith('/');
        const seg = p.split('/').filter(Boolean);
        if (!seg.length) return out;
        const dirSeg = isDir ? seg : seg.slice(0, -1);
        if (backtrack) {
            for (let i = dirSeg.length; i >= 1; i--) {
                out.push(dirSeg.slice(0, i).join('/') + '/');
            }
        } else {
            if (dirSeg.length) out.push(dirSeg.join('/') + '/');
            if (dirSeg.length >= 2) out.push(dirSeg.slice(0, -1).join('/') + '/');
        }
    } catch { }
    return Array.from(new Set(out));
}

function buildListingCandidates(url, bucketBaseUrl, mode, backtrack) {
    const base = (bucketBaseUrl || getBucketBase(url)).replace(/\/$/, '');
    const prefixes = buildPrefixCandidates(url, backtrack);
    const res = [];
    if (mode === 'aws') {
        for (const prefix of prefixes) {
            const qs = new URLSearchParams();
            qs.set('list-type', '2');
            qs.set('delimiter', '/');
            if (prefix) qs.set('prefix', prefix);
            res.push({ url: `${base}/?${qs.toString()}` });
        }
        return res;
    }

    res.push({ url: `${base}/` });
    for (const prefix of prefixes) {
        const qs = new URLSearchParams();
        qs.set('delimiter', '/');
        if (prefix) qs.set('prefix', prefix);
        res.push({ url: `${base}/?${qs.toString()}` });
    }
    return res;
}
    self.BucketVendors.checkAliyun = checkAliyun;
})();

/* ===== 厂商检测：tencent.js ===== */
(function () {
const TYPE = {
    TRAVERSABLE: '存储桶可遍历',
    UPLOAD: 'PUT文件上传',
    ACL_READ: 'ACL可读',
    ACL_WRITE: 'ACL可写',
};

function buildBurpRequest(method, url, headers, body) {
    const u = new URL(url);
    let req = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
    req += `Host: ${u.host}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        if (k.toLowerCase() !== 'host') req += `${k}: ${v}\r\n`;
    }
    req += '\r\n';
    if (body) req += body;
    return req;
}

function buildBurpResponse(status, statusText, headers, body) {
    let resp = `HTTP/1.1 ${status} ${statusText}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        resp += `${k}: ${v}\r\n`;
    }
    resp += '\r\n';
    if (body) resp += body;
    return resp;
}

function getBucketBase(url) {
    try {
        const u = new URL(url);
        u.pathname = '/';
        u.search = '';
        u.hash = '';
        return u.toString().replace(/\/$/, '');
    } catch {
        return removeAllParameters(url).replace(/\/.+$/, '');
    }
}

function buildPrefixCandidates(url, backtrack) {
    const out = [''];
    try {
        const u = new URL(url);
        let p = u.pathname || '/';
        if (!p || p === '/') return out;
        p = p.replace(/^\/+/, '');
        if (!p) return out;
        const isDir = p.endsWith('/');
        const seg = p.split('/').filter(Boolean);
        if (!seg.length) return out;
        const dirSeg = isDir ? seg : seg.slice(0, -1);
        if (backtrack) {
            for (let i = dirSeg.length; i >= 1; i--) {
                out.push(dirSeg.slice(0, i).join('/') + '/');
            }
        } else {
            if (dirSeg.length) out.push(dirSeg.join('/') + '/');
            if (dirSeg.length >= 2) out.push(dirSeg.slice(0, -1).join('/') + '/');
        }
    } catch { }
    return Array.from(new Set(out));
}

function buildListingCandidates(url, bucketBaseUrl, backtrack) {
    const base = (bucketBaseUrl || getBucketBase(url)).replace(/\/$/, '');
    const prefixes = buildPrefixCandidates(url, backtrack);
    const res = [];
    res.push({ url: `${base}/` });
    for (const prefix of prefixes) {
        const qs = new URLSearchParams();
        qs.set('delimiter', '/');
        if (prefix) qs.set('prefix', prefix);
        res.push({ url: `${base}/?${qs.toString()}` });
    }
    return res;
}

async function checkTencent(url, options = { checkAcl: true }) {
    const results = [];
    const enabledTypes = Array.isArray(options && options.enabledTypes) ? options.enabledTypes : null;
    const want = (t) => !enabledTypes || enabledTypes.indexOf(t) !== -1;
    const { checkAcl } = options;
    const safeMode = options && options.safeMode === true;
    const traverseBacktrack = options && options.traverseBacktrack === true;
    const listUrl = removeAllParameters(url);
    const bucketBaseUrl = getBucketBase(url);

    if (checkAcl) {
        const aclUrl = listUrl + '/?acl';
        if (!safeMode && want(TYPE.ACL_WRITE)) {
            let aclWriteFound = false;
            const putAclHeaders = {
                'x-cos-acl': 'public-read-write',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.5414.75 Safari/537.36'
            };
            let putAclResp, putAclRespBody, putAclRespHeaders;
            try {
                putAclResp = await fetch(aclUrl, {
                    method: 'PUT',
                    headers: putAclHeaders
                });
                putAclRespBody = await putAclResp.text();
                putAclRespHeaders = Object.fromEntries(putAclResp.headers.entries());
                if (putAclResp.status >= 200 && putAclResp.status < 300) {
                    aclWriteFound = true;
                }
            } catch (e) { }
            if (aclWriteFound) {
                results.push({
                    type: TYPE.ACL_WRITE,
                    vendor: '腾讯云',
                    url: aclUrl,
                    found: aclWriteFound,
                    request: buildBurpRequest('PUT', aclUrl, putAclHeaders, undefined),
                    response: putAclResp ? buildBurpResponse(putAclResp.status, putAclResp.statusText, putAclRespHeaders, putAclRespBody) : '',
                    detail: 'ACL可写'
                });
            }
        }
        let aclReadFound = false;
        const getAclHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.5414.75 Safari/537.36'
        };
        let getAclResp, getAclText, getAclRespHeaders;
        if (want(TYPE.ACL_READ)) try {
            getAclResp = await fetch(aclUrl, {
                method: 'GET',
                headers: getAclHeaders
            });
            getAclText = await getAclResp.text();
            getAclRespHeaders = Object.fromEntries(getAclResp.headers.entries());
            if (
                getAclResp.status >= 200 && getAclResp.status < 300 &&
                getAclText &&
                getAclText.includes('<Permission>')
            ) {
                aclReadFound = true;
            }
        } catch (e) { }
        const isAccessDenied = !!(getAclResp && getAclResp.status === 403 && getAclText && getAclText.includes('<Code>AccessDenied</Code>'));
        if (aclReadFound || isAccessDenied) {
            results.push({
                type: TYPE.ACL_READ,
                vendor: '腾讯云',
                url: aclUrl,
                found: aclReadFound,
                request: buildBurpRequest('GET', aclUrl, getAclHeaders, undefined),
                response: getAclResp ? buildBurpResponse(getAclResp.status, getAclResp.statusText, getAclRespHeaders, getAclText) : '',
                detail: aclReadFound ? 'ACL匿名可读' : 'ACL禁止访问 (AccessDenied)'
            });
        }
    }

    let traverseFound = false;
    const getHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.5414.75 Safari/537.36'
    };
    let getResp, getText, respHeaders;
    let matchedTraverseUrl = '';
    if (want(TYPE.TRAVERSABLE)) try {
        const candidates = buildListingCandidates(url, bucketBaseUrl, traverseBacktrack);
        for (const c of candidates) {
            try {
                getResp = await fetch(c.url, { method: 'GET', headers: getHeaders });
                getText = await getResp.text();
                respHeaders = Object.fromEntries(getResp.headers.entries());
                if (
                    getResp.status >= 200 && getResp.status < 300 &&
                    getText.includes('<ListBucketResult') && getText.includes('<Name>')
                ) {
                    traverseFound = true;
                    matchedTraverseUrl = c.url;
                    break;
                }
            } catch (e) { }
        }
    } catch (e) { }
    if (traverseFound) {
        results.push({
            type: TYPE.TRAVERSABLE,
            vendor: '腾讯云',
            url: matchedTraverseUrl || bucketBaseUrl,
            found: traverseFound,
            request: buildBurpRequest('GET', matchedTraverseUrl || bucketBaseUrl, getHeaders, undefined),
            response: getResp ? buildBurpResponse(getResp.status, getResp.statusText, respHeaders, getText) : '',
            detail: matchedTraverseUrl ? `存储桶可遍历 (${matchedTraverseUrl})` : '存储桶可遍历'
        });
    }

    if (!safeMode && want(TYPE.UPLOAD)) {
        let uploadFound = false;
        const fileName = 'testFileByExt.txt';
        const uploadUrl = listUrl + '/' + fileName;
        const reqHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.5414.75 Safari/537.36'
        };
        const reqBody = 'test fileUpload';
        let uploadResp, respBody, uploadRespHeaders;
        try {
            uploadResp = await fetch(uploadUrl, {
                method: 'PUT',
                headers: reqHeaders,
                body: reqBody
            });
            respBody = await uploadResp.text();
            uploadRespHeaders = Object.fromEntries(uploadResp.headers.entries());
            if (uploadResp.status >= 200 && uploadResp.status < 300) {
                uploadFound = true;
            }
        } catch (e) { }
        if (uploadFound) {
            results.push({
                type: TYPE.UPLOAD,
                vendor: '腾讯云',
                url: uploadUrl,
                found: uploadFound,
                request: buildBurpRequest('PUT', uploadUrl, reqHeaders, reqBody),
                response: uploadResp ? buildBurpResponse(uploadResp.status, uploadResp.statusText, uploadRespHeaders, respBody) : '',
                detail: 'PUT文件上传成功'
            });
        }
    }

    return results;
}

function removeAllParameters(url) {
    try {
        const u = new URL(url);
        u.search = '';
        return u.toString();
    } catch {
        return url;
    }
}
    self.BucketVendors.checkTencent = checkTencent;
})();

/* ===== 厂商检测：huawei.js ===== */
(function () {
const TYPE = {
    TRAVERSABLE: '存储桶可遍历',
    UPLOAD: 'PUT文件上传',
    ACL_READ: 'ACL可读',
    ACL_WRITE: 'ACL可写',
};

function buildBurpRequest(method, url, headers, body) {
    const u = new URL(url);
    let req = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
    req += `Host: ${u.host}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        if (k.toLowerCase() !== 'host') req += `${k}: ${v}\r\n`;
    }
    req += '\r\n';
    if (body) req += body;
    return req;
}

function buildBurpResponse(status, statusText, headers, body) {
    let resp = `HTTP/1.1 ${status} ${statusText}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        resp += `${k}: ${v}\r\n`;
    }
    resp += '\r\n';
    if (body) resp += body;
    return resp;
}

function getBucketBase(url) {
    try {
        const u = new URL(url);
        u.pathname = '/';
        u.search = '';
        u.hash = '';
        return u.toString().replace(/\/$/, '');
    } catch {
        return removeAllParameters(url).replace(/\/.+$/, '');
    }
}

function buildPrefixCandidates(url, backtrack) {
    const out = [''];
    try {
        const u = new URL(url);
        let p = u.pathname || '/';
        if (!p || p === '/') return out;
        p = p.replace(/^\/+/, '');
        if (!p) return out;
        const isDir = p.endsWith('/');
        const seg = p.split('/').filter(Boolean);
        if (!seg.length) return out;
        const dirSeg = isDir ? seg : seg.slice(0, -1);
        if (backtrack) {
            for (let i = dirSeg.length; i >= 1; i--) {
                out.push(dirSeg.slice(0, i).join('/') + '/');
            }
        } else {
            if (dirSeg.length) out.push(dirSeg.join('/') + '/');
            if (dirSeg.length >= 2) out.push(dirSeg.slice(0, -1).join('/') + '/');
        }
    } catch { }
    return Array.from(new Set(out));
}

function buildListingCandidates(url, bucketBaseUrl, backtrack) {
    const base = (bucketBaseUrl || getBucketBase(url)).replace(/\/$/, '');
    const prefixes = buildPrefixCandidates(url, backtrack);
    const res = [];
    res.push({ url: `${base}/` });
    for (const prefix of prefixes) {
        const qs = new URLSearchParams();
        qs.set('delimiter', '/');
        if (prefix) qs.set('prefix', prefix);
        res.push({ url: `${base}/?${qs.toString()}` });
    }
    return res;
}

async function checkHuawei(url, options = { checkAcl: true }) {
    const results = [];
    const enabledTypes = Array.isArray(options && options.enabledTypes) ? options.enabledTypes : null;
    const want = (t) => !enabledTypes || enabledTypes.indexOf(t) !== -1;
    const { checkAcl } = options;
    const safeMode = options && options.safeMode === true;
    const traverseBacktrack = options && options.traverseBacktrack === true;
    const listUrl = removeAllParameters(url);
    const bucketBaseUrl = getBucketBase(url);

    if (!safeMode && want(TYPE.UPLOAD)) {
        let uploadFound = false;
        const uploadUrl = listUrl + '/testFileByExt.txt';
        const reqHeaders = {};
        const reqBody = 'test';
        let uploadResp, respBody, uploadRespHeaders;
        try {
            uploadResp = await fetch(uploadUrl, {
                method: 'PUT',
                body: reqBody
            });
            respBody = await uploadResp.text();
            uploadRespHeaders = Object.fromEntries(uploadResp.headers.entries());
            if (uploadResp.status >= 200 && uploadResp.status < 300) {
                uploadFound = true;
            }
        } catch (e) { }
        if (uploadFound) {
            results.push({
                type: TYPE.UPLOAD,
                vendor: '华为云',
                url: uploadUrl,
                found: uploadFound,
                request: buildBurpRequest('PUT', uploadUrl, reqHeaders, reqBody),
                response: uploadResp ? buildBurpResponse(uploadResp.status, uploadResp.statusText, uploadRespHeaders, respBody) : '',
                detail: 'PUT文件上传成功'
            });
        }
    }

    let traverseFound = false;
    let getResp, getText, respHeaders;
    let matchedTraverseUrl = '';
    if (want(TYPE.TRAVERSABLE)) try {
        const candidates = buildListingCandidates(url, bucketBaseUrl, traverseBacktrack);
        for (const c of candidates) {
            try {
                getResp = await fetch(c.url, { method: 'GET' });
                getText = await getResp.text();
                respHeaders = Object.fromEntries(getResp.headers.entries());
                if (
                    getResp.status >= 200 && getResp.status < 300 &&
                    getText.includes('<Name>') && getText.includes('<Contents>')
                ) {
                    traverseFound = true;
                    matchedTraverseUrl = c.url;
                    break;
                }
            } catch (e) { }
        }
    } catch (e) { }
    if (traverseFound) {
        results.push({
            type: TYPE.TRAVERSABLE,
            vendor: '华为云',
            url: matchedTraverseUrl || bucketBaseUrl,
            found: traverseFound,
            request: buildBurpRequest('GET', matchedTraverseUrl || bucketBaseUrl, {}, undefined),
            response: getResp ? buildBurpResponse(getResp.status, getResp.statusText, respHeaders, getText) : '',
            detail: matchedTraverseUrl ? `存储桶可遍历 (${matchedTraverseUrl})` : '存储桶可遍历'
        });
    }

    if (checkAcl) {
        let aclReadFound = false;
        const aclUrl = listUrl + '/?acl';
        let aclResp, aclText, aclRespHeaders;
        if (want(TYPE.ACL_READ)) try {
            aclResp = await fetch(aclUrl, { method: 'GET' });
            aclText = await aclResp.text();
            aclRespHeaders = Object.fromEntries(aclResp.headers.entries());
            if (
                aclResp.status >= 200 && aclResp.status < 300 &&
                aclText.includes('<Owner>') && aclText.includes('<AccessControlList>')
            ) {
                aclReadFound = true;
            }
        } catch (e) { }
        const isAccessDenied = !!(aclResp && aclResp.status === 403 && aclText && aclText.includes('<Code>AccessDenied</Code>'));
        if (aclReadFound || isAccessDenied) {
            results.push({
                type: TYPE.ACL_READ,
                vendor: '华为云',
                url: aclUrl,
                found: aclReadFound,
                request: buildBurpRequest('GET', aclUrl, {}, undefined),
                response: aclResp ? buildBurpResponse(aclResp.status, aclResp.statusText, aclRespHeaders, aclText) : '',
                detail: aclReadFound ? 'ACL匿名可读' : 'ACL禁止访问 (AccessDenied)'
            });
        }

        if (!safeMode && want(TYPE.ACL_WRITE)) {
            let aclWriteFound = false;
            const putAclHeaders = { 'x-obs-acl': 'public-read-write-delivered' };
            let putAclResp, putAclRespBody, putAclRespHeaders;
            try {
                putAclResp = await fetch(aclUrl, {
                    method: 'PUT',
                    headers: putAclHeaders
                });
                putAclRespBody = await putAclResp.text();
                putAclRespHeaders = Object.fromEntries(putAclResp.headers.entries());
                if (putAclResp.status >= 200 && putAclResp.status < 300) {
                    aclWriteFound = true;
                }
            } catch (e) { }
            if (aclWriteFound) {
                results.push({
                    type: TYPE.ACL_WRITE,
                    vendor: '华为云',
                    url: aclUrl,
                    found: aclWriteFound,
                    request: buildBurpRequest('PUT', aclUrl, putAclHeaders, undefined),
                    response: putAclResp ? buildBurpResponse(putAclResp.status, putAclResp.statusText, putAclRespHeaders, putAclRespBody) : '',
                    detail: 'ACL可写'
                });
            }
        }
    }

    return results;
}

function removeAllParameters(url) {
    try {
        const u = new URL(url);
        u.search = '';
        return u.toString();
    } catch {
        return url;
    }
}
    self.BucketVendors.checkHuawei = checkHuawei;
})();

/* ===== 厂商检测：aws.js ===== */
(function () {
const TYPE = {
    TRAVERSABLE: '存储桶可遍历',
    UPLOAD: 'PUT文件上传',
    DELETE: 'DELETE文件删除',
    ACL_READ: 'ACL可读',
    ACL_WRITE: 'ACL可写',
    POLICY_READ: 'Policy可读',
    BUCKET_TAKEOVER: '桶接管',
};

function buildBurpRequest(method, url, headers, body) {
    const u = new URL(url);
    let req = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
    req += `Host: ${u.host}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        if (k.toLowerCase() !== 'host') req += `${k}: ${v}\r\n`;
    }
    req += '\r\n';
    if (body) req += body;
    return req;
}

function buildBurpResponse(status, statusText, headers, body) {
    let resp = `HTTP/1.1 ${status} ${statusText}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        resp += `${k}: ${v}\r\n`;
    }
    resp += '\r\n';
    if (body) resp += body;
    return resp;
}

function getBucketBase(url) {
    try {
        const u = new URL(url);
        u.pathname = '/';
        u.search = '';
        u.hash = '';
        return u.toString().replace(/\/$/, '');
    } catch {
        return removeAllParameters(url).replace(/\/.+$/, '');
    }
}

function buildPrefixCandidates(url, backtrack) {
    const out = [''];
    try {
        const u = new URL(url);
        let p = u.pathname || '/';
        if (!p || p === '/') return out;
        p = p.replace(/^\/+/, '');
        if (!p) return out;
        const isDir = p.endsWith('/');
        const seg = p.split('/').filter(Boolean);
        if (!seg.length) return out;
        const dirSeg = isDir ? seg : seg.slice(0, -1);
        if (backtrack) {
            for (let i = dirSeg.length; i >= 1; i--) {
                out.push(dirSeg.slice(0, i).join('/') + '/');
            }
        } else {
            if (dirSeg.length) out.push(dirSeg.join('/') + '/');
            if (dirSeg.length >= 2) out.push(dirSeg.slice(0, -1).join('/') + '/');
        }
    } catch { }
    return Array.from(new Set(out));
}

function buildListingCandidates(url, bucketBaseUrl, backtrack) {
    const base = (bucketBaseUrl || getBucketBase(url)).replace(/\/$/, '');
    const prefixes = buildPrefixCandidates(url, backtrack);
    const res = [];
    for (const prefix of prefixes) {
        const qs = new URLSearchParams();
        qs.set('list-type', '2');
        qs.set('delimiter', '/');
        if (prefix) qs.set('prefix', prefix);
        res.push({ url: `${base}/?${qs.toString()}` });
    }
    return res;
}

async function checkAWS(url, options = {}) {
    const results = [];
    const enabledTypes = Array.isArray(options && options.enabledTypes) ? options.enabledTypes : null;
    const want = (t) => !enabledTypes || enabledTypes.indexOf(t) !== -1;
    const listUrl = removeAllParameters(url);
    const bucketBaseUrl = getBucketBase(url);
    const safeMode = options && options.safeMode === true;
    const traverseBacktrack = options && options.traverseBacktrack === true;

    let traverseFound = false;
    let traverseReq = '';
    let traverseResp, traverseRespText, traverseRespStatus, traverseRespStatusText, traverseRespHeaders;
    let matchedTraverseUrl = '';

    if (want(TYPE.TRAVERSABLE)) try {
        const candidates = buildListingCandidates(url, bucketBaseUrl, traverseBacktrack);
        for (const c of candidates) {
            try {
                traverseReq = buildBurpRequest('GET', c.url, {}, undefined);
                traverseResp = await fetch(c.url, { method: 'GET' });
                traverseRespText = await traverseResp.text();
                traverseRespStatus = traverseResp.status;
                traverseRespStatusText = traverseResp.statusText;
                traverseRespHeaders = Object.fromEntries(traverseResp.headers.entries());
                if (
                    traverseResp.status >= 200 && traverseResp.status < 300 &&
                    traverseRespText.includes('<ListBucketResult') && traverseRespText.includes('<Name>')
                ) {
                    traverseFound = true;
                    matchedTraverseUrl = c.url;
                    break;
                }
            } catch (e) { }
        }
    } catch (e) { }
    if (traverseFound) {
        results.push({
            type: TYPE.TRAVERSABLE,
            vendor: 'AmazonS3',
            url: matchedTraverseUrl || bucketBaseUrl,
            found: traverseFound,
            request: traverseReq,
            response: traverseResp ? buildBurpResponse(traverseRespStatus, traverseRespStatusText, traverseRespHeaders, traverseRespText) : '',
            detail: matchedTraverseUrl ? `存储桶可遍历 (${matchedTraverseUrl})` : '存储桶可遍历'
        });
    }

    if (!safeMode && want(TYPE.UPLOAD)) {
        let uploadFound = false;
        const uploadUrl = listUrl + '/testFileByExt.txt';
        const uploadReq = buildBurpRequest('PUT', uploadUrl, {}, 'test fileUpload');
        let uploadResp, uploadRespText, uploadRespHeaders;
        try {
            uploadResp = await fetch(uploadUrl, {
                method: 'PUT',
                body: 'test fileUpload'
            });
            uploadRespText = await uploadResp.text();
            uploadRespHeaders = Object.fromEntries(uploadResp.headers.entries());
            if (uploadResp.status >= 200 && uploadResp.status < 300) {
                uploadFound = true;
            }
        } catch (e) { }
        if (uploadFound) {
            results.push({
                type: TYPE.UPLOAD,
                vendor: 'AmazonS3',
                url: uploadUrl,
                found: uploadFound,
                request: uploadReq,
                response: uploadResp ? buildBurpResponse(uploadResp.status, uploadResp.statusText, uploadRespHeaders, uploadRespText) : '',
                detail: 'PUT文件上传成功'
            });
        }
    }

    if (!safeMode && (want(TYPE.DELETE) || uploadFound)) {
        let deleteFound = false;
        const delUrl = listUrl + '/testFileByExt.txt';
        const delReq = buildBurpRequest('DELETE', delUrl, {}, undefined);
        let delResp, delRespText, delRespHeaders;
        try {
            delResp = await fetch(delUrl, { method: 'DELETE' });
            delRespText = await delResp.text();
            delRespHeaders = Object.fromEntries(delResp.headers.entries());
            if (delResp.status >= 200 && delResp.status < 300) {
                deleteFound = true;
            }
        } catch (e) { }
        if (deleteFound && want(TYPE.DELETE)) {
            results.push({
                type: TYPE.DELETE,
                vendor: 'AmazonS3',
                url: delUrl,
                found: deleteFound,
                request: delReq,
                response: delResp ? buildBurpResponse(delResp.status, delResp.statusText, delRespHeaders, delRespText) : '',
                detail: 'DELETE文件删除成功'
            });
        }
    }

    let aclReadFound = false;
    const aclUrl = listUrl + '?acl';
    const aclReadReq = buildBurpRequest('GET', aclUrl, {}, undefined);
    let aclResp, aclText, aclHeaders;
    if (want(TYPE.ACL_READ)) try {
        aclResp = await fetch(aclUrl, { method: 'GET' });
        aclText = await aclResp.text();
        aclHeaders = Object.fromEntries(aclResp.headers.entries());
        if (aclResp.status >= 200 && aclResp.status < 300 && aclText && aclText.includes('<AccessControlPolicy>')) {
            aclReadFound = true;
        }
    } catch (e) { }
    const aclAccessDenied = !!(aclResp && aclResp.status === 403 && aclText && aclText.includes('<Code>AccessDenied</Code>'));
    if (aclReadFound || aclAccessDenied) {
        results.push({
            type: TYPE.ACL_READ,
            vendor: 'AmazonS3',
            url: aclUrl,
            found: aclReadFound,
            request: aclReadReq,
            response: aclResp ? buildBurpResponse(aclResp.status, aclResp.statusText, aclHeaders, aclText) : '',
            detail: aclReadFound ? 'ACL匿名可读' : 'ACL禁止访问 (AccessDenied)'
        });
    }

    let policyReadFound = false;
    const policyUrl = listUrl + '?policy';
    const policyReq = buildBurpRequest('GET', policyUrl, {}, undefined);
    let policyResp, policyText, policyHeaders;
    if (want(TYPE.POLICY_READ)) try {
        policyResp = await fetch(policyUrl, { method: 'GET' });
        policyText = await policyResp.text();
        policyHeaders = Object.fromEntries(policyResp.headers.entries());
        if (
            policyResp.status >= 200 && policyResp.status < 300 &&
            policyText &&
            (policyText.trim().startsWith('{') || policyText.includes('Statement'))
        ) {
            policyReadFound = true;
        }
    } catch (e) { }
    const policyAccessDenied = !!(policyResp && policyResp.status === 403 && policyText && policyText.includes('<Code>AccessDenied</Code>'));
    if (policyReadFound || policyAccessDenied) {
        results.push({
            type: TYPE.POLICY_READ,
            vendor: 'AmazonS3',
            url: policyUrl,
            found: policyReadFound,
            request: policyReq,
            response: policyResp ? buildBurpResponse(policyResp.status, policyResp.statusText, policyHeaders, policyText) : '',
            detail: policyReadFound ? 'Policy匿名可读' : 'Policy禁止访问 (AccessDenied)'
        });
    }

    if (!safeMode && want(TYPE.ACL_WRITE)) {
        let aclWriteFound = false;
        const aclWriteReq = buildBurpRequest('PUT', aclUrl, { 'x-amz-acl': 'public-read-write' }, undefined);
        let putAclResp, putAclText, putAclHeaders;
        try {
            const putHeaders = { 'x-amz-acl': 'public-read-write' };
            putAclResp = await fetch(aclUrl, {
                method: 'PUT',
                headers: putHeaders
            });
            putAclText = await putAclResp.text();
            putAclHeaders = Object.fromEntries(putAclResp.headers.entries());
            if (putAclResp.status >= 200 && putAclResp.status < 300) {
                aclWriteFound = true;
            }
        } catch (e) { }
        if (aclWriteFound) {
            results.push({
                type: TYPE.ACL_WRITE,
                vendor: 'AmazonS3',
                url: aclUrl,
                found: aclWriteFound,
                request: aclWriteReq,
                response: putAclResp ? buildBurpResponse(putAclResp.status, putAclResp.statusText, putAclHeaders, putAclText) : '',
                detail: 'ACL可写'
            });
        }
    }

    let takeoverFound = false;
    let takeoverResp, takeoverText, takeoverHeaders;
    if (want(TYPE.BUCKET_TAKEOVER)) try {
        const takeoverUrl = bucketBaseUrl + '/';
        takeoverResp = await fetch(takeoverUrl, { method: 'GET' });
        takeoverText = await takeoverResp.text();
        takeoverHeaders = Object.fromEntries(takeoverResp.headers.entries());
        if (
            takeoverResp &&
            takeoverResp.status >= 400 && takeoverResp.status < 500 &&
            takeoverText &&
            takeoverText.includes('<Error') &&
            takeoverText.includes('<Code>NoSuchBucket</Code>')
        ) {
            takeoverFound = true;
        }
    } catch (e) { }
    if (takeoverFound) {
        results.push({
            type: TYPE.BUCKET_TAKEOVER,
            vendor: 'AmazonS3',
            url: bucketBaseUrl,
            found: takeoverFound,
            request: buildBurpRequest('GET', bucketBaseUrl + '/', {}, undefined),
            response: takeoverResp ? buildBurpResponse(takeoverResp.status, takeoverResp.statusText, takeoverHeaders, takeoverText) : '',
            detail: takeoverResp && takeoverResp.url ? `存在桶接管风险 (${takeoverResp.url})` : '存在桶接管风险'
        });
    }

    return results;
}

function removeAllParameters(url) {
    try {
        const u = new URL(url);
        u.search = '';
        return u.toString();
    } catch {
        return url;
    }
}
    self.BucketVendors.checkAWS = checkAWS;
})();

/* ===== 厂商检测：qiniu.js ===== */
(function () {
const TYPE = {
    TRAVERSABLE: '存储桶可遍历',
    UPLOAD: 'PUT文件上传',
    DELETE: 'DELETE文件删除',
    ACL_READ: 'ACL可读',
    ACL_WRITE: 'ACL可写',
    POLICY_READ: 'Policy可读',
    POLICY_WRITE: 'Policy可写'
};

function buildBurpRequest(method, url, headers, body) {
    const u = new URL(url);
    let req = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
    req += `Host: ${u.host}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        if (k.toLowerCase() !== 'host') req += `${k}: ${v}\r\n`;
    }
    req += '\r\n';
    if (body) req += body;
    return req;
}

function buildBurpResponse(status, statusText, headers, body) {
    let resp = `HTTP/1.1 ${status} ${statusText}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        resp += `${k}: ${v}\r\n`;
    }
    resp += '\r\n';
    if (body) resp += body;
    return resp;
}

function removeAllParameters(url) {
    try {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        return u.toString();
    } catch {
        return url;
    }
}

function getBucketBase(url) {
    try {
        const u = new URL(url);
        u.pathname = '/';
        u.search = '';
        u.hash = '';
        return u.toString().replace(/\/$/, '');
    } catch {
        return removeAllParameters(url).replace(/\/.+$/, '');
    }
}

function buildPrefixCandidates(url, backtrack) {
    const out = [''];
    try {
        const u = new URL(url);
        let p = u.pathname || '/';
        if (!p || p === '/') return out;
        p = p.replace(/^\/+/, '');
        if (!p) return out;
        const isDir = p.endsWith('/');
        const seg = p.split('/').filter(Boolean);
        if (!seg.length) return out;
        const dirSeg = isDir ? seg : seg.slice(0, -1);
        if (backtrack) {
            for (let i = dirSeg.length; i >= 1; i--) {
                out.push(dirSeg.slice(0, i).join('/') + '/');
            }
        } else {
            if (dirSeg.length) out.push(dirSeg.join('/') + '/');
            if (dirSeg.length >= 2) out.push(dirSeg.slice(0, -1).join('/') + '/');
        }
    } catch { }
    return Array.from(new Set(out));
}

function buildListingCandidates(url, bucketBaseUrl, backtrack) {
    const base = (bucketBaseUrl || getBucketBase(url)).replace(/\/$/, '');
    const prefixes = buildPrefixCandidates(url, backtrack);
    const res = [];
    res.push({ url: `${base}/` });
    for (const prefix of prefixes) {
        const qs = new URLSearchParams();
        qs.set('delimiter', '/');
        if (prefix) qs.set('prefix', prefix);
        res.push({ url: `${base}/?${qs.toString()}` });
    }
    return res;
}

function isListResponse(text) {
    const t = String(text || '');
    return t.includes('<ListBucketResult') || (t.includes('<Name>') && t.includes('<Contents>'));
}

async function checkQiniu(url, options = {}) {
    const results = [];
    const enabledTypes = Array.isArray(options && options.enabledTypes) ? options.enabledTypes : null;
    const want = (t) => !enabledTypes || enabledTypes.indexOf(t) !== -1;
    const checkAcl = options && typeof options.checkAcl === 'boolean' ? options.checkAcl : true;
    const checkPolicy = options && typeof options.checkPolicy === 'boolean' ? options.checkPolicy : true;
    const safeMode = options && options.safeMode === true;
    const traverseBacktrack = options && options.traverseBacktrack === true;

    const listUrl = removeAllParameters(url);
    const bucketBaseUrl = getBucketBase(url);

    const testObjectName = `bt_test_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`;

    let traverseFound = false;
    let traverseResp, traverseText, traverseHeaders;
    let matchedTraverseUrl = '';
    if (want(TYPE.TRAVERSABLE)) try {
        const candidates = buildListingCandidates(url, bucketBaseUrl, traverseBacktrack);
        for (const c of candidates) {
            try {
                traverseResp = await fetch(c.url, { method: 'GET' });
                traverseText = await traverseResp.text();
                traverseHeaders = Object.fromEntries(traverseResp.headers.entries());
                if (traverseResp.status >= 200 && traverseResp.status < 300 && isListResponse(traverseText)) {
                    traverseFound = true;
                    matchedTraverseUrl = c.url;
                    break;
                }
            } catch { }
        }
    } catch { }

    if (traverseFound) {
        results.push({
            type: TYPE.TRAVERSABLE,
            vendor: '七牛云',
            url: matchedTraverseUrl || bucketBaseUrl,
            found: true,
            request: buildBurpRequest('GET', matchedTraverseUrl || bucketBaseUrl, {}, undefined),
            response: traverseResp ? buildBurpResponse(traverseResp.status, traverseResp.statusText, traverseHeaders, traverseText) : '',
            detail: matchedTraverseUrl ? `存储桶可遍历 (${matchedTraverseUrl})` : '存储桶可遍历'
        });
    }

    if (!safeMode && want(TYPE.UPLOAD)) {
        let uploadFound = false;
        const uploadUrl = listUrl.replace(/\/$/, '') + '/' + testObjectName;
        const reqBody = 'test fileUpload';
        let uploadResp, uploadRespBody, uploadRespHeaders;
        try {
            uploadResp = await fetch(uploadUrl, { method: 'PUT', body: reqBody });
            uploadRespBody = await uploadResp.text();
            uploadRespHeaders = Object.fromEntries(uploadResp.headers.entries());
            if (uploadResp.status >= 200 && uploadResp.status < 300) uploadFound = true;
        } catch { }
        if (uploadFound) {
            results.push({
                type: TYPE.UPLOAD,
                vendor: '七牛云',
                url: uploadUrl,
                found: true,
                request: buildBurpRequest('PUT', uploadUrl, {}, reqBody),
                response: uploadResp ? buildBurpResponse(uploadResp.status, uploadResp.statusText, uploadRespHeaders, uploadRespBody) : '',
                detail: 'PUT文件上传成功'
            });
        }

        if (uploadFound) {
            let deleteFound = false;
            const delUrl = uploadUrl;
            let delResp, delRespBody, delRespHeaders;
            try {
                delResp = await fetch(delUrl, { method: 'DELETE' });
                delRespBody = await delResp.text();
                delRespHeaders = Object.fromEntries(delResp.headers.entries());
                if (delResp.status >= 200 && delResp.status < 300) deleteFound = true;
            } catch { }
            if (deleteFound && want(TYPE.DELETE)) {
                results.push({
                    type: TYPE.DELETE,
                    vendor: '七牛云',
                    url: delUrl,
                    found: true,
                    request: buildBurpRequest('DELETE', delUrl, {}, undefined),
                    response: delResp ? buildBurpResponse(delResp.status, delResp.statusText, delRespHeaders, delRespBody) : '',
                    detail: 'DELETE文件删除成功'
                });
            }
        }
    }

    if (checkAcl) {
        const aclUrl = listUrl + '?acl';
        let aclReadFound = false;
        let aclResp, aclText, aclHeaders;
        if (want(TYPE.ACL_READ)) try {
            aclResp = await fetch(aclUrl, { method: 'GET' });
            aclText = await aclResp.text();
            aclHeaders = Object.fromEntries(aclResp.headers.entries());
            if (aclResp.status >= 200 && aclResp.status < 300 && aclText && aclText.includes('<AccessControlPolicy')) {
                aclReadFound = true;
            }
        } catch { }
        const aclAccessDenied = !!(aclResp && aclResp.status === 403 && aclText && aclText.includes('AccessDenied'));
        if (aclReadFound || aclAccessDenied) {
            results.push({
                type: TYPE.ACL_READ,
                vendor: '七牛云',
                url: aclUrl,
                found: aclReadFound,
                request: buildBurpRequest('GET', aclUrl, {}, undefined),
                response: aclResp ? buildBurpResponse(aclResp.status, aclResp.statusText, aclHeaders, aclText) : '',
                detail: aclReadFound ? 'ACL匿名可读' : 'ACL禁止访问'
            });
        }

        if (!safeMode && want(TYPE.ACL_WRITE)) {
            let aclWriteFound = false;
            const putHeaders = { 'x-amz-acl': 'public-read-write' };
            let putResp, putText, putRespHeaders;
            try {
                putResp = await fetch(aclUrl, { method: 'PUT', headers: putHeaders });
                putText = await putResp.text();
                putRespHeaders = Object.fromEntries(putResp.headers.entries());
                if (putResp.status >= 200 && putResp.status < 300) aclWriteFound = true;
            } catch { }
            if (aclWriteFound) {
                results.push({
                    type: TYPE.ACL_WRITE,
                    vendor: '七牛云',
                    url: aclUrl,
                    found: true,
                    request: buildBurpRequest('PUT', aclUrl, putHeaders, undefined),
                    response: putResp ? buildBurpResponse(putResp.status, putResp.statusText, putRespHeaders, putText) : '',
                    detail: 'ACL可写'
                });
            }
        }
    }

    if (checkPolicy) {
        const policyUrl = listUrl + '?policy';
        let policyReadFound = false;
        let policyResp, policyText, policyHeaders;
        if (want(TYPE.POLICY_READ)) try {
            policyResp = await fetch(policyUrl, { method: 'GET' });
            policyText = await policyResp.text();
            policyHeaders = Object.fromEntries(policyResp.headers.entries());
            if (policyResp.status >= 200 && policyResp.status < 300 && policyText && (policyText.trim().startsWith('{') || policyText.includes('Statement'))) {
                policyReadFound = true;
            }
        } catch { }
        const policyAccessDenied = !!(policyResp && policyResp.status === 403 && policyText && policyText.includes('AccessDenied'));
        if (policyReadFound || policyAccessDenied) {
            results.push({
                type: TYPE.POLICY_READ,
                vendor: '七牛云',
                url: policyUrl,
                found: policyReadFound,
                request: buildBurpRequest('GET', policyUrl, {}, undefined),
                response: policyResp ? buildBurpResponse(policyResp.status, policyResp.statusText, policyHeaders, policyText) : '',
                detail: policyReadFound ? 'Policy匿名可读' : 'Policy禁止访问'
            });
        }

        if (!safeMode && want(TYPE.POLICY_WRITE)) {
            let policyWriteFound = false;
            const policyBody = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::*/*'] }] });
            let putResp, putText, putHeaders;
            try {
                putResp = await fetch(policyUrl, { method: 'PUT', body: policyBody });
                putText = await putResp.text();
                putHeaders = Object.fromEntries(putResp.headers.entries());
                if (putResp.status >= 200 && putResp.status < 300) policyWriteFound = true;
            } catch { }
            if (policyWriteFound) {
                results.push({
                    type: TYPE.POLICY_WRITE,
                    vendor: '七牛云',
                    url: policyUrl,
                    found: true,
                    request: buildBurpRequest('PUT', policyUrl, {}, policyBody),
                    response: putResp ? buildBurpResponse(putResp.status, putResp.statusText, putHeaders, putText) : '',
                    detail: 'Policy可写'
                });
            }
        }
    }

    return results;
}
    self.BucketVendors.checkQiniu = checkQiniu;
})();

/* ===== 厂商检测：qingcloud.js ===== */
(function () {
const TYPE = {
    TRAVERSABLE: '存储桶可遍历',
    UPLOAD: 'PUT文件上传',
    DELETE: 'DELETE文件删除',
    ACL_READ: 'ACL可读',
    ACL_WRITE: 'ACL可写',
    POLICY_READ: 'Policy可读',
    POLICY_WRITE: 'Policy可写'
};

function buildBurpRequest(method, url, headers, body) {
    const u = new URL(url);
    let req = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
    req += `Host: ${u.host}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        if (k.toLowerCase() !== 'host') req += `${k}: ${v}\r\n`;
    }
    req += '\r\n';
    if (body) req += body;
    return req;
}

function buildBurpResponse(status, statusText, headers, body) {
    let resp = `HTTP/1.1 ${status} ${statusText}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        resp += `${k}: ${v}\r\n`;
    }
    resp += '\r\n';
    if (body) resp += body;
    return resp;
}

function removeAllParameters(url) {
    try {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        return u.toString();
    } catch {
        return url;
    }
}

function getBucketBase(url) {
    try {
        const u = new URL(url);
        u.pathname = '/';
        u.search = '';
        u.hash = '';
        return u.toString().replace(/\/$/, '');
    } catch {
        return removeAllParameters(url).replace(/\/.+$/, '');
    }
}

function buildPrefixCandidates(url, backtrack) {
    const out = [''];
    try {
        const u = new URL(url);
        let p = u.pathname || '/';
        if (!p || p === '/') return out;
        p = p.replace(/^\/+/, '');
        if (!p) return out;
        const isDir = p.endsWith('/');
        const seg = p.split('/').filter(Boolean);
        if (!seg.length) return out;
        const dirSeg = isDir ? seg : seg.slice(0, -1);
        if (backtrack) {
            for (let i = dirSeg.length; i >= 1; i--) {
                out.push(dirSeg.slice(0, i).join('/') + '/');
            }
        } else {
            if (dirSeg.length) out.push(dirSeg.join('/') + '/');
            if (dirSeg.length >= 2) out.push(dirSeg.slice(0, -1).join('/') + '/');
        }
    } catch { }
    return Array.from(new Set(out));
}

function buildListingCandidates(url, bucketBaseUrl, backtrack) {
    const base = (bucketBaseUrl || getBucketBase(url)).replace(/\/$/, '');
    const prefixes = buildPrefixCandidates(url, backtrack);
    const res = [];
    res.push({ url: `${base}/` });
    for (const prefix of prefixes) {
        const qs1 = new URLSearchParams();
        qs1.set('delimiter', '/');
        if (prefix) qs1.set('prefix', prefix);
        res.push({ url: `${base}/?${qs1.toString()}` });

        const qs2 = new URLSearchParams();
        qs2.set('list-type', '2');
        qs2.set('delimiter', '/');
        if (prefix) qs2.set('prefix', prefix);
        res.push({ url: `${base}/?${qs2.toString()}` });
    }
    return res;
}

function isListResponse(text) {
    const t = String(text || '');
    return t.includes('<ListBucketResult') || (t.includes('<Name>') && (t.includes('<Contents>') || t.includes('<CommonPrefixes>')));
}

async function checkQingCloud(url, options = {}) {
    const results = [];
    const enabledTypes = Array.isArray(options && options.enabledTypes) ? options.enabledTypes : null;
    const want = (t) => !enabledTypes || enabledTypes.indexOf(t) !== -1;
    const checkAcl = options && typeof options.checkAcl === 'boolean' ? options.checkAcl : true;
    const checkPolicy = options && typeof options.checkPolicy === 'boolean' ? options.checkPolicy : true;
    const safeMode = options && options.safeMode === true;
    const traverseBacktrack = options && options.traverseBacktrack === true;

    const listUrl = removeAllParameters(url);
    const bucketBaseUrl = getBucketBase(url);

    const testObjectName = `bt_test_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`;

    let traverseFound = false;
    let traverseResp, traverseText, traverseHeaders;
    let matchedTraverseUrl = '';
    if (want(TYPE.TRAVERSABLE)) try {
        const candidates = buildListingCandidates(url, bucketBaseUrl, traverseBacktrack);
        for (const c of candidates) {
            try {
                traverseResp = await fetch(c.url, { method: 'GET' });
                traverseText = await traverseResp.text();
                traverseHeaders = Object.fromEntries(traverseResp.headers.entries());
                if (traverseResp.status >= 200 && traverseResp.status < 300 && isListResponse(traverseText)) {
                    traverseFound = true;
                    matchedTraverseUrl = c.url;
                    break;
                }
            } catch { }
        }
    } catch { }

    if (traverseFound) {
        results.push({
            type: TYPE.TRAVERSABLE,
            vendor: '青云',
            url: matchedTraverseUrl || bucketBaseUrl,
            found: true,
            request: buildBurpRequest('GET', matchedTraverseUrl || bucketBaseUrl, {}, undefined),
            response: traverseResp ? buildBurpResponse(traverseResp.status, traverseResp.statusText, traverseHeaders, traverseText) : '',
            detail: matchedTraverseUrl ? `存储桶可遍历 (${matchedTraverseUrl})` : '存储桶可遍历'
        });
    }

    if (!safeMode && want(TYPE.UPLOAD)) {
        let uploadFound = false;
        const uploadUrl = listUrl.replace(/\/$/, '') + '/' + testObjectName;
        const reqBody = 'test fileUpload';
        let uploadResp, uploadRespBody, uploadRespHeaders;
        try {
            uploadResp = await fetch(uploadUrl, { method: 'PUT', body: reqBody });
            uploadRespBody = await uploadResp.text();
            uploadRespHeaders = Object.fromEntries(uploadResp.headers.entries());
            if (uploadResp.status >= 200 && uploadResp.status < 300) uploadFound = true;
        } catch { }
        if (uploadFound) {
            results.push({
                type: TYPE.UPLOAD,
                vendor: '青云',
                url: uploadUrl,
                found: true,
                request: buildBurpRequest('PUT', uploadUrl, {}, reqBody),
                response: uploadResp ? buildBurpResponse(uploadResp.status, uploadResp.statusText, uploadRespHeaders, uploadRespBody) : '',
                detail: 'PUT文件上传成功'
            });
        }

        if (uploadFound) {
            let deleteFound = false;
            const delUrl = uploadUrl;
            let delResp, delRespBody, delRespHeaders;
            try {
                delResp = await fetch(delUrl, { method: 'DELETE' });
                delRespBody = await delResp.text();
                delRespHeaders = Object.fromEntries(delResp.headers.entries());
                if (delResp.status >= 200 && delResp.status < 300) deleteFound = true;
            } catch { }
            if (deleteFound && want(TYPE.DELETE)) {
                results.push({
                    type: TYPE.DELETE,
                    vendor: '青云',
                    url: delUrl,
                    found: true,
                    request: buildBurpRequest('DELETE', delUrl, {}, undefined),
                    response: delResp ? buildBurpResponse(delResp.status, delResp.statusText, delRespHeaders, delRespBody) : '',
                    detail: 'DELETE文件删除成功'
                });
            }
        }
    }

    if (checkAcl) {
        const aclUrl = listUrl + '?acl';
        let aclReadFound = false;
        let aclResp, aclText, aclHeaders;
        if (want(TYPE.ACL_READ)) try {
            aclResp = await fetch(aclUrl, { method: 'GET' });
            aclText = await aclResp.text();
            aclHeaders = Object.fromEntries(aclResp.headers.entries());
            if (aclResp.status >= 200 && aclResp.status < 300 && aclText && aclText.includes('<AccessControlPolicy')) {
                aclReadFound = true;
            }
        } catch { }
        const aclAccessDenied = !!(aclResp && aclResp.status === 403 && aclText && aclText.includes('AccessDenied'));
        if (aclReadFound || aclAccessDenied) {
            results.push({
                type: TYPE.ACL_READ,
                vendor: '青云',
                url: aclUrl,
                found: aclReadFound,
                request: buildBurpRequest('GET', aclUrl, {}, undefined),
                response: aclResp ? buildBurpResponse(aclResp.status, aclResp.statusText, aclHeaders, aclText) : '',
                detail: aclReadFound ? 'ACL匿名可读' : 'ACL禁止访问'
            });
        }

        if (!safeMode && want(TYPE.ACL_WRITE)) {
            let aclWriteFound = false;
            const putHeaders = { 'x-amz-acl': 'public-read-write' };
            let putResp, putText, putRespHeaders;
            try {
                putResp = await fetch(aclUrl, { method: 'PUT', headers: putHeaders });
                putText = await putResp.text();
                putRespHeaders = Object.fromEntries(putResp.headers.entries());
                if (putResp.status >= 200 && putResp.status < 300) aclWriteFound = true;
            } catch { }
            if (aclWriteFound) {
                results.push({
                    type: TYPE.ACL_WRITE,
                    vendor: '青云',
                    url: aclUrl,
                    found: true,
                    request: buildBurpRequest('PUT', aclUrl, putHeaders, undefined),
                    response: putResp ? buildBurpResponse(putResp.status, putResp.statusText, putRespHeaders, putText) : '',
                    detail: 'ACL可写'
                });
            }
        }
    }

    if (checkPolicy) {
        const policyUrl = listUrl + '?policy';
        let policyReadFound = false;
        let policyResp, policyText, policyHeaders;
        if (want(TYPE.POLICY_READ)) try {
            policyResp = await fetch(policyUrl, { method: 'GET' });
            policyText = await policyResp.text();
            policyHeaders = Object.fromEntries(policyResp.headers.entries());
            if (policyResp.status >= 200 && policyResp.status < 300 && policyText && (policyText.trim().startsWith('{') || policyText.includes('Statement'))) {
                policyReadFound = true;
            }
        } catch { }
        const policyAccessDenied = !!(policyResp && policyResp.status === 403 && policyText && policyText.includes('AccessDenied'));
        if (policyReadFound || policyAccessDenied) {
            results.push({
                type: TYPE.POLICY_READ,
                vendor: '青云',
                url: policyUrl,
                found: policyReadFound,
                request: buildBurpRequest('GET', policyUrl, {}, undefined),
                response: policyResp ? buildBurpResponse(policyResp.status, policyResp.statusText, policyHeaders, policyText) : '',
                detail: policyReadFound ? 'Policy匿名可读' : 'Policy禁止访问'
            });
        }

        if (!safeMode && want(TYPE.POLICY_WRITE)) {
            let policyWriteFound = false;
            const policyBody = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::*/*'] }] });
            let putResp, putText, putHeaders;
            try {
                putResp = await fetch(policyUrl, { method: 'PUT', body: policyBody });
                putText = await putResp.text();
                putHeaders = Object.fromEntries(putResp.headers.entries());
                if (putResp.status >= 200 && putResp.status < 300) policyWriteFound = true;
            } catch { }
            if (policyWriteFound) {
                results.push({
                    type: TYPE.POLICY_WRITE,
                    vendor: '青云',
                    url: policyUrl,
                    found: true,
                    request: buildBurpRequest('PUT', policyUrl, {}, policyBody),
                    response: putResp ? buildBurpResponse(putResp.status, putResp.statusText, putHeaders, putText) : '',
                    detail: 'Policy可写'
                });
            }
        }
    }

    return results;
}
    self.BucketVendors.checkQingCloud = checkQingCloud;
})();

/* ===== 厂商检测：upyun.js ===== */
(function () {
const TYPE = {
    TRAVERSABLE: '存储桶可遍历',
    UPLOAD: 'PUT文件上传',
    DELETE: 'DELETE文件删除',
    ACL_READ: 'ACL可读',
    ACL_WRITE: 'ACL可写',
    POLICY_READ: 'Policy可读',
    POLICY_WRITE: 'Policy可写'
};

function buildBurpRequest(method, url, headers, body) {
    const u = new URL(url);
    let req = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
    req += `Host: ${u.host}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        if (k.toLowerCase() !== 'host') req += `${k}: ${v}\r\n`;
    }
    req += '\r\n';
    if (body) req += body;
    return req;
}

function buildBurpResponse(status, statusText, headers, body) {
    let resp = `HTTP/1.1 ${status} ${statusText}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        resp += `${k}: ${v}\r\n`;
    }
    resp += '\r\n';
    if (body) resp += body;
    return resp;
}

function removeAllParameters(url) {
    try {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        return u.toString();
    } catch {
        return url;
    }
}

function getBucketBase(url) {
    try {
        const u = new URL(url);
        u.pathname = '/';
        u.search = '';
        u.hash = '';
        return u.toString().replace(/\/$/, '');
    } catch {
        return removeAllParameters(url).replace(/\/.+$/, '');
    }
}

function looksLikeListResponse(text) {
    const t = String(text || '');
    return t.includes('<ListBucketResult') || t.includes('ListBucketResult') || (t.includes('<Name>') && t.includes('<Contents>'));
}

async function checkUpyun(url, options = {}) {
    const results = [];
    const enabledTypes = Array.isArray(options && options.enabledTypes) ? options.enabledTypes : null;
    const want = (t) => !enabledTypes || enabledTypes.indexOf(t) !== -1;
    const checkAcl = options && typeof options.checkAcl === 'boolean' ? options.checkAcl : true;
    const checkPolicy = options && typeof options.checkPolicy === 'boolean' ? options.checkPolicy : true;
    const safeMode = options && options.safeMode === true;

    const listUrl = removeAllParameters(url);
    const bucketBaseUrl = getBucketBase(url);

    const testObjectName = `bt_test_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`;

    let traverseFound = false;
    let traverseResp, traverseText, traverseHeaders;
    let matchedTraverseUrl = '';
    if (want(TYPE.TRAVERSABLE)) try {
        const candidates = [
            `${bucketBaseUrl}/`,
            `${bucketBaseUrl}/?delimiter=/`,
            `${bucketBaseUrl}/?list-type=2&delimiter=/`
        ];
        for (const c of candidates) {
            try {
                traverseResp = await fetch(c, { method: 'GET' });
                traverseText = await traverseResp.text();
                traverseHeaders = Object.fromEntries(traverseResp.headers.entries());
                if (traverseResp.status >= 200 && traverseResp.status < 300 && looksLikeListResponse(traverseText)) {
                    traverseFound = true;
                    matchedTraverseUrl = c;
                    break;
                }
            } catch { }
        }
    } catch { }

    if (traverseFound) {
        results.push({
            type: TYPE.TRAVERSABLE,
            vendor: '又拍云',
            url: matchedTraverseUrl || bucketBaseUrl,
            found: true,
            request: buildBurpRequest('GET', matchedTraverseUrl || bucketBaseUrl, {}, undefined),
            response: traverseResp ? buildBurpResponse(traverseResp.status, traverseResp.statusText, traverseHeaders, traverseText) : '',
            detail: matchedTraverseUrl ? `存储桶可遍历 (${matchedTraverseUrl})` : '存储桶可遍历'
        });
    }

    if (!safeMode && want(TYPE.UPLOAD)) {
        let uploadFound = false;
        const uploadUrl = listUrl.replace(/\/$/, '') + '/' + testObjectName;
        const reqBody = 'test fileUpload';
        let uploadResp, uploadRespBody, uploadRespHeaders;
        try {
            uploadResp = await fetch(uploadUrl, { method: 'PUT', body: reqBody });
            uploadRespBody = await uploadResp.text();
            uploadRespHeaders = Object.fromEntries(uploadResp.headers.entries());
            if (uploadResp.status >= 200 && uploadResp.status < 300) uploadFound = true;
        } catch { }
        if (uploadFound) {
            results.push({
                type: TYPE.UPLOAD,
                vendor: '又拍云',
                url: uploadUrl,
                found: true,
                request: buildBurpRequest('PUT', uploadUrl, {}, reqBody),
                response: uploadResp ? buildBurpResponse(uploadResp.status, uploadResp.statusText, uploadRespHeaders, uploadRespBody) : '',
                detail: 'PUT文件上传成功'
            });
        }

        if (uploadFound) {
            let deleteFound = false;
            const delUrl = uploadUrl;
            let delResp, delRespBody, delRespHeaders;
            try {
                delResp = await fetch(delUrl, { method: 'DELETE' });
                delRespBody = await delResp.text();
                delRespHeaders = Object.fromEntries(delResp.headers.entries());
                if (delResp.status >= 200 && delResp.status < 300) deleteFound = true;
            } catch { }
            if (deleteFound && want(TYPE.DELETE)) {
                results.push({
                    type: TYPE.DELETE,
                    vendor: '又拍云',
                    url: delUrl,
                    found: true,
                    request: buildBurpRequest('DELETE', delUrl, {}, undefined),
                    response: delResp ? buildBurpResponse(delResp.status, delResp.statusText, delRespHeaders, delRespBody) : '',
                    detail: 'DELETE文件删除成功'
                });
            }
        }
    }

    if (checkAcl) {
        const aclUrl = listUrl + '?acl';
        let aclReadFound = false;
        let aclResp, aclText, aclHeaders;
        if (want(TYPE.ACL_READ)) try {
            aclResp = await fetch(aclUrl, { method: 'GET' });
            aclText = await aclResp.text();
            aclHeaders = Object.fromEntries(aclResp.headers.entries());
            if (aclResp.status >= 200 && aclResp.status < 300 && aclText && aclText.includes('<AccessControlPolicy')) {
                aclReadFound = true;
            }
        } catch { }
        const aclAccessDenied = !!(aclResp && aclResp.status === 403 && aclText && aclText.includes('AccessDenied'));
        if (aclReadFound || aclAccessDenied) {
            results.push({
                type: TYPE.ACL_READ,
                vendor: '又拍云',
                url: aclUrl,
                found: aclReadFound,
                request: buildBurpRequest('GET', aclUrl, {}, undefined),
                response: aclResp ? buildBurpResponse(aclResp.status, aclResp.statusText, aclHeaders, aclText) : '',
                detail: aclReadFound ? 'ACL匿名可读' : 'ACL禁止访问'
            });
        }

        if (!safeMode && want(TYPE.ACL_WRITE)) {
            let aclWriteFound = false;
            const putHeaders = { 'x-amz-acl': 'public-read-write' };
            let putResp, putText, putRespHeaders;
            try {
                putResp = await fetch(aclUrl, { method: 'PUT', headers: putHeaders });
                putText = await putResp.text();
                putRespHeaders = Object.fromEntries(putResp.headers.entries());
                if (putResp.status >= 200 && putResp.status < 300) aclWriteFound = true;
            } catch { }
            if (aclWriteFound) {
                results.push({
                    type: TYPE.ACL_WRITE,
                    vendor: '又拍云',
                    url: aclUrl,
                    found: true,
                    request: buildBurpRequest('PUT', aclUrl, putHeaders, undefined),
                    response: putResp ? buildBurpResponse(putResp.status, putResp.statusText, putRespHeaders, putText) : '',
                    detail: 'ACL可写'
                });
            }
        }
    }

    if (checkPolicy) {
        const policyUrl = listUrl + '?policy';
        let policyReadFound = false;
        let policyResp, policyText, policyHeaders;
        if (want(TYPE.POLICY_READ)) try {
            policyResp = await fetch(policyUrl, { method: 'GET' });
            policyText = await policyResp.text();
            policyHeaders = Object.fromEntries(policyResp.headers.entries());
            if (policyResp.status >= 200 && policyResp.status < 300 && policyText && (policyText.trim().startsWith('{') || policyText.includes('Statement'))) {
                policyReadFound = true;
            }
        } catch { }
        const policyAccessDenied = !!(policyResp && policyResp.status === 403 && policyText && policyText.includes('AccessDenied'));
        if (policyReadFound || policyAccessDenied) {
            results.push({
                type: TYPE.POLICY_READ,
                vendor: '又拍云',
                url: policyUrl,
                found: policyReadFound,
                request: buildBurpRequest('GET', policyUrl, {}, undefined),
                response: policyResp ? buildBurpResponse(policyResp.status, policyResp.statusText, policyHeaders, policyText) : '',
                detail: policyReadFound ? 'Policy匿名可读' : 'Policy禁止访问'
            });
        }

        if (!safeMode && want(TYPE.POLICY_WRITE)) {
            let policyWriteFound = false;
            const policyBody = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::*/*'] }] });
            let putResp, putText, putHeaders;
            try {
                putResp = await fetch(policyUrl, { method: 'PUT', body: policyBody });
                putText = await putResp.text();
                putHeaders = Object.fromEntries(putResp.headers.entries());
                if (putResp.status >= 200 && putResp.status < 300) policyWriteFound = true;
            } catch { }
            if (policyWriteFound) {
                results.push({
                    type: TYPE.POLICY_WRITE,
                    vendor: '又拍云',
                    url: policyUrl,
                    found: true,
                    request: buildBurpRequest('PUT', policyUrl, {}, policyBody),
                    response: putResp ? buildBurpResponse(putResp.status, putResp.statusText, putHeaders, putText) : '',
                    detail: 'Policy可写'
                });
            }
        }
    }

    return results;
}
    self.BucketVendors.checkUpyun = checkUpyun;
})();

/* ===== 厂商检测：jdcloud.js ===== */
(function () {
const TYPE = {
    TRAVERSABLE: '存储桶可遍历',
    UPLOAD: 'PUT文件上传',
    DELETE: 'DELETE文件删除',
    ACL_READ: 'ACL可读',
    ACL_WRITE: 'ACL可写',
    POLICY_READ: 'Policy可读',
    POLICY_WRITE: 'Policy可写'
};

function buildBurpRequest(method, url, headers, body) {
    const u = new URL(url);
    let req = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
    req += `Host: ${u.host}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        if (k.toLowerCase() !== 'host') req += `${k}: ${v}\r\n`;
    }
    req += '\r\n';
    if (body) req += body;
    return req;
}

function buildBurpResponse(status, statusText, headers, body) {
    let resp = `HTTP/1.1 ${status} ${statusText}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        resp += `${k}: ${v}\r\n`;
    }
    resp += '\r\n';
    if (body) resp += body;
    return resp;
}

function removeAllParameters(url) {
    try {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        return u.toString();
    } catch {
        return url;
    }
}

function getBucketBase(url) {
    try {
        const u = new URL(url);
        u.pathname = '/';
        u.search = '';
        u.hash = '';
        return u.toString().replace(/\/$/, '');
    } catch {
        return removeAllParameters(url).replace(/\/.+$/, '');
    }
}

function buildPrefixCandidates(url, backtrack) {
    const out = [''];
    try {
        const u = new URL(url);
        let p = u.pathname || '/';
        if (!p || p === '/') return out;
        p = p.replace(/^\/+/, '');
        if (!p) return out;
        const isDir = p.endsWith('/');
        const seg = p.split('/').filter(Boolean);
        if (!seg.length) return out;
        const dirSeg = isDir ? seg : seg.slice(0, -1);
        if (backtrack) {
            for (let i = dirSeg.length; i >= 1; i--) {
                out.push(dirSeg.slice(0, i).join('/') + '/');
            }
        } else {
            if (dirSeg.length) out.push(dirSeg.join('/') + '/');
            if (dirSeg.length >= 2) out.push(dirSeg.slice(0, -1).join('/') + '/');
        }
    } catch { }
    return Array.from(new Set(out));
}

function buildListingCandidates(url, bucketBaseUrl, backtrack) {
    const base = (bucketBaseUrl || getBucketBase(url)).replace(/\/$/, '');
    const prefixes = buildPrefixCandidates(url, backtrack);
    const res = [];
    res.push({ url: `${base}/` });
    for (const prefix of prefixes) {
        const qs1 = new URLSearchParams();
        qs1.set('delimiter', '/');
        if (prefix) qs1.set('prefix', prefix);
        res.push({ url: `${base}/?${qs1.toString()}` });

        const qs2 = new URLSearchParams();
        qs2.set('list-type', '2');
        qs2.set('delimiter', '/');
        if (prefix) qs2.set('prefix', prefix);
        res.push({ url: `${base}/?${qs2.toString()}` });
    }
    return res;
}

function isListResponse(text) {
    const t = String(text || '');
    return t.includes('<ListBucketResult') || (t.includes('<Name>') && (t.includes('<Contents>') || t.includes('<CommonPrefixes>')));
}

async function checkJDCloud(url, options = {}) {
    const results = [];
    const enabledTypes = Array.isArray(options && options.enabledTypes) ? options.enabledTypes : null;
    const want = (t) => !enabledTypes || enabledTypes.indexOf(t) !== -1;
    const checkAcl = options && typeof options.checkAcl === 'boolean' ? options.checkAcl : true;
    const checkPolicy = options && typeof options.checkPolicy === 'boolean' ? options.checkPolicy : true;
    const safeMode = options && options.safeMode === true;
    const traverseBacktrack = options && options.traverseBacktrack === true;

    const listUrl = removeAllParameters(url);
    const bucketBaseUrl = getBucketBase(url);

    const testObjectName = `bt_test_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`;

    let traverseFound = false;
    let traverseResp, traverseText, traverseHeaders;
    let matchedTraverseUrl = '';
    if (want(TYPE.TRAVERSABLE)) try {
        const candidates = buildListingCandidates(url, bucketBaseUrl, traverseBacktrack);
        for (const c of candidates) {
            try {
                traverseResp = await fetch(c.url, { method: 'GET' });
                traverseText = await traverseResp.text();
                traverseHeaders = Object.fromEntries(traverseResp.headers.entries());
                if (traverseResp.status >= 200 && traverseResp.status < 300 && isListResponse(traverseText)) {
                    traverseFound = true;
                    matchedTraverseUrl = c.url;
                    break;
                }
            } catch { }
        }
    } catch { }

    if (traverseFound) {
        results.push({
            type: TYPE.TRAVERSABLE,
            vendor: '京东云',
            url: matchedTraverseUrl || bucketBaseUrl,
            found: true,
            request: buildBurpRequest('GET', matchedTraverseUrl || bucketBaseUrl, {}, undefined),
            response: traverseResp ? buildBurpResponse(traverseResp.status, traverseResp.statusText, traverseHeaders, traverseText) : '',
            detail: matchedTraverseUrl ? `存储桶可遍历 (${matchedTraverseUrl})` : '存储桶可遍历'
        });
    }

    if (!safeMode && want(TYPE.UPLOAD)) {
        let uploadFound = false;
        const uploadUrl = listUrl.replace(/\/$/, '') + '/' + testObjectName;
        const reqBody = 'test fileUpload';
        let uploadResp, uploadRespBody, uploadRespHeaders;
        try {
            uploadResp = await fetch(uploadUrl, { method: 'PUT', body: reqBody });
            uploadRespBody = await uploadResp.text();
            uploadRespHeaders = Object.fromEntries(uploadResp.headers.entries());
            if (uploadResp.status >= 200 && uploadResp.status < 300) uploadFound = true;
        } catch { }
        if (uploadFound) {
            results.push({
                type: TYPE.UPLOAD,
                vendor: '京东云',
                url: uploadUrl,
                found: true,
                request: buildBurpRequest('PUT', uploadUrl, {}, reqBody),
                response: uploadResp ? buildBurpResponse(uploadResp.status, uploadResp.statusText, uploadRespHeaders, uploadRespBody) : '',
                detail: 'PUT文件上传成功'
            });
        }

        if (uploadFound) {
            let deleteFound = false;
            const delUrl = uploadUrl;
            let delResp, delRespBody, delRespHeaders;
            try {
                delResp = await fetch(delUrl, { method: 'DELETE' });
                delRespBody = await delResp.text();
                delRespHeaders = Object.fromEntries(delResp.headers.entries());
                if (delResp.status >= 200 && delResp.status < 300) deleteFound = true;
            } catch { }
            if (deleteFound && want(TYPE.DELETE)) {
                results.push({
                    type: TYPE.DELETE,
                    vendor: '京东云',
                    url: delUrl,
                    found: true,
                    request: buildBurpRequest('DELETE', delUrl, {}, undefined),
                    response: delResp ? buildBurpResponse(delResp.status, delResp.statusText, delRespHeaders, delRespBody) : '',
                    detail: 'DELETE文件删除成功'
                });
            }
        }
    }

    if (checkAcl) {
        const aclUrl = listUrl + '?acl';
        let aclReadFound = false;
        let aclResp, aclText, aclHeaders;
        if (want(TYPE.ACL_READ)) try {
            aclResp = await fetch(aclUrl, { method: 'GET' });
            aclText = await aclResp.text();
            aclHeaders = Object.fromEntries(aclResp.headers.entries());
            if (aclResp.status >= 200 && aclResp.status < 300 && aclText && aclText.includes('<AccessControlPolicy')) {
                aclReadFound = true;
            }
        } catch { }
        const aclAccessDenied = !!(aclResp && aclResp.status === 403 && aclText && aclText.includes('AccessDenied'));
        if (aclReadFound || aclAccessDenied) {
            results.push({
                type: TYPE.ACL_READ,
                vendor: '京东云',
                url: aclUrl,
                found: aclReadFound,
                request: buildBurpRequest('GET', aclUrl, {}, undefined),
                response: aclResp ? buildBurpResponse(aclResp.status, aclResp.statusText, aclHeaders, aclText) : '',
                detail: aclReadFound ? 'ACL匿名可读' : 'ACL禁止访问'
            });
        }

        if (!safeMode && want(TYPE.ACL_WRITE)) {
            let aclWriteFound = false;
            const putHeaders = { 'x-amz-acl': 'public-read-write' };
            let putResp, putText, putRespHeaders;
            try {
                putResp = await fetch(aclUrl, { method: 'PUT', headers: putHeaders });
                putText = await putResp.text();
                putRespHeaders = Object.fromEntries(putResp.headers.entries());
                if (putResp.status >= 200 && putResp.status < 300) aclWriteFound = true;
            } catch { }
            if (aclWriteFound) {
                results.push({
                    type: TYPE.ACL_WRITE,
                    vendor: '京东云',
                    url: aclUrl,
                    found: true,
                    request: buildBurpRequest('PUT', aclUrl, putHeaders, undefined),
                    response: putResp ? buildBurpResponse(putResp.status, putResp.statusText, putRespHeaders, putText) : '',
                    detail: 'ACL可写'
                });
            }
        }
    }

    if (checkPolicy) {
        const policyUrl = listUrl + '?policy';
        let policyReadFound = false;
        let policyResp, policyText, policyHeaders;
        if (want(TYPE.POLICY_READ)) try {
            policyResp = await fetch(policyUrl, { method: 'GET' });
            policyText = await policyResp.text();
            policyHeaders = Object.fromEntries(policyResp.headers.entries());
            if (policyResp.status >= 200 && policyResp.status < 300 && policyText && (policyText.trim().startsWith('{') || policyText.includes('Statement'))) {
                policyReadFound = true;
            }
        } catch { }
        const policyAccessDenied = !!(policyResp && policyResp.status === 403 && policyText && policyText.includes('AccessDenied'));
        if (policyReadFound || policyAccessDenied) {
            results.push({
                type: TYPE.POLICY_READ,
                vendor: '京东云',
                url: policyUrl,
                found: policyReadFound,
                request: buildBurpRequest('GET', policyUrl, {}, undefined),
                response: policyResp ? buildBurpResponse(policyResp.status, policyResp.statusText, policyHeaders, policyText) : '',
                detail: policyReadFound ? 'Policy匿名可读' : 'Policy禁止访问'
            });
        }

        if (!safeMode && want(TYPE.POLICY_WRITE)) {
            let policyWriteFound = false;
            const policyBody = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::*/*'] }] });
            let putResp, putText, putHeaders;
            try {
                putResp = await fetch(policyUrl, { method: 'PUT', body: policyBody });
                putText = await putResp.text();
                putHeaders = Object.fromEntries(putResp.headers.entries());
                if (putResp.status >= 200 && putResp.status < 300) policyWriteFound = true;
            } catch { }
            if (policyWriteFound) {
                results.push({
                    type: TYPE.POLICY_WRITE,
                    vendor: '京东云',
                    url: policyUrl,
                    found: true,
                    request: buildBurpRequest('PUT', policyUrl, {}, policyBody),
                    response: putResp ? buildBurpResponse(putResp.status, putResp.statusText, putHeaders, putText) : '',
                    detail: 'Policy可写'
                });
            }
        }
    }

    return results;
}
    self.BucketVendors.checkJDCloud = checkJDCloud;
})();

/* ===== 厂商检测：kingsoft.js ===== */
(function () {
const TYPE = {
    TRAVERSABLE: '存储桶可遍历',
    UPLOAD: 'PUT文件上传',
    DELETE: 'DELETE文件删除',
    ACL_READ: 'ACL可读',
    ACL_WRITE: 'ACL可写',
    POLICY_READ: 'Policy可读',
    POLICY_WRITE: 'Policy可写'
};

function buildBurpRequest(method, url, headers, body) {
    const u = new URL(url);
    let req = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
    req += `Host: ${u.host}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        if (k.toLowerCase() !== 'host') req += `${k}: ${v}\r\n`;
    }
    req += '\r\n';
    if (body) req += body;
    return req;
}

function buildBurpResponse(status, statusText, headers, body) {
    let resp = `HTTP/1.1 ${status} ${statusText}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        resp += `${k}: ${v}\r\n`;
    }
    resp += '\r\n';
    if (body) resp += body;
    return resp;
}

function removeAllParameters(url) {
    try {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        return u.toString();
    } catch {
        return url;
    }
}

function getBucketBase(url) {
    try {
        const u = new URL(url);
        u.pathname = '/';
        u.search = '';
        u.hash = '';
        return u.toString().replace(/\/$/, '');
    } catch {
        return removeAllParameters(url).replace(/\/.+$/, '');
    }
}

function buildPrefixCandidates(url, backtrack) {
    const out = [''];
    try {
        const u = new URL(url);
        let p = u.pathname || '/';
        if (!p || p === '/') return out;
        p = p.replace(/^\/+/, '');
        if (!p) return out;
        const isDir = p.endsWith('/');
        const seg = p.split('/').filter(Boolean);
        if (!seg.length) return out;
        const dirSeg = isDir ? seg : seg.slice(0, -1);
        if (backtrack) {
            for (let i = dirSeg.length; i >= 1; i--) {
                out.push(dirSeg.slice(0, i).join('/') + '/');
            }
        } else {
            if (dirSeg.length) out.push(dirSeg.join('/') + '/');
            if (dirSeg.length >= 2) out.push(dirSeg.slice(0, -1).join('/') + '/');
        }
    } catch { }
    return Array.from(new Set(out));
}

function buildListingCandidates(url, bucketBaseUrl, backtrack) {
    const base = (bucketBaseUrl || getBucketBase(url)).replace(/\/$/, '');
    const prefixes = buildPrefixCandidates(url, backtrack);
    const res = [];
    for (const prefix of prefixes) {
        const qs1 = new URLSearchParams();
        qs1.set('delimiter', '/');
        if (prefix) qs1.set('prefix', prefix);
        res.push({ url: `${base}/?${qs1.toString()}` });

        const qs2 = new URLSearchParams();
        qs2.set('list-type', '2');
        qs2.set('delimiter', '/');
        if (prefix) qs2.set('prefix', prefix);
        res.push({ url: `${base}/?${qs2.toString()}` });
    }
    return res;
}

function isListResponse(text) {
    const t = String(text || '');
    return t.includes('<ListBucketResult') || (t.includes('<Name>') && (t.includes('<Contents>') || t.includes('<CommonPrefixes>')));
}

async function checkKingsoft(url, options = {}) {
    const results = [];
    const enabledTypes = Array.isArray(options && options.enabledTypes) ? options.enabledTypes : null;
    const want = (t) => !enabledTypes || enabledTypes.indexOf(t) !== -1;
    const checkAcl = options && typeof options.checkAcl === 'boolean' ? options.checkAcl : true;
    const checkPolicy = options && typeof options.checkPolicy === 'boolean' ? options.checkPolicy : true;
    const safeMode = options && options.safeMode === true;
    const traverseBacktrack = options && options.traverseBacktrack === true;

    const listUrl = removeAllParameters(url);
    const bucketBaseUrl = getBucketBase(url);

    const testObjectName = `bt_test_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`;

    let traverseFound = false;
    let traverseResp, traverseText, traverseHeaders;
    let matchedTraverseUrl = '';
    if (want(TYPE.TRAVERSABLE)) try {
        const candidates = buildListingCandidates(url, bucketBaseUrl, traverseBacktrack);
        for (const c of candidates) {
            try {
                traverseResp = await fetch(c.url, { method: 'GET' });
                traverseText = await traverseResp.text();
                traverseHeaders = Object.fromEntries(traverseResp.headers.entries());
                if (traverseResp.status >= 200 && traverseResp.status < 300 && isListResponse(traverseText)) {
                    traverseFound = true;
                    matchedTraverseUrl = c.url;
                    break;
                }
            } catch { }
        }
    } catch { }

    if (traverseFound) {
        results.push({
            type: TYPE.TRAVERSABLE,
            vendor: '金山云',
            url: matchedTraverseUrl || bucketBaseUrl,
            found: true,
            request: buildBurpRequest('GET', matchedTraverseUrl || bucketBaseUrl, {}, undefined),
            response: traverseResp ? buildBurpResponse(traverseResp.status, traverseResp.statusText, traverseHeaders, traverseText) : '',
            detail: matchedTraverseUrl ? `存储桶可遍历 (${matchedTraverseUrl})` : '存储桶可遍历'
        });
    }

    if (!safeMode && want(TYPE.UPLOAD)) {
        let uploadFound = false;
        const uploadUrl = listUrl.replace(/\/$/, '') + '/' + testObjectName;
        const reqBody = 'test fileUpload';
        let uploadResp, uploadRespBody, uploadRespHeaders;
        try {
            uploadResp = await fetch(uploadUrl, { method: 'PUT', body: reqBody });
            uploadRespBody = await uploadResp.text();
            uploadRespHeaders = Object.fromEntries(uploadResp.headers.entries());
            if (uploadResp.status >= 200 && uploadResp.status < 300) uploadFound = true;
        } catch { }
        if (uploadFound) {
            results.push({
                type: TYPE.UPLOAD,
                vendor: '金山云',
                url: uploadUrl,
                found: true,
                request: buildBurpRequest('PUT', uploadUrl, {}, reqBody),
                response: uploadResp ? buildBurpResponse(uploadResp.status, uploadResp.statusText, uploadRespHeaders, uploadRespBody) : '',
                detail: 'PUT文件上传成功'
            });
        }

        if (uploadFound) {
            let deleteFound = false;
            const delUrl = uploadUrl;
            let delResp, delRespBody, delRespHeaders;
            try {
                delResp = await fetch(delUrl, { method: 'DELETE' });
                delRespBody = await delResp.text();
                delRespHeaders = Object.fromEntries(delResp.headers.entries());
                if (delResp.status >= 200 && delResp.status < 300) deleteFound = true;
            } catch { }
            if (deleteFound && want(TYPE.DELETE)) {
                results.push({
                    type: TYPE.DELETE,
                    vendor: '金山云',
                    url: delUrl,
                    found: true,
                    request: buildBurpRequest('DELETE', delUrl, {}, undefined),
                    response: delResp ? buildBurpResponse(delResp.status, delResp.statusText, delRespHeaders, delRespBody) : '',
                    detail: 'DELETE文件删除成功'
                });
            }
        }
    }

    if (checkAcl) {
        const aclUrl = listUrl + '?acl';
        let aclReadFound = false;
        let aclResp, aclText, aclHeaders;
        if (want(TYPE.ACL_READ)) try {
            aclResp = await fetch(aclUrl, { method: 'GET' });
            aclText = await aclResp.text();
            aclHeaders = Object.fromEntries(aclResp.headers.entries());
            if (aclResp.status >= 200 && aclResp.status < 300 && aclText && aclText.includes('<AccessControlPolicy')) {
                aclReadFound = true;
            }
        } catch { }
        const aclAccessDenied = !!(aclResp && aclResp.status === 403 && aclText && aclText.includes('AccessDenied'));
        if (aclReadFound || aclAccessDenied) {
            results.push({
                type: TYPE.ACL_READ,
                vendor: '金山云',
                url: aclUrl,
                found: aclReadFound,
                request: buildBurpRequest('GET', aclUrl, {}, undefined),
                response: aclResp ? buildBurpResponse(aclResp.status, aclResp.statusText, aclHeaders, aclText) : '',
                detail: aclReadFound ? 'ACL匿名可读' : 'ACL禁止访问'
            });
        }

        if (!safeMode && want(TYPE.ACL_WRITE)) {
            let aclWriteFound = false;
            const putHeaders = { 'x-amz-acl': 'public-read-write' };
            let putResp, putText, putRespHeaders;
            try {
                putResp = await fetch(aclUrl, { method: 'PUT', headers: putHeaders });
                putText = await putResp.text();
                putRespHeaders = Object.fromEntries(putResp.headers.entries());
                if (putResp.status >= 200 && putResp.status < 300) aclWriteFound = true;
            } catch { }
            if (aclWriteFound) {
                results.push({
                    type: TYPE.ACL_WRITE,
                    vendor: '金山云',
                    url: aclUrl,
                    found: true,
                    request: buildBurpRequest('PUT', aclUrl, putHeaders, undefined),
                    response: putResp ? buildBurpResponse(putResp.status, putResp.statusText, putRespHeaders, putText) : '',
                    detail: 'ACL可写'
                });
            }
        }
    }

    if (checkPolicy) {
        const policyUrl = listUrl + '?policy';
        let policyReadFound = false;
        let policyResp, policyText, policyHeaders;
        if (want(TYPE.POLICY_READ)) try {
            policyResp = await fetch(policyUrl, { method: 'GET' });
            policyText = await policyResp.text();
            policyHeaders = Object.fromEntries(policyResp.headers.entries());
            if (policyResp.status >= 200 && policyResp.status < 300 && policyText && (policyText.trim().startsWith('{') || policyText.includes('Statement'))) {
                policyReadFound = true;
            }
        } catch { }
        const policyAccessDenied = !!(policyResp && policyResp.status === 403 && policyText && policyText.includes('AccessDenied'));
        if (policyReadFound || policyAccessDenied) {
            results.push({
                type: TYPE.POLICY_READ,
                vendor: '金山云',
                url: policyUrl,
                found: policyReadFound,
                request: buildBurpRequest('GET', policyUrl, {}, undefined),
                response: policyResp ? buildBurpResponse(policyResp.status, policyResp.statusText, policyHeaders, policyText) : '',
                detail: policyReadFound ? 'Policy匿名可读' : 'Policy禁止访问'
            });
        }

        if (!safeMode && want(TYPE.POLICY_WRITE)) {
            let policyWriteFound = false;
            const policyBody = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::*/*'] }] });
            let putResp, putText, putHeaders;
            try {
                putResp = await fetch(policyUrl, { method: 'PUT', body: policyBody });
                putText = await putResp.text();
                putHeaders = Object.fromEntries(putResp.headers.entries());
                if (putResp.status >= 200 && putResp.status < 300) policyWriteFound = true;
            } catch { }
            if (policyWriteFound) {
                results.push({
                    type: TYPE.POLICY_WRITE,
                    vendor: '金山云',
                    url: policyUrl,
                    found: true,
                    request: buildBurpRequest('PUT', policyUrl, {}, policyBody),
                    response: putResp ? buildBurpResponse(putResp.status, putResp.statusText, putHeaders, putText) : '',
                    detail: 'Policy可写'
                });
            }
        }
    }

    return results;
}
    self.BucketVendors.checkKingsoft = checkKingsoft;
})();

/* ===== 厂商检测：ctyun.js ===== */
(function () {
const TYPE = {
    TRAVERSABLE: '存储桶可遍历',
    UPLOAD: 'PUT文件上传',
    DELETE: 'DELETE文件删除',
    ACL_READ: 'ACL可读',
    ACL_WRITE: 'ACL可写',
    POLICY_READ: 'Policy可读',
    POLICY_WRITE: 'Policy可写'
};

function buildBurpRequest(method, url, headers, body) {
    const u = new URL(url);
    let req = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
    req += `Host: ${u.host}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        if (k.toLowerCase() !== 'host') req += `${k}: ${v}\r\n`;
    }
    req += '\r\n';
    if (body) req += body;
    return req;
}

function buildBurpResponse(status, statusText, headers, body) {
    let resp = `HTTP/1.1 ${status} ${statusText}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
        resp += `${k}: ${v}\r\n`;
    }
    resp += '\r\n';
    if (body) resp += body;
    return resp;
}

function removeAllParameters(url) {
    try {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        return u.toString();
    } catch {
        return url;
    }
}

function getBucketBase(url) {
    try {
        const u = new URL(url);
        u.pathname = '/';
        u.search = '';
        u.hash = '';
        return u.toString().replace(/\/$/, '');
    } catch {
        return removeAllParameters(url).replace(/\/.+$/, '');
    }
}

function buildPrefixCandidates(url, backtrack) {
    const out = [''];
    try {
        const u = new URL(url);
        let p = u.pathname || '/';
        if (!p || p === '/') return out;
        p = p.replace(/^\/+/, '');
        if (!p) return out;
        const isDir = p.endsWith('/');
        const seg = p.split('/').filter(Boolean);
        if (!seg.length) return out;
        const dirSeg = isDir ? seg : seg.slice(0, -1);
        if (backtrack) {
            for (let i = dirSeg.length; i >= 1; i--) {
                out.push(dirSeg.slice(0, i).join('/') + '/');
            }
        } else {
            if (dirSeg.length) out.push(dirSeg.join('/') + '/');
            if (dirSeg.length >= 2) out.push(dirSeg.slice(0, -1).join('/') + '/');
        }
    } catch { }
    return Array.from(new Set(out));
}

function buildListingCandidates(url, bucketBaseUrl, backtrack) {
    const base = (bucketBaseUrl || getBucketBase(url)).replace(/\/$/, '');
    const prefixes = buildPrefixCandidates(url, backtrack);
    const res = [];

    for (const prefix of prefixes) {
        const qs1 = new URLSearchParams();
        qs1.set('delimiter', '/');
        if (prefix) qs1.set('prefix', prefix);
        res.push({ url: `${base}/?${qs1.toString()}` });

        const qs2 = new URLSearchParams();
        qs2.set('list-type', '2');
        qs2.set('delimiter', '/');
        if (prefix) qs2.set('prefix', prefix);
        res.push({ url: `${base}/?${qs2.toString()}` });
    }

    res.unshift({ url: `${base}/` });

    return res;
}

function isListResponse(text) {
    const t = String(text || '');
    return t.includes('<ListBucketResult') || (t.includes('<Name>') && (t.includes('<Contents>') || t.includes('<CommonPrefixes>')));
}

async function checkCTYun(url, options = {}) {
    const results = [];
    const enabledTypes = Array.isArray(options && options.enabledTypes) ? options.enabledTypes : null;
    const want = (t) => !enabledTypes || enabledTypes.indexOf(t) !== -1;
    const checkAcl = options && typeof options.checkAcl === 'boolean' ? options.checkAcl : true;
    const checkPolicy = options && typeof options.checkPolicy === 'boolean' ? options.checkPolicy : true;
    const safeMode = options && options.safeMode === true;
    const traverseBacktrack = options && options.traverseBacktrack === true;

    const listUrl = removeAllParameters(url);
    const bucketBaseUrl = getBucketBase(url);

    const testObjectName = `bt_test_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`;

    let traverseFound = false;
    let traverseResp, traverseText, traverseHeaders;
    let matchedTraverseUrl = '';
    if (want(TYPE.TRAVERSABLE)) try {
        const candidates = buildListingCandidates(url, bucketBaseUrl, traverseBacktrack);
        for (const c of candidates) {
            try {
                traverseResp = await fetch(c.url, { method: 'GET' });
                traverseText = await traverseResp.text();
                traverseHeaders = Object.fromEntries(traverseResp.headers.entries());
                if (traverseResp.status >= 200 && traverseResp.status < 300 && isListResponse(traverseText)) {
                    traverseFound = true;
                    matchedTraverseUrl = c.url;
                    break;
                }
            } catch { }
        }
    } catch { }

    if (traverseFound) {
        results.push({
            type: TYPE.TRAVERSABLE,
            vendor: '天翼云',
            url: matchedTraverseUrl || bucketBaseUrl,
            found: true,
            request: buildBurpRequest('GET', matchedTraverseUrl || bucketBaseUrl, {}, undefined),
            response: traverseResp ? buildBurpResponse(traverseResp.status, traverseResp.statusText, traverseHeaders, traverseText) : '',
            detail: matchedTraverseUrl ? `存储桶可遍历 (${matchedTraverseUrl})` : '存储桶可遍历'
        });
    }

    if (!safeMode && want(TYPE.UPLOAD)) {
        let uploadFound = false;
        const uploadUrl = listUrl.replace(/\/$/, '') + '/' + testObjectName;
        const uploadReqHeaders = {};
        const uploadReqBody = 'test fileUpload';
        let uploadResp, uploadRespBody, uploadRespHeaders;
        try {
            uploadResp = await fetch(uploadUrl, { method: 'PUT', body: uploadReqBody });
            uploadRespBody = await uploadResp.text();
            uploadRespHeaders = Object.fromEntries(uploadResp.headers.entries());
            if (uploadResp.status >= 200 && uploadResp.status < 300) uploadFound = true;
        } catch { }
        if (uploadFound) {
            results.push({
                type: TYPE.UPLOAD,
                vendor: '天翼云',
                url: uploadUrl,
                found: true,
                request: buildBurpRequest('PUT', uploadUrl, {}, uploadReqBody),
                response: uploadResp ? buildBurpResponse(uploadResp.status, uploadResp.statusText, uploadRespHeaders, uploadRespBody) : '',
                detail: 'PUT文件上传成功'
            });
        }

        if (uploadFound) {
            let deleteFound = false;
            const delUrl = uploadUrl;
            let delResp, delRespBody, delRespHeaders;
            try {
                delResp = await fetch(delUrl, { method: 'DELETE' });
                delRespBody = await delResp.text();
                delRespHeaders = Object.fromEntries(delResp.headers.entries());
                if (delResp.status >= 200 && delResp.status < 300) deleteFound = true;
            } catch { }
            if (deleteFound && want(TYPE.DELETE)) {
                results.push({
                    type: TYPE.DELETE,
                    vendor: '天翼云',
                    url: delUrl,
                    found: true,
                    request: buildBurpRequest('DELETE', delUrl, {}, undefined),
                    response: delResp ? buildBurpResponse(delResp.status, delResp.statusText, delRespHeaders, delRespBody) : '',
                    detail: 'DELETE文件删除成功'
                });
            }
        }
    }

    if (checkAcl) {
        const aclUrl = listUrl + '?acl';
        let aclReadFound = false;
        let aclResp, aclText, aclHeaders;
        if (want(TYPE.ACL_READ)) try {
            aclResp = await fetch(aclUrl, { method: 'GET' });
            aclText = await aclResp.text();
            aclHeaders = Object.fromEntries(aclResp.headers.entries());
            if (aclResp.status >= 200 && aclResp.status < 300 && aclText && aclText.includes('<AccessControlPolicy')) {
                aclReadFound = true;
            }
        } catch { }
        const aclAccessDenied = !!(aclResp && aclResp.status === 403 && aclText && aclText.includes('AccessDenied'));
        if (aclReadFound || aclAccessDenied) {
            results.push({
                type: TYPE.ACL_READ,
                vendor: '天翼云',
                url: aclUrl,
                found: aclReadFound,
                request: buildBurpRequest('GET', aclUrl, {}, undefined),
                response: aclResp ? buildBurpResponse(aclResp.status, aclResp.statusText, aclHeaders, aclText) : '',
                detail: aclReadFound ? 'ACL匿名可读' : 'ACL禁止访问'
            });
        }

        if (!safeMode && want(TYPE.ACL_WRITE)) {
            let aclWriteFound = false;
            const putHeaders = { 'x-amz-acl': 'public-read-write' };
            let putResp, putText, putRespHeaders;
            try {
                putResp = await fetch(aclUrl, { method: 'PUT', headers: putHeaders });
                putText = await putResp.text();
                putRespHeaders = Object.fromEntries(putResp.headers.entries());
                if (putResp.status >= 200 && putResp.status < 300) aclWriteFound = true;
            } catch { }
            if (aclWriteFound) {
                results.push({
                    type: TYPE.ACL_WRITE,
                    vendor: '天翼云',
                    url: aclUrl,
                    found: true,
                    request: buildBurpRequest('PUT', aclUrl, putHeaders, undefined),
                    response: putResp ? buildBurpResponse(putResp.status, putResp.statusText, putRespHeaders, putText) : '',
                    detail: 'ACL可写'
                });
            }
        }
    }

    if (checkPolicy) {
        const policyUrl = listUrl + '?policy';
        let policyReadFound = false;
        let policyResp, policyText, policyHeaders;
        if (want(TYPE.POLICY_READ)) try {
            policyResp = await fetch(policyUrl, { method: 'GET' });
            policyText = await policyResp.text();
            policyHeaders = Object.fromEntries(policyResp.headers.entries());
            if (policyResp.status >= 200 && policyResp.status < 300 && policyText && (policyText.trim().startsWith('{') || policyText.includes('Statement'))) {
                policyReadFound = true;
            }
        } catch { }
        const policyAccessDenied = !!(policyResp && policyResp.status === 403 && policyText && policyText.includes('AccessDenied'));
        if (policyReadFound || policyAccessDenied) {
            results.push({
                type: TYPE.POLICY_READ,
                vendor: '天翼云',
                url: policyUrl,
                found: policyReadFound,
                request: buildBurpRequest('GET', policyUrl, {}, undefined),
                response: policyResp ? buildBurpResponse(policyResp.status, policyResp.statusText, policyHeaders, policyText) : '',
                detail: policyReadFound ? 'Policy匿名可读' : 'Policy禁止访问'
            });
        }

        if (!safeMode && want(TYPE.POLICY_WRITE)) {
            let policyWriteFound = false;
            const policyBody = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::*/*'] }] });
            let putResp, putText, putHeaders;
            try {
                putResp = await fetch(policyUrl, { method: 'PUT', body: policyBody });
                putText = await putResp.text();
                putHeaders = Object.fromEntries(putResp.headers.entries());
                if (putResp.status >= 200 && putResp.status < 300) policyWriteFound = true;
            } catch { }
            if (policyWriteFound) {
                results.push({
                    type: TYPE.POLICY_WRITE,
                    vendor: '天翼云',
                    url: policyUrl,
                    found: true,
                    request: buildBurpRequest('PUT', policyUrl, {}, policyBody),
                    response: putResp ? buildBurpResponse(putResp.status, putResp.statusText, putHeaders, putText) : '',
                    detail: 'Policy可写'
                });
            }
        }
    }

    return results;
}
    self.BucketVendors.checkCTYun = checkCTYun;
})();

/* ===== 分发入口：index.js ===== */
(function () {
    const { checkAliyun, checkTencent, checkHuawei, checkAWS, checkQiniu, checkQingCloud, checkUpyun, checkJDCloud, checkKingsoft, checkCTYun } = self.BucketVendors;
async function detectBucketVul(url, options) {
    if (options && Array.isArray(options.vendors) && options.vendors.length > 0) {
        let results = [];
        for (const v of options.vendors) {
            if (v === 'aliyun') {
                results = results.concat(await checkAliyun(url, options));
            } else if (v === 'tencent') {
                results = results.concat(await checkTencent(url, options));
            } else if (v === 'huawei') {
                results = results.concat(await checkHuawei(url, options));
            } else if (v === 'AmazonS3') {
                results = results.concat(await checkAWS(url, options));
            } else if (v === 'qiniu') {
                results = results.concat(await checkQiniu(url, options));
            } else if (v === 'qingcloud') {
                results = results.concat(await checkQingCloud(url, options));
            } else if (v === 'upyun') {
                results = results.concat(await checkUpyun(url, options));
            } else if (v === 'jdcloud') {
                results = results.concat(await checkJDCloud(url, options));
            } else if (v === 'kingsoft') {
                results = results.concat(await checkKingsoft(url, options));
            } else if (v === 'ctyun') {
                results = results.concat(await checkCTYun(url, options));
            }
        }
        if (!Array.isArray(results)) return [];
        return results;
    }

    let vendor = detectVendor(url);
    if (vendor === '未知') {
        vendor = await detectVendorByServer(url);
    }
    let results = [];

    if (vendor === '阿里云') {
        results = await checkAliyun(url, options);
    } else if (vendor === '腾讯云') {
        results = await checkTencent(url, options);
    } else if (vendor === '华为云') {
        results = await checkHuawei(url, options);
    } else if (vendor === 'AmazonS3') {
        results = await checkAWS(url, options);
    } else if (vendor === '七牛云') {
        results = await checkQiniu(url, options);
    } else if (vendor === '青云') {
        results = await checkQingCloud(url, options);
    } else if (vendor === '又拍云') {
        results = await checkUpyun(url, options);
    } else if (vendor === '京东云') {
        results = await checkJDCloud(url, options);
    } else if (vendor === '金山云') {
        results = await checkKingsoft(url, options);
    } else if (vendor === '天翼云') {
        results = await checkCTYun(url, options);
    }
    if (!Array.isArray(results)) return [];

    return results;
}

function detectVendor(url) {
    try {
        const u = new URL(url);
        const host = u.hostname;
        if (host.includes('aliyuncs.com')) return '阿里云';
        if (host.includes('myqcloud.com')) return '腾讯云';
        if (host.includes('myhuaweicloud.com')) return '华为云';
        if (host.includes('amazonaws.com') || host.includes('s3.amazonaws.com.cn')) return 'AmazonS3';
        if (host.includes('qiniucs.com') || host.includes('clouddn.com') || host.includes('qcloudcdn.com')) return '七牛云';
        if (host.includes('qingstor.com')) return '青云';
        if (host.includes('upaiyun.com') || host.includes('upyun.com') || host.includes('upcdn.net')) return '又拍云';
        if (host.includes('jcloudcs.com')) return '京东云';
        if (host.includes('ksyuncs.com') || host.includes('ks3-cn-')) return '金山云';
        if ((host.includes('ctyun.cn') && host.includes('.obs.')) || (host.includes('ctyunapi.cn') && host.startsWith('oos-'))) return '天翼云';
        return '未知';
    } catch {
        return '未知';
    }
}

function detectVendorByServerHeader(resp) {
    const server = resp.headers.get('server');
    if (!server) return null;
    const s = String(server).toLowerCase();
    if (server === 'AliyunOSS' || s.includes('aliyunoss')) return '阿里云';
    if (server === 'tencent-cos' || s.includes('tencent-cos')) return '腾讯云';
    if (server === 'OBS' || s === 'obs') return '华为云';
    if (server === 'AmazonS3' || s.includes('amazons3')) return 'AmazonS3';
    if (s.includes('qiniu')) return '七牛云';
    if (s.includes('qingstor') || s.includes('qingcloud')) return '青云';
    if (s.includes('upyun') || s.includes('upaiyun')) return '又拍云';
    if (s.includes('jdcloud') || s.includes('jcloud')) return '京东云';
    if (s.includes('ks3') || s.includes('kingsoft')) return '金山云';
    if (s.includes('ctyun')) return '天翼云';
    return null;
}

async function detectVendorByServer(url) {
    try {
        const resp = await fetch(url, { method: 'HEAD' });
        const vendor = detectVendorByServerHeader(resp);
        return vendor || '未知';
    } catch {
        return '未知';
    }
}
    self.BucketDetect = self.BucketDetect || {};
    self.BucketDetect.detectBucketVul = detectBucketVul;
    self.BucketDetect.detectVendor = detectVendor;
    self.BucketDetect.detectVendorByServerHeader = detectVendorByServerHeader;
    self.BucketDetect.detectVendorByServer = detectVendorByServer;
})();
