/**
 * ★ flomo MCP 客户端（★ 官方长期方案）★★
 *
 *  ★★ 为什么走 MCP 而不是内部接口 ★★
 *  ★ 内部接口（/api/v1/memo/updated/）是逆向来的 → flomo 改版就失效
 *  ★ MCP 是【官方公开能力】→ 长期稳定、跨电脑、官方支持
 *  ★ 官方文档：help.flomoapp.com/advance/mcp/
 *  ★ 凭证：设置 → MCP / API → MCP → Token 授权模式 → 创建 Token
 *  ★ 用法：Authorization: Bearer <Token>
 *
 *  ★★ 协议（streamable-http + JSON-RPC）★★
 *  ★ 1. POST /mcp  initialize        → 拿 mcp-session-id 响应头
 *  ★ 2. POST /mcp  notifications/initialized（通知，不等响应）
 *  ★ 3. POST /mcp  tools/list         → 列出工具
 *  ★ 4. POST /mcp  tools/call         → 调用工具
 *  ★ 响应可能是 JSON，也可能是 SSE（text/event-stream）→ 两种都要解析
 */

const MCP_URL = "https://flomoapp.com/mcp";

class FlomoMCP {
  /**
   * @param {string} token flomo MCP 个人 Token
   */
  constructor(token) {
    this.token = String(token || "").trim();
    this.sessionId = "";
    this.idSeq = 0;
  }

  _headers() {
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    };
    if (this.token) h.Authorization = "Bearer " + this.token;
    return h;
  }

  /** ★ 发一个 JSON-RPC 请求（★ 兼容 JSON 与 SSE 两种响应）★ */
  async _rpc(method, params, isNotify) {
    this.idSeq++;
    const payload = {
      jsonrpc: "2.0",
      method,
      params: params || {},
    };
    if (!isNotify) payload.id = this.idSeq;

    const init = { method: "POST", headers: this._headers(), body: JSON.stringify(payload) };
    if (this.sessionId) init.headers["mcp-session-id"] = this.sessionId;

    const r = await fetch(MCP_URL, init);
    // ★ 会话 id 在响应头里 ★
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    const text = await r.text();
    if (!r.ok) {
      throw new Error("MCP HTTP " + r.status + " → " + text.slice(0, 200));
    }
    if (isNotify) return null;

    // ① 纯 JSON
    const t = text.trim();
    if (t.startsWith("{")) {
      try { return JSON.parse(t); } catch (e) { /* 落到 SSE */ }
    }
    // ② SSE：逐行找 data:
    let last = null;
    for (const line of t.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        const body = line.slice(5).trim();
        if (!body) continue;
        try {
          const j = JSON.parse(body);
          if (j.id === this.idSeq || j.result || j.error) last = j;
        } catch (e) { /* 忽略非 JSON 行 */ }
      }
    }
    if (!last) throw new Error("MCP 响应无法解析：" + t.slice(0, 200));
    return last;
  }

  /** 初始化会话 */
  async init() {
    const res = await this._rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "flomo-notion-sync", version: "1.0" },
    });
    if (res && res.error) throw new Error("MCP initialize 失败：" + JSON.stringify(res.error).slice(0, 200));
    // 通知已初始化（不等响应）
    try {
      await this._rpc("notifications/initialized", {}, true);
    } catch (e) { /* 忽略 */ }
    return res;
  }

  /** 列出工具 */
  async listTools() {
    const res = await this._rpc("tools/list", {});
    if (res && res.error) throw new Error("tools/list 失败：" + JSON.stringify(res.error).slice(0, 200));
    return (res && res.result && res.result.tools) || [];
  }

  /**
   * 调用工具
   * @param {string} name  memo_search / memo_batch_get …
   * @param {Object} args
   */
  async call(name, args) {
    const res = await this._rpc("tools/call", { name, arguments: args || {} });
    if (res && res.error) {
      throw new Error("tools/call " + name + " 失败：" + JSON.stringify(res.error).slice(0, 200));
    }
    const content = (res && res.result && res.result.content) || [];
    // MCP 返回 [{type:"text", text:"..."}]
    const texts = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (!texts) return null;
    try {
      return JSON.parse(texts);
    } catch (e) {
      return texts;
    }
  }

  /**
   * ★ 读 memo（★ memo_search 拿列表 → memo_batch_get 补全正文）★
   *  ★★ 官方说明：memo_search 的正文超过 500 字会被截断（content_truncated=true）
   *  ★★ → 所以必须用 memo_batch_get 逐批取完整正文 ★★
   * @param {Object} o { limit }
   */
  async readMemos(o) {
    const limit = (o && o.limit) || 50;
    const all = [];
    const seen = new Set();

    // ① memo_search：按 30 天一段往前拉
    let end = new Date();
    for (let round = 0; round < 60; round++) {
      const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
      const fmt = (d) =>
        d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      const res = await this.call("memo_search", {
        start_date: fmt(start),
        end_date: fmt(end),
        limit,
      });
      const list = extractMemos(res);
      if (!list.length) break;
      list.forEach((m) => {
        const k = m.slug || m.id || "";
        if (k && !seen.has(k)) { seen.add(k); all.push(m); }
      });
      const times = list.map((m) => parseTime(m.created_at || m.updated_at)).filter(Boolean);
      if (!times.length) break;
      const min = Math.min.apply(null, times);
      const lastEnd = new Date(min - 24 * 3600 * 1000);
      if (lastEnd.getTime() <= start.getTime()) break;
      end = lastEnd;
      if (list.length < limit) break;
    }

    // ② memo_batch_get：把被截断的正文补全（★ 每次 10 条 ★）
    const ids = all
      .map((m) => m.id || m.slug)
      .filter(Boolean);
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      try {
        const res = await this.call("memo_batch_get", { ids: batch });
        const full = extractMemos(res);
        if (!full.length) continue;
        const byKey = new Map();
        full.forEach((m) => byKey.set(m.slug || m.id, m));
        for (let k = 0; k < all.length; k++) {
          const key = all[k].slug || all[k].id;
          const f = byKey.get(key);
          if (f) all[k] = Object.assign({}, all[k], f);   // ★ 用完整版覆盖 ★
        }
      } catch (e) {
        // 批量失败 → 单条重试
        for (const id of batch) {
          try {
            const one = await this.call("memo_batch_get", { id });
            const f = extractMemos(one);
            if (!f.length) continue;
            const key = f[0].slug || f[0].id;
            for (let k = 0; k < all.length; k++) {
              const kk = all[k].slug || all[k].id;
              if (kk === key) all[k] = Object.assign({}, all[k], f[0]);
            }
          } catch (e2) { /* 忽略单条失败 */ }
        }
      }
    }
    return all;
  }
}

/** ★ 从 MCP 返回里抽出 memo 数组（★ 兼容多种结构）★ */
function extractMemos(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.memos)) return res.memos;
  if (Array.isArray(res.data)) return res.data;
  if (res.content && Array.isArray(res.content)) {
    // ★ 嵌套一层 text→JSON ★
    for (const c of res.content) {
      if (c.type === "text" && typeof c.text === "string") {
        try {
          const j = JSON.parse(c.text);
          const got = extractMemos(j);
          if (got.length) return got;
        } catch (e) { /* 忽略 */ }
      }
    }
  }
  if (res.result && Array.isArray(res.result.memos)) return res.result.memos;
  if (res.result && Array.isArray(res.result.content)) {
    for (const c of res.result.content) {
      if (c.type === "text") {
        try {
          const got = extractMemos(JSON.parse(c.text));
          if (got.length) return got;
        } catch (e) { /* 忽略 */ }
      }
    }
  }
  return [];
}

/** flomo 时间 "2026-11-06 03:43:02" → 时间戳（★ 北京时间 ★） */
function parseTime(s) {
  if (!s) return 0;
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s));
  if (!m) return 0;
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6])
  ).getTime();
}

module.exports = { FlomoMCP, extractMemos, parseTime, MCP_URL };
