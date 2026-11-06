/**
 * ★ flomo → Notion 云端同步：部署到 GitHub（★ 双击即用）★★
 *
 *  ★ 做四件事 ★
 *  ① git init + commit
 *  ② gh repo create（不存在才建）
 *  ③ ★ 自动上传两个 secret（★ 用户零操作 ★）
 *     FLOMO_API_KEY ← 本机 同步/flomo配置.json 里的 apiKey
 *     NOTION_TOKEN  ← 本机 ~/.config/notion/token
 *  ④ 推代码 + 触发一次 workflow（验证能不能跑通）
 *
 *  ★ 前置：gh CLI 已登录（gh auth login）★
 *  ★ 首次需要你在 flomo「设置 → API」生成 API Key，填进 同步/flomo配置.json ★
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const DIR = __dirname;
const SYNC = path.join(DIR, "..");
const REPO_NAME = "flomo-notion-sync";
const USER = "Enrunde";

const GH_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || "", "Programs", "GitHub CLI", "bin", "gh.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Programs", "GitHub CLI", "gh.exe"),
  "gh",
];

function step(t) { console.log("  → " + t); }
function ok(t) { console.log("  ✔ " + t); }
function fail(t) { console.log("  ✘ " + t); process.exit(1); }

function ghBin() {
  for (const c of GH_CANDIDATES) {
    try {
      if (c === "gh" || fs.existsSync(c)) return c;
    } catch (e) { /* 忽略 */ }
  }
  fail("找不到 gh CLI");
}

function gh(args, opts) {
  const o = opts || {};
  try {
    return execFileSync(ghBin(), args, {
      cwd: DIR,
      encoding: "utf8",
      stdio: o.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      timeout: 300000,
    });
  } catch (e) {
    if (o.quiet) return "";
    console.log("  ✘ gh " + args.join(" ") + " 失败");
    if (e.stderr) console.log(String(e.stderr).slice(0, 400));
    process.exit(1);
  }
}

function ghJson(args) {
  const out = gh(args, { quiet: true });
  try { return JSON.parse(out); } catch (e) { return {}; }
}

// ══════════════════════════════════════════════════
//  读凭证
// ══════════════════════════════════════════════════
function readFlomoKey() {
  // ★ 优先读 flomo凭证.txt（★ 记事本能开，用户偏好）★
  const txt = path.join(SYNC, "flomo凭证.txt");
  if (fs.existsSync(txt)) {
    try {
      const t = fs.readFileSync(txt, "utf8");
      const m = /^s*apiKeys*=s*(.+)$/mi.exec(t);
      if (m && m[1].trim()) return m[1].trim();
    } catch (e) { /* 忽略 */ }
  }
  // 兜底：读 json
  const p = path.join(SYNC, "flomo配置.json");
  if (!fs.existsSync(p)) return "";
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return String(j.apiKey || "").trim();
  } catch (e) {
    return "";
  }
}
function readNotionToken() {
  const p = path.join(os.homedir(), ".config", "notion", "token");
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf8").trim();
}

// ══════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════
console.log("═══ 部署 flomo → Notion 云端同步 ═══\n");

// ① 检查凭证
step("检查凭证…");
const flomoKey = readFlomoKey();
const notionToken = readNotionToken();
if (!notionToken) fail("没找到 Notion token（~/.config/notion/token）");
ok("Notion token ✔");
if (!flomoKey) {
  console.log("  ⚠ 没找到 FLOMO_API_KEY");
  console.log("    → 请到 flomo 网页版「设置 → API」生成，填进 " + path.join(SYNC, "flomo配置.json"));
  console.log("    → 或者直接告诉 AI 你的 API Key，让 AI 帮你填");
} else {
  ok("FLOMO_API_KEY ✔");
}

// ② git init + commit
step("初始化 git…");
try {
  execFileSync("git", ["init", "-q"], { cwd: DIR, stdio: "ignore" });
  execFileSync("git", ["checkout", "-q", "-B", "main"], { cwd: DIR, stdio: "ignore" });
} catch (e) { /* 已存在 */ }
try {
  execFileSync("git", ["add", "-A"], { cwd: DIR, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=workbuddy", "-c", "user.email=workbuddy@local",
     "commit", "-q", "-m", "feat: flomo → Notion 云端定时同步"],
    { cwd: DIR, stdio: "ignore" }
  );
} catch (e) { /* 无改动 */ }
ok("已提交");

// ③ 建仓库
const full = USER + "/" + REPO_NAME;
step("检查远端仓库…");
let repo = ghJson(["api", "repos/" + full]);
if (!repo.id) {
  step("创建仓库 " + full + "…");
  gh(["repo", "create", full, "--public", "--description",
      "flomo 速记 → Notion「Flomo知识库」自动同步", "--source=."], { quiet: true });
  ok("已创建");
} else {
  ok("仓库已存在");
}

// ④ remote
step("配置 remote…");
try {
  execFileSync("git", ["remote", "remove", "origin"], { cwd: DIR, stdio: "ignore" });
} catch (e) { /* 忽略 */ }
execFileSync("git", ["remote", "add", "origin", "https://github.com/" + full + ".git"], {
  cwd: DIR, stdio: "ignore",
});
execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: DIR, stdio: "ignore" });
ok("已推送");

// ⑤ secret
step("上传 secret…");
gh(["secret", "set", "NOTION_TOKEN", "--repo", full, "--body", notionToken], { quiet: true });
ok("NOTION_TOKEN ✔");
if (flomoKey) {
  gh(["secret", "set", "FLOMO_API_KEY", "--repo", full, "--body", flomoKey], { quiet: true });
  ok("FLOMO_API_KEY ✔");
} else {
  console.log("  ⚠ 跳过 FLOMO_API_KEY（还没填）");
  console.log("    → 填好后重跑本脚本，或在 GitHub 手动加：");
  console.log("      https://github.com/" + full + "/settings/secrets/actions");
}

// ⑥ 触发一次
step("触发一次运行验证…");
gh(["workflow", "run", "flomo-notion-sync.yml", "--repo", full, "--ref", "main"], { quiet: true });
ok("已触发（去 Actions 页看结果）");

console.log("");
console.log("── 完成 ──");
console.log("  仓库    https://github.com/" + full);
console.log("  Actions https://github.com/" + full + "/actions");
console.log("  Secrets https://github.com/" + full + "/settings/secrets/actions");
console.log("");
console.log("  ★ 自动同步时间：每天北京时间 08:30 / 20:30");
console.log("  ★ 电脑关机也照跑（云端执行）");
if (!flomoKey) {
  console.log("");
  console.log("  ⚠ 还差一步：把 flomo API Key 填进 " + path.join(SYNC, "flomo配置.json"));
  console.log("    然后重跑这个脚本 → 或直接在 GitHub Secrets 里加 FLOMO_API_KEY");
}
