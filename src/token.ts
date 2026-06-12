// Entry-side resolve CF API tokenu (čte process.env / wrangler oauth). ZÁMĚRNĚ mimo pure lib
// (index.ts) — engine zůstává bez process.env; CLI/consumer ho použije pro ctx.apiToken.
// V CI: CLOUDFLARE_API_TOKEN. Lokálně fallback na wrangler OAuth token z configu.
// source: OAuth token NEpokrývá ai-gateway/access REST (scope neexistuje) → provision fail-fast.
export async function resolveCfToken(): Promise<{ token: string; source: 'env' | 'oauth' }> {
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, source: 'env' }
  const cfg = `${process.env.HOME}/.wrangler/config/default.toml`
  const text = await Bun.file(cfg)
    .text()
    .catch(() => '')
  const m = text.match(/oauth_token\s*=\s*"([^"]+)"/)
  if (!m)
    throw new Error(
      'chybí CLOUDFLARE_API_TOKEN i wrangler OAuth token — lokálně `wrangler login` nebo export CLOUDFLARE_API_TOKEN; v CI GH secret (cross-org reusable workflow: předat explicitně, viz header preview.yaml)',
    )
  return { token: m[1]!, source: 'oauth' }
}
