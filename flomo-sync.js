/**
 * ★★★ flomo → Notion「Flomo知识库」云端同步入口 ★★★ ★
 *
 *  ★★ 为什么要有这个（★ 回答"连接好为什么还要手动"）★★
 *  ★ flomo 官方【没有"主动推送到 Notion"的服务】（只有 API）
 *  ★ → 必须有个"拉取器"在某个地方跑 ★
 *  ★   · 那个卖插件的方案 → 把拉取器放在【浏览器插件】里（浏览器开着才同步）
 *  ★   · ★ 本方案 → 把拉取器放在【GitHub Actions 云端】→ ★ 电脑关机也跑 ★★
 *  ★ ★ Readest 之所以"自动"，是因为 Readest 客户端自己会写 Notion（不一样的机制）★
 *
 *  ★★ 云端跑需要两个 secret ★★
 *  ★ FLOMO_API_KEY  ← flomo「设置 → API」生成（★ 官方 API，跨电脑 ★）
 *  ★ NOTION_TOKEN   ← Notion integration token（★ 需有「Flomo知识库」权限 ★）
 *
 *  ★★ 增量策略 ★★
 *  ★ 官方 API 一次只能拿最近 N 条 → 用【游标文件】记住进度 ★
 *  ★ 游标存 flomo-sync.cursor.json → 每次跑完提交回仓库 ★
 *  ★ ★ 若 flomo 官方 API 支持翻页，会优先翻页拉全量 ★
 *
 *  ★★ 用法 ★★
 *  ★   node flomo-sync.js            实际同步（云端用这个）
 *  ★   node flomo-sync.js --干跑      只看会做什么
 *  ★   node flomo-sync.js --全量      忽略游标，全量重拉
 */

const fs = require("fs");
const path = require("path");
const W = require("./flomo写Notion.js");

const DRY = process.argv.includes("--干跑");
const FULL = process.argv.includes("--全量");
const CURSOR_FILE = path.join(__dirname, "flomo-sync.cursor.json");

// ══════════════════════════════════════════════════
//  官方 API 读取
// ══════════════════════════════════════════════════
function apiKey() {
  return String(
    process.env.FLOMO_API_KEY || process.env.FLOMO_KEY || ""
  ).trim();
}

/**
 * 调官方 flomo API 读 memo
 * @param {string} key
 * @param {Object} extra 额外参数（page 等）
 */
async function pullOfficial(key, extra) {
  const url = "https://flomoapp.com/api/memo/?api_key=" + encodeURIComponent(key);
  let list = [];
  let page = 1;
  // ★ 最多翻 50 页（防死循环）★
  for (; page <= 50; page++) {
    const q = new URLSearchParams(Object.assign({ api_key: key }, extra || {}));
    q.set("page", String(page));
    const r = await fetch(url + "?" + q.toString(), {
      headers: { Accept: "application/json" },
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    if (!j) {
      throw new Error(
        "官方 API 返回的不是 JSON（HTTP " + r.status + "）→ api_key 可能无效，或该接口需 PRO"
      );
    }
    const arr = Array.isArray(j) ? j : (j.data || j.memos || []);
    if (!arr.length) break;
    list = list.concat(arr);
    // ★ 返回数量少于一页 → 说明到底了 ★
    if (arr.length < 50) break;
    await new Promise((r2) => setTimeout(r2, 300));
  }
  return list;
}

// ══════════════════════════════════════════════════
//  游标
// ══════════════════════════════════════════════════
function readCursor() {
  if (!fs.existsSync(CURSOR_FILE)) return { seen: {}, lastRun: "" };
  try {
    return JSON.parse(fs.readFileSync(CURSOR_FILE, "utf8"));
  } catch (e) {
    return { seen: {}, lastRun: "" };
  }
}
function writeCursor(c) {
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(c, null, 2), "utf8");
}

// ══════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════
async function main() {
  console.log("═══ flomo → Notion「Flomo知识库」云端同步 ═══\n");

  const key = apiKey();
  if (!key) {
    console.log("  ✘ 没有 FLOMO_API_KEY（GitHub secret）");
    console.log("    → flomo 网页版 → 设置 → API → 生成 API Key");
    process.exitCode = 1;
    return;
  }
  const notionToken = process.env.NOTION_TOKEN || "";
  if (!notionToken) {
    console.log("  ✘ 没有 NOTION_TOKEN（GitHub secret）");
    process.exitCode = 1;
    return;
  }

  // ── ① 取数 ──
  let memos;
  try {
    memos = await pullOfficial(key);
  } catch (e) {
    console.log("  ✘ 官方 API 读取失败：" + e.message);
    process.exitCode = 1;
    return;
  }
  console.log("  官方 API 拉到 " + memos.length + " 条 memo");
  if (!memos.length) {
    console.log("  · 没有内容");
    return;
  }

  // ── ② 游标过滤（只处理没同步过的 + 最近更新的）──
  const cursor = readCursor();
  const seen = cursor.seen || {};
  let todo = memos;
  if (!FULL) {
    // ★ 已同步过但 updated_at 变了 → 也要更新 ★
    todo = memos.filter((m) => {
      const slug = String(m.slug || "");
      if (!slug) return false;
      const prev = seen[slug];
      const upd = String(m.updated_at || "");
      return !prev || prev !== upd;
    });
  }
  console.log(
    "  待处理 " + todo.length + " 条" +
    (FULL ? "（全量模式）" : "（新增或已修改）")
  );

  // ── ③ 写 Notion ──
  const notes = new W.NoteStore();
  const tags = new W.TagStore();
  let canWrite = true;
  try {
    const n = await notes.load(notionToken);
    const t = await tags.load(notionToken);
    console.log("  Notion 现有：笔记 " + n + " 条 ｜ 标签 " + t + " 个\n");
  } catch (e) {
    canWrite = false;
    console.log("  ⚠ 读不到「Flomo知识库」：" + String(e.message).slice(0, 130));
    console.log("    → 确认 secret NOTION_TOKEN 对应的 integration 已分享「Flomo知识库」\n");
  }

  let nNew = 0, nUpd = 0, nArc = 0, nSkip = 0;

  for (const memo of todo) {
    const slug = String(memo.slug || "").trim();
    if (!slug) { nSkip++; continue; }
    try {
      if (memo.deleted_at) {
        const hit = notes.find(memo);
        if (hit) {
          const r = await W.archiveMemo(hit, notes, notionToken, DRY);
          console.log("  🗑 " + r.action + " " + r.title);
          nArc++;
        } else nSkip++;
      } else {
        const r = await W.writeMemo(memo, notes, tags, {
          token: notionToken,
          dry: DRY,
        });
        console.log(
          "  " + (r.action === "新建" ? "➕" : "⬆") + " " + r.action + " " + r.title
        );
        if (r.action === "新建") nNew++;
        else if (r.action === "更新") nUpd++;
        else nSkip++;
      }
      // ★ 记游标 ★
      seen[slug] = String(memo.updated_at || "");
    } catch (e) {
      console.log("  ✘ " + slug + " → " + String(e.message).slice(0, 140));
      nSkip++;
    }
  }

  // ── ④ 存游标 ──
  if (!DRY) {
    writeCursor({ seen, lastRun: new Date().toISOString() });
    console.log("");
    console.log("  ✔ 游标已写入 " + path.basename(CURSOR_FILE));
  }

  console.log("");
  console.log("── 汇总 ──");
  console.log("  新建 " + nNew + " ｜ 更新 " + nUpd + " ｜ 归档 " + nArc + " ｜ 跳过 " + nSkip);
  if (!canWrite) console.log("  ★ Notion 权限不足 → 实际没写入");
  if (DRY) console.log("  （干跑）");
}

main().catch((e) => {
  console.log("  ✘ 出错：" + String(e.message).slice(0, 250));
  process.exitCode = 1;
});
