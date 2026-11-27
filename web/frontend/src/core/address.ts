const ABC = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

export const isAccount = (a: string): boolean => /^g1[02-9ac-hj-np-z]{38}$/.test(a);

/** Where a realm keeps its coins and tokens: the first 20 bytes of sha256("pkgPath:" + path), in bech32. */
export async function realmAddress(path: string): Promise<string> {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pkgPath:' + path))).subarray(0, 20), d: number[] = [];
  let acc = 0, n = 0;
  for (const x of b) { acc = ((acc << 8) | x) & 0xfff; n += 8; while (n >= 5) { n -= 5; d.push((acc >> n) & 31); } }
  let c = 1;
  for (const v of [3, 0, 7, ...d, 0, 0, 0, 0, 0, 0]) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ v; [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3].forEach((g, i) => { if ((t >>> i) & 1) c ^= g; }); }
  c = (c ^ 1) >>> 0;
  return 'g1' + [...d, ...[0, 1, 2, 3, 4, 5].map((i) => (c >>> (5 * (5 - i))) & 31)].map((i) => ABC[i]).join('');
}
