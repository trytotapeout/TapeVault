# TapeVault

链上加密保险箱：一枚 TapeOut 电路 NFT 就是一个文件夹，文件加密后存进电路容器（BNB Chain · SiteRegistry），全站可作为 DeWEB 发布。

- 无后端、无数据库、无外部脚本；页面 CSP 为 `connect-src 'none'`，读链全部经由用户钱包（EIP-1193 / EIP-6963）。
- 网盘文件只放在容器的 `_tapevault/` 目录下，容器里的其他文件（如 DeWEB 网站）不读不写。

## 当前进度（v0.6.0）

- 连接钱包，自动扫描持有的电路（每枚电路 = 一个文件夹），也可手动添加
- 初始化保险箱：钱包签名 2 次核对签名确定性，写入明文 `_tapevault/_meta.json`（只含格式版本和 keyCheck）
- 解锁：签名 1 次派生密钥，与 keyCheck 核对；密钥只在页面内存里
- 上传：本机加密后按 24 KB 分块写入（`putFile` + `appendChunk`），逐笔确认；中断后可从链上已写入的块数继续
- 列表：只解文件头（前 1100 字节）；同名文件显示最新版本，旧版本保留
- 下载：读全文 → 核对长度与 SHA-256 → 解密
- 遗产托付（测试版）：持有人设置继承人和守护人，定期报平安；超过设定天数后守护人放行碎片，继承人凑够门限数量的碎片并用自己的私钥解开文件夹

## 存储格式

```
_tapevault/_meta.json     明文 {app, v, cipher, kdf, keyCheck}
_tapevault/f/<随机ID>     TVF1 密文，内容类型一律 application/octet-stream
```

- 密钥：`personal_sign(固定消息，含容器地址)` → 取 r‖s → HKDF-SHA256 → 主密钥（AES-256-GCM）
- 每个文件一把随机密钥，由主密钥包裹后放在文件开头；文件名、类型、大小在加密头里（补齐到 1008 字节，不泄露文件名长度）
- 所有 AES-GCM 的附加数据绑定文件 ID，密文换路径就解不开
- 格式细节见 `src/crypto.js` 开头注释

## 遗产托付

```
_tapevault/legacy/s-<秒>-<随机>.json   设置记录（明文 JSON + 持有人签名）
_tapevault/legacy/c-<秒>-<随机>.json   报平安记录（明文 JSON + 持有人签名）
```

- 继承人和守护人各自在线下生成 P-256 密钥对，只把公钥交给持有人：
  `openssl ecparam -name prime256v1 -genkey -noout -out key.pem`，`openssl ec -in key.pem -pubout`
- 设置：持有人签名得到文件夹的 64 字节密钥材料（与解锁同一条消息），
  先用继承人公钥 ECIES 加密（内层），再用随机外锁密钥 AES-GCM 加密（外层）；
  外锁密钥用 Shamir（GF(256)）拆成 n 份，每份用一位守护人的公钥 ECIES 加密
- 每条记录都带持有人 `personal_sign` 签名，读取时经钱包节点调用 `ecrecover` 预编译合约核对，
  只认签名人等于记录里 owner 的；时间取「签名时间」与「链上写入时间」的较小值，防止重放旧签名推后倒计时
- 倒计时用链上时间（Multicall3 `getCurrentBlockTimestamp`），从最后一次报平安算起
- 放行：守护人导入私钥解开自己的碎片，改用继承人公钥重新加密，得到 `tvs1:<编号>:<base64>` 交给继承人
- 继承人：私钥指纹必须与记录一致；碎片不足门限时解不开；解出的密钥用 `keyCheck` 核对
- 格式细节见 `src/legacy-store.js`、`src/seal.js` 开头注释

遗产托付的限制：

- 放行时间靠守护人遵守约定，链上不会在到期时自动执行；继承人与门限数量的守护人串通可以提前解密
- 设置后无法撤回：已上传和之后上传的文件，继承人将来都能解开
- 持有人失联后电路可能落到别人手里，新持有人可以删除容器里的文件；继承人放行后应尽快下载

## 已知限制

- 只支持签名确定的普通钱包（EOA）；智能合约钱包、MPC 钱包会在初始化时被拒绝
- 只有初始化时的钱包能解密；电路转手后新持有人解不开已有文件
- 链上"覆盖"只是新增版本，旧密文永久保留；文件大小（约等于原文大小 + 1128 字节）是公开的
- 单文件最大 512 KB（加密后 22 笔交易，约 0.006 BNB，gas 0.05 gwei 时）；定位是保存个人秘密信息，链上上限 8.4 MB 不开放

## 开发

```bash
npm test               # 单元测试（选择器、ABI 编解码、加密、遗产托付全流程）
npm run live [地址]    # 主网只读冒烟测试（含 ecrecover 与链上时间自检）
# 浏览器里的模拟钱包（内存模拟 SiteRegistry，不发真实交易）：
#   const m = await import('/test/browser-mock.js'); m.install('0x…')
#   m.timeSkew.value = 8 * 86400   // 把链上时间往后拨，测试遗产到期
node dev-server.mjs    # 本地预览 http://127.0.0.1:5178/
```

`dev-server.mjs` 只用于本地开发，发布上链时不要上传它和 `test/`。
