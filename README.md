# Steam 市场批量助手

Chrome / Edge Manifest V3 扩展，用于批量下架 Steam 社区市场中的在售商品，并生成官方批量上架页面。

## 功能

- 通过 Steam 官方 `mylistings/render` 接口分页读取完整在售列表。
- 页面面板和扩展弹窗均可一键在新标签页打开 Steam 社区市场。
- 页面面板和扩展弹窗均可通过游戏名称、Steam 商品链接或市场名称生成官方 `multisell` 页面。
- 按商品名、游戏、AppID、挂单 ID 和价格搜索。
- 新扫描的商品默认不选择；批量操作前显示数量与商品预览并二次确认。
- 下架请求串行执行，支持暂停、立即停止和可取消退避。
- 支持 `Retry-After`，没有该响应头时使用指数退避和随机抖动。
- GET/POST 请求带单次超时；认证异常、持续限流或不明确响应会停止后续队列。
- 下架请求完成后自动重新扫描，以在售列表为准核验结果。
- 面板使用 Shadow DOM 隔离页面样式，被页面移除时会中止活动任务并安全重建。

## 批量上架

1. 展开“批量上架”并选择游戏。内置 Counter-Strike 2、Dota 2、Team Fortress 2、Rust、PUBG 和 Steam 社区物品。
2. 每行粘贴一个 Steam 市场商品页链接；也可以直接输入市场名称。在具体商品页中可点击“添加当前页面商品”。
3. 点击“打开官方批量上架”，在新标签页中设置数量和价格并由 Steam 完成最终确认。

传统商品链接会自动提供精确的 `market_hash_name` 并识别游戏；遇到 Steam 新版 `G...` 商品组链接时，请在该商品页点击“添加当前页面商品”，扩展会从页面数据读取标准市场名称。无法唯一识别时会阻止生成链接并提示手动输入，避免把内部商品组 ID 误传给 Steam。重复名称会自动合并；同种物品的数量在 Steam 页面中选择，不同游戏的链接需要分批处理。

只有选择“其他游戏（高级）”时才需要修改 AppID 和 ContextID。AppID 是游戏应用 ID，不是单件库存资产或挂单的编号。商品链接本身不包含 ContextID，未知游戏会暂用 `2` 并要求在高级设置中确认；Steam 社区物品使用 `appid=753&contextid=6`。Steam 的批量出售页面主要用于可堆叠的同质商品。

扩展每次最多接受 100 种物品，并限制最终 URL 长度，以避免浏览器或 Steam 拒绝过长链接。这是扩展的本地保护限制，不是 Steam 官方配额。

## 安装

1. 打开 `chrome://extensions/` 或 `edge://extensions/`。
2. 启用开发者模式。
3. 选择“加载已解压的扩展程序”，指向本目录。
4. 打开或刷新 `https://steamcommunity.com/market/`。

## 权限与隐私

- 内容脚本只匹配 `https://steamcommunity.com/market/*`。
- `content.css` 仅作为扩展自身的 Shadow DOM 样式资源暴露给 `steamcommunity.com`。
- 扩展不声明 `cookies`、`storage`、`tabs`、`activeTab`、`scripting` 或远程主机权限。
- `sessionid` 只在执行下架时从当前 Steam 页面读取，并仅提交到同源的 Steam 官方下架接口。
- 批量上架工具只生成并打开固定域名下的 Steam 官方页面，不读取 `sessionid`、不填写价格，也不自动提交出售请求。
- 不包含遥测、远程脚本、第三方请求或账号数据存储。

## 本地测试

测试不会连接 Steam，也不会执行真实下架请求：

```powershell
node --test tests\*.test.cjs
```

发布前还应执行：

```powershell
node --check core.js
node --check content.js
node --check popup.js
```

## 目录

- `core.js`：状态、筛选、链接校验、重试、取消和队列逻辑，可独立测试。
- `content.js`：Steam 页面解析、批量上架入口、面板交互和请求核验。
- `content.css`：页面面板样式。
- `popup.html` / `popup.js`：扩展状态、市场入口与批量上架链接生成器。
- `tests/*.test.cjs`：无网络核心回归与界面连线测试。
