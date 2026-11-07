/**
 * ══════════════════════════════════════════════════════════════
 *  flomo → Notion「Flomo知识库」云端同步入口 ★★★ 2026-11-07 重写 ★★★
 * ══════════════════════════════════════════════════════════════
 *
 *  ★★★ 为什么重写（★ 解决「要顾及二边」★）★★★
 *   痛点：★ 本地和云端各写一份同步逻辑 → 改一边忘另一边 → 两边行为不一致 → 冲突 ★
 *   ★ 解决：★ 云端【直接调用本地那份主脚本】→ 逻辑只有一份 ★
 *     · 本地主脚本：同步flomo到Notion.js（★ 唯一代码源 ★）
 *     · 云端入口：只负责准备环境变量 + 调用它 ★
 *
 *  ★★★ 需要的 secret（★ GitHub Actions）★★★ ★
 *   FLOMO_MCP_TOKEN  ← flomo 官方 MCP 个人 Token（★ 首选 ★）
 *   FLOMO_API_KEY    ← flomo 官方 API Key（★ 备选 ★）
 *   NOTION_TOKEN     ← Notion integration token（★ 要有「Flomo知识库」权限 ★）
 *
 *  ★★★ 基线（三方合并用）★★★ ★
 *   云端：flomo-baseline.json（★ 存在仓库里 → 每次跑完提交回去 ★）
 *   本机：D:/Obsidian/同步状态/flomo基线.json（★ vault 外 ★）
 *   ★ 通过环境变量 FLOMO_BASELINE_FILE 切换 ★
 */

const fs = require("fs");
const path = require("path");

// ★★★ 2026-11-07：★ 基线放仓库内（★ 云端每次跑完提交回去 → 下次能对比 ★）★★★
const BASELINE_FILE = path.join(__dirname, "flomo-baseline.json");
process.env.FLOMO_BASELINE_FILE = BASELINE_FILE;

// ★★★ 唯一代码源：本地主脚本 ★★★
const MAIN = path.join(__dirname, "同步flomo到Notion.js");
const BASE = path.join(__dirname, "flomo基线.js");

/** ★ 基线文件：不存在就建一个空的 ★ */
function ensureBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) {
    fs.writeFileSync(BASELINE_FILE, "{}", "utf8");
  }
}

/** ★ 把基线文件删掉 → 主脚本会重建 ★ */
function resetBaseline() {
  try { fs.unlinkSync(BASELINE_FILE); } catch (e) { /* 忽略 */ }
}

async function main() {
  console.log("═══ flomo → Notion「Flomo知识库」云端同步 ═══\n");

  // ── ① 检查凭证 ──
  const hasMcp = !!String(process.env.FLOMO_MCP_TOKEN || "").trim();
  const hasKey = !!String(process.env.FLOMO_API_KEY || "").trim();
  const hasNotion = !!String(process.env.NOTION_TOKEN || "").trim();

  if (!hasNotion) {
    console.log("  ✘ 没有 NOTION_TOKEN（GitHub secret）");
    process.exitCode = 1;
    return;
  }
  if (!hasMcp && !hasKey) {
    console.log("  ✘ 没有取数凭证");
    console.log("    需要 secret：FLOMO_MCP_TOKEN（★ 优先 ★）或 FLOMO_API_KEY");
    process.exitCode = 1;
    return;
  }
  console.log("  取数凭证：" + (hasMcp ? "FLOMO_MCP_TOKEN ✔" : "") + (hasMcp && hasKey ? " + " : "") + (hasKey ? "FLOMO_API_KEY ✔" : ""));
  console.log("  基线文件：" + BASELINE_FILE + (fs.existsSync(BASELINE_FILE) ? "" : "（首次会新建）"));

  // ★ 基线已存在 → 主脚本会读它做三方合并 ★
  ensureBaseline();

  // ── ② 调主脚本（★ 逻辑只有一份 ★）──
  if (!fs.existsSync(MAIN)) {
    console.log("  ✘ 找不到主脚本：" + MAIN);
    console.log("    → 本地跑一次「工具/发布到云端.js」把文件传上来");
    process.exitCode = 1;
    return;
  }
  const { main: syncMain } = require(MAIN);
  await syncMain();

  // ── ③ 基线回写（★ 顺便把基线一起提交 ★）──
  console.log("");
  console.log("── 基线 ──");
  if (fs.existsSync(BASELINE_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
      console.log("  ✔ 基线 " + Object.keys(j).length + " 条 → " + path.basename(BASELINE_FILE));
    } catch (e) {
      console.log("  ⚠ 基线读不了：" + String(e.message).slice(0, 60));
    }
  } else {
    console.log("  ⚠ 没找到基线文件（三方合并下次会退化成单向覆盖）");
  }
}

main().catch((e) => {
  console.error("✘ " + String(e.message || e).slice(0, 250));
  process.exit(1);
});
