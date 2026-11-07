/**
 * ══════════════════════════════════════════════════════════════
 *  flomo 同步基线（★ 2026-11-07 新增 · 支撑双向同步 ★）
 * ══════════════════════════════════════════════════════════════
 *
 *  ★★★ 问题 ★★★
 *   现象：你在 Notion 上改了 flomo 笔记的标题 / 摘要 / 标签
 *        → 下一次同步 → 你的修改被【覆盖】掉
 *   原因：flomo 同步是【单向】的 —— writeMemo() 无条件全量覆盖所有属性
 *        → 它不知道「你改过」→ 只能以 flomo 为准
 *
 *  ★★★ 解法：三方合并 ★★★
 *   每次同步后，把「当时的 Notion 值」和「当时的 flomo 值」记进基线。
 *   下次同步时三方对比：
 *     · Notion 改了 + flomo 没改 → ★ 保留你的修改 ★（Notion 为准）
 *     · flomo 改了 + Notion 没改 → 用 flomo 的（正常同步）
 *     · 两边都改了           → 以 flomo 为准（★ flomo 是源头 ★），
 *                               但【记录一条提示】让你知道有冲突
 *     · 两边都没改           → 不动（避免无谓写入）
 *
 *  ★ 基线文件位置：D:/Obsidian/同步状态/flomo基线.json（★ vault 外 ★）
 */

const fs = require("fs");
const path = require("path");

const SYNC = __dirname;

// ★★★ 基线文件位置（★ 两个地方 ★）★★★ ★
//   ① 本机：D:/Obsidian/同步状态/flomo基线.json（★ vault 外 ★）
//   ② 云端：仓库内的 flomo-baseline.json（★ GitHub Actions 要能读到 ★）
//   → 用环境变量 FLOMO_BASELINE_FILE 覆盖（云端入口会设）
const BASELINE_FILE = process.env.FLOMO_BASELINE_FILE
  || path.join(
    path.dirname(path.dirname(path.dirname(__dirname))),
    "同步状态", "flomo基线.json"
  );
const STATE_DIR = path.dirname(BASELINE_FILE);

/** 读基线 */
function readBaseline() {
  try {
    if (!fs.existsSync(BASELINE_FILE)) return {};
    return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

/** 写基线 */
function saveBaseline(b) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(b, null, 0), "utf8");
  } catch (e) {
    console.error("  ⚠ 基线写入失败：" + String(e.message).slice(0, 80));
  }
}

/** 取某条的基线 */
function getEntry(baseline, slug) {
  return (baseline[slug] || {});
}

/** 记某条的基线 */
function setEntry(baseline, slug, notionVals, flomoVals) {
  if (!slug) return;
  baseline[slug] = {
    N: notionVals || {},     // ★ 上次同步后的 Notion 值 ★
    F: flomoVals || {},      // ★ 上次同步时的 flomo 值 ★
    t: Date.now(),
  };
}

/**
 * ★★ 三方合并判定（★ 核心 ★）★★
 *
 * @param {Object} base     基线条目 {N, F}
 * @param {Object} now      本轮 Notion 现值
 * @param {Object} flomoNow 本轮 flomo 现值
 * @param {Array}  fields   要比较的字段名列表
 * @returns {{use: Object, kept: Array, conflict: Array}}
 *   use     → 最终该写入 Notion 的值
 *   kept    → 保留用户修改的字段名
 *   conflict → 两边都改了的字段名
 */
function merge3(base, now, flomoNow, fields) {
  const use = {};
  const kept = [];
  const conflict = [];
  const bn = (base && base.N) || {};
  const bf = (base && base.F) || {};

  for (const f of fields) {
    const nv = now[f];
    const fv = flomoNow[f];
    const bv = bn[f];        // 上次同步后的 Notion 值
    const bfv = bf[f];       // 上次同步时的 flomo 值

    const notionChanged = !eq(nv, bv);
    const flomoChanged = !eq(fv, bfv);

    if (!base || !bv && !bfv) {
      // ★ 没有基线（首次）→ 以 flomo 为准 ★
      use[f] = fv;
      continue;
    }
    if (notionChanged && !flomoChanged) {
      // ★★ 只有 Notion 改了 → 【保留用户的修改】★★
      use[f] = nv;
      kept.push(f);
      continue;
    }
    if (!notionChanged && flomoChanged) {
      use[f] = fv;           // ★ flomo 改了 → 正常同步 ★
      continue;
    }
    if (notionChanged && flomoChanged) {
      // ★★ 两边都改了 → flomo 为准（源头）+ 记冲突 ★★
      use[f] = fv;
      conflict.push(f);
      continue;
    }
    // 两边都没改 → 保持 Notion 现值（不写）
    use[f] = nv;
  }
  return { use, kept, conflict };
}

function eq(a, b) {
  if (a === b) return true;
  if (a === undefined || a === null) return (b === undefined || b === null || b === "");
  if (b === undefined || b === null) return a === "";
  return String(a) === String(b);
}

// ══════════════════════════════════════════════════
//  ★ 基线存到 Notion（★ 云端用这个代替 git 提交 ★）
// ══════════════════════════════════════════════════
//  ★ 为什么不用 git 提交基线：
//   · GitHub Contents API 提交 .github/ 下的文件会被拒（404）
//   · 而且这台机器的 git 端点时好时坏（CONNECT tunnel 502）
//  ★ → 改成把基线存在 Notion 的一个特殊页面里 → 下次从 Notion 读回来 ★
//  ★ 好处：不依赖 git、跨机器天然一致 ★

const BASELINE_PAGE_TITLE = "🔒 flomo同步基线（勿删）";

/**
 * ★ 基线存进 Notion（★ 建成/更新一个特殊页面 ★）
 * @param {Object} baseline  基线对象
 * @param {Object} api        { api(path, method, body, token) }
 * @param {String} dsId       笔记库的数据源 id
 * @param {String} token
 */
async function saveBaselineToNotion(baseline, api, dsId, token) {
  const payload = JSON.stringify(baseline);
  // ★★★ Notion rich_text 单段上限 2000 字符 → 必须切片 ★★★
  const CHUNK = 1800;
  const chunks = [];
  for (let i = 0; i < payload.length; i += CHUNK) {
    chunks.push(payload.slice(i, i + CHUNK));
  }
  // ① 找已有页面
  const q = await api("/data_sources/" + dsId + "/query", "POST", { page_size: 100 }, token);
  let pageId = null;
  for (const p of (q.results || [])) {
    const pr = p.properties || {};
    let title = "";
    for (const k of Object.keys(pr)) {
      if (pr[k].type === "title") title = (pr[k].title || []).map((x) => x.plain_text).join("");
    }
    if (title === BASELINE_PAGE_TITLE) { pageId = p.id; break; }
  }
  // ② 写正文（★ 每块一段 code ★）
  const blocks = chunks.map((c) => ({
    object: "block",
    type: "code",
    code: { rich_text: [{ type: "text", text: { content: c } }], language: "json" },
  }));
  if (pageId) {
    // 清掉旧块
    const kids = await api("/blocks/" + pageId + "/children?page_size=100", "GET", null, token);
    for (const b of (kids.results || [])) {
      await api("/blocks/" + b.id, "PATCH", { archived: true }, token);
    }
    for (let i = 0; i < blocks.length; i += 80) {
      await api("/blocks/" + pageId + "/children", "PATCH", { children: blocks.slice(i, i + 80) }, token);
    }
  } else {
    await api("/pages", "POST", {
      parent: { type: "data_source_id", data_source_id: dsId },
      properties: {
        "标题": { title: [{ type: "text", text: { content: BASELINE_PAGE_TITLE } }] },
      },
      children: blocks.slice(0, 80),
    }, token);
    // ★ 超过 80 块要分批追加 ★
    for (let i = 80; i < blocks.length; i += 80) {
      await api("/blocks/" + pageId + "/children", "PATCH", { children: blocks.slice(i, i + 80) }, token);
    }
  }
  return true;
}

/**
 * ★ 从 Notion 读回基线 ★
 */
async function loadBaselineFromNotion(api, dsId, token) {
  try {
    const q = await api("/data_sources/" + dsId + "/query", "POST", { page_size: 100 }, token);
    for (const p of (q.results || [])) {
      const pr = p.properties || {};
      let title = "";
      for (const k of Object.keys(pr)) {
        if (pr[k].type === "title") title = (pr[k].title || []).map((x) => x.plain_text).join("");
      }
      if (title !== BASELINE_PAGE_TITLE) continue;
      const kids = await api("/blocks/" + p.id + "/children?page_size=100", "GET", null, token);
      // ★ 基线可能分成多个 code 块（★ Notion rich_text 单段上限 2000 ★）→ 拼接 ★
      const parts = [];
      for (const b of (kids.results || [])) {
        if (b.type !== "code") continue;
        parts.push(((b.code.rich_text || []).map((x) => x.plain_text || (x.text && x.text.content) || "")).join(""));
      }
      if (!parts.length) continue;
      const txt = parts.join("");
      try { return JSON.parse(txt); } catch (e) { /* 继续找 */ }
    }
  } catch (e) {
    // ★ 读不到就用文件版的 ★
  }
  return null;
}

module.exports = {
  BASELINE_FILE, STATE_DIR,
  readBaseline, saveBaseline, getEntry, setEntry, merge3, eq,
  saveBaselineToNotion, loadBaselineFromNotion, BASELINE_PAGE_TITLE,
};
