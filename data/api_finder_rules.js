/*
 * Happy JS - API Finder Rules
 * ─────────────────────────────────────────────────────────────────────────
 *  多关键字 AND 规则库（高精度二轮扫描，补充 content.js 中 29 类基础正则）
 *
 *  设计要点（参考 BurpAPIFinder 等开源启发式）：
 *    1. 单条规则的多个 keyword/regex 默认 AND 关系 → 大幅降低误报
 *    2. 同 location 的多个 keyword 命中可叠加（"pass+email+user" 都出现）
 *    3. accuracy 1-3：1=低（参考），2=中，3=高（默认）
 *    4. important=true 时高亮显示
 *    5. type 含 "白名单" 的规则不参与匹配，其 keyword 用于 URL 过滤
 *
 *  自定义：编辑本文件末尾的 _USER_RULES 数组，或在 popup「规则管理」新增。
 *  导入：tools/import_burpapi_rules.js 可从 finger-important.json 选择性导入。
 *
 *  ⚠️ 规则使用通用安全测试知识编写，欢迎根据个人积累补充。
 * ─────────────────────────────────────────────────────────────────────────
 */

(function (global) {
  'use strict';

  // ──────────────────────────── 字段约定 ────────────────────────────
  // 一条规则的最小单元：
  // {
  //   id:          string,           // 全局唯一，建议前缀按分类
  //   category:    string,           // 大分类（敏感内容/有价值信息/敏感路径/白名单*）
  //   subcategory: string,           // 子类（修改密码/账号信息/内部接口...）
  //   match:       'keyword' | 'regex',
  //   relation:    'AND' | 'OR',     // 多个 keyword 之间的逻辑关系，默认 AND
  //   keyword:     [str],            // match=keyword 时使用
  //   regex:       string,           // match=regex 时使用（Pattern 编译）
  //   location:    'body' | 'urlPath' | 'header' | 'all',  // 匹配范围
  //   accuracy:    1 | 2 | 3,        // 1=低，2=中，3=高
  //   important:   boolean,          // 高亮显示
  //   describe:    string,           // 命中说明
  //   enabled:     boolean,          // 是否启用，默认 true
  // }
  //
  // type 含 "白名单" 的规则被识别为过滤配置，不参与匹配；其 keyword 会
  // 合并到扫描时的 URL 白名单/静态扩展名/路径过滤集合中。

  // ────────────────────────── 通用敏感内容（凭证/账号） ──────────────────────────
  const SENSITIVE_CRED = [
    // ─── 修改密码类（高危：直接涉及账号接管）───
    { id: 'cred-modpwd-1', category: '敏感内容', subcategory: '修改密码',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['newPwd', 'userName'], describe: '修改密码接口（newPwd + userName）' },
    { id: 'cred-modpwd-2', category: '敏感内容', subcategory: '修改密码',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['oldPassword', 'newPassword'], describe: '修改密码接口（old + new 同现）' },
    { id: 'cred-modpwd-3', category: '敏感内容', subcategory: '修改密码',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['username', 'newpassword'], describe: '修改密码接口' },
    { id: 'cred-modpwd-4', category: '敏感内容', subcategory: '修改密码',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['password', 'oldPwd'], describe: '修改密码接口' },
    { id: 'cred-modpwd-5', category: '敏感内容', subcategory: '重置密码',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['resetPassword', 'userId'], describe: '重置密码接口（resetPassword）' },
    { id: 'cred-modpwd-6', category: '敏感内容', subcategory: '重置密码',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['findPassword', 'mobile'], describe: '找回密码接口' },
    { id: 'cred-modpwd-7', category: '敏感内容', subcategory: '修改密码',
      match: 'keyword', relation: 'AND', location: 'urlPath', accuracy: 2, important: true,
      keyword: ['/changePassword', '/api/'], describe: 'URL 中含修改密码路径' },

    // ─── 登录/注册/注销 ───
    { id: 'cred-login-1', category: '敏感内容', subcategory: '登录凭证',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['"account"', '"password"'],
      describe: '登录请求（JSON 字段 account + password）' },
    { id: 'cred-login-2', category: '敏感内容', subcategory: '登录凭证',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['username', 'password'], describe: '登录请求（username + password）' },
    { id: 'cred-login-3', category: '敏感内容', subcategory: '登录凭证',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['mobile', 'smsCode'], describe: '短信验证码登录' },
    { id: 'cred-register-1', category: '敏感内容', subcategory: '注册',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
      keyword: ['inviteCode', 'mobile'], describe: '带邀请码的注册' },
    { id: 'cred-register-2', category: '敏感内容', subcategory: '注册',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
      keyword: ['password', 'confirmPassword'], describe: '注册（带确认密码）' },

    // ─── 验证码 / Token ───
    { id: 'cred-sms-1', category: '敏感内容', subcategory: '短信验证码',
      match: 'regex', location: 'body', accuracy: 2, important: true,
      regex: '"smsCode"\\s*:\\s*"([0-9]{4,6})"',
      describe: '短信验证码字段（4-6 位数字）' },
    { id: 'cred-sms-2', category: '敏感内容', subcategory: '短信验证码',
      match: 'regex', location: 'body', accuracy: 2, important: true,
      regex: '"verifyCode"\\s*:\\s*"([0-9A-Za-z]{4,8})"',
      describe: '图形/邮箱验证码字段' },
    { id: 'cred-token-1', category: '敏感内容', subcategory: '认证Token',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
      keyword: ['access_token', 'refresh_token'], describe: 'OAuth 双 Token 返回' },
    { id: 'cred-token-2', category: '敏感内容', subcategory: '认证Token',
      match: 'keyword', relation: 'AND', location: 'header', accuracy: 2, important: true,
      keyword: ['Authorization', 'Bearer'], describe: 'Bearer Token 认证' },
  ];

  // ────────────────────────── 用户隐私信息（PII） ──────────────────────────
  const SENSITIVE_PII = [
    // ─── 用户完整档案（JSON 多个字段同现）───
    { id: 'pii-profile-1', category: '敏感内容', subcategory: '用户档案',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['"name"', '"realName"', '"email"', '"phone"'],
      describe: '用户完整档案（JSON 字段 name + realName + email + phone）' },
    { id: 'pii-profile-2', category: '敏感内容', subcategory: '用户档案',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['email', 'phone', 'pwd', 'id', 'name'],
      describe: '用户档案+密码字段（极敏感）' },
    { id: 'pii-profile-3', category: '敏感内容', subcategory: '用户档案',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
      keyword: ['"description"', '"name"', '"message"', '"Type"'],
      describe: 'JSON 用户档案集合（带 type 字段）' },
    { id: 'pii-profile-4', category: '敏感内容', subcategory: '通讯录',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
      keyword: ['tel', 'account', 'userName', 'mailAccount'],
      describe: '通讯录字段（tel + account + userName + mailAccount）' },
    { id: 'pii-profile-5', category: '敏感内容', subcategory: '员工通讯录',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
      keyword: ['personName', 'phoneNo', 'deptName'],
      describe: '员工通讯录（personName + phoneNo + deptName）' },
    { id: 'pii-profile-6', category: '敏感内容', subcategory: '联系人',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
      keyword: ['person', 'mobilPhone', 'id', 'status'],
      describe: '联系人列表（person + mobilPhone + id）' },

    // ─── 身份证 / 证件号（响应中带回身份证号是高危）───
    { id: 'pii-idcard-1', category: '敏感内容', subcategory: '身份证号',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['idCard', 'name'], describe: '身份证号+姓名 响应' },
    { id: 'pii-idcard-2', category: '敏感内容', subcategory: '身份证号',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['identityCard', 'userName'], describe: '身份证号+用户名' },
    { id: 'pii-idcard-3', category: '敏感内容', subcategory: '身份证号',
      match: 'regex', location: 'body', accuracy: 3, important: true,
      regex: '"(?:idCard|id_number|identityCard|sfzhm|sfz|身份证)[^"]{0,15}"\\s*:\\s*"([0-9]{15}|[0-9]{17}[0-9Xx])"',
      describe: '身份证号字段（15 位 / 18 位）' },

    // ─── 银行卡号 ───
    { id: 'pii-bankcard-1', category: '敏感内容', subcategory: '银行卡号',
      match: 'regex', location: 'body', accuracy: 3, important: true,
      regex: '"(?:bankCard|cardNo|bankNo|卡号)[^"]{0,10}"\\s*:\\s*"([0-9]{13,19})"',
      describe: '银行卡号字段（13-19 位数字）' },

    // ─── 地址 / 定位 ───
    { id: 'pii-address-1', category: '敏感内容', subcategory: '详细地址',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
      keyword: ['province', 'city', 'address', 'phone'],
      describe: '省市区+详细地址+手机' },
    { id: 'pii-address-2', category: '敏感内容', subcategory: 'GPS定位',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
      keyword: ['latitude', 'longitude'], describe: '经纬度 GPS 定位' },
  ];

  // ────────────────────────── 业务/订单/支付 ──────────────────────────
  const SENSITIVE_BIZ = [
    // ─── 订单 ───
    { id: 'biz-order-1', category: '敏感内容', subcategory: '订单信息',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
      keyword: ['orderId', 'amount', 'userId'], describe: '订单详情（orderId + amount + userId）' },
    { id: 'biz-order-2', category: '敏感内容', subcategory: '订单导出',
      match: 'keyword', relation: 'AND', location: 'urlPath', accuracy: 3, important: true,
      keyword: ['/order', 'export'], describe: '订单导出接口' },
    { id: 'biz-order-3', category: '敏感内容', subcategory: '物流',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
      keyword: ['trackingNo', 'receiver', 'address'], describe: '物流单号+收件人' },

    // ─── 支付/交易 ───
    { id: 'biz-pay-1', category: '敏感内容', subcategory: '支付信息',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['payAmount', 'payPassword'], describe: '支付金额+支付密码' },
    { id: 'biz-pay-2', category: '敏感内容', subcategory: '收款账户',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
      keyword: ['alipayAccount', 'realName'], describe: '支付宝账号+姓名' },
    { id: 'biz-pay-3', category: '敏感内容', subcategory: '交易流水',
      match: 'regex', location: 'body', accuracy: 2, important: true,
      regex: '"tradeNo"\\s*:\\s*"([A-Za-z0-9]{16,32})"',
      describe: '交易流水号（16-32 位字母数字）' },

    // ─── 工单/合同 ───
    { id: 'biz-ticket-1', category: '敏感内容', subcategory: '工单详情',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
      keyword: ['ticketNo', 'content', 'creator'],
      describe: '工单详情（ticketNo + content + creator）' },
    { id: 'biz-contract-1', category: '敏感内容', subcategory: '合同信息',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
      keyword: ['contractNo', 'partyA', 'amount'],
      describe: '合同信息（合同号+甲方+金额）' },
  ];

  // ────────────────────────── 系统/密钥/凭据 ──────────────────────────
  const SENSITIVE_SYSTEM = [
    // ─── 云密钥（复合检测：高危词+密钥前缀）───
    { id: 'sys-cloud-ak-1', category: '敏感内容', subcategory: '云访问密钥',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['AccessKeyId', 'AccessKeySecret'],
      describe: '阿里云/腾讯云 AccessKey 双字段同现' },
    { id: 'sys-cloud-ak-2', category: '敏感内容', subcategory: '云访问密钥',
      match: 'regex', location: 'body', accuracy: 3, important: true,
      regex: '"(?:secret_id|secret_key|AccessKey|SecretKey)"\\s*:\\s*"([A-Za-z0-9+/=_-]{20,})"',
      describe: '云平台密钥字段（20+ 位 base64-like）' },
    { id: 'sys-jwt-1', category: '敏感内容', subcategory: 'JWT令牌',
      match: 'regex', location: 'body', accuracy: 2, important: true,
      regex: '"(?:token|accessToken|id_token)"\\s*:\\s*"(ey[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})"',
      describe: 'JWT 格式 token 字段' },
    { id: 'sys-cookie-set-1', category: '敏感内容', subcategory: '会话Cookie',
      match: 'keyword', relation: 'AND', location: 'header', accuracy: 2, important: true,
      keyword: ['Set-Cookie', 'SESSION'], describe: '会话 Cookie 设置' },
    { id: 'sys-rsa-key-1', category: '敏感内容', subcategory: 'RSA私钥',
      match: 'regex', location: 'body', accuracy: 3, important: true,
      regex: '"(?:privateKey|private_key|rsaPrivateKey)"\\s*:\\s*"-----BEGIN',
      describe: 'RSA 私钥字段（PEM 内容）' },

    // ─── 配置/接口地址 ───
    { id: 'sys-config-1', category: '敏感内容', subcategory: '数据库连接',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['jdbc:mysql', 'password'], describe: 'MySQL JDBC 连接字符串+密码' },
    { id: 'sys-config-2', category: '敏感内容', subcategory: 'Redis 连接',
      match: 'regex', location: 'body', accuracy: 2, important: true,
      regex: '"redis"\\s*:\\s*\\{[\\s\\S]{0,200}"(?:host|password|port)"',
      describe: 'Redis 连接配置块' },
    { id: 'sys-config-3', category: '敏感内容', subcategory: '内部域名',
      match: 'regex', location: 'body', accuracy: 2, important: true,
      regex: '"(?:apiUrl|apiHost|baseUrl|serverUrl|backend)"\\s*:\\s*"(https?://[a-z0-9.-]+(?::\\d+)?)',
      describe: '内部 API 域名配置' },
    { id: 'sys-config-4', category: '敏感内容', subcategory: '加密密钥',
      match: 'keyword', relation: 'AND', location: 'body', accuracy: 3, important: true,
      keyword: ['encryptKey', 'signKey'], describe: '前后端加密/签名密钥' },
  ];

  // ────────────────────────── 有价值信息（情报） ──────────────────────────
  const SENSITIVE_INTEL = [
    // ─── 错误/调试信息 ───
    { id: 'intel-error-1', category: '有价值信息', subcategory: '堆栈异常',
      match: 'regex', location: 'body', accuracy: 2, important: true,
      regex: 'Exception in thread|at\\s+[a-zA-Z_][\\w$.]+\\([\\w]+\\.java:\\d+\\)',
      describe: 'Java 异常堆栈（含 .java 行号）' },
    { id: 'intel-error-2', category: '有价值信息', subcategory: '堆栈异常',
      match: 'regex', location: 'body', accuracy: 2, important: true,
      regex: 'File "[^"]+\\.py", line \\d+|Traceback \\(most recent call last\\)',
      describe: 'Python 异常堆栈' },
    { id: 'intel-error-3', category: '有价值信息', subcategory: 'SQL错误',
      match: 'regex', location: 'body', accuracy: 2, important: true,
      regex: '(?:MySQL|PostgreSQL|Oracle|SQL Server)[^\\n]{0,200}(?:syntax error|ORA-|\\[SQLServer\\])',
      describe: 'SQL 数据库错误信息' },
    { id: 'intel-error-4', category: '有价值信息', subcategory: '框架版本',
      match: 'regex', location: 'header', accuracy: 2, important: true,
      regex: 'X-Powered-By\\s*:\\s*[^\\r\\n]+',
      describe: 'X-Powered-By 框架版本泄漏' },

    // ─── 路径信息 ───
    { id: 'intel-path-1', category: '有价值信息', subcategory: '绝对路径',
      match: 'regex', location: 'body', accuracy: 2, important: true,
      regex: '"(?:path|filePath|filepath|file_path)"\\s*:\\s*"((?:/|[A-Z]:\\\\)[^"]+)"',
      describe: '响应中文件绝对路径字段' },

    // ─── URL 路径级敏感接口（漏出 /admin、/api/internal 等）───
    { id: 'intel-path-2', category: '敏感路径', subcategory: '管理后台',
      match: 'regex', location: 'urlPath', accuracy: 3, important: true,
      regex: '/(?:admin|administrator|manage|management|backend|console)/[\\w/-]+',
      describe: '管理后台 URL 路径' },
    { id: 'intel-path-3', category: '敏感路径', subcategory: '内部API',
      match: 'regex', location: 'urlPath', accuracy: 3, important: true,
      regex: '/(?:internal|private|debug|dev|test|stage)/api/',
      describe: '内部/测试环境 API 路径' },
    { id: 'intel-path-4', category: '敏感路径', subcategory: 'Swagger',
      match: 'regex', location: 'urlPath', accuracy: 2, important: true,
      regex: '/(?:swagger-ui\\.html|v2/api-docs|v3/api-docs|api-docs|openapi)',
      describe: 'Swagger / OpenAPI 文档路径' },
    { id: 'intel-path-5', category: '敏感路径', subcategory: 'Actuator',
      match: 'regex', location: 'urlPath', accuracy: 3, important: true,
      regex: '/(?:actuator|management)/(?:env|beans|mappings|trace|heapdump|jolokia|health)',
      describe: 'Spring Boot Actuator 端点' },
    { id: 'intel-path-6', category: '敏感路径', subcategory: 'Druid',
      match: 'keyword', relation: 'AND', location: 'urlPath', accuracy: 3, important: true,
      keyword: ['/druid', '/login'], describe: 'Druid 数据库监控登录页' },
    { id: 'intel-path-7', category: '敏感路径', subcategory: 'Kibana',
      match: 'keyword', relation: 'AND', location: 'urlPath', accuracy: 2, important: true,
      keyword: ['/kibana', '/app/kibana'], describe: 'Kibana 控制台' },
    { id: 'intel-path-8', category: '敏感路径', subcategory: 'Git元数据',
      match: 'keyword', relation: 'AND', location: 'urlPath', accuracy: 3, important: true,
      keyword: ['/.git/', 'HEAD'], describe: 'Git 元数据泄漏' },
    { id: 'intel-path-9', category: '敏感路径', subcategory: 'SVN元数据',
      match: 'keyword', relation: 'AND', location: 'urlPath', accuracy: 3, important: true,
      keyword: ['/.svn/', 'entries'], describe: 'SVN 元数据泄漏' },
    { id: 'intel-path-10', category: '敏感路径', subcategory: '备份文件',
      match: 'regex', location: 'urlPath', accuracy: 3, important: true,
      regex: '\\.(?:sql|bak|zip|rar|7z|tar\\.gz|war|jar|log|old|swp|save)$',
      describe: '备份文件 URL 后缀（sql/bak/zip/...）' },
    { id: 'intel-path-11', category: '敏感路径', subcategory: '上传目录',
      match: 'regex', location: 'urlPath', accuracy: 2, important: true,
      regex: '/upload[s]?/[^"\\s?#]+',
      describe: '可访问的上传目录' },

    // ─── 文件操作 ───
    { id: 'intel-file-1', category: '敏感路径', subcategory: '文件下载',
      match: 'regex', location: 'urlPath', accuracy: 2, important: true,
      regex: '/(?:download|file|attachment|getFile)[/?]',
      describe: '文件下载接口' },
    { id: 'intel-file-2', category: '敏感路径', subcategory: '文件上传',
      match: 'regex', location: 'urlPath', accuracy: 2, important: true,
      regex: '/(?:upload|fileUpload|importFile)[/?]',
      describe: '文件上传接口' },
  ];

  // ────────────────────────── 白名单配置（不参与匹配） ──────────────────────────
  // 这些规则不参与指纹匹配，其 keyword 在扫描时用于 URL 过滤。
  // 修改后保存，扫描时会自动加载。
  const WHITELIST_CONFIG = [
    { id: 'wl-static-ext', category: '白名单URL后缀', match: 'keyword',
      keyword: ['js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp',
                'woff', 'woff2', 'ttf', 'eot', 'otf',
                'mp3', 'mp4', 'm4a', 'wav', 'ogg', 'webm',
                'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
                'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
                'exe', 'dmg', 'apk', 'ipa',
                'csv', 'cvs', 'txt', 'md', 'xml', 'rss',
                'php', 'jsp', 'asp', 'aspx', 'map']
    },
    { id: 'wl-static-path', category: '白名单路径', match: 'keyword',
      keyword: ['/static/', '/assets/', '/public/', '/cdn/',
                '/img/', '/image/', '/images/', '/pic/', '/pics/',
                '/css/', '/js/', '/fonts/', '/font/',
                '/favicon', '/robots.txt', '/sitemap',
                '/__webpack_dev_server__', '/sockjs-node/']
    },
    { id: 'wl-static-domain', category: '白名单域名', match: 'keyword',
      keyword: ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com',
                'fonts.googleapis.com', 'fonts.gstatic.com',
                'ajax.googleapis.com', 'maxcdn.bootstrapcdn.com',
                'code.jquery.com', 'cdn.bootcdn.net',
                'hm.baidu.com', 'wss://', 'wxs.qq.com']
    },
  ];

  // ────────────────────────── 用户自定义区域 ──────────────────────────
  // 在此添加你自己的规则。格式同上，会自动合并到扫描引擎。
  const _USER_RULES = [
    // 示例：内部系统标识
    // { id: 'my-custom-1', category: '敏感内容', subcategory: '工号',
    //   match: 'keyword', relation: 'AND', location: 'body', accuracy: 2, important: true,
    //   keyword: ['employeeId', 'department'],
    //   describe: '员工档案接口' },
  ];

  // ────────────────────────── 汇总 ───────────────────────────────────────────
  const ALL_RULES = [].concat(
    SENSITIVE_CRED, SENSITIVE_PII, SENSITIVE_BIZ, SENSITIVE_SYSTEM,
    SENSITIVE_INTEL, WHITELIST_CONFIG, _USER_RULES
  );

  // 验证 / 规范化
  function normalize(rules) {
    const seen = new Set();
    return rules.map(function (r, idx) {
      if (!r.id) r.id = 'rule-' + idx;
      if (seen.has(r.id)) {
        console.warn('[api_finder_rules] 重复 id: ' + r.id);
      }
      seen.add(r.id);
      if (r.enabled === undefined) r.enabled = true;
      if (!r.relation) r.relation = 'AND';
      if (!r.location) r.location = 'body';
      if (!r.accuracy) r.accuracy = 2;
      return r;
    });
  }

  const API_FINDER_RULES = normalize(ALL_RULES);

  // ────────────────────────── 暴露 ───────────────────────────────────────────
  if (typeof module !== 'undefined' && module.exports) {
    // Node.js（测试 / 工具）
    module.exports = {
      RULES: API_FINDER_RULES,
      SENSITIVE_CRED: SENSITIVE_CRED,
      SENSITIVE_PII: SENSITIVE_PII,
      SENSITIVE_BIZ: SENSITIVE_BIZ,
      SENSITIVE_SYSTEM: SENSITIVE_SYSTEM,
      SENSITIVE_INTEL: SENSITIVE_INTEL,
      WHITELIST_CONFIG: WHITELIST_CONFIG,
      _USER_RULES: _USER_RULES,
      normalize: normalize,
    };
  } else {
    // 浏览器 / Service Worker
    global.API_FINDER_RULES = API_FINDER_RULES;
  }
})(typeof self !== 'undefined' ? self : this);