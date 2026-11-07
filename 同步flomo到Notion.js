/**
 * ★★★ flomo → Notion「Flomo知识库」同步（★ 主脚本）★★★ ★
 *
 *  ★★ 数据来源（三条路，自动降级）★★
 *  ① 【官方 API Key】★ 最稳、跨电脑 ★
 *     GET https://flomoapp.com/api/memo/?api_key=XXX
 *     ★ 需要你在 flomo「设置 → API」生成的 api_key ★
 *     ★ 存在同目录的 flomo配置.json 里 ★
 *  ② 【内部接口 + 本机 flomo 客户端登录态】★ 兜底 ★
 *     读 %APPDATA%/flomo卡片笔记/config.json 的 access_token
 *     ★ ★ 换电脑失效 → 只能用 ① 或 ③ ★★
 *  ③ 【内部接口 + 邮箱登录】★ 跨电脑 ★
 *     POST /api/v1/user/login_by_email  {email, password} → access_token
 *     ★ 账号密码存在 flomo配置.json → 换电脑也能换 token ★
 *
 *  ★★ 增量游标 ★★
 *  存 flomo游标.json（跟脚本同目录）：
 *    { "latest_updated_at": "2026-11-06 13:20:00", "synced": ["slug1","slug2"] }
 *  ★ 每次只拉「比游标新的」+ 「最近 N 条」做兜底校对 ★
 *
 *  ★★ 用法 ★★
 *    node 同步flomo到Notion.js            实际执行
 *    node 同步flomo到Notion.js --干跑      只看会做什么
 *    node 同步flomo到Notion.js --全量      忽略游标，全量拉
 *    node 同步flomo到Notion.js --仅=关键词  只同步含关键词的
 */

const fs = require("fs");
const path = require("path");
const F = require(path.join(__dirname, "flomo接口.js"));
const S = require(path.join(__dirname, "flomo签名.js"));
const W = require(path.join(__dirname, "flomo写Notion.js"));

const DRY = process.argv.includes("--干跑");
const FULL = process.argv.includes("--全量");
const ONLY = (
  process.argv.find((a) => a.startsWith("--仅=")) || ""
).split("=").slice(1).join("=").trim();

// ══════════════════════════════════════════════════
//  日志（★ 计划任务没有控制台 → 必须留痕 ★）
// ══════════════════════════════════════════════════
// ★ 日志目录在 vault 外（★ 避免 Obsidian Sync 同步噪音）★
const LOG_DIR = path.join(path.dirname(path.dirname(path.dirname(__dirname))), "同步日志");
try {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logFile = path.join(LOG_DIR, "flomo-" + stamp + ".log");
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk, ...rest) {
    try {
      fs.appendFileSync(logFile, chunk);
    } catch (e) { /* 忽略 */ }
    return origWrite(chunk, ...rest);
  };
} catch (e) { /* 忽略 */ }

const CFG_FILE = path.join(__dirname, "flomo配置.json");
const TXT_FILE = path.join(__dirname, "flomo凭证.txt");   // ★ 记事本可编辑（用户偏好）★
const CURSOR_FILE = path.join(__dirname, "flomo游标.json");

// ══════════════════════════════════════════════════
//  配置（★ 优先读 txt（记事本能开），再读 json ★）
// ══════════════════════════════════════════════════
function readCfg() {
  const cfg = { apiKey: "", email: "", password: "", mcpToken: "" };

  // ① txt（key=value 形式）
  if (fs.existsSync(TXT_FILE)) {
    try {
      const txt = fs.readFileSync(TXT_FILE, "utf8");
      txt.split(/\r?\n/).forEach((line) => {
        const m = /^\s*([A-Za-z_]+)\s*=\s*(.*)$/.exec(line);
        if (!m) return;
        const k = m[1].toLowerCase();
        const v = m[2].trim();
        if (k === "apikey") cfg.apiKey = v;
        else if (k === "email") cfg.email = v;
        else if (k === "password") cfg.password = v;
        else if (k === "mcptoken") cfg.mcpToken = v;
      });
    } catch (e) { /* 忽略 */ }
  }

  // ② json（补充/覆盖）
  if (fs.existsSync(CFG_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
      if (j.apiKey) cfg.apiKey = String(j.apiKey).trim();
      if (j.email) cfg.email = String(j.email).trim();
      if (j.password) cfg.password = String(j.password).trim();
      if (j.mcpToken) cfg.mcpToken = String(j.mcpToken).trim();
    } catch (e) { /* 忽略 */ }
  }

  // ③ 环境变量（云端用）
  if (process.env.FLOMO_API_KEY) cfg.apiKey = String(process.env.FLOMO_API_KEY).trim();
  if (process.env.FLOMO_EMAIL) cfg.email = String(process.env.FLOMO_EMAIL).trim();
  if (process.env.FLOMO_PASSWORD) cfg.password = String(process.env.FLOMO_PASSWORD).trim();
  if (process.env.FLOMO_MCP_TOKEN) cfg.mcpToken = String(process.env.FLOMO_MCP_TOKEN).trim();

  return cfg;
}
function readCursor() {
  if (!fs.existsSync(CURSOR_FILE)) return { latest_updated_at: "0", synced: [] };
  try {
    return JSON.parse(fs.readFileSync(CURSOR_FILE, "utf8"));
  } catch (e) {
    return { latest_updated_at: "0", synced: [] };
  }
}
function writeCursor(c) {
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(c, null, 2), "utf8");
}

// ══════════════════════════════════════════════════
//  取数：方式 ① 官方 API Key
// ══════════════════════════════════════════════════
async function pullViaOfficialApi(cfg) {
  const key = String(cfg.apiKey || "").trim();
  if (!key) return null;
  const url = "https://flomoapp.com/api/memo/?api_key=" + encodeURIComponent(key);
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  if (!j) throw new Error("官方 API 返回的不是 JSON（HTTP " + r.status + "）→ api_key 可能无效");
  // flomo 官方返回 { code, message, data: [...] } 或直接数组
  const list = Array.isArray(j) ? j : (j.data || j.memos || []);
  if (!list.length && j.code !== undefined && j.code !== 0) {
    throw new Error("官方 API：" + j.code + " " + (j.message || ""));
  }
  return list;
}

// ══════════════════════════════════════════════════
//  取数：方式 ③ 邮箱登录换 token
// ══════════════════════════════════════════════════
async function loginByEmail(cfg) {
  const email = String(cfg.email || "").trim();
  const password = String(cfg.password || "");
  if (!email || !password) return null;
  const body = { email, password, device: "web" };
  const r = await fetch("https://flomoapp.com/api/v1/user/login_by_email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (e) { /* 非 JSON */ }
  if (!j || j.code !== 0) {
    throw new Error("邮箱登录失败：" + ((j && j.message) || ("HTTP " + r.status)));
  }
  const tok = j.data && (j.data.access_token || j.data.token);
  if (!tok) throw new Error("邮箱登录没拿到 access_token");
  return tok;
}

// ══════════════════════════════════════════════════
//  取数：方式 ②/③ 内部接口
// ══════════════════════════════════════════════════
async function pullViaInternal(token, latestUpdatedAt) {
  const res = await F.call(
    "GET",
    "/memo/updated/",
    {
      limit: 50,
      latest_updated_at: latestUpdatedAt || 0,
      latest_slug: "",
      tz: "-480",
    },
    { token }
  );
  if (!res.json) throw new Error("响应不是 JSON：" + res.text.slice(0, 150));
  if (res.json.code !== 0) {
    throw new Error("接口返回：" + res.json.code + " " + (res.json.message || ""));
  }
  return res.json.data || [];
}

/** 一次性拿全量（内部接口） */
async function pullAllInternal(token) {
  const out = [];
  let cur = null;
  for (let round = 0; round < 60; round++) {
    const batch = await pullViaInternal(token, cur);
    if (!batch.length) break;
    out.push.apply(out, batch);
    const last = batch[batch.length - 1];
    const next = last.updated_at || "";
    if (!next || next === cur) break;
    cur = next;
    if (batch.length < 50) break;
  }
  return out;
}

// ══════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════
/** 本地算标题（无 Notion 权限时也能报告）*/
function makeTitleLocal(memo) {
  const text = W.htmlToText(memo.content);
  return W.makeTitle(text, memo.slug);
}

async function main() {
  console.log("═══ flomo → Notion「Flomo知识库」同步 ═══\n");
  const cfg = readCfg();
  const cursor = readCursor();

  // ── ① 定取数方式（★ 优先级：MCP Token > 官方 API Key > 邮箱登录 > 本机客户端）──
  let memos = null;
  let source = "";
  let mcpCli = null;                        // ★ 留引用 → 后面用来做「删除探测」★
  let MCP = null;                           // ★ 模块引用（要用 extractMemos）★
  const localCred = F.readCredentials();

  // ① MCP（★ 官方长期方案 · 跨电脑 · 不怕改版 ★）
  if (cfg.mcpToken) {
    try {
      MCP = require(path.join(__dirname, "flomoMCP.js"));
      const cli = new MCP.FlomoMCP(cfg.mcpToken);
      await cli.init();
      memos = (await cli.readMemos({ limit: 50 })).map((m) => W.adaptMemo(m));
      source = "flomo 官方 MCP（个人 Token）";
      mcpCli = cli;
    } catch (e) {
      console.log("  ⚠ MCP 取数失败：" + String(e.message).slice(0, 140));
      console.log("    → 检查 Token 是否完整（Bearer 后有空格）、是否被注销");
    }
  }

  if (!memos && cfg.apiKey) {
    try {
      memos = await pullViaOfficialApi(cfg);
      source = "官方 API Key";
    } catch (e) {
      console.log("  ⚠ 官方 API 失败：" + e.message);
    }
  }
  if (!memos) {
    // 内部接口：优先用邮箱登录换 token（跨电脑），否则用本机客户端
    let token = null;
    if (cfg.email && cfg.password) {
      try {
        token = await loginByEmail(cfg);
        source = "内部接口 + 邮箱登录";
        console.log("  ✔ 邮箱登录成功");
      } catch (e) {
        console.log("  ⚠ 邮箱登录失败：" + e.message);
      }
    }
    if (!token && localCred) {
      token = localCred.accessToken;
      source = "内部接口 + 本机客户端登录态（★ 换电脑需重登 ★）";
    }
    if (!token) {
      console.log("  ✘ 没有可用的 flomo 凭证。");
      console.log("    在 " + TXT_FILE + " 里填一种：");
      console.log("    ① mcpToken=  ★ 官方 MCP 个人 Token（推荐，跨电脑）");
      console.log("    ② apiKey=    官方 API Key");
      console.log("    ③ email + password  邮箱登录（跨电脑）");
      console.log("    ④ 或打开一次本机 flomo 桌面客户端（兜底）");
      return;
    }
    memos = FULL || !cursor.latest_updated_at
      ? await pullAllInternal(token)
      : await pullViaInternal(token, cursor.latest_updated_at);
    // ★ 补一轮「最近的」用于校对（防止游标漏了删除）★
    if (!FULL) {
      const recent = await pullViaInternal(token, 0);
      const seen = new Set(memos.map((m) => m.slug));
      recent.forEach((m) => { if (m.slug && !seen.has(m.slug)) memos.push(m); });
    }
  }

  console.log("  取数方式：" + source);
  console.log("  拉到 " + memos.length + " 条 memo");
  if (!memos.length) {
    console.log("  · 没有新内容");
    return;
  }

  // ── ② 过滤 ──
  let list = memos;
  if (ONLY) {
    list = list.filter((m) =>
      String(m.content || "").indexOf(ONLY) >= 0 ||
      String(m.slug || "").indexOf(ONLY) >= 0
    );
    console.log("  --仅=" + ONLY + " → 保留 " + list.length + " 条");
  }

  // ── ③ 写 Notion ──
  const token = W.loadToken();
  const notes = new W.NoteStore();
  const tags = new W.TagStore();
  // ★ 读库失败（没分享给 integration）→ 警告但继续（干跑尤其需要）★
  let canWrite = true;
  try {
    const nNotes = await notes.load(token);
    const nTags = await tags.load(token);
    console.log("  Notion 现有：笔记 " + nNotes + " 条 ｜ 标签 " + nTags + " 个\n");
  } catch (e) {
    canWrite = false;
    console.log("  ⚠ 读不到 Notion「Flomo知识库」：" + String(e.message).slice(0, 110));
    console.log("    → 需要把该库分享给你的 Notion integration（Obsidian Notes）");
    console.log("    → 分享前只能干跑；同步会跳过写入\n");
  }

  let nNew = 0, nUpd = 0, nArc = 0, nSkip = 0;
  const synced = new Set(Array.isArray(cursor.synced) ? cursor.synced : []);
  // ★★★ 2026-11-07：★ 三方合并基线（★ 支撑「Notion 端改动不被覆盖」★★★
  const BASE = require(path.join(__dirname, "flomo基线.js"));
  const baseline = BASE.readBaseline();
  let nKept = 0, nConflict = 0;

  for (const memo of list) {
    const slug = String(memo.slug || "").trim();
    // ★ flomo 侧已删除 → Notion 归档 ★
    if (memo.deleted_at) {
      const hit = notes.find(memo);
      if (!hit) { nSkip++; continue; }
      const r = await W.archiveMemo(hit, notes, token, DRY);
      console.log("  🗑 " + r.action + " " + r.title);
      nArc++;
      continue;
    }
    if (!slug) { nSkip++; continue; }
    // ★ 没权限 → 只报告不写 ★
    if (!canWrite && !DRY) {
      console.log("  · " + makeTitleLocal(memo) + "（无写权限，跳过）");
      nSkip++;
      continue;
    }
    try {
      const r = await W.writeMemo(memo, notes, tags, { token, dry: DRY, baseline });
      console.log(
        "  " + (r.action === "新建" ? "➕" : r.action === "更新" ? "⬆" : "·") +
        " " + r.action + " " + r.title + (r.detail ? "（" + r.detail + "）" : "")
      );
      if (r.action === "新建") nNew++;
      else if (r.action === "更新") {
        nUpd++;
        if (r.detail && r.detail.indexOf("保留你的修改") >= 0) nKept++;
        if (r.detail && r.detail.indexOf("两边都改") >= 0) nConflict++;
      }
      else nSkip++;
      if (slug) synced.add(slug);
    } catch (e) {
      console.log("  ✘ " + slug + " → " + String(e.message).slice(0, 150));
      nSkip++;
    }
  }

  // ── ③.5 删除探测与归档（★ MCP 模式专属：flomo 删了 → Notion 自动归档）──
  //   ★ 原理：MCP 的 memo_search 搜不到已删除的 memo → 需要主动探测 ★
  //   ★ 范围：只探测「游标里记录过、但本轮没拉到」的 → 不会漏、也不会误伤 ★
  //   ★ 判定：memo_batch_get 返回空 = 确认已删 → Notion 状态改「已归档」★
  if (mcpCli && !ONLY) {
    const fetched = new Set();
    list.forEach((m) => { if (m.slug) fetched.add(String(m.slug).trim()); });
    // ★ 候选 = 游标里同步过、但本轮没出现 ★
    const candidates = [...synced].filter((s) => s && !fetched.has(s));
    if (candidates.length) {
      console.log("");
      console.log("  ── 删除探测（" + candidates.length + " 条待查）──");
      try {
        const probe = await mcpCli.probeAlive(candidates);
        if (probe.unknown.length) {
          console.log("    ⚠ " + probe.unknown.length + " 条无法判定（网络/限流）→ 跳过，不误判");
        }
        for (const slug of probe.deleted) {
          // ★ 在 Notion 上找到这条（按 slug）★
          const hit = notes.bySlug.get(slug);
          if (!hit) { nSkip++; continue; }
          if (hit.status === "已归档") { nSkip++; continue; }     // ★ 已归档过 → 幂等 ★
          const r = await W.archiveMemo(hit, notes, token, DRY);
          console.log("  🗑 " + r.action + " " + r.title + "（flomo 侧已删除）");
          nArc++;
        }
        if (probe.alive.length) {
          console.log("    ✔ " + probe.alive.length + " 条仍在 flomo（只是本轮没拉到）");
        }
      } catch (e) {
        console.log("    ⚠ 删除探测失败：" + String(e.message).slice(0, 100));
      }
    }
  }

  // ── ④ 更新游标 ──
  if (!DRY && !ONLY && !FULL) {
    const times = memos.map((m) => m.updated_at || "").filter(Boolean).sort();
    const latest = times[times.length - 1] || cursor.latest_updated_at;
    writeCursor({ latest_updated_at: latest, synced: [...synced].slice(-500) });
    console.log("");
    console.log("  ✔ 游标已更新 → " + latest);
  }

  // ★★★ 2026-11-07：★ 保存三方合并基线 ★★★
  if (!DRY) {
    BASE.saveBaseline(baseline);
    console.log("  ✔ 基线已保存 → " + BASE.BASELINE_FILE + "（" + Object.keys(baseline).length + " 条）");
  }

  console.log("");
  console.log("── 汇总 ──");
  console.log("  新建 " + nNew + " ｜ 更新 " + nUpd + " ｜ 归档 " + nArc + " ｜ 跳过 " + nSkip);
  if (nKept) console.log("  ★ 保留了你的修改 " + nKept + " 条（Notion 端改动没被覆盖）");
  if (nConflict) console.log("  ⚠ 两边都改了 " + nConflict + " 条（以 flomo 为准）");
  if (DRY) console.log("  （干跑，未写入）");
}

// ★★★ 2026-11-07：★ 允许被别的脚本引用（★ 云端入口直接调它 → 只有一份逻辑 ★）★★★
if (require.main === module) {
  main().catch((e) => {
    console.log("  ✘ 出错：" + String(e.message).slice(0, 250));
  });
}

module.exports = { main };
