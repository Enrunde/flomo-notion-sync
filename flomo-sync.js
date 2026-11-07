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

// ★★★ 2026-11-07：★ 基线放 Notion（★ 不依赖 git 提交 ★）★★★ ★
//   ★ 原因：★ GitHub 提交 .github/ 下的文件会被拒（404）★
//     而且这台机器的 git 端点时好时坏（CONNECT tunnel 502）★
//   ★ → 基线存 Notion 的一个特殊页面 → 下次从 Notion 读回 → 跨机器一致 ★
process.env.FLOMO_BASELINE_IN_NOTION = "1";
process.env.FLOMO_BASELINE_FILE = path.join(__dirname, "flomo-baseline.json");

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
  console.log("  基线存放：Notion 特殊页面（★ 不依赖 git ★）");

  // ── ② 调主脚本（★ 逻辑只有一份 ★）──
  if (!fs.existsSync(MAIN)) {
    console.log("  ✘ 找不到主脚本：" + MAIN);
    console.log("    → 本地跑一次「工具/发布到云端.js」把文件传上来");
    process.exitCode = 1;
    return;
  }
  const { main: syncMain } = require(MAIN);
  await syncMain();

  // ── ③ 基线（★ 已由主脚本写进 Notion ★）──
  console.log("");
  console.log("  ✔ 基线已由主脚本写进 Notion（下次会自动读回）");
}

main().catch((e) => {
  console.error("✘ " + String(e.message || e).slice(0, 250));
  process.exit(1);
});
