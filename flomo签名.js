/**
 * ★ flomo 内部接口签名（★ 从 Electron 应用源码逆向得到）★★
 *
 *  ★★ 来源：/c/Program Files/flomo/resources/app.asar → js/index.*.js ★★
 *  ★★ static _getSign(e) { ★★
 *  ★★   const t = "dbbc3dd73364b4084c3a69346e0ce2b2";   ← 固定盐 ★★
 *  ★★   e = this._ksort(e);                                ← 参数名升序 ★★
 *  ★★   let i = "";
 *  ★★   for (let n in e) { ... i += n + "=" + t + "&"; }   ← 拼 query ★★
 *  ★★   i = i.substring(0, i.length - 1);                  ← 去掉末尾 & ★★
 *  ★★   let a = p(i + t);                                  ← md5(拼好的串 + 盐) ★★
 *  ★★   return a;
 *  ★★ }
 *
 *  ★★ 必带请求头（源码 buildCommonHeaders + 业务代码）★★
 *  ★★   Authorization: Bearer <access_token>
 *  ★★   platform: windows|mac|web
 *  ★★   device-model / device-id
 */

const crypto = require("crypto");

const SIGN_SECRET = "dbbc3dd73364b4084c3a69346e0ce2b2";

function md5(s) {
  return crypto.createHash("md5").update(String(s), "utf8").digest("hex");
}

/** 参数名升序 */
function ksort(obj) {
  const keys = Object.keys(obj).sort();
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

/**
 * 计算 sign
 * @param {Object} params 请求参数（不含 sign 本身）
 * @returns {string} 32 位小写 hex
 */
function sign(params) {
  const sorted = ksort(params || {});
  let s = "";
  for (const k in sorted) {
    let v = sorted[k];
    // ★★★ 必须与 flomo 原版一致：跳过 undefined / null / 空字符串 ★★★
    //   原版：if ("undefined" !== typeof t && (t || 0 === t))
    //   → 空字符串 "" 是 falsy 且 0 !== "" → 【不参与签名】
    //   ★ 若这里把空串也算进去 → 服务端算出的 sign 与我们算的不同 → 「sign 错误」★
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      v = v.slice().sort((a, b) => (a && b ? String(a).localeCompare(String(b)) : 0));
      for (const item of v) s += k + "[]=" + item + "&";
    } else if (typeof v === "boolean") {
      s += k + "=" + (v ? "1" : "0") + "&";
    } else {
      s += k + "=" + v + "&";
    }
  }
  s = s.substring(0, s.length - 1);
  return md5(s + SIGN_SECRET);
}

/**
 * 给参数加上 sign
 */
function withSign(params) {
  const p = Object.assign({}, params);
  p.sign = sign(p);
  return p;
}

module.exports = { sign, withSign, md5, SIGN_SECRET };
