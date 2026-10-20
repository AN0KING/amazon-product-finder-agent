# B09NXS1BLL：普通 Edge 与采集页面的 Item Weight 差异

状态：已确认用户页面有重量；自动采集根因尚未定位，未发布新修复版本。

## 已确认的用户证据

用户在普通 Microsoft Edge（非 InPrivate）打开原始 Amazon AU 商品链接，配送邮编为 3010。截图的 Product details → Item details 显示 `Item Weight — 110 g`，等于 0.11 kg，商品 ASIN 为 B09NXS1BLL。

这条重量来自明确的 Item Weight 字段，不是包装、运输、承载容量或尺寸尾部重量。不要再要求用户证明该数值存在，也不能把本次漏读解释为该商品页面未提供重量。

## 实际差异

- 已保存的采集 DOM 局部片段 `test/fixtures/amazon-b09nxs1bll-mixed-identity.html` 中 Item details 有 8 行，没有该重量行。这是 16,464 字节的局部 outerHTML，不是整页响应源码。
- 用户截图在 Age Range Description 后多出 Item Weight 行。
- 自动采集的完整规格入口实际带有 `aria-disabled="true"`；这不是单纯点击选择器找错。
- 原链接打开功能使用普通 `msedge.exe`，保留 URL 参数；后台补查使用临时用户目录、`--headless=new` 和 `--disable-extensions`。两者没有共享用户当前 Edge 会话。该差异确实存在，但尚未证明是哪一项使重量行出现或缺失。

## 本轮验证及其边界

1. 对已有采集 HTML 仅补入截图转录的 `Item Weight / 110 g` 行，经 getProductDetail、浏览器补查结果合并、服务端映射、PersistenceStore 保存和重读后得到 0.11 kg；未补入时仍为 null。
2. 对应测试在 `test/amazon-product-single-visit.test.mjs`。最初以截图转录行回放，整个文件 37 项测试通过；用户补充原始源码行后，测试已更新为 `B09 user-provided source Item Weight survives parser, browser supplement, mapping and durable storage`，单独重跑通过。此回放证明解析和保存能处理该字段，不能证明实时浏览器已取得该字段。
3. 在可控制的内置浏览器中对照原始 URL：去掉 th=1 后 Amazon 自动加回；仍无重量行。
4. 同一内置浏览器改为截图对应的桌面宽度并重新加载，仍无重量行。内置浏览器不是普通 Edge，以上比较不能代替普通 Edge 验证。
5. 限定读取已安装扩展的 manifest 和静态代码，发现读取 Item Weight 的代码，未发现向 Amazon 原表插入该行的证据。不能认定扩展制造了 110 g，也不能根据安装清单认定扩展当前已启用。未读取 Cookie、历史、凭据或 Preferences，未授权 SellerSprite。

## 尚缺的证据

桌面工具选中普通 Edge 后，因不能可靠确定当前浏览器 URL 而停止控制；没有继续输入或通过其他自动化接口绕过该检查。现有浏览器连接器没有提供普通 Edge。

需要普通 Edge 中该商品已展开 Item details 后保存的 HTML，才能对照真实节点和加载来源。用户可以在该页按 Ctrl+S，选择“网页，仅 HTML”，保存到 `D:\deliverables\amazon-product-finder-agent\.diagnostics\B09NXS1BLL-normal-edge.html`。这是下一步所需的页面证据，不是再次要求截图或重量数值。仅对照相关规格节点，不输出账户信息或完整页面内容。

遵循 `D:\skills\engineering\diagnosing-bugs\SKILL.md` 中“当你确实无法构建 loop 时……不要在没有 loop 时继续 hypothesise”的要求，当前不基于会话差异猜测修改生产逻辑。

### 用户补充 view-source 地址后的核对

用户提供了同一商品的完整 `view-source:https://...` 地址，并再次确认普通 Edge 访问授权。该地址不包含浏览器会话或源码正文；指定路径下尚未出现用户保存的 HTML。

对地址对应的原始 HTTPS URL 做了一次普通 HTTP GET（没有读取用户 Edge 配置或会话）。返回 HTTP 200、2,860 字节，页面标题为 `Server Busy`，有访问验证标记，规格行数为 0。出现此返回后停止请求；该结果不能用于判断商品是否提供重量。

再次限定检查两份现存 B09 局部 HTML，原始字符串、解码文本、属性和脚本中均未发现重量字段；没有 JSON-LD 或 template。局部片段不能排除整页源码其他位置存在数据。现有解析器要求主商品结构化字段 `Item Weight`；通用 Product.weight 辅助函数当前没有调用方，不能凭假设启用为重量回退。

已请求用户直接粘贴普通 Edge 源码页面中包含 `Item Weight`、`110 g` 及相邻 HTML 标签的片段，作为完整保存 HTML 之外的更小证据。无需再次确认重量数值或提供账户信息。

### 收到用户原始源码行后的验证

用户随后提供：

```html
<tr>   <th class="a-color-secondary a-size-base prodDetSectionEntry"> Item Weight </th>  <td class="a-size-base prodDetAttrValue"> 110 g </td> </tr>
```

该行已原样保存为 `test/fixtures/amazon-b09nxs1bll-user-source-weight-row.html`。在现有支持的五种原生规格容器中的离线解析均得到 0.11 kg；解析器不依赖 Voyager 或 prodDet 的字段类名，因此没有依据修改类名选择器。

此前的解析到保存回放现改用这份原始行，仍明确标注外层容器来自旧采集片段，而非用户完整页面。执行命令：

```powershell
node --test --test-name-pattern='B09 user-provided source' test/amazon-product-single-visit.test.mjs
```

结果 1 项通过、0 项失败，未改变生产解析逻辑。

对现有内置浏览器同商品页面做只读 DOM 核对：21 个 `th.prodDetSectionEntry`、8 行 Item details，其中没有 Item Weight 或 110 g 对应行。该结果只描述内置浏览器会话，不能代替普通 Edge。

尝试使用浏览器工具直接查看用户提供的 `view-source:` 地址时，工具按 URL 协议规则拒绝访问，仅允许 HTTP/HTTPS，且明确禁止间接绕过。未再尝试其他途径执行该受阻操作。完整普通 Edge HTML 仍是缺失证据：单个 tr 不包含祖先容器，也不能证明同一次响应到 DOM 的变化。不能据此断言脚本删行或发布猜测性修复。

## 任务保护

当前服务版本 0.9.58；主服务 PID 9200 和守护 PID 6392 的命令行均属于本项目，4173 仅一个监听服务。

原 runId `886a89e6-8e79-4fbd-921f-74ca1da13102` 已完成，workerActive=false；9 项价格已核验，重量 5 项已核验、3 项页面未提供、1 项待核验。B09NXS1BLL 的额外补查预算已耗尽，未重置、强制补查或新建批次；未修改人工数据、1688 验证暂停或速率试验。

本次新增仅为诊断测试和本记录，不代表重量采集问题已解决。
