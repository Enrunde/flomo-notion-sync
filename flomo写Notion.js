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
  const SL = String.fromCharCode(1);          // ★ 哨兵：左尖括号（不会出现在正文里）★
  const SR = String.fromCharCode(2);          // ★ 哨兵：右尖括号 ★
  return String(html || "")
    // ★★★ flomo 的 Markdown 链接是 <https://xxx> 形式 → 不是 HTML 标签，要保留 ★★★
    //   ★ 先用两个哨兵把 < 和 > 换掉 → 剥完标签再还原（否则会被 <[^>]+> 一起吃掉）★
    //   ★★★ 注意：左右必须用【不同】哨兵 → 同一个会导致还原时 ">" 变成 "<" ★★★
    .replace(/<((?:https?|mailto):[^>]+)>/g, SL + "$1" + SR)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(new RegExp(SL, "g"), "<")
    .replace(new RegExp(SR, "g"), ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * ★★★ 把 MCP 返回的 memo 适配成【内部接口的字段格式】★★★ ★
 *  ★ MCP 与内部接口的差异：★
 *   · slug        → MCP 用 id
 *   · content     → MCP 是 Markdown 原文（内部接口是 HTML）
 *   · created_at  → MCP 是 ISO 带时区（内部接口是 "YYYY-MM-DD HH:mm:ss"）
 *   · source      → MCP 是 from（human/ai/api/import/paste）
 *   · pin         → MCP 没有
 *   · deleted_at  → MCP 搜不到已删除的
 */
function adaptMemo(m) {
  if (!m) return null;
  const o = Object.assign({}, m);
  if (!o.slug && o.id) o.slug = String(o.id);
  // ★ 时间：统一成 "YYYY-MM-DD HH:mm:ss"（北京时间）★★
  const fmt = (s) => {
    if (!s) return "";
    const m2 = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s));
    if (!m2) return String(s);
    return m2[1] + "-" + m2[2] + "-" + m2[3] + " " + m2[4] + ":" + m2[5] + ":" + m2[6];
  };
  if (o.created_at) o.created_at = fmt(o.created_at);
  if (o.updated_at) o.updated_at = fmt(o.updated_at);
  // ★ source：MCP 的 from="human" 不在 Notion 的选项里 → 留空（写入时自动跳过）★
  if (o.from && ["ios", "web", "wechat", "微信"].indexOf(o.from) < 0) o.source = "";
  if (o.pin === undefined) o.pin = 0;
  if (!Array.isArray(o.tags)) o.tags = [];
  if (!Array.isArray(o.files)) o.files = [];
  if (o.linked_memos && !o.linked_count) o.linked_count = o.linked_memos.length;
  return o;
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
      return shortenTitle(t);
    }  }
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

/**
 * ★★★ 2026-11-07：★ 标题自动缩短 ★★★ ★
 *
 *  ★ 问题：原来直接截前 120 字 → 标题是一大段被硬切的话 → 很难看 ★
 *  ★ 现在：★ 在【语义边界】断开 ★ → 读起来是完整的一句 ★
 *
 *  ★ 断开优先级（从前往后找第一个合适的切点）：
 *   ① 句号 / 问号 / 感叹号 / 分号
 *   ② 逗号 / 顿号 / 冒号
 *   ③ 空格（英文词之间）
 *  ★ 长度上限 40 字（★ 比原来的 120 短很多 ★，列表里一眼能看完 ★）
 */
const TITLE_MAX = 40;

function shortenTitle(t) {
  const s = String(t || "").trim();
  if (!s) return trimTitleTail(s);
  if (s.length <= TITLE_MAX) return trimTitleTail(s);

  // ★★★ 0. URL 处理：★ 标题里不该有被切一半的链接 ★★★ ★
  //   ★ 把完整 URL 摘出来 → 标题里只留链接前的中文说明 ★
  //   ★ URL 本身太长 → 直接整个去掉（正文里有）★
  let body = s;
  // ★ flomo 的链接常写成 <https://...>（尖括号自动链接）→ 一起认 ★
  const urlRe = /<?https?:\/\/[^\s>]+>?/g;
  const urls = body.match(urlRe) || [];
  let urlNote = "";
  if (urls.length) {
    // ★ 去掉链接后剩下的文字 ★
    body = body.replace(urlRe, " ").replace(/\s+/g, " ").trim();
    // ★ 剩余文字够长就用它；太短就退化成「前缀 + 链接标识」★
    if (body.length >= 6) {
      urlNote = "";
    } else {
      // ★ 只剩几个字 → 标题用「前缀 + 🔗」★
      const prefix = body.replace(/[（(【\[]?\s*$/, "").trim();
      return trimTitleTail((prefix ? prefix.slice(0, TITLE_MAX - 4) : "笔记") + " 🔗");
    }
  }

  if (body.length <= TITLE_MAX) return trimTitleTail(body + urlNote);

  // ① 句末标点
  const m1 = body.slice(0, TITLE_MAX + 12).match(/^[\s\S]{4,}?[。！？!?；;]/);
  if (m1) return trimTitleTail(m1[0].trim());

  // ② 逗号 / 顿号 / 冒号（★ 在 TITLE_MAX 内找【最靠后】的 ★）
  const cand = [];
  const re = /[，,、：:]/g;
  let mm;
  while ((mm = re.exec(body)) !== null) {
    if (mm.index < 8) continue;              // 太靠前 → 标题太空
    if (mm.index > TITLE_MAX) break;         // 太靠后 → 标题还是长
    cand.push(mm.index);
  }
  if (cand.length) {
    // ★ 取【最靠前】的一个 ★
    //   ★ 为什么最靠前：★ 标题应该是「一件事的概括」★
    //     「购买谷歌手机，使用英文版…」比「购买谷歌手机，使用英文版注册谷歌账户，另外…」更像标题 ★
    const cut = cand[0];
    const t = body.slice(0, cut).trim();
    if (t.length >= 8) return trimTitleTail(t);
  }

  // ③ 空格（英文句子）
  const sp = body.slice(0, TITLE_MAX).lastIndexOf(" ");
  if (sp >= 12) return trimTitleTail(body.slice(0, sp).trim());

  // ④ 兜底：硬切
  return trimTitleTail(body.slice(0, TITLE_MAX).trim() + "…");
}

/** ★ 去掉标题尾部的孤立标点（★ 「（」「，」这类残留 ★）*/
function trimTitleTail(s) {
  let t = String(s || "").trim();
  // ★ 空括号（URL 被摘掉后留下的）→ 一起去掉 ★
  t = t.replace(/[（(【\[｛{]\s*[）)】\]｝}]/g, "");
  t = t.replace(/[（(【\[｛{]\s*$/u, "");
  t = t.replace(/[，,、：:；;。．.\s]+$/u, "");
  return t.trim();
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
        // ★★★ 读「状态」属性（★ 归档标记在这里，不在 p.archived ★）★★★
        //   ★ p.archived 是 Notion 的"在回收站"标记 → 跟"已归档"是两回事 ★
        //   ★ 2026-11-06：因为只存了 p.archived → 归档后无法识别已归档 → 每次都重复归档 ★
        const status = (p.properties["状态"] && p.properties["状态"].status)
          ? (p.properties["状态"].status.name || "")
          : "";
        // ★★★ 2026-11-07：★ 存下当前属性值（★ 供三方合并用 ★）★★★
        //   ★ 不存就没法判断「用户改过」→ 只能单向覆盖 ✘★
        const vals = {
          标题: title,
          Summary: ((p.properties["Summary"] && p.properties["Summary"].rich_text) || [])
            .map((x) => x.plain_text).join(""),
          标签: ((p.properties["标签"] && p.properties["标签"].relation) || [])
            .map((x) => x.id).sort().join(","),
          状态: status,
        };
        if (slug) this.bySlug.set(slug, { id: p.id, url: p.url, title, archived: p.archived, status, vals });
        else if (title) this.bySlug.set("#title:" + title, { id: p.id, url: p.url, title, archived: p.archived, status, vals });
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
    // ★★★ 2026-11-07：★ 新建也要记基线（★ 否则下一轮会误判成「你改过」★★★
    const BASE = require(path.join(SYNC, "flomo基线.js"));
    const baseline = opts.baseline || {};
    const slugKey = String(memo.slug || "").trim();
    BASE.setEntry(baseline, slugKey, {
      标题: title,
      Summary: summary,
      标签: tagPages.map((t) => t.id).sort().join(","),
      状态: "",
      正文: text,
    }, {
      标题: title,
      Summary: summary,
      标签: tagPages.map((t) => t.id).sort().join(","),
    });
    return { action: "新建", title, id: p.id, url: p.url };
  }

  // 已存在 → 更新
  if (dry) {
    return { action: hit.archived ? "更新(已归档)" : "更新", title, detail: "标签 " + memoTags.length + " 个" };
  }

  // ★★★ 2026-11-07：★ 三方合并（★ 支持「你在 Notion 上改过」不被覆盖 ★）★★★
  //   ★ 原来：无条件全量覆盖 → 你改的一律被冲掉 ✘★
  //   ★ 现在：拿基线对比 → 只有 flomo 改了的字段才写回 Notion ★
  const BASE = require(path.join(SYNC, "flomo基线.js"));
  const baseline = opts.baseline || {};
  const slugKey = String(memo.slug || "").trim();
  const baseEntry = BASE.getEntry(baseline, slugKey);

  // ★ flomo 侧现在应该是什么值 ★
  const flomoNow = {
    标题: title,
    Summary: summary,
    标签: tagPages.map((t) => t.id).sort().join(","),
  };
  // ★ Notion 侧现在是什么值 ★
  const notionNow = hit.vals || {};

  const MERGE_FIELDS = ["标题", "Summary", "标签"];
  const m = BASE.merge3(baseEntry, notionNow, flomoNow, MERGE_FIELDS);

  // ★ 按合并结果重建属性 ★
  const finalProps = Object.assign({}, props);
  if (m.kept.length) {
    // ★ 保留用户改过的字段 → 用 Notion 现值 ★
    if (m.kept.indexOf("标题") >= 0) {
      finalProps["标题"] = { title: [{ type: "text", text: { content: String(m.use["标题"] || "") } }] };
    }
    if (m.kept.indexOf("Summary") >= 0) {
      finalProps["Summary"] = { rich_text: [{ type: "text", text: { content: String(m.use["Summary"] || "") } }] };
    }
    if (m.kept.indexOf("标签") >= 0) {
      // ★ 标签是 relation → 用 Notion 现有的 id ★
      const ids = String(m.use["标签"] || "").split(",").filter(Boolean);
      if (ids.length) finalProps["标签"] = { relation: ids.map((id) => ({ id })) };
    }
  }

  // ★ 记基线（★ 同步后的 Notion 值 + 这次的 flomo 值 ★）
  BASE.setEntry(
    baseline, slugKey,
    {
      标题: m.use["标题"],
      Summary: m.use["Summary"],
      标签: m.use["标签"],
      状态: hit.status || "",
    },
    flomoNow
  );

  const detail = [];
  if (m.kept.length) detail.push("保留你的修改:" + m.kept.join("/"));
  if (m.conflict.length) detail.push("两边都改(以flomo为准):" + m.conflict.join("/"));

  // ★★ 正文：★ 只有 flomo 内容变了才重填 ★★
  //   ★ 不变就别动 → 避免覆盖你在 Notion 上排的版 ★
  const flomoBodyChanged = !BASE.eq(baseEntry.F && baseEntry.F.正文, text);
  if (flomoBodyChanged && !m.kept.length) {
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
  } else if (flomoBodyChanged && m.kept.length) {
    detail.push("正文有变化但你改过属性→正文未重填");
  }
  // ★ 基线里记下正文指纹（★ 下次判断正文变没变 ★）
  BASE.setEntry(baseline, slugKey, {
    标题: m.use["标题"],
    Summary: m.use["Summary"],
    标签: m.use["标签"],
    状态: hit.status || "",
    正文: text,
  }, flomoNow);

  const upd = { properties: finalProps };
  await api("/pages/" + hit.id, "PATCH", upd, token);
  return { action: "更新", title: finalProps["标题"].title[0].text.content, id: hit.id, url: hit.url,
           detail: detail.join("｜") || undefined };
}

/** 归档（flomo 侧删除 → Notion 状态改「已归档」）*/
async function archiveMemo(hit, notes, token, dry) {
  if (dry) return { action: "归档", title: hit.title };
  await api("/pages/" + hit.id, "PATCH", {
    properties: { "状态": { status: { name: "已归档" } } },
  }, token);
  hit.archived = true;
  hit.status = "已归档";        // ★ 记住状态 → 下轮能识别已归档 → 幂等 ★
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
  api, loadToken, htmlToText, adaptMemo, extractTags, makeTitle, makeSummary, toISO,
  TagStore, NoteStore, writeMemo, archiveMemo, buildBlocks, clearChildren,
  DS_NOTES, DS_TAGS, FLOMO_PAGE,
};
