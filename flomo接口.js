/**
 * ★ flomo 内部 API 客户端（★ 从 Electron 应用逆向得到）★★
 *
 *  ★★ 接口基址 ★★
 *  Electron: BASE_URL + "/api/v1" ；调用时用相对路径 "/memo/updated/"
 *  ★★ 完整地址：https://flomoapp.com/api/v1/memo/updated/ ★★
 *
 *  ★★ 鉴权（源码 buildCommonHeaders + 各业务方法的 headers）★★
 *  Authorization: Bearer <access_token>   ← 来自 config.json 的 user.access_token
 *  platform / device-model / device-id
 *  api_key=flomo_web  app_version=2.0  timestamp=unix  sign=md5(...)
 *
 *  ★★ 凭证从哪来 ★★
 *  %APPDATA%/com.bilingify.readest  →  不对，是 flomo 卡片笔记 ★★
 *  %APPDATA%/flomo卡片笔记/config.json → user.access_token / user.api_token / user.slug
 */

const fs = require("fs");
const path = require("path");
const S = require(path.join(__dirname, "flomo签名.js"));

const BASE = "https://flomoapp.com/api/v1";

function appDir() {
  const appData = process.env.APPDATA || path.join(process.env.HOME || "", "AppData", "Roaming");
  return path.join(appData, "flomo卡片笔记");
}

/** 读本地凭证（flomo 卡片笔记 Electron 应用） */
function readCredentials() {
  const p = path.join(appDir(), "config.json");
  if (!fs.existsSync(p)) return null;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
  const u = (cfg && cfg.user) || {};
  if (!u.access_token) return null;
  return {
    accessToken: String(u.access_token),
    apiToken: String(u.api_token || ""),
    slug: String(u.slug || ""),
    name: String(u.name || ""),
    email: String(u.email || ""),
  };
}

function platform() {
  // ★★★ 必须与请求头一致，且服务端只认 web/mac/windows ★★★
  // ★ 实测：platform=web 签名能过；用 windows 会报「sign 错误」★
  // ★ → 统一用 web（flomo 的 Web 端身份），最稳 ★
  return "web";
}

/**
 * 调 flomo 内部接口
 * @param {string} method  GET / POST
 * @param {string} relPath  如 "/memo/updated/"
 * @param {Object} params  查询参数（会自动加 timestamp/api_key/app_version/platform/sign）
 * @param {Object} opts    { token, headers }
 */
async function call(method, relPath, params, opts) {
  const o = opts || {};
  const token = o.token || (readCredentials() || {}).accessToken || "";
  const p = Object.assign(
    {
      timestamp: Math.floor(Date.now() / 1000),
      api_key: "flomo_web",
      app_version: "2.0",
      platform: platform(),
    },
    params || {}
  );
  const signed = S.withSign(p);
  const qs = Object.keys(signed)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(signed[k]))
    .join("&");
  const url = BASE + relPath + (qs ? "?" + qs : "");

  const headers = {
    Accept: "application/json",
    platform: platform(),
    "device-model": "PC",
    "device-id": "workbuddy-sync",
  };
  if (token) headers.Authorization = "Bearer " + token;

  const init = { method, headers };
  if (method === "POST" && o.body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(o.body).toString();
  }

  const r = await fetch(url, init);
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    /* 非 JSON */
  }
  return { status: r.status, json, text };
}

/**
 * 增量拉取 memo（★ Electron 应用的 pullMemos 逻辑 ★）
 * @param {Object} o { limit, latestUpdatedAt, latestSlug, token }
 * @returns {Array} memo 数组
 */
async function pullMemos(o) {
  const c = readCredentials() || {};
  const res = await call(
    "GET",
    "/memo/updated/",
    {
      limit: (o && o.limit) || 50,
      latest_updated_at: (o && o.latestUpdatedAt) || 0,
      latest_slug: (o && o.latestSlug) || c.slug || "",
      tz: "-480",
    },
    { token: o && o.token }
  );
  if (!res.json) {
    throw new Error("响应不是 JSON（HTTP " + res.status + "）：" + res.text.slice(0, 200));
  }
  if (res.json.code !== 0) {
    throw new Error("flomo 接口返回：" + res.json.code + " " + (res.json.message || ""));
  }
  return res.json.data || [];
}

module.exports = { call, pullMemos, readCredentials, BASE };
