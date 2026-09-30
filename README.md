# TapeVault

链上加密保险箱：一枚 TapeOut 电路 NFT 就是一个文件夹，文件加密后存进电路容器（BNB Chain · SiteRegistry），全站可作为 DeWEB 发布。

- 无后端、无数据库、无外部脚本；页面 CSP 为 `connect-src 'none'`，读链全部经由用户钱包（EIP-1193 / EIP-6963）。
- 网盘文件只放在容器的 `_tapevault/` 目录下，容器里的其他文件（如 DeWEB 网站）不读不写。

## 当前进度（v0.1.0）

- 连接钱包，自动切换到 BNB Smart Chain
- 自动扫描持有的电路：Multicall 读全部处理器的 `balanceOf`，再按 `nextId()` 批量 `ownerOf` 找出 #ID；结果缓存在 localStorage，每次显示前重新核对 `ownerOf`
- 手动添加电路（`4246.0` / `4246.0.tape` / `#4246@0`）
- 文件夹详情：容器地址、是否开通、`_tapevault/` 文件列表

下一步：`_meta.json` 初始化、客户端加密（钱包签名 → HKDF → AES-256-GCM）、`putFile` / `appendChunk` 上传、下载校验与解密。

## 开发

```bash
npm test               # 单元测试（选择器、ABI 编解码、文件夹解析）
npm run live [地址]    # 主网只读冒烟测试
node dev-server.mjs    # 本地预览 http://127.0.0.1:5178/
```

`dev-server.mjs` 只用于本地开发，发布上链时不要上传它和 `test/`。
