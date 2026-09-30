// 主网只读冒烟测试（手动运行：npm run live [钱包地址]）。直连公共节点，只发 eth_call / eth_blockNumber。
import { createChain } from '../src/chain.js';
import { scanFolders, verifyFolders } from '../src/folders.js';

const RPC = process.env.RPC || 'https://bsc-dataseed.bnbchain.org';
const wallet = process.argv[2] || '0x571d447f4f24688ec35ccf07f1d6993655f6af15'; // 4246.0.tape 的持有人（2026-09-30）

let id = 0;
const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ': ' + j.error.message);
  return j.result;
};

const chain = createChain(rpc);
const t0 = Date.now();
const scan = await scanFolders(chain, wallet, { onProgress: (p) => p.stage === 'ids' && p.done === p.total && console.log(`  cpu ${p.cpu}: scanned ${p.total} ids`) });
console.log(`processors: ${scan.cpus.length}, found: ${scan.found.length}, skipped: ${scan.skipped.length}, ${Date.now() - t0}ms`);
for (const s of scan.skipped) console.log('  skipped', s);
const folders = await verifyFolders(chain, wallet, scan.found, scan.cpus, scan.block);
for (const f of folders) {
  const v = f.opened ? await chain.vaultListing(f.container, scan.block) : null;
  console.log(`  ${f.label}  container=${f.container} opened=${f.opened} cpu="${f.cpuName}"`
    + (v ? ` vault=${v.initialized ? 'yes' : 'no'} vaultFiles=${v.files.length} otherFiles=${v.otherFileCount}` : ''));
}

// ecrecover 预编译：随机私钥签一条消息，节点恢复出的地址应与私钥地址一致
{
  const { personalSign, addressOf, randomPriv } = await import('./secp256k1.mjs');
  const priv = randomPriv();
  const text = 'TapeVault ecrecover self-test ' + Date.now();
  const sig = personalSign(priv, text);
  const got = await chain.recoverSigner(text, sig);
  const want = addressOf(priv);
  console.log(`ecrecover: ${got === want ? 'ok' : 'MISMATCH'} (${want})`);
  if (got !== want) process.exitCode = 1;
  const bad = await chain.recoverSigner(text + 'x', sig);
  console.log(`ecrecover tampered: ${bad !== want ? 'ok' : 'MISMATCH'}`);
}
