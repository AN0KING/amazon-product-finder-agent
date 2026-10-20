# Windows 轻量包构建说明

本文件面向维护人员。同事安装只需完整解压 ZIP 后双击 `Install.cmd`，详细步骤见 [安装说明](workbuddy-installation.md)。

## 输入与隔离

构建使用 Windows x64 的 Node.js 24.x。安装包不附带 Node，可在不访问 npm 的情况下安装；实际采集和匹配仍需要网络以及用户自己的账号。不要从正在使用的目录复制 node_modules 或任何业务数据。

先在仓库外创建全新构建目录，其下建立 `clean-deps/amazon` 和 `clean-deps/finder`。分别只复制根项目、`1688-dependencies/1688-image-finder` 的 package.json 和 package-lock.json。对两个目录分别运行：

```powershell
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

本包使用系统 Microsoft Edge，不下载 Playwright 浏览器。忽略依赖安装脚本之后，必须用实际包进行 sharp 图像处理和服务启动测试；不能仅用 npm 安装成功代替验证。

## 生成可安装目录

在项目根目录执行，以下路径是可替换示例，output 必须不存在且位于仓库外：

```powershell
node scripts/build-windows-package.mjs --output=C:/ScoutBuild/Scout-Amazon-Windows-x64 --dependencies=C:/ScoutBuild/clean-deps
```

构建器按白名单复制运行代码、生产依赖、Windows 安装和守护脚本、接口及说明，生成每个文件的 SHA-256 清单。它不复制 data、日志、私有配置、任务结果或登录档案；发现符号链接或受限路径时拒绝构建。清单记录基础 Git 提交和包构建时间。清单能检查文件损坏，不代替发布者签名。

完成所有验证后，将整个输出目录压缩为一个 ZIP，并另外公布 ZIP 的 SHA-256。不要从 ZIP 预览界面执行安装入口。

## 发布前验证

1. 运行根项目 `npm test`、`npm run check`，并检查相关采购组件测试。
2. 使用真实完整包安装到中文和空格目录，指定 `-NoStart -NoShortcuts`，避免注册当前电脑的登录自启；验证安装后的数据和配置位置、记录的系统 Node 路径。
3. 用隔离数据、随机端口和阻断外连的测试环境验证主服务、采购桥接及 native 图像处理，不触碰生产端口或现有任务。
4. 验证升级保留模拟 data/config，手动暂停及待登录不能被守护自动恢复，服务退出恢复有次数限制。
5. 校验所有清单文件、凭据和私有文件排除情况；最终 ZIP 解压后再次核对清单。

Windows 安装脚本源码在 `packaging/windows`，接口定义在 `interfaces`。已生成安装包中的对应目录为 `windows`、`interfaces`，安装器将它们写入安装根目录的 `control/scripts`、`interfaces`。
