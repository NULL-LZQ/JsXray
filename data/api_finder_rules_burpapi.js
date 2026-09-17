/*
 * Happy JS - BurpAPIFinder 导入规则
 * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
 *  自动生成于：2026-09-15T02:21:07.199Z
 *  源文件：finger-important.json
 *  规则数：106（keyword=86, regex=20, 白名单=3）
 *
 *  使用：在 popup「规则管理」启用 / 禁用，或编辑本文件修改规则。
 *  生成工具：tools/import_burpapi_rules.js
 * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
 */

(function (global) {
  'use strict';

  const BURPAPI_RULES = [
  {
    "id": "burp-账号-密码-邮箱-0",
    "category": "敏感内容",
    "subcategory": "账号, 密码, 邮箱",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 密码, 邮箱",
    "enabled": true,
    "keyword": [
      "pass",
      "email",
      "user",
      "Content-Type: application/json"
    ]
  },
  {
    "id": "burp-身份号-1",
    "category": "敏感内容",
    "subcategory": "身份号",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "身份号",
    "enabled": true,
    "keyword": [
      "gmsfhm",
      "Content-Type: application/json"
    ]
  },
  {
    "id": "burp-身份号-2",
    "category": "敏感内容",
    "subcategory": "身份号",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "身份号",
    "enabled": true,
    "keyword": [
      "cjrsfzh",
      "Content-Type: application/json"
    ]
  },
  {
    "id": "burp-手机-用户名-邮件-3",
    "category": "敏感内容",
    "subcategory": "手机, 用户名, 邮件",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "手机, 用户名, 邮件",
    "enabled": true,
    "keyword": [
      "tel",
      "account",
      "userName",
      "mailAccount",
      "Content-Type: application/json"
    ]
  },
  {
    "id": "burp-修改密码-4",
    "category": "敏感内容",
    "subcategory": "修改密码",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "修改密码",
    "enabled": true,
    "keyword": [
      "newPws",
      "userName"
    ]
  },
  {
    "id": "burp-修改密码-5",
    "category": "敏感内容",
    "subcategory": "修改密码",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "修改密码",
    "enabled": true,
    "keyword": [
      "newpassword",
      "actionid"
    ]
  },
  {
    "id": "burp-修改密码-6",
    "category": "敏感内容",
    "subcategory": "修改密码",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "修改密码",
    "enabled": true,
    "keyword": [
      "username",
      "newpassword"
    ]
  },
  {
    "id": "burp-账号-密码-7",
    "category": "敏感内容",
    "subcategory": "账号, 密码",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 密码",
    "enabled": true,
    "keyword": [
      "password",
      "name",
      "userid",
      "Content-Type: application/json"
    ]
  },
  {
    "id": "burp-账号-邮箱-收集-8",
    "category": "敏感内容",
    "subcategory": "账号, 邮箱， 收集",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 邮箱， 收集",
    "enabled": true,
    "keyword": [
      "name",
      "realName",
      "email",
      "phone",
      "Content-Type: application/json"
    ]
  },
  {
    "id": "burp-账号-9",
    "category": "敏感内容",
    "subcategory": "账号",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号",
    "enabled": true,
    "keyword": [
      "description",
      "name\"",
      "message\"",
      "Type\"",
      "Content-Type: application/json"
    ]
  },
  {
    "id": "burp-账号-手机-10",
    "category": "敏感内容",
    "subcategory": "账号, 手机",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 手机",
    "enabled": true,
    "keyword": [
      "person",
      "mobilPhone",
      "id",
      "status"
    ]
  },
  {
    "id": "burp-手机-用户名-邮件-密码-11",
    "category": "敏感内容",
    "subcategory": "手机, 用户名, 邮件, 密码",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "手机, 用户名, 邮件, 密码",
    "enabled": true,
    "keyword": [
      "email",
      "phone",
      "pwd",
      "id",
      "name",
      "Content-Type: application/json"
    ]
  },
  {
    "id": "burp-手机-用户名-12",
    "category": "敏感内容",
    "subcategory": "手机, 用户名",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "手机, 用户名",
    "enabled": true,
    "keyword": [
      "personName",
      "phoneNo",
      "deptName"
    ]
  },
  {
    "id": "burp-身份证-13",
    "category": "敏感内容",
    "subcategory": "身份证",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "身份证",
    "enabled": true,
    "keyword": [
      "sfzhm",
      "total",
      "rows"
    ]
  },
  {
    "id": "burp-身份证-14",
    "category": "敏感内容",
    "subcategory": "身份证",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "身份证",
    "enabled": true,
    "keyword": [
      "keyHash",
      "idCard",
      "partment"
    ]
  },
  {
    "id": "burp-身份证-15",
    "category": "敏感内容",
    "subcategory": "身份证",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "身份证",
    "enabled": true,
    "keyword": [
      "Idcard",
      "Name",
      "id",
      "status",
      "address"
    ]
  },
  {
    "id": "burp-云KEY-16",
    "category": "敏感内容",
    "subcategory": "云KEY",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "云KEY",
    "enabled": true,
    "keyword": [
      "ALI_ACCESS_ID",
      "ALI_ACCESS_KEY"
    ]
  },
  {
    "id": "burp-云KEY-17",
    "category": "敏感内容",
    "subcategory": "云KEY",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "云KEY",
    "enabled": true,
    "keyword": [
      "ACCESSID",
      "ACCESSKEY"
    ]
  },
  {
    "id": "burp-云KEY-18",
    "category": "敏感内容",
    "subcategory": "云KEY",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "云KEY",
    "enabled": true,
    "keyword": [
      "AccessKey ID",
      "AccessKey Secret"
    ]
  },
  {
    "id": "burp-云KEY-19",
    "category": "敏感内容",
    "subcategory": "云KEY",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "云KEY",
    "enabled": true,
    "keyword": [
      "accessKeyId",
      "accessKeySecret"
    ]
  },
  {
    "id": "burp-云KEY-20",
    "category": "敏感内容",
    "subcategory": "云KEY",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "云KEY",
    "enabled": true,
    "keyword": [
      "ACCESS_ID",
      "ACCESS_KEY"
    ]
  },
  {
    "id": "burp-云KEY-21",
    "category": "敏感内容",
    "subcategory": "云KEY",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "云KEY",
    "enabled": true,
    "keyword": [
      "SSOusername",
      "SSOpassword"
    ]
  },
  {
    "id": "burp-云KEY-22",
    "category": "敏感内容",
    "subcategory": "云KEY",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "云KEY",
    "enabled": true,
    "keyword": [
      "oss://"
    ]
  },
  {
    "id": "burp-云KEY-23",
    "category": "敏感内容",
    "subcategory": "云KEY",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "云KEY",
    "enabled": true,
    "keyword": [
      "UC_DBHOST",
      "UC_DBUSER",
      "UC_KEY",
      "UC_API"
    ]
  },
  {
    "id": "burp-JDBC泄漏-24",
    "category": "敏感内容",
    "subcategory": "JDBC泄漏",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "JDBC泄漏",
    "enabled": true,
    "regex": "jdbc:(mysql|h2|oracle|sqlserver|jtds:sqlserver):"
  },
  {
    "id": "burp-JDBC泄漏-25",
    "category": "敏感内容",
    "subcategory": "JDBC泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "JDBC泄漏",
    "enabled": true,
    "keyword": [
      "System.Data.SqlClient"
    ]
  },
  {
    "id": "burp-JDBC泄漏-26",
    "category": "敏感内容",
    "subcategory": "JDBC泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "JDBC泄漏",
    "enabled": true,
    "keyword": [
      "Data.PassportContext"
    ]
  },
  {
    "id": "burp-JDBC泄漏-27",
    "category": "敏感内容",
    "subcategory": "JDBC泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "JDBC泄漏",
    "enabled": true,
    "keyword": [
      "mysql.username",
      "mysql.password",
      "mysql.url"
    ]
  },
  {
    "id": "burp-JDBC泄漏-28",
    "category": "敏感内容",
    "subcategory": "JDBC泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "JDBC泄漏",
    "enabled": true,
    "keyword": [
      "jdbc.username",
      "jdbc.password"
    ]
  },
  {
    "id": "burp-JDBC泄漏-29",
    "category": "敏感内容",
    "subcategory": "JDBC泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "JDBC泄漏",
    "enabled": true,
    "keyword": [
      "mssql.jdbc",
      "mssql.user"
    ]
  },
  {
    "id": "burp-JDBC泄漏-30",
    "category": "敏感内容",
    "subcategory": "JDBC泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "JDBC泄漏",
    "enabled": true,
    "keyword": [
      "com.microsoft.sqlserver.jdbc.SQLServerDriver"
    ]
  },
  {
    "id": "burp-邮箱凭证泄漏-31",
    "category": "敏感内容",
    "subcategory": "邮箱凭证泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "邮箱凭证泄漏",
    "enabled": true,
    "keyword": [
      "EMAIL_HOST_USER",
      "EMAIL_HOST_PASSWORD"
    ]
  },
  {
    "id": "burp-邮箱凭证泄漏-32",
    "category": "敏感内容",
    "subcategory": "邮箱凭证泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "邮箱凭证泄漏",
    "enabled": true,
    "keyword": [
      "mail.username",
      "mail.password"
    ]
  },
  {
    "id": "burp-邮箱凭证泄漏-33",
    "category": "敏感内容",
    "subcategory": "邮箱凭证泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "邮箱凭证泄漏",
    "enabled": true,
    "keyword": [
      "sender.username",
      "sender.password"
    ]
  },
  {
    "id": "burp-邮箱凭证泄漏-34",
    "category": "敏感内容",
    "subcategory": "邮箱凭证泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "邮箱凭证泄漏",
    "enabled": true,
    "keyword": [
      "mailUserPwd",
      "mailUserName"
    ]
  },
  {
    "id": "burp-邮箱凭证泄漏-35",
    "category": "敏感内容",
    "subcategory": "邮箱凭证泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "邮箱凭证泄漏",
    "enabled": true,
    "keyword": [
      "mail_user",
      "mail_pass"
    ]
  },
  {
    "id": "burp-邮箱凭证泄漏-36",
    "category": "敏感内容",
    "subcategory": "邮箱凭证泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "邮箱凭证泄漏",
    "enabled": true,
    "keyword": [
      "EMAIL_PSWD",
      "EMAIL_USER"
    ]
  },
  {
    "id": "burp-邮箱凭证泄漏-37",
    "category": "敏感内容",
    "subcategory": "邮箱凭证泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "邮箱凭证泄漏",
    "enabled": true,
    "keyword": [
      "EMAIL_LOGIN_NAME",
      "EMAIL_LOGIN_PASSWD"
    ]
  },
  {
    "id": "burp-邮箱凭证泄漏-38",
    "category": "敏感内容",
    "subcategory": "邮箱凭证泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "邮箱凭证泄漏",
    "enabled": true,
    "keyword": [
      "email_username",
      "email_password"
    ]
  },
  {
    "id": "burp-邮箱凭证泄漏-39",
    "category": "敏感内容",
    "subcategory": "邮箱凭证泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "邮箱凭证泄漏",
    "enabled": true,
    "keyword": [
      "smtp_username",
      "smtp_password"
    ]
  },
  {
    "id": "burp-邮箱凭证泄漏-40",
    "category": "敏感内容",
    "subcategory": "邮箱凭证泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "邮箱凭证泄漏",
    "enabled": true,
    "keyword": [
      "mailuser",
      "mailPassword"
    ]
  },
  {
    "id": "burp-邮箱凭证泄漏-41",
    "category": "敏感内容",
    "subcategory": "邮箱凭证泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "邮箱凭证泄漏",
    "enabled": true,
    "keyword": [
      "mailServerUsername",
      "mailServerPassword"
    ]
  },
  {
    "id": "burp-邮箱凭证泄漏-42",
    "category": "敏感内容",
    "subcategory": "邮箱凭证泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "邮箱凭证泄漏",
    "enabled": true,
    "keyword": [
      "WebMail.UserName",
      "WebMail.Password"
    ]
  },
  {
    "id": "burp-FTP泄漏-43",
    "category": "敏感内容",
    "subcategory": "FTP泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "FTP泄漏",
    "enabled": true,
    "keyword": [
      "ftpUsername",
      "ftpPassword"
    ]
  },
  {
    "id": "burp-FTP泄漏-44",
    "category": "敏感内容",
    "subcategory": "FTP泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "FTP泄漏",
    "enabled": true,
    "keyword": [
      "FTP_USER",
      "FTP_ADDR",
      "FTP_PASS"
    ]
  },
  {
    "id": "burp-SSH泄漏-45",
    "category": "敏感内容",
    "subcategory": "SSH泄漏",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "SSH泄漏",
    "enabled": true,
    "keyword": [
      "ssh://"
    ]
  },
  {
    "id": "burp-云KEY-46",
    "category": "敏感内容",
    "subcategory": "云KEY",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "云KEY",
    "enabled": true,
    "keyword": [
      "access_key_id",
      "secret_access_key"
    ]
  },
  {
    "id": "burp-身份证-47",
    "category": "敏感内容",
    "subcategory": "身份证",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "身份证",
    "enabled": true,
    "keyword": [
      "name",
      "sfzh",
      "Content-Type: application/json"
    ]
  },
  {
    "id": "burp-手机号码-48",
    "category": "敏感内容",
    "subcategory": "手机号码",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "手机号码",
    "enabled": true,
    "keyword": [
      "msg",
      "mobile\"",
      "Content-Type: application/json"
    ]
  },
  {
    "id": "burp-云KEY-49",
    "category": "敏感内容",
    "subcategory": "云KEY",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "云KEY",
    "enabled": true,
    "keyword": [
      "accessKeyId",
      "accessSecret"
    ]
  },
  {
    "id": "burp-云KEY-50",
    "category": "敏感内容",
    "subcategory": "云KEY",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "云KEY",
    "enabled": true,
    "keyword": [
      "\"accessKeyId\""
    ]
  },
  {
    "id": "burp-云KEY-51",
    "category": "敏感内容",
    "subcategory": "云KEY",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "云KEY",
    "enabled": true,
    "keyword": [
      "accessKeyId",
      "secretAccessKey"
    ]
  },
  {
    "id": "burp-账号-密码-IP-52",
    "category": "敏感内容",
    "subcategory": "账号, 密码, IP",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": false,
    "describe": "账号, 密码, IP",
    "enabled": true,
    "keyword": [
      "password:",
      "HOST:",
      "NAME:"
    ]
  },
  {
    "id": "burp-管理员账号-管理员密码-53",
    "category": "敏感内容",
    "subcategory": "管理员账号、管理员密码",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "管理员账号、管理员密码",
    "enabled": true,
    "keyword": [
      "管理员密码",
      "管理员账号"
    ]
  },
  {
    "id": "burp-管理员账号-管理员密码-54",
    "category": "敏感内容",
    "subcategory": "管理员账号、管理员密码",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "管理员账号、管理员密码",
    "enabled": true,
    "keyword": [
      "'admin_pwd'",
      "'admin_user'"
    ]
  },
  {
    "id": "burp-管理员账号-管理员密码-55",
    "category": "敏感内容",
    "subcategory": "管理员账号、管理员密码",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "管理员账号、管理员密码",
    "enabled": true,
    "keyword": [
      "<pwd>",
      "<admin_user>"
    ]
  },
  {
    "id": "burp-管理员账号-管理员密码-56",
    "category": "敏感内容",
    "subcategory": "管理员账号、管理员密码",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "管理员账号、管理员密码",
    "enabled": true,
    "keyword": [
      "\"admin_pwd\"",
      "\"admin_user\""
    ]
  },
  {
    "id": "burp-初始密码-57",
    "category": "敏感内容",
    "subcategory": "初始密码",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 2,
    "important": true,
    "describe": "初始密码",
    "enabled": true,
    "regex": "(initPassword\\s*[:=]\\s*\"?|\"initPassword\"\\s*:\\s*\"?|\"初始密码\"\\s*:\\s*\"?)[\"]?[^\"\\s]+[\"]?|\\b初始密码是\\s+[^\"\\s]+"
  },
  {
    "id": "burp-账号-密码-IP-58",
    "category": "敏感内容",
    "subcategory": "账号, 密码, IP",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 密码, IP",
    "enabled": true,
    "keyword": [
      "server",
      "pwd",
      "database",
      "user"
    ]
  },
  {
    "id": "burp-账号-密码-IP-59",
    "category": "敏感内容",
    "subcategory": "账号, 密码, IP",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 密码, IP",
    "enabled": true,
    "keyword": [
      "Authentication failed",
      "user",
      "__construct"
    ]
  },
  {
    "id": "burp-GraphQL-API-60",
    "category": "敏感内容",
    "subcategory": "GraphQL API",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "GraphQL API",
    "enabled": true,
    "keyword": [
      "/graphiql"
    ]
  },
  {
    "id": "burp-GraphQL-API-61",
    "category": "敏感内容",
    "subcategory": "GraphQL API",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "GraphQL API",
    "enabled": true,
    "keyword": [
      "__graphiql"
    ]
  },
  {
    "id": "burp-账号-密码-62",
    "category": "敏感内容",
    "subcategory": "账号, 密码",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 密码",
    "enabled": true,
    "keyword": [
      "user=='",
      "password=='"
    ]
  },
  {
    "id": "burp-账号-密码-63",
    "category": "敏感内容",
    "subcategory": "账号, 密码",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 密码",
    "enabled": true,
    "keyword": [
      "userName =>",
      "password =>",
      "info"
    ]
  },
  {
    "id": "burp-账号-密码-IP-64",
    "category": "敏感内容",
    "subcategory": "账号, 密码, IP",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 密码, IP",
    "enabled": true,
    "keyword": [
      "VPN服务器地址",
      "用户名",
      "密码"
    ]
  },
  {
    "id": "burp-账号-密码-IP-65",
    "category": "敏感内容",
    "subcategory": "账号, 密码, IP",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 密码, IP",
    "enabled": true,
    "keyword": [
      "username",
      "password",
      "jdbc:"
    ]
  },
  {
    "id": "burp-账号-密码-IP-66",
    "category": "敏感内容",
    "subcategory": "账号, 密码, IP",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 密码, IP",
    "enabled": true,
    "keyword": [
      "String username",
      "String password",
      "="
    ]
  },
  {
    "id": "burp-账号-密码-IP-67",
    "category": "敏感内容",
    "subcategory": "账号, 密码, IP",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 密码, IP",
    "enabled": true,
    "keyword": [
      "jdbc.url",
      "://",
      "username",
      "password"
    ]
  },
  {
    "id": "burp-账号-身份证-68",
    "category": "敏感内容",
    "subcategory": "账号, 身份证",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 身份证",
    "enabled": true,
    "keyword": [
      "身份证号码",
      "姓名",
      "公司",
      "Content-Type: application/json"
    ]
  },
  {
    "id": "burp-账号-密码-69",
    "category": "敏感内容",
    "subcategory": "账号, 密码",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 密码",
    "enabled": true,
    "keyword": [
      "secret_key",
      "address"
    ]
  },
  {
    "id": "burp-账号-密码-70",
    "category": "敏感内容",
    "subcategory": "账号, 密码",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "账号, 密码",
    "enabled": true,
    "keyword": [
      "secret_key",
      "api_key"
    ]
  },
  {
    "id": "burp-shiro-71",
    "category": "敏感内容",
    "subcategory": "shiro",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "shiro",
    "enabled": true,
    "regex": "(=deleteMe|rememberMe=)"
  },
  {
    "id": "burp-JSON-Web-Token-72",
    "category": "敏感内容",
    "subcategory": "JSON Web Token",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": false,
    "describe": "JSON Web Token",
    "enabled": true,
    "regex": "(eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9._-]{10,}|eyJ[A-Za-z0-9_\\/+-]{10,}\\.[A-Za-z0-9._\\/+-]{10,})"
  },
  {
    "id": "burp-Swagger-UI-73",
    "category": "敏感内容",
    "subcategory": "Swagger UI",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "Swagger UI",
    "enabled": true,
    "regex": "((swagger-ui.html)|(\\\"swagger\\\":)|(Swagger UI)|(swaggerUi)|(swaggerVersion))"
  },
  {
    "id": "burp-Ueditor-74",
    "category": "敏感内容",
    "subcategory": "Ueditor",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "Ueditor",
    "enabled": true,
    "regex": "(ueditor\\.(config|all)\\.js)"
  },
  {
    "id": "burp-Druid-75",
    "category": "敏感内容",
    "subcategory": "Druid",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "Druid",
    "enabled": true,
    "regex": "(Druid Stat Index)"
  },
  {
    "id": "burp-身份证-76",
    "category": "敏感内容",
    "subcategory": "身份证",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "身份证",
    "enabled": true,
    "regex": "(11|12|13|14|15|21|22|23|31|32|33|34|35|36|37|41|42|43|44|45|46|50|51|52|53|54|61|62|63|64|65|71|81|82)\\d{4}(19|20)\\d{2}((0[1-9])|(1[0-2]))((0[1-9])|([12]\\d)|(3[01]))\\d{3}([0-9Xx])"
  },
  {
    "id": "burp-Cloud-Key-77",
    "category": "敏感内容",
    "subcategory": "Cloud Key",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "Cloud Key",
    "enabled": true,
    "regex": "(((access)(|-|_)(key)(|-|_)(id|secret))|(LTAI[a-z0-9]{12,20}))"
  },
  {
    "id": "burp-Windows-File-Dir-Path-78",
    "category": "敏感内容",
    "subcategory": "Windows File/Dir Path",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "Windows File/Dir Path",
    "enabled": true,
    "regex": "'[^\\w](([a-zA-Z]:\\\\(?:\\w+\\\\?)*)|([a-zA-Z]:\\\\(?:\\w+\\\\)*\\w+\\.\\w+))'"
  },
  {
    "id": "burp-Password-Field-79",
    "category": "敏感内容",
    "subcategory": "Password Field",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "Password Field",
    "enabled": true,
    "regex": "((|'|\")(|[\\w]{1,10})([p](ass|wd|asswd|assword))(|[\\w]{1,10})(|'|\")(:|=)(|)('|\")(.*?)('|\")(|,))"
  },
  {
    "id": "burp-JDBC-Connection-80",
    "category": "敏感内容",
    "subcategory": "JDBC Connection",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "JDBC Connection",
    "enabled": true,
    "regex": "(jdbc:[a-z:]+://[a-z0-9\\.\\-_:;=/@?,&]+)"
  },
  {
    "id": "burp-AppSecret-AppID-81",
    "category": "敏感内容",
    "subcategory": "AppSecret、AppID",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "AppSecret、AppID",
    "enabled": true,
    "keyword": [
      "AppSecret",
      "AppID"
    ]
  },
  {
    "id": "burp-AppSecret-AppKey-82",
    "category": "敏感内容",
    "subcategory": "AppSecret、AppKey",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "AppSecret、AppKey",
    "enabled": true,
    "keyword": [
      "AppSecret",
      "AppKey"
    ]
  },
  {
    "id": "burp-AppSecret-AppKey-83",
    "category": "敏感内容",
    "subcategory": "AppSecret、AppKey",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "AppSecret、AppKey",
    "enabled": true,
    "keyword": [
      "AppSecret",
      "AppKey"
    ]
  },
  {
    "id": "burp-企业微信Corpid-Corpsecret-84",
    "category": "敏感内容",
    "subcategory": "企业微信Corpid、Corpsecret",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "企业微信Corpid、Corpsecret",
    "enabled": true,
    "keyword": [
      "Corpid",
      "Corpsecret"
    ]
  },
  {
    "id": "burp-飞书App_Id-App_Secret-85",
    "category": "敏感内容",
    "subcategory": "飞书App_Id、App_Secret",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": true,
    "describe": "飞书App_Id、App_Secret",
    "enabled": true,
    "keyword": [
      "App_Id",
      "App_Secret"
    ]
  },
  {
    "id": "burp-Java-Deserialization-86",
    "category": "有价值信息",
    "subcategory": "Java Deserialization",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": false,
    "describe": "Java Deserialization",
    "enabled": true,
    "regex": "(javax\\.faces\\.ViewState)"
  },
  {
    "id": "burp-Authorization-Header-87",
    "category": "有价值信息",
    "subcategory": "Authorization Header",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": false,
    "describe": "Authorization Header",
    "enabled": true,
    "regex": "((basic [a-z0-9=:_\\+\\/-]{5,100})|(bearer [a-z0-9_.=:_\\+\\/-]{5,100}))"
  },
  {
    "id": "burp-Upload-Form-88",
    "category": "有价值信息",
    "subcategory": "Upload Form",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": false,
    "describe": "Upload Form",
    "enabled": true,
    "regex": "(type\\=\\\"file\\\")"
  },
  {
    "id": "burp-Email-89",
    "category": "有价值信息",
    "subcategory": "Email",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": false,
    "describe": "Email",
    "enabled": true,
    "regex": "(([a-z0-9]+[_|\\.])*[a-z0-9]+@([a-z0-9]+[-|_|\\.])*[a-z0-9]+\\.((?!js|css|jpg|jpeg|png|ico)[a-z]{2,5}))"
  },
  {
    "id": "burp-Chinese-Mobile-Number-90",
    "category": "有价值信息",
    "subcategory": "Chinese Mobile Number",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": false,
    "describe": "Chinese Mobile Number",
    "enabled": true,
    "regex": "[^\\w]((?:(?:\\+|00)86)?1(?:(?:3[\\d])|(?:4[5-79])|(?:5[0-35-9])|(?:6[5-7])|(?:7[0-8])|(?:8[\\d])|(?:9[189]))\\d{8})[^\\w]"
  },
  {
    "id": "burp-Internal-IP-Address-91",
    "category": "有价值信息",
    "subcategory": "Internal IP Address",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": false,
    "describe": "Internal IP Address",
    "enabled": true,
    "regex": "[^0-9]((127\\.0\\.0\\.1)|(10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})|(172\\.((1[6-9])|(2\\d)|(3[01]))\\.\\d{1,3}\\.\\d{1,3})|(192\\.168\\.\\d{1,3}\\.\\d{1,3}))"
  },
  {
    "id": "burp-MAC-Address-92",
    "category": "有价值信息",
    "subcategory": "MAC Address",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": false,
    "describe": "MAC Address",
    "enabled": true,
    "regex": "(^([a-fA-F0-9]{2}(:[a-fA-F0-9]{2}){5})|[^a-zA-Z0-9]([a-fA-F0-9]{2}(:[a-fA-F0-9]{2}){5}))"
  },
  {
    "id": "burp-缺少参数-93",
    "category": "有价值信息",
    "subcategory": "缺少参数",
    "match": "regex",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": false,
    "describe": "缺少参数",
    "enabled": true,
    "regex": "\".*Required .{1,18} parameter.*\""
  },
  {
    "id": "burp-缺少参数-94",
    "category": "有价值信息",
    "subcategory": "缺少参数",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": false,
    "describe": "缺少参数",
    "enabled": true,
    "keyword": [
      "Content-Type: application/json",
      "is not present"
    ]
  },
  {
    "id": "burp-缺少参数-95",
    "category": "有价值信息",
    "subcategory": "缺少参数",
    "match": "keyword",
    "relation": "AND",
    "location": "body",
    "accuracy": 3,
    "important": false,
    "describe": "缺少参数",
    "enabled": true,
    "keyword": [
      "Content-Type: application/json",
      "缺少参数"
    ]
  },
  {
    "id": "burp-GraphQL-96",
    "category": "敏感路径",
    "subcategory": "GraphQL",
    "match": "keyword",
    "relation": "AND",
    "location": "urlPath",
    "accuracy": 3,
    "important": true,
    "describe": "GraphQL",
    "enabled": true,
    "keyword": [
      "/graphql"
    ]
  },
  {
    "id": "burp-GraphQL-97",
    "category": "敏感路径",
    "subcategory": "GraphQL",
    "match": "keyword",
    "relation": "AND",
    "location": "urlPath",
    "accuracy": 3,
    "important": true,
    "describe": "GraphQL",
    "enabled": true,
    "keyword": [
      "/graphiql"
    ]
  },
  {
    "id": "burp-OpenAPI-Swagger-98",
    "category": "敏感路径",
    "subcategory": "OpenAPI-Swagger",
    "match": "keyword",
    "relation": "AND",
    "location": "urlPath",
    "accuracy": 3,
    "important": true,
    "describe": "OpenAPI-Swagger",
    "enabled": true,
    "keyword": [
      "/swagger-resources"
    ]
  },
  {
    "id": "burp-OpenAPI-Swagger-99",
    "category": "敏感路径",
    "subcategory": "OpenAPI-Swagger",
    "match": "keyword",
    "relation": "AND",
    "location": "urlPath",
    "accuracy": 3,
    "important": true,
    "describe": "OpenAPI-Swagger",
    "enabled": true,
    "keyword": [
      "/swagger/"
    ]
  },
  {
    "id": "burp-SpringbootActuator-100",
    "category": "敏感路径",
    "subcategory": "SpringbootActuator",
    "match": "keyword",
    "relation": "AND",
    "location": "urlPath",
    "accuracy": 3,
    "important": true,
    "describe": "SpringbootActuator",
    "enabled": true,
    "keyword": [
      "/mappings"
    ]
  },
  {
    "id": "burp-SpringbootActuator-101",
    "category": "敏感路径",
    "subcategory": "SpringbootActuator",
    "match": "keyword",
    "relation": "AND",
    "location": "urlPath",
    "accuracy": 3,
    "important": true,
    "describe": "SpringbootActuator",
    "enabled": true,
    "keyword": [
      "/actuator"
    ]
  },
  {
    "id": "burp-GraphQL-API-102",
    "category": "敏感路径",
    "subcategory": "GraphQL API",
    "match": "keyword",
    "relation": "AND",
    "location": "urlPath",
    "accuracy": 3,
    "important": true,
    "describe": "GraphQL API",
    "enabled": true,
    "keyword": [
      "/graphiql"
    ]
  },
  {
    "id": "burp-rule-103-103",
    "category": "白名单URL后缀",
    "subcategory": "",
    "match": "keyword",
    "relation": "AND",
    "location": "urlPath",
    "accuracy": 3,
    "important": false,
    "describe": "",
    "enabled": true,
    "keyword": [
      "vue",
      "ts",
      "min",
      "png",
      "jpg",
      "jpeg",
      "gif",
      "bmp",
      "css",
      "woff",
      "woff2",
      "ttf",
      "otf",
      "ttc",
      "svg",
      "psd",
      "exe",
      "zip",
      "rar",
      "7z",
      "msi",
      "tar",
      "gz",
      "mp3",
      "mp4",
      "mkv",
      "swf",
      "iso",
      "ico",
      "gif"
    ]
  },
  {
    "id": "burp-rule-104-104",
    "category": "白名单路径",
    "subcategory": "",
    "match": "keyword",
    "relation": "AND",
    "location": "urlPath",
    "accuracy": 3,
    "important": false,
    "describe": "",
    "enabled": true,
    "keyword": [
      "zh-CN",
      "image/",
      "images/",
      "text/css",
      "text/javascript",
      ":",
      "：",
      "%",
      "@",
      "//",
      "&",
      "=",
      "~",
      ".css",
      ",",
      "??",
      "<",
      ">",
      "[",
      "]",
      "(",
      ")",
      "}",
      "{",
      "`",
      "^",
      "'",
      " ",
      "+",
      "|"
    ]
  },
  {
    "id": "burp-rule-105-105",
    "category": "白名单域名",
    "subcategory": "",
    "match": "keyword",
    "relation": "AND",
    "location": "urlPath",
    "accuracy": 3,
    "important": false,
    "describe": "",
    "enabled": true,
    "keyword": [
      ".baidu.com",
      ".google.com",
      ".bing.com",
      ".yahoo.com",
      ".aliyun.com",
      ".alibaba.com"
    ]
  }
];

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BURPAPI_RULES;
  } else {
    global.BURPAPI_RULES = BURPAPI_RULES;
  }
})(typeof self !== 'undefined' ? self : this);
