import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const split = arg.indexOf("=");
  if (!arg.startsWith("--") || split < 3) throw new Error("Use --output=PATH --dependencies=PATH");
  return [arg.slice(2, split), arg.slice(split + 1)];
}));
for (const key of ["output", "dependencies"]) if (!args[key] || !path.isAbsolute(args[key])) throw new Error(`Absolute --${key} is required`);
if (Object.keys(args).some(key => !["output", "dependencies"].includes(key))) throw new Error("Unknown package option");
const destination = path.resolve(args.output);
if (destination === sourceRoot || destination.startsWith(sourceRoot + path.sep)) throw new Error("Package output must be outside the repository");
try { await fs.access(destination); throw new Error("Output already exists; choose a new staging directory"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const digest = buffer => createHash("sha256").update(buffer).digest("hex");
await fs.mkdir(destination, { recursive: true });
async function copyFile(source, relative) {
  if ((await fs.lstat(source)).isSymbolicLink()) throw new Error("Symlinks are not distribution inputs");
  const target = path.join(destination, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}
async function copyTree(source, relative) {
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Symlink found in package input: " + to);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}
for (const file of ["app.js", "index.html", "styles.css", "server.mjs", "package.json", "package-lock.json"])
  await copyFile(path.join(sourceRoot, file), path.join("application", file));
await copyTree(path.join(sourceRoot, "lib"), "application/lib");
await copyFile(path.join(sourceRoot, "scripts/start-1688-dependency.mjs"), "application/scripts/start-1688-dependency.mjs");
await copyFile(path.join(sourceRoot, "config/sellersprite.example.toml"), "application/config/sellersprite.example.toml");
for (const component of ["1688-procurement-assistant-2.3.0", "1688-image-finder"]) {
  const from = path.join(sourceRoot, "1688-dependencies", component), to = path.join("application/1688-dependencies", component);
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory() && ["lib", "dist", "scripts"].includes(entry.name)) await copyTree(path.join(from, entry.name), path.join(to, entry.name));
    else if (entry.isFile() && ["package.json", "package-lock.json", "server.mjs", "README.md"].includes(entry.name)) await copyFile(path.join(from, entry.name), path.join(to, entry.name));
  }
}
await copyFile(path.join(sourceRoot, "1688-dependencies/README.md"), "application/1688-dependencies/README.md");
await copyTree(path.join(args.dependencies, "amazon/node_modules"), "application/node_modules");
await copyTree(path.join(args.dependencies, "finder/node_modules"), "application/1688-dependencies/1688-image-finder/node_modules");
await copyTree(path.join(sourceRoot, "packaging/windows"), "windows");
await copyFile(path.join(sourceRoot, "packaging/windows/Install.cmd"), "Install.cmd");
await copyTree(path.join(sourceRoot, "interfaces"), "interfaces");
for (const file of ["workbuddy-installation.md", "windows-package-build.md", "standalone-operations.md", "task-recovery.md", "local-api.md", "monthly-sales-sources.md", "1688-rate-trial.md", "fba-rates-au-ca.md", "release-0.9.51.md", "release-0.9.52.md", "release-0.9.53.md", "release-0.9.54.md", "release-0.9.63.md", "release-0.9.64.md"])
  await copyFile(path.join(sourceRoot, "docs", file), path.join("docs", file));
const standaloneGuide = path.join(destination, "docs/standalone-operations.md");
await fs.writeFile(standaloneGuide, (await fs.readFile(standaloneGuide, "utf8")).replace("../1688-dependencies/README.md", "../application/1688-dependencies/README.md"));
const version = JSON.parse(await fs.readFile(path.join(sourceRoot, "package.json"), "utf8")).version;
const readme = `店铺分析 Agent ${version} · Windows x64 轻量安装包\r\n\r\n1. 将 ZIP 完整解压到普通本地目录，不能在压缩包预览内运行。\r\n2. 双击 Install.cmd，安装到当前用户目录，使用现有 Node 24.x，无需管理员、Git 或 AI 软件。\r\n3. 安装后使用桌面快捷方式打开程序：http://127.0.0.1:4173/\r\n4. 首次使用 1688 时，由同事在程序中登录自己的账户。SellerSprite 是可选配置。\r\n5. WorkBuddy 使用 interfaces/Invoke-Scout.ps1 和 scout-local.openapi.json，通过本机接口查询或明确控制任务；无需设置 AI 定时轮询。\r\n\r\n完整安装、自启、卸载、工作原理和 WorkBuddy 调用步骤：docs/workbuddy-installation.md\r\n\r\n安装包使用本机现有 Node 24.x（x64），自带生产依赖，无需 npm install，使用系统 Microsoft Edge。Windows 10/11 x64；业务访问仍需网络。\r\n默认目录：%LOCALAPPDATA%\\ScoutAmazon；业务数据、登录会话、配置和日志在同事电脑生成。\r\nAmazon 与已确认 1688 批次由后台推进；SellerSprite 多批分析仍需保留网页。关机/休眠、断网和平台验证码无法靠轮询消除；验证码或人工暂停不会自动解除。\r\n本包不包含发布者的任务、密钥、Cookie 或登录档案。\r\n`;
await fs.writeFile(path.join(destination, "README-使用说明.txt"), "\ufeff" + readme, "utf8");

await fs.writeFile(path.join(destination, "README-安装说明.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>店铺分析 Agent 安装说明</title><style>body{font:16px/1.8 system-ui,"Microsoft YaHei",sans-serif;background:#f4f6f8;color:#202b33;margin:0}main{max-width:850px;margin:35px auto;background:white;padding:40px;border-radius:12px}h1{font-size:28px}h2{font-size:21px;margin-top:30px}code,pre{background:#edf2f5;border-radius:4px;padding:3px 6px}pre{padding:16px;white-space:pre-wrap;word-break:break-all}td,th{padding:8px 15px;border:1px solid #ddd;text-align:left}table{border-collapse:collapse;width:100%}a{color:#096357}.hint{border-left:4px solid #207868;padding:12px 18px;background:#f0f8f5}small{color:#617078}</style><main><h1>店铺分析 Agent ${version}</h1><p>Windows x64 轻量安装包 · 使用电脑已有 Node 24.x · 自动巡检不依赖 AI</p><div class="hint">同事只需完整解压 ZIP，再双击 <b>Install.cmd</b>。生产依赖和采购组件已附带，不需要执行 npm install。</div><h2>安装与使用</h2><ol><li>确认 Windows 10/11 x64、Node.js 24.x x64 和 Microsoft Edge 已安装。</li><li>解压全部文件，在普通本地目录运行 Install.cmd，不要从 ZIP 预览内运行。</li><li>默认安装到当前用户的 LocalAppData / ScoutAmazon，不需要管理员权限。安装器检测 Node 并记录其绝对路径。</li><li>安装完成后打开桌面 Scout Amazon 快捷方式，或访问 <a href="http://127.0.0.1:4173/">本地页面</a>。</li><li>导入自己的店铺清单。1688 使用同事自己的账号登录；SellerSprite 可选，不配置也能进行 Amazon 采集。</li></ol><h2>WorkBuddy 接口</h2><p>WorkBuddy 有本地命令执行能力时，可运行安装目录中的接口脚本。以下是单次只读查询：</p><pre>&amp; "$env:LOCALAPPDATA\\ScoutAmazon\\interfaces\\Invoke-Scout.ps1" -Operation Status</pre><p>标准接口定义：<a href="interfaces/scout-local.openapi.json">OpenAPI JSON</a>；操作说明：<a href="interfaces/README.md">interfaces/README.md</a>。不需要在 WorkBuddy 里另建定时轮询任务。</p><h2>后台自动执行</h2><table><tr><th>机制</th><th>频率与职责</th></tr><tr><td>Amazon 执行器</td><td>每 30 秒检查已保存任务，有限重试与断点恢复</td></tr><tr><td>1688 执行器</td><td>按冷却截止时间唤醒，每 5 秒兜底检查</td></tr><tr><td>安装包守护</td><td>每 60 秒检查进程，恢复退出、连续无响应或采集长期无进展的 Scout 服务</td></tr><tr><td>事件巡检</td><td>Amazon 每 15 分钟，1688 每 30 分钟，异常事件去重记录</td></tr></table><h2>暂停、退出与恢复边界</h2><p>人工暂停、验证码和登录失效均保留断点，等待本人处理。守护不会自动破解验证或扩大匹配范围。关机、休眠及断网期间不能采集。</p><p>Amazon 采集和已确认的 1688 匹配可在关闭网页后继续；<b>SellerSprite 多批分析仍需保持网页打开</b>。</p><p>安装后当前用户登录会自动启动后台。Start.cmd 打开程序；先暂停任务再运行 Stop.cmd 停止本安装；Uninstall.cmd 撤销自启及快捷方式，默认保留业务数据。</p><h2>文件与排障</h2><p>安装根目录内：data 保存断点和历史、config 保存本机配置、logs 保存日志、exports 保存导出文件、interfaces 保存 WorkBuddy 接口。</p><p>完整说明：<a href="docs/workbuddy-installation.md">同事电脑安装与 WorkBuddy 接入</a>。若 Node 版本不符、端口已有其他实例或安装校验失败，安装器会明确停止，请按日志处理，不要删除 data。</p><small>此包不包含发布者的任务数据、密钥、Cookie 或登录档案。安装版以本说明为准，旧源码文档中的 D 盘部署路径不适用于此包。</small></main></html>`, "utf8");

const files = [];
async function enumerate(directory, prefix = "") {
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const name = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) await enumerate(path.join(directory, entry.name), name);
    else {
      if (/(^|\/)(\.git|\.codex|data|logs|backups)\/|\.local\.toml$|(^|\/)\.env(?:$|\.)|storage-state\.json$|cookies\.json$/i.test(name)) throw new Error("Private data path in package: " + name);
      const buffer = await fs.readFile(path.join(directory, entry.name));
      files.push({ path: name, sha256: digest(buffer), size: buffer.length });
    }
  }
}
await enumerate(destination);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
await fs.writeFile(path.join(destination, "package-manifest.json"), JSON.stringify({ product: "scout-amazon-agent-windows", version, packageRevision: "windows-20261016-watchdog-0963", platform: "win32-x64", createdAt: new Date().toISOString(), baseCommit: commit, sourceIncludesPackagingChanges: true, requirements: { node: "24.x", arch: "x64", edge: "system Microsoft Edge" }, files }, null, 2));
console.log(JSON.stringify({ destination, version, files: files.length, bytes: files.reduce((sum,file) => sum + file.size, 0) }));
