// Entry-side resolve CF API tokenu (čte process.env / wrangler oauth). ZÁMĚRNĚ mimo pure lib
// (index.ts) — engine zůstává bez process.env; CLI/consumer ho použije pro ctx.apiToken.
// V CI: CLOUDFLARE_API_TOKEN. Lokálně fallback na wrangler OAuth token z configu.
export async function resolveCfToken(): Promise<string> {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN
  const cfg = `${process.env.HOME}/.wrangler/config/default.toml`
  const m = (await Bun.file(cfg).text()).match(/oauth_token\s*=\s*"([^"]+)"/)
  if (!m) throw new Error('chybí CLOUDFLARE_API_TOKEN i wrangler OAuth token')
  return m[1]!
}
