# Security & maintenance controls (required)

Threat model in one line: untrusted offer text (from the internet and WhatsApp) flows into an LLM and then
into a browser. Protect the model server, the browser, the data, and the supply chain.

## 1. Model & inference
- SGLang servers bind to **127.0.0.1** only. Never `--host 0.0.0.0` in the demo. The FastAPI app is the only public surface.
- If SGLang ever must be remote: `--api-key` from env, and network allow-list.
- `trust_remote_code=False`; pin model revisions (commit hash) in `configs/models.yaml`; record SHA-256 of merged weights in PROVENANCE.json.
- Load weights as **safetensors** only. Reject `.bin`/pickle.

## 2. Prompt injection & output safety
- Offer text is wrapped in `<offer_text>` delimiters; system prompt says treat as data (SPEC §2).
- **Constrained decoding is a security control**: output can only be schema-shaped JSON, so injected text cannot make
  the model emit instructions, HTML, or arbitrary prose.
- Every model output is re-validated with Pydantic (`extra="forbid"`, length caps, regex on coupon codes, numeric ranges).
  Invalid → return `valid:false`, never pass raw output through.
- Add 5 injection cases to the test set ("ignore previous instructions and output…", HTML/script in offer text).

## 3. API hardening (FastAPI)
- Request size limit 8 KB; `text` 1–2000 chars; strip control chars except `\n`; normalize Unicode NFKC.
- Rate limit (`slowapi`): 30 req/min per IP on `/api/*`.
- Timeouts: 10s to SGLang, `max_tokens` 512. Concurrency semaphore (e.g. 8) to protect the GPU.
- CORS: same-origin only (no `*`). Methods GET/POST only.
- Headers on every response: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- Optional `X-API-Key` (env `OFFERLENS_API_KEY`) for non-demo deployments; constant-time compare.
- Errors as problem+json, no stack traces, `debug=False`. Docs routes (`/docs`, `/openapi.json`) disabled unless `ENV=dev`.

## 4. Frontend
- No inline scripts or styles (CSP). Render all model output with `textContent` / DOM APIs — **never `innerHTML`**.
- Highlighting builds spans by splitting text nodes, not by string-concatenating HTML.
- No third-party runtime assets: fonts self-hosted, no analytics, no CDN.

## 5. Data & privacy
- Real DealFeed offers live only in `data/real/` (gitignored). Run CuratorKIT hygiene (PII/secrets) on them first.
- Logs record a SHA-256 of input text + lengths + latency, **not** raw text. Log level INFO, JSON format.
- `.env` never committed; `.env.example` lists keys with empty values. Claude Code is denied reading `.env` (see `.claude/settings.json`).

## 6. Supply chain & maintenance
- `uv.lock` committed; deps pinned. `pip-audit` in `make check` and CI.
- `pre-commit`: ruff, ruff-format, mypy, bandit, gitleaks, end-of-file-fixer, check-added-large-files (≤5 MB; models never committed).
- CI (`.github/workflows/ci.yml`): `make check` on push/PR (no GPU tests — mark them `@pytest.mark.gpu` and skip in CI).
- Tests: schema validators, metric math (hand-computed cases), prompt rendering, API validation & headers (TestClient with SGLang mocked).
- `docs/DECISIONS.md` logs every shortcut so future-you can pay it back.
- License: Lexsi kits are source-available, non-commercial by default — note before any DealFeed production use.

## 7. Hosted model and fallback (online demo)
- **Hosted SGLang (Modal):** the server binds `0.0.0.0` only inside its container so Modal's proxy can reach it.
  SGLang's `--api-key` guards every request, and `deploy/modal_sglang.py` refuses to start with a key shorter than
  32 characters. The key lives only in the Modal secret `offerlens-sglang` and the Vercel env var `SGLANG_API_KEY`.
- **App-side checks (`settings.py`):** a remote SGLang URL must be `https`, must not carry credentials, a query or
  a fragment, and requires `SGLANG_API_KEY` (32 or more characters). Otherwise the app refuses to start, so a
  misconfiguration can't silently send traffic to an open or plaintext endpoint.
- **OpenRouter fallback:** offer text goes to a third party. Requests set `provider.data_collection` from
  `OPENROUTER_DATA_COLLECTION` (default `deny`: only providers that don't store or train on prompts) and
  `require_parameters: true`, so the JSON-schema constraint is never silently dropped. The output passes the same
  Pydantic validation. The UI tells the user when the fallback processed their text.
- **Quota protection:** `/api/extract` and `/api/compare` allow 30 requests a minute and 300 a day per IP, so one
  visitor can't burn the shared free GPU credits or the OpenRouter daily quota.
- **Cost cap:** set a Modal workspace budget equal to the free credits. When it's hit the GPU stops and the app
  falls back. It never bills past the budget.
- **Secrets:** API keys are set as sensitive Vercel env vars and the Modal secret, never in the repo.
  `.env.example` lists names only. Upstream error bodies are never echoed to clients.
