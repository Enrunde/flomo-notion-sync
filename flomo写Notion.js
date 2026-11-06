/**
 * ★★★ flomo → Notion「Flomo知识库 / 笔记」写入器 ★★★ ★
 *
 *  ★★ 目标库（★ 你下载的模板，已用 Notion MCP 确认结构）★★
 *  页面「Flomo知识库」= 64692bf9-b4d9-83b4-b924-019eb5547b64
 *    ├─ 数据库「笔记」 dsId = c6192bf9-b4d9-83b6-8da0-07f518321a0e   ← 主表
 *    └─ 数据库「标签」 dsId = bef92bf9-b4d9-82fb-abad-0780e0dec701
 *
 *  ★★ 「笔记」库的属性（★ 全部按实际 schema 写，不猜）★★
 *    标题        title      → memo 正文首行（去掉 HTML）
 *    Summary     text       → 正文摘要（去标签后的前 N 字）
 *    slug        text       → flomo 的 slug（★ 唯一认亲键 ★）
 *    Flomo链接   url        → https://app.flomoapp.com/memo/<slug>
 *    来源        select     → ios / web / wechat / 微信
 *    状态        status     → 置顶 / 未知(默认) / 已归档
 *    标签        relation   → 「标签」库里的页面
 *    笔记创建时间 date
 *    笔记修改时间 date
 *    链接数量    number
 *    ★ 创建时间/修改时间 = Notion 自动字段，不要写 ★
 *
 *  ★★ 幂等策略 ★★
 *  ① 认亲：slug（唯一）→ 查已有页面
 *  ② 已存在 → 更新（标题/Summary/日期/来源/状态/正文）
 *  ③ 不存在 → 新建
 *  ④ flomo 侧删除的（deleted_at）→ 状态改为「已归档」
 *  ⑤ 标签库：按标题找，找不到就建（relation 必须指向真实页面）
 *
 *  ★★ 正文怎么写 ★★
 *  flomo 的 content 是 HTML（<p>…</p>）→ 转成 markdown 块写进页面正文
 *  ★ 文件（图片/录音）→ flomo 的 OSS 链接带签名会过期 → ★ 上传到 Notion 需重新拉取
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const SYNC = __dirname;
const TOKEN_FILE = path.join(os.homedir(), ".config", "notion", "token");

// ══════════════════════════════════════════════════
//  常量
// ══════════════════════════════════════════════════
const DS_NOTES = "c6192bf9-b4d9-83b6-8da0-07f518321a0e";   // 「笔记」
const DS_TAGS = "bef92bf9-b4d9-82fb-abad-0780e0dec701";    // 「标签」
const FLOMO_PAGE = "64692bf9-b4d9-83b4-b924-019eb5547b64"; // 「Flomo知识库」页面

const NOTION_VERSION = "2025-09-03";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadToken() {
  // ★ 云端跑时用环境变量（GitHub Actions secret）★★
  // ★ 本机跑时读本机文件（~/.config/notion/token）★★
  const env = process.env.NOTION_TOKEN || process.env.NOTION_API_TOKEN || "";
  if (env) return String(env).trim();
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}

async function api(p, method, body, token) {
  const tok = token || loadToken();
  for (let a = 0; a < 7; a++) {
    const r = await fetch("https://api.notion.com/v1" + p, {
      method: method || "GET",
      headers: {
        Authorization: "Bearer " + tok,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    if (r.status === 429) {
      const wait = Number((r.headers.get("retry-after") || 3)) * 1000;
      await sleep(wait);
      continue;
    }
    let j = null;
    try { j = JSON.parse(t); } catch (e) { /* 非 JSON */ }
    if (!r.ok) {
      const msg = (j && j.message) || t.slice(0, 160);
      throw new Error("HTTP " + r.status + " → " + msg);
    }
    return j;
  }
  throw new Error("重试耗尽：" + p);
}

// ══════════════════════════════════════════════════
//  HTML → 纯文本 / markdown
// ══════════════════════════════════════════════════
function htmlToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 抽正文里的 #标签 */
function extractTags(text) {
  const out = [];
  const re = /(^|\s)#([^\s#，。！？、；：,.;!?:"'()（）【】\[\]]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = m[2].trim();
    if (t && t.length <= 40) out.push(t);
  }
  return [...new Set(out)];
}

/** 去标签后的摘要（★ 也要去列表壳 ★）*/
function makeSummary(text, n) {
  const clean = String(text || "")
    .replace(/(^|\s)#[^\s#，。！？、；：,.;!?:"'()（）【】\[\]]+/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > (n || 100) ? clean.slice(0, n || 100) + "…" : clean;
}

/** 一行里是否只有 flomo 标签（★ `#标签` 无空格 = 标签；`# 标题` 有空格 = markdown 标题 ★）*/
function isOnlyTags(line) {
  const t = stripShellKeepHash(line).trim();
  if (!t) return true;
  // ★ 去掉所有「#xxx」（无空格的）后若为空 → 纯标签行 ★
  const rest = t.replace(/(^|\s)#[^\s#，。！？、；：,.;!?:"'()（）【】\[\]]+/g, "$1").trim();
  return !rest;
}

/** 剥列表/引用壳，但【保留 #】（因为要区分标签与标题）*/
function stripShellKeepHash(raw) {
  return String(raw || "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .replace(/^\s*>\s*/, "")
    .trim();
}

/** 去掉 markdown 列表符号 / 引用符号 / 标题井号（★ 标题与摘要不要带这些壳 ★）*/
function stripShell(raw) {
  return stripShellKeepHash(raw)
    .replace(/^\s*#{1,6}\s+/, "")        // ★★ 只剥「# + 空格」= markdown 标题；不动 flomo 标签 ★★
    .trim();
}

/** 第一行当标题（★ 跳过纯标签行 → 找第一行有实际内容的 ★）*/
function makeTitle(text, fallback, memo) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const raw of lines) {
    // ★ ① 纯标签行 → 跳过 ★
    if (isOnlyTags(raw)) continue;
    // ★ ② 剥壳 + 去标签 → 这行才是标题 ★
    const t = stripShell(raw)
      .replace(/(^|\s)#[^\s#，。！？、；：,.;!?:"'()（）【】\[\]]+/g, "$1")
      .trim();
    if (t) {
      return t.length > 120 ? t.slice(0, 120) + "…" : t;
    }
  }
  // ★ 正文空但有附件（录音/图片）→ 用附件名 ★
  const files = (memo && memo.files) || [];
  if (files.length) {
    const f = files[0];
    const kind = f.type === "recorded" ? "🎙 录音" : f.type === "image" ? "🖼 图片" : "📎 附件";
    const nm = String(f.name || "").replace(/\.[a-z0-9]+$/i, "");
    return (kind + (nm ? " " + nm.slice(0, 60) : "")).slice(0, 120);
  }
  return fallback || "未命名";
}

/** "2026-11-06 00:20:55"（★ flomo 是北京时间 ★）→ ISO（★ 按北京时间存，Notion 里显示的就是你记的那一刻 ★）*/
function toISO(s) {
  if (!s) return "";
  const str = String(s).trim();
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str);
  if (!m) {
    const d = /(\d{4})-(\d{2})-(\d{2})/.exec(str);
    if (d) return d[1] + "-" + d[2] + "-" + d[3];
    return "";
  }
  // ★★★ 关键：flomo 的时间是北京时间 ★★★
  //   ★ 直接把它当 UTC 存 → Notion 显示 03:43（= 你记录的北京时间）✔
  //   ★ 若转成真 UTC → 会变成 19:43（差 8 小时）✘ ★
  return (
    m[1] + "-" + m[2] + "-" + m[3] + "T" +
    m[4] + ":" + m[5] + ":" + m[6] + ".000Z"
  );
}

// ══════════════════════════════════════════════════
//  标签库（relation 目标）
// ══════════════════════════════════════════════════
class TagStore {
  constructor() {
    this.byTitle = new Map();   // 标题 → page
    this.dirty = false;
  }
  async load(token) {
    let cur = null;
    do {
      const q = await api(
        "/data_sources/" + DS_TAGS + "/query" + (cur ? "?start_cursor=" + cur : ""),
        "POST", cur ? {} : { page_size: 100 }, token
      );
      for (const p of q.results || []) {
        const t = (p.properties["标题"] && p.properties["标题"].title || [])
          .map((x) => x.plain_text).join("");
        if (t) this.byTitle.set(t, { id: p.id, url: p.url });
      }
      cur = q.has_more ? q.next_cursor : null;
    } while (cur);
    return this.byTitle.size;
  }
  /** 取或建一个标签页 */
  async ensure(title, token) {
    const key = String(title).trim();
    if (!key) return null;
    if (this.byTitle.has(key)) return this.byTitle.get(key);
    const p = await api("/pages", "POST", {
      parent: { type: "data_source_id", data_source_id: DS_TAGS },
      properties: { "标题": { title: [{ type: "text", text: { content: key } }] } },
    }, token);
    const rec = { id: p.id, url: p.url };
    this.byTitle.set(key, rec);
    this.dirty = true;
    return rec;
  }
}

// ══════════════════════════════════════════════════
//  笔记库
// ══════════════════════════════════════════════════
class NoteStore {
  constructor() {
    this.bySlug = new Map();
  }
  async load(token) {
    let cur = null;
    do {
      const q = await api(
        "/data_sources/" + DS_NOTES + "/query" + (cur ? "?start_cursor=" + cur : ""),
        "POST", cur ? {} : { page_size: 100 }, token
      );
      for (const p of q.results || []) {
        const slug = (p.properties["slug"] && p.properties["slug"].rich_text || [])
          .map((x) => x.plain_text).join("").trim();
        const title = (p.properties["标题"] && p.properties["标题"].title || [])
          .map((x) => x.plain_text).join("").trim();
        if (slug) this.bySlug.set(slug, { id: p.id, url: p.url, title, archived: p.archived });
        else if (title) this.bySlug.set("#title:" + title, { id: p.id, url: p.url, title, archived: p.archived });
      }
      cur = q.has_more ? q.next_cursor : null;
    } while (cur);
    return this.bySlug.size;
  }
  find(memo) {
    const slug = String(memo.slug || "").trim();
    if (slug && this.bySlug.has(slug)) return this.bySlug.get(slug);
    const text = htmlToText(memo.content);
    const title = makeTitle(text, memo.slug, memo);
    if (this.bySlug.has("#title:" + title)) return this.bySlug.get("#title:" + title);
    return null;
  }
}

// ══════════════════════════════════════════════════
//  正文块构造
// ══════════════════════════════════════════════════
function buildBlocks(memo, text) {
  const blocks = [];
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line) continue;
    const rich = [{ type: "text", text: { content: line.slice(0, 1900) } }];
    // ★ 去掉行内 #标签 的井号，保留文字（标签另有属性存）★
    const clean = line.replace(/(^|\s)#[^\s#，。！？、；：,.;!?:"'()（）【】\[\]]+/g, "$1").trim();
    if (!clean) continue;
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: clean.slice(0, 1900) } }] },
    });
  }
  // ★ 文件（图片/录音）→ 作为段落列出原链接 ★
  const files = memo.files || [];
  for (const f of files) {
    if (!f.url) continue;
    const label = f.type === "recorded" ? "🎙 录音" : (f.type === "image" ? "🖼 图片" : "📎 文件");
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          { type: "text", text: { content: label + " " + (f.name || "") } },
        ],
      },
    });
    // 若是图片 → 建 image 块
    if (f.type === "image") {
      blocks.push({
        object: "block",
        type: "image",
        image: { type: "external", external: { url: f.url } },
      });
    }
  }
  return blocks;
}

// ══════════════════════════════════════════════════
//  写一条 memo
// ══════════════════════════════════════════════════
async function writeMemo(memo, notes, tags, opts) {
  const token = opts.token;
  const dry = opts.dry;
  const text = htmlToText(memo.content);
  const title = makeTitle(text, memo.slug, memo);
  const summary = makeSummary(text, 100);
  const memoTags = Array.isArray(memo.tags) ? memo.tags.map(String) : [];

  // 标签 relation
  const tagPages = [];
  for (const t of memoTags) {
    if (dry) { tagPages.push({ id: "dry", url: "dry" }); continue; }
    const rec = await tags.ensure(t, token);
    if (rec) tagPages.push(rec);
  }

  const props = {
    "标题": { title: [{ type: "text", text: { content: title } }] },
    "Summary": { rich_text: [{ type: "text", text: { content: summary } }] },
    "slug": { rich_text: [{ type: "text", text: { content: String(memo.slug || "") } }] },
    "Flomo链接": { url: "https://app.flomoapp.com/memo/" + String(memo.slug || "") },
    "笔记创建时间": { date: { start: toISO(memo.created_at) } },
    "笔记修改时间": { date: { start: toISO(memo.updated_at) } },
    "链接数量": { number: Number(memo.linked_count) || 0 },
  };
  // 来源（只写合法选项）
  const src = String(memo.source || "").trim();
  if (["ios", "web", "wechat", "微信"].indexOf(src) >= 0) {
    props["来源"] = { select: { name: src } };
  }
  // 状态：置顶
  if (Number(memo.pin) === 1) {
    props["状态"] = { status: { name: "置顶" } };
  }
  // 标签 relation（★ Notion 2025 版要求 [{ id: "..." }] 对象，不能是纯字符串 ★）
  if (tagPages.length) {
    props["标签"] = { relation: tagPages.map((t) => ({ id: t.id })) };
  }

  const hit = notes.find(memo);

  if (!hit) {
    if (dry) {
      return { action: "新建", title, detail: "标签 " + memoTags.length + " 个" };
    }
    const blocks = buildBlocks(memo, text);
    const p = await api("/pages", "POST", {
      parent: { type: "data_source_id", data_source_id: DS_NOTES },
      properties: props,
      ...(blocks.length ? { children: blocks } : {}),
    }, token);
    notes.bySlug.set(String(memo.slug || ""), { id: p.id, url: p.url, title });
    return { action: "新建", title, id: p.id, url: p.url };
  }

  // 已存在 → 更新
  if (dry) {
    return { action: hit.archived ? "更新(已归档)" : "更新", title, detail: "标签 " + memoTags.length + " 个" };
  }
  const upd = { properties: props };
  const blocks = buildBlocks(memo, text);
  if (blocks.length) {
    // ★ 先清正文再重填（逐个删子块）★
    await clearChildren(hit.id, token);
    for (let i = 0; i < blocks.length; i += 80) {
      await api("/blocks/" + hit.id + "/children", "PATCH", {
        children: blocks.slice(i, i + 80),
      }, token);
      await sleep(300);
    }
  }
  await api("/pages/" + hit.id, "PATCH", upd, token);
  return { action: "更新", title, id: hit.id, url: hit.url };
}

/** 归档（flomo 侧删除 → Notion 状态改「已归档」）*/
async function archiveMemo(hit, notes, token, dry) {
  if (dry) return { action: "归档", title: hit.title };
  await api("/pages/" + hit.id, "PATCH", {
    properties: { "状态": { status: { name: "已归档" } } },
  }, token);
  hit.archived = true;
  return { action: "归档", title: hit.title, id: hit.id };
}

/** 清正文（逐个 DELETE 子块）*/
async function clearChildren(pageId, token) {
  let cur = null;
  const ids = [];
  do {
    const q = await api(
      "/blocks/" + pageId + "/children?page_size=100" + (cur ? "&start_cursor=" + cur : ""),
      "GET", null, token
    );
    for (const b of q.results || []) ids.push(b.id);
    cur = q.has_more ? q.next_cursor : null;
  } while (cur);
  for (const id of ids) {
    await api("/blocks/" + id, "DELETE", null, token);
    await sleep(120);
  }
  return ids.length;
}

module.exports = {
  api, loadToken, htmlToText, extractTags, makeTitle, makeSummary, toISO,
  TagStore, NoteStore, writeMemo, archiveMemo, buildBlocks, clearChildren,
  DS_NOTES, DS_TAGS, FLOMO_PAGE,
};
