/** 网络层：本地开发若配置了 HTTPS_PROXY/HTTP_PROXY 则走企业代理，云托管生产环境直连。 */

let _fetch = global.fetch;

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  try {
    const { fetch: undiciFetch, ProxyAgent } = require("undici");
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    // 公司代理做 TLS 中间人重签证书：本地联调可设 ALLOW_INSECURE_TLS=1 跳过校验。
    // 生产（云托管直连）不设置代理与本变量，走正常证书校验。
    const requestTls = process.env.ALLOW_INSECURE_TLS === "1" ? { rejectUnauthorized: false } : undefined;
    const dispatcher = new ProxyAgent(proxy, { requestTls });
    _fetch = (url, opts = {}) => undiciFetch(url, { ...opts, dispatcher });
    console.log("出站请求走代理:", proxy, requestTls ? "(已跳过TLS校验，仅限联调)" : "");
  } catch (e) {
    console.error("代理初始化失败，改用直连:", e.message);
  }
}

module.exports = { fetch2: _fetch };
