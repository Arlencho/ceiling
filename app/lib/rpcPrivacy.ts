/** Endpoints safe to display and hand to an agent. Never use app credentials. */
export function publicRpcFor(cluster: string): string {
  switch (cluster) {
    case 'devnet': return 'https://api.devnet.solana.com';
    case 'testnet': return 'https://api.testnet.solana.com';
    case 'mainnet-beta': return 'https://api.mainnet-beta.solana.com';
    default: throw new Error('Unsupported public RPC cluster');
  }
}

/** Sanitize URLs embedded in errors as well as standalone RPC URLs. */
export function redactRpc(url: string): string {
  return url
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => value
      .replace(/^(https?:\/\/)[^/?#]*@/i, '$1[redacted]@')
      .replace(/[?#].*$/, '[redacted]'))
    .replace(/api-key\s*=\s*[^\s&<>"']*/gi, '[redacted]');
}
