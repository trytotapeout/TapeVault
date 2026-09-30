// 网络常量。地址来自 TapeKit SPEC §3.1（BNB Smart Chain 主网），2026-09-30 只读核对过。
// 函数选择器 = keccak256(签名) 前 4 字节，test/abi.test.mjs 会逐个重算核对。

export const BSC = Object.freeze({
  chainId: 56,
  chainIdHex: '0x38',
  name: 'BNB Smart Chain',
  currency: 'BNB',
  factory: '0x68224f668083c29e9800be2a646d42d18cedf7e2',
  opener: '0x021745de2f42a7839d96f2d3634d0294487d81f1',
  registry: '0xd006ffdd5ae313b17729621a00999cd3c71ce5e6',
  multicall3: '0xca11bde05977b3631167028862be2a173976ca11',
  // 仅用于 wallet_addEthereumChain；读链一律走用户钱包自己的节点
  rpcUrls: Object.freeze(['https://bsc-dataseed.bnbchain.org']),
  explorer: 'https://bscscan.com',
});

// TapeVault 在容器里的专属目录。所有网盘文件都在这个前缀下，容器里的其他文件（DeWEB 网站等）不读不写。
export const VAULT_PREFIX = '_tapevault/';
export const VAULT_META = VAULT_PREFIX + '_meta.json';

export const SIG = Object.freeze({
  cpuCount: 'cpuCount()',
  cpuAt: 'cpuAt(uint256)',
  accountOf: 'accountOf(address,uint256)',
  isOpened: 'isOpened(address,uint256)',
  ownerOf: 'ownerOf(uint256)',
  balanceOf: 'balanceOf(address)',
  name: 'name()',
  nextId: 'nextId()',
  fileInfo: 'fileInfo(address,string)',
  pathCount: 'pathCount(address)',
  pathsRange: 'pathsRange(address,uint256,uint256)',
  aggregate3: 'aggregate3((address,bool,bytes)[])',
  read: 'read(address,string)',
  readRange: 'readRange(address,string,uint256,uint256)',
  putFile: 'putFile(address,string,string,bytes32,bytes)',
  appendChunk: 'appendChunk(address,string,uint256,bytes)',
  removeFile: 'removeFile(address,string)',
});

export const SEL = Object.freeze({
  cpuCount: '0xa94da8a7',
  cpuAt: '0x4bc7cbbd',
  accountOf: '0x0c1905e5',
  isOpened: '0x8b508494',
  ownerOf: '0x6352211e',
  balanceOf: '0x70a08231',
  name: '0x06fdde03',
  nextId: '0x61b8ce8c',
  fileInfo: '0x6c609107',
  pathCount: '0xb554782b',
  pathsRange: '0xb056072c',
  aggregate3: '0x82ad56cb',
  read: '0xccaa7afb',
  readRange: '0x15a4cae2',
  putFile: '0xfab2ed82',
  appendChunk: '0xe2b51347',
  removeFile: '0x0a9c1871',
});

// SiteRegistry 写入限制（SPEC §5 / README）：每块最多 24,000 字节，最多 350 块
export const CHUNK_SIZE = 24000;
export const MAX_FILE_BYTES = 350 * CHUNK_SIZE;
// readRange 每段读取字节数（SPEC 建议 96 KB）
export const READ_RANGE = 96000;
// 链上文件的内容类型：密文一律标成二进制，不暴露原文件类型
export const CIPHER_CONTENT_TYPE = 'application/octet-stream';
// 单文件上传上限。链上允许 8.4 MB，但每 24 KB 就要一笔交易、用户逐笔确认。
// TapeVault 定位是保存个人秘密信息，限制在 512 KB（加密后 22 笔交易）
export const MAX_UPLOAD_BYTES = 512 * 1024;
export const MAX_UPLOAD_LABEL = '512 KB';

// 单次 Multicall 打包的调用数。公共节点对 eth_call 有 gas 上限，ownerOf/balanceOf 都很轻，400 个留足余量。
export const MULTICALL_BATCH = 400;
// 单个处理器按编号扫描持有的电路时，最多扫多少个编号；超过就改为手动添加，避免把钱包节点打爆。
export const MAX_IDS_PER_CPU = 50000;
// 列文件夹内容时每页读取的路径数
export const PATHS_PAGE = 200;
