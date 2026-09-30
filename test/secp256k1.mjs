// 仅测试用的 secp256k1 personal_sign 实现（BigInt，不防侧信道，不要用于真实私钥）。
import { keccak256 } from '../src/keccak.js';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m = P) => ((a % m) + m) % m;
const inv = (a, m = P) => { let [x, y, u, v] = [mod(a, m), m, 1n, 0n]; while (x) { const q = y / x; [x, y, u, v] = [y - q * x, x, v - q * u, u]; } return mod(v, m); };
function add(p, q) {
  if (!p) return q; if (!q) return p;
  if (p[0] === q[0] && mod(p[1] + q[1]) === 0n) return null;
  const l = p[0] === q[0] ? mod(3n * p[0] * p[0] * inv(2n * p[1])) : mod((q[1] - p[1]) * inv(q[0] - p[0]));
  const x = mod(l * l - p[0] - q[0]);
  return [x, mod(l * (p[0] - x) - p[1])];
}
function mul(k, p = G) { let r = null; for (; k; k >>= 1n, p = add(p, p)) if (k & 1n) r = add(r, p); return r; }
const be = (n) => n.toString(16).padStart(64, '0');
const toBig = (b) => BigInt('0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''));
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function addressOf(priv) {
  const [x, y] = mul(priv);
  const pub = Uint8Array.from((be(x) + be(y)).match(/../g), (h) => parseInt(h, 16));
  return '0x' + hexOf(keccak256(pub)).slice(-40);
}

export function personalSign(priv, text) {
  const msg = new TextEncoder().encode(text);
  const z = toBig(keccak256(new Uint8Array([...new TextEncoder().encode('\x19Ethereum Signed Message:\n' + msg.length), ...msg])));
  for (;;) {
    const k = mod(toBig(crypto.getRandomValues(new Uint8Array(32))), N);
    if (!k) continue;
    const R = mul(k);
    const r = mod(R[0], N);
    if (!r) continue;
    let s = mod(inv(k, N) * (z + r * priv), N);
    if (!s) continue;
    let v = Number(R[1] & 1n);
    if (s > N / 2n) { s = N - s; v ^= 1; }
    return '0x' + be(r) + be(s) + (27 + v).toString(16);
  }
}

export const randomPriv = () => mod(toBig(crypto.getRandomValues(new Uint8Array(32))), N - 1n) + 1n;

/** 纯 JS ecrecover（仅测试用，对应链上预编译合约 0x01）。返回小写地址或 null */
export function recoverPersonal(text, sigHex) {
  const s = String(sigHex).replace(/^0x/, '');
  if (s.length !== 130) return null;
  const r = BigInt('0x' + s.slice(0, 64));
  const sv = BigInt('0x' + s.slice(64, 128));
  let v = parseInt(s.slice(128), 16);
  if (v < 27) v += 27;
  if (!r || r >= N || !sv || sv >= N || (v !== 27 && v !== 28)) return null;
  const msg = new TextEncoder().encode(text);
  const z = toBig(keccak256(new Uint8Array([...new TextEncoder().encode('\x19Ethereum Signed Message:\n' + msg.length), ...msg])));
  // R = (r, y)，y 的奇偶由 v 决定；p ≡ 3 (mod 4)，平方根 = a^((p+1)/4)
  const x = r;
  const a = mod(x * x * x + 7n);
  let y = 1n;
  for (let e = (P + 1n) / 4n, b = a; e; e >>= 1n, b = mod(b * b)) if (e & 1n) y = mod(y * b);
  if (mod(y * y) !== a) return null;
  if (Number(y & 1n) !== v - 27) y = P - y;
  const ri = inv(r, N);
  const Q = add(mul(mod(sv * ri, N), [x, y]), mul(mod(-z * ri, N)));
  if (!Q) return null;
  const pub = Uint8Array.from((be(Q[0]) + be(Q[1])).match(/../g), (h) => parseInt(h, 16));
  return '0x' + hexOf(keccak256(pub)).slice(-40);
}
