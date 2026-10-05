# TapeVault

链上加密保险箱：一枚 TapeOut 电路 NFT 就是一个文件夹，文件加密后存进电路容器（BNB Chain · SiteRegistry），全站可作为 DeWEB 发布。

- 无后端、无数据库、无外部脚本；页面 CSP 为 `connect-src 'none'`，读链全部经由用户钱包（EIP-1193 / EIP-6963）。
- 网盘文件只放在容器的 `_tapevault/` 目录下，容器里的其他文件（如 DeWEB 网站）不读不写。

## 当前进度（v0.7.5）

- 连接钱包，自动扫描持有的电路（每枚电路 = 一个文件夹），也可手动添加
- 初始化保险箱：钱包签名 2 次核对签名确定性，写入明文 `_tapevault/_meta.json`（只含格式版本和 keyCheck）
- 解锁：签名 1 次派生密钥，与 keyCheck 核对；密钥只在页面内存里
- 重置：密钥核对不上（电路转手来的、旧版本初始化的）时，持有人可以勾选确认后重置：重新签名 2 次并覆盖 `_meta.json`。旧密文删不掉也解不开，列表里不再显示；用旧密钥设置的托付随之失效（只认 keyCheck 与当前 `_meta.json` 一致的托付）
- 上传：本机加密后按 24 KB 分块写入（`putFile` + `appendChunk`），逐笔确认；中断后可从链上已写入的块数继续
- 手写文字：上传区可以直接写一段文字，存成 `.txt` 或 `.md` 后和普通文件一样加密上传；文本框关闭拼写检查和自动填充，草稿只在页面内存里（不写 localStorage），未上传时关闭页面会提醒
- 列表：只解文件头（前 1100 字节）；同名文件显示最新版本，旧版本保留
- 下载：读全文 → 核对长度与 SHA-256 → 解密
- 托付保险箱（测试版）：持有人设置受托人和守护人，定期报平安；超过设定天数后守护人放行碎片，受托人凑够门限数量的碎片并用自己的私钥解开文件夹
- 中英文切换：顶栏 EN / 中 按钮，默认跟随浏览器语言，选择保存在本机；词典在 `src/i18n-en.js`，以中文原文为键

## 存储格式

```
_tapevault/_meta.json     明文 {app, v, cipher, kdf, keyCheck}
_tapevault/f/<随机ID>     TVF1 密文，内容类型一律 application/octet-stream
```

- 密钥：`personal_sign(固定消息，含容器地址)` → 取 r‖s → HKDF-SHA256 → 主密钥（AES-256-GCM）
- 每个文件一把随机密钥，由主密钥包裹后放在文件开头；文件名、类型、大小在加密头里（补齐到 1008 字节，不泄露文件名长度）
- 所有 AES-GCM 的附加数据绑定文件 ID，密文换路径就解不开
- 格式细节见 `src/crypto.js` 开头注释

## 托付保险箱

```
_tapevault/legacy/s-<秒>-<随机>.json   设置记录（明文 JSON + 持有人签名）
_tapevault/legacy/c-<秒>-<随机>.json   报平安记录（明文 JSON + 持有人签名）
```

- 受托人和守护人各自在线下生成 P-256 密钥对，只把公钥交给持有人：
  `openssl ecparam -name prime256v1 -genkey -noout -out key.pem`，`openssl ec -in key.pem -pubout`
- 设置：持有人签名得到文件夹的 64 字节密钥材料（与解锁同一条消息），
  先用受托人公钥 ECIES 加密（内层），再用随机外锁密钥 AES-GCM 加密（外层）；
  外锁密钥用 Shamir（GF(256)）拆成 n 份，每份用一位守护人的公钥 ECIES 加密
- 每条记录都带持有人 `personal_sign` 签名，读取时经钱包节点调用 `ecrecover` 预编译合约核对，
  只认签名人等于记录里 owner 的；时间取「签名时间」与「链上写入时间」的较小值，防止重放旧签名推后倒计时
- 倒计时用链上时间（Multicall3 `getCurrentBlockTimestamp`），从最后一次报平安算起
- 放行：守护人导入私钥解开自己的碎片，改用受托人公钥重新加密，得到 `tvs1:<编号>:<base64>` 交给受托人
- 受托人：私钥指纹必须与记录一致；碎片不足门限时解不开；解出的密钥用 `keyCheck` 核对
- 格式细节见 `src/legacy-store.js`、`src/seal.js` 开头注释

托付的限制：

- 放行时间靠守护人遵守约定，链上不会在到期时自动执行；受托人与门限数量的守护人串通可以提前解密
- 设置后无法撤回：已上传和之后上传的文件，受托人将来都能解开
- 持有人失联后电路可能落到别人手里，新持有人可以删除容器里的文件；受托人放行后应尽快下载

## 已知限制

- 只支持签名确定的普通钱包（EOA）；智能合约钱包、MPC 钱包会在初始化时被拒绝
- 只有初始化时的钱包能解密；电路转手后新持有人解不开已有文件
- 链上"覆盖"只是新增版本，旧密文永久保留；文件大小（约等于原文大小 + 1128 字节）是公开的
- 单文件最大 512 KB（加密后 22 笔交易，约 0.006 BNB，gas 0.05 gwei 时）；定位是保存个人秘密信息，链上上限 8.4 MB 不开放

## 开发

```bash
npm test               # 单元测试（选择器、ABI 编解码、加密、托付全流程）
npm run live [地址]    # 主网只读冒烟测试（含 ecrecover 与链上时间自检）
# 浏览器里的模拟钱包（内存模拟 SiteRegistry，不发真实交易）：
#   const m = await import('/test/browser-mock.js'); m.install('0x…')
#   m.timeSkew.value = 8 * 86400   // 把链上时间往后拨，测试托付到期
node dev-server.mjs    # 本地预览 http://127.0.0.1:5178/（直接用源码）
```

## 发布到 DeWEB

```bash
npm install            # 只需要一次：安装 esbuild（固定版本，只在构建时用）
npm run build          # 打包压缩到 dist/，并做自检
npm run preview        # 构建后用 dist/ 起本地预览，发布前走一遍
```

`dist/` 里的 4 个文件就是要上传到容器的全部内容：`index.html`、`style.<hash>.css`、`src/theme.<hash>.js`、`src/app.<hash>.js`。content type 分别是 `text/html`、`text/css`、`text/javascript`、`text/javascript`。

资源文件名带内容哈希：链上发布器（如 TapeOutScan）只允许替换 `index.html`，同名资源内容不同会被拒绝覆盖。更新网站时整个 `dist/` 选上传，内容没变的文件自动复用，改过的以新文件名上传，最后勾选"允许最后替换首页"替换 `index.html`。旧版资源留在链上，以后可以重新发布旧版 `dist/` 回退。

构建会检查：页面引用的文件都在、CSP 仍是 `connect-src 'none'`、没有混进测试或开发代码、钱包签名的固定文字原样保留、压缩后的 `data-i18n` 文案仍能对上英文词典、页脚版本号与 `package.json` 一致。构建输出每个文件的 SHA-256，可以和链上 `fileInfo` 核对。

钱包签名的文字（`crypto.keyMessage`、`legacy-store.signText`）永远是固定中文，不随界面语言变化：改动会让已有文件夹派生不出原密钥、已有托付记录核对不过签名。v0.7.2 在正式使用前最后一次改了这些文字（「TapeVault 文件夹密钥」版本 2、「TapeVault 托付：设置 / 报平安」），之前的测试文件夹和托付记录不再能解开；此后不再改动。`test/i18n.test.mjs` 会检查每条 `t('…')` 都有英文且占位符一致。

### GitHub Pages

`github_pages/` 是同一份构建产物的副本，由 `.github/workflows/pages.yml` 原样发布到 GitHub Pages（CI 不重新构建，线上文件与链上 DeWEB 的文件逐字节一致）。发版时：

```bash
npm run pages          # 构建并把 dist/ 复制到 github_pages/
```

然后提交 `github_pages/` 并 push，改动推到 main 后自动发布。

`dev-server.mjs` 和 `test/` 只用于本地开发，不在 `dist/` 里。更新网站时不要动容器里的 `_tapevault/` 目录。

## 参与共建

欢迎提 Issue 和 PR，一起把 TapeVault 做好。比起各自 fork 出独立分支，更希望改进能合回主仓库，让所有用户都用上。

- 仓库：[github.com/trytotapeout/TapeVault](https://github.com/trytotapeout/TapeVault)
- 提 PR 前请跑 `npm run -s check`、`npm test`、`npm run -s build`，全部通过再提交；改动界面文案时同步更新 `src/i18n-en.js`
- 以下内容属于存储协议，改动会让已有用户的文件夹解不开，请不要修改：钱包签名的固定文字（`crypto.keyMessage`、`legacy-store.signText`）、`_tapevault/` 目录结构、HKDF 参数、TVF1 文件格式
- 页面 CSP 保持 `connect-src 'none'`，不引入外部脚本和网络请求
- 大的改动（新功能、格式变化）建议先开 Issue 讨论

### DCO 签名

提交须遵守 [Developer Certificate of Origin](DCO)：每个提交都要带 `Signed-off-by` 行，表示你有权以本项目的开源协议提交这些代码。提交时加 `-s` 即可：

```bash
git commit -s -m "feat: ..."
```

`Signed-off-by` 的邮箱须与提交作者邮箱一致（即 `git config user.email`）。PR 会自动检查（`.github/workflows/dco.yml`），漏签的提交可以这样补上：

```bash
git rebase --signoff origin/main && git push --force-with-lease
```

## 开源协议

[GPL-3.0-or-later](LICENSE)：GNU GPL 第 3 版或（按你的选择）任何更新的版本。可以自由使用、修改和再分发；分发修改后的版本时，须以同样的协议公开完整源码。
