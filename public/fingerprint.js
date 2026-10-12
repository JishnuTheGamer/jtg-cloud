// Resume-record lookup only; server authentication and part integrity use native crypto.
// Direct HTTP IP pages may not expose SubtleCrypto, so metadata needs a portable key.
export async function fingerprintDigest(bytes, provider = globalThis.crypto) {
  if (provider?.subtle) {
    const digest = new Uint8Array(await provider.subtle.digest('SHA-256', bytes));
    return [...digest].map(byte => byte.toString(16).padStart(2,'0')).join('');
  }
  const lanes = new Uint32Array([0x811c9dc5,0x9e3779b9,0x85ebca6b,0xc2b2ae35]);
  for (const byte of bytes) for(let index=0;index<lanes.length;index++) lanes[index]=Math.imul(lanes[index]^byte,0x01000193)>>>0;
  return 'ip-'+[...lanes].map(value=>value.toString(16).padStart(8,'0')).join('');
}
