# src/auth

Credential lifecycle: how the proxy obtains, stores, and resolves the upstream credential.
Two paths — `apikey` (a key you already have) and `oauth` (browser login → token exchange →
API-key resolution). Both converge on a `Credential` that `proxy/upstream.ts` turns into auth
headers per request.

## STRUCTURE
```
auth/
├── manager.ts    # AuthManager: per-request getCredential() (apikey | oauth)
├── apikey.ts     # createApiKeyCredential(): parse "{apiKey}.{secret}" / "{apiKey}"
├── oauth.ts      # ZaiOAuthClient / BigmodelOAuthClient: auth-code flow + token exchange
├── resolver.ts   # KeyResolver: OAuth token → biz token → org/project → coding-plan API key
├── store.ts      # AES-256-GCM encrypted credential file (~/.zcode-proxy/credentials.json)
└── types.ts      # Credential, AuthMode, credentialString(), isExpired()
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Change per-request credential selection | `manager.ts:getCredential` | apikey returns parsed key; oauth loads+decrypts, checks expiry |
| Fix provider-specific key format | `apikey.ts` + `types.ts:credentialString` | zai = `{apiKey}.{secret}`, bigmodel = `{apiKey}` |
| Change the OAuth login flow | `oauth.ts` | auth-code flow only; callback binds `127.0.0.1` |
| Change how an OAuth token becomes an API key | `resolver.ts` | biz token → customerInfo → org/project → find/create key |
| Change credential storage / key derivation | `store.ts` | AES-256-GCM; key from `ZCODE_CREDENTIAL_SECRET` or host-derived fallback |
| Add/adjust an expiry rule | `types.ts:isExpired` | drives whether oauth re-resolution kicks in |

## CONVENTIONS
- **Credential format is provider-specific and split-on-first-dot.** Z.AI needs `{apiKey}.{secret}` (the proxy sends the whole string as `x-api-key`); Bigmodel sends `{apiKey}` only. `credentialString()` assembles it; never JSON-split or trim it.
- **OAuth is auth-code, not device/poll.** The legacy `/oauth/cli/init` + `/oauth/cli/poll` endpoints 404. Both providers share one token-exchange endpoint at `zcode.z.ai`; only the authorize URL + query-param scheme differ (`oauth.ts` `AuthCodeConfig`).
- **Key resolution is a 3-call chain** (`resolver.ts`): `getCustomerInfo` (pick org "默认机构" + project "默认项目") → list/create `api_keys` (name `zcode-api-key`) → `api_keys/copy/{id}` for the `secretKey`. Z.AI stitches `{apiKey}.{secret}`; Bigmodel keeps just `apiKey`.
- **OAuth credentials carry an optional `jwt`** for start-plan (the `zcode.z.ai` gateway token) alongside the provider `apiKey`. Don't drop it on save/load.
- **The callback server is localhost-only** (`oauth.ts:138`, `127.0.0.1`). Security requirement — don't widen it.

## ANTI-PATTERNS
- **Don't split a Z.AI key on every dot** — split on the FIRST dot only (`{apiKey}.{secret}`); a secret may itself contain dots.
- **Don't skip `isExpired()`** before handing out an oauth credential — a stale token surfaces as upstream 401, not a clean proxy error.
- **Don't print the full credential string.** It's the upstream secret. `index.ts` only ever logs `apiKey.substring(0,12)...`.
