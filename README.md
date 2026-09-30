# TapeVault

链上加密保险箱：一枚 TapeOut 电路 NFT 就是一个文件夹，文件加密后存进电路容器（BNB Chain · SiteRegistry），全站可作为 DeWEB 发布。

- 无后端、无数据库、无外部脚本；页面 CSP 为 `connect-src 'none'`，读链全部经由用户钱包（EIP-1193 / EIP-6963）。
- 网盘文件只放在容器的 `_tapevault/` 目录下，容器里的其他文件（如 DeWEB 网站）不读不写。

## 当前进度（v0.2.0）

- 连接钱包，自动扫描持有的电路（每枚电路 = 一个文件夹），也可手动添加
- 初始化保险箱：钱包签名 2 次核对签名确定性，写入明文 `_tapevault/_meta.json`（只含格式版本和 keyCheck）
- 解锁：签名 1 次派生密钥，与 keyCheck 核对；密钥只在页面内存里
- 上传：本机加密后按 24 KB 分块写入（`putFile` + `appendChunk`），逐笔确认；中断后可从链上已写入的块数继续
- 列表：只解文件头（前 1100 字节）；同名文件显示最新版本，旧版本保留
- 下载：读全文 → 核对长度与 SHA-256 → 解密

## 存储格式

```
_tapevault/_meta.json     明文 {app, v, cipher, kdf, keyCheck}
_tapevault/f/<随机ID>     TVF1 密文，内容类型一律 application/octet-stream
```

- 密钥：`personal_sign(固定消息，含容器地址)` → 取 r‖s → HKDF-SHA256 → 主密钥（AES-256-GCM）
- 每个文件一把随机密钥，由主密钥包裹后放在文件开头；文件名、类型、大小在加密头里（补齐到 1008 字节，不泄露文件名长度）
- 所有 AES-GCM 的附加数据绑定文件 ID，密文换路径就解不开
- 格式细节见 `src/crypto.js` 开头注释

## 已知限制

- 只支持签名确定的普通钱包（EOA）；智能合约钱包、MPC 钱包会在初始化时被拒绝
- 只有初始化时的钱包能解密；电路转手后新持有人解不开已有文件
- 链上"覆盖"只是新增版本，旧密文永久保留；文件大小（约等于原文大小 + 1128 字节）是公开的
- 单文件先限制 2 MB（约 88 笔交易）；写入约 220 gas/字节，1 MB 约 0.012 BNB（gas 0.05 gwei 时）

## 开发

```bash
npm test               # 单元测试（选择器、ABI 编解码、文件夹解析）
npm run live [地址]    # 主网只读冒烟测试
# 浏览器里的模拟钱包（内存模拟 SiteRegistry，不发真实交易）：
#   const m = await import('/test/browser-mock.js'); m.install('0x…')
node dev-server.mjs    # 本地预览 http://127.0.0.1:5178/
```

`dev-server.mjs` 只用于本地开发，发布上链时不要上传它和 `test/`。
