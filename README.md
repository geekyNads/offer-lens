# OfferLens

Messy Indian deal text in, schema-valid JSON out, on a fine-tuned 1.5B open model served by SGLang.

Built for Syntax Error 2026, Local LLM Track, Problem Statement #5 (Structured output and extraction).

**Live demo:** https://offer-lens-fawn.vercel.app (extraction works once the hosted model or fallback is set up;
see [step 9](#9-make-the-online-demo-extract-hosted-sglang--fallback).)

![OfferLens](media/icon-600x600.png)

## What it does

OfferLens reads bank T&Cs, coupon SMSes and Hinglish WhatsApp forwards and returns one JSON record per offer:
merchant, issuer (bank, card or wallet), offer type, value and unit, cap, minimum order, coupon code, validity
dates, payment modes, exclusions and per-user limit. Fields the text does not state come back as `null`, not
guesses.

Illustrative input and output shape (not a measured result):

```
Input:  "Flat 10% cashback upto Rs 150 on HDFC CC, min txn Rs 999, valid till 31st Oct. Not on EMI"

Output: {"offers": [{"merchant": null, "issuer": "HDFC Bank", "offer_type": "cashback",
         "value": 10, "value_unit": "percent", "max_cap_inr": 150, "min_order_inr": 999,
         "coupon_code": null, "valid_from": null, "valid_till": "2026-10-31",
         "payment_modes": ["credit_card"], "exclusions": ["EMI transactions"], "per_user_limit": null}]}
```

The claim the project tests:

- Constrained decoding alone gives valid JSON, but the values can be wrong.
- Fine-tuning fixes the values. Together they give output that is both valid and accurate, on a small local model.

## How it works

| Stage | Tool | What happens |
|---|---|---|
| 1. Data | SGLang teacher + CuratorKIT | Offer specs (the ground truth) are sampled in Python. A 7B teacher writes messy text for each spec in one of 8 styles. A deterministic gate checks that every fact made it into the text. CuratorKIT then runs dedup, a secrets gate and an LLM judge, and exports `sft_messages`. |
| 2. Fine-tune | AlignTune | LoRA SFT of Qwen2.5-1.5B-Instruct, then merged into safetensors. |
| 3. Evaluate | AuditKIT + SGLang | Conditions A (base, free text), B (base + JSON-schema grammar), C (fine-tuned + grammar) and D (teacher + grammar), with custom extraction metrics. |
| Demo | FastAPI + plain HTML/JS | Extract, Compare and Results views, with source highlighting. |

All inference goes through SGLang's OpenAI-compatible API with
`response_format={"type": "json_schema", ...}`. Every output is re-validated with Pydantic, and an invalid
output is returned as `valid: false`, never passed through.

## Results

Filled automatically from `reports/results.json` by `make report`. Do not edit by hand.

<!-- results:start -->
_No results yet. Run `make eval`, then `make report`._
<!-- results:end -->

## Screenshots

| Extract | Mobile (375px) | Dark mode |
|---|---|---|
| ![Extract](media/02-extract-hinglish-example.png) | ![Mobile](media/06-mobile-375.png) | ![Dark](media/07-dark-mode.png) |

These show the UI only. No model server was running when they were taken. More are in `media/`.

## Requirements

- Python 3.12 and [uv](https://docs.astral.sh/uv/)
- One of:
  - **Apple Silicon Mac** (tested on an M4 with 16 GB). SGLang must be built from source with the MLX backend.
  - **Linux with an NVIDIA GPU** (24 GB or more recommended). Install SGLang from PyPI.
- About 15 GB of free disk space for models
- A Hugging Face account. The models used are public; set `HF_TOKEN` if you hit rate limits.

## How to run

### 1. Clone and configure

```bash
git clone https://github.com/geekyNads/offer-lens.git
cd offer-lens
cp .env.example .env
```

Edit `.env` if you need to. The defaults use ports 30000 (teacher), 30001 (student), 30002 (base) and
8000 (app). Set `GPU_COST_INR_PER_HOUR` if you want cost-per-1k numbers in the report.

### 2. Install the project

```bash
make setup
```

This creates `.venv`, installs the package with the Lexsi kits, exports `src/offerlens/schema.json` and
downloads the self-hosted fonts into `web/fonts/`.

### 3. Install SGLang

SGLang runs from its own virtual environment so its pins don't clash with the training stack.

**Apple Silicon** (from the [SGLang Apple Metal docs](https://docs.sglang.io/docs/hardware-platforms/apple_metal)):

```bash
git clone https://github.com/sgl-project/sglang.git ~/code/sglang
cd ~/code/sglang
uv venv -p 3.12 .venv
rm -f python/pyproject.toml && mv python/pyproject_other.toml python/pyproject.toml
VIRTUAL_ENV=.venv uv pip install -e "python[all_mps]"
cd -
```

The Makefile expects it at `~/code/sglang/.venv/bin/python`. Override this with `SGLANG_PY=...` if yours is
elsewhere.

**Linux with an NVIDIA GPU:**

```bash
pip install "sglang[all]"
```

Then add `SGLANG_ENV= SGLANG_EXTRA= SGLANG_PY=python` to every `make serve-*` command, and in
`configs/models.yaml` change the teacher to `Qwen/Qwen2.5-7B-Instruct` (the default is an MLX 4-bit build).

### 4. Stage 1: generate and curate data

```bash
make serve-teacher        # terminal 1: 7B teacher on 127.0.0.1:30000, wait for "ready to roll"
make data                 # terminal 2: writes data/raw/ then data/curated/
```

Generation is resumable: re-running skips rows already written. Rows that fail the fact-presence gate go to
`data/raw/flagged.jsonl`. The curation summary is written to `data/curated/curation_summary.json`.

### 5. Stage 2: fine-tune

Stop the teacher first (Ctrl+C in terminal 1) to free memory.

```bash
make train                # LoRA SFT with AlignTune, writes models/offerlens-lora
make merge                # merged safetensors in models/offerlens-1.5b-merged with PROVENANCE.json
```

### 6. Stage 3: evaluate

Start one model server at a time if memory is tight. `make eval` only runs the conditions whose server is up,
and merges into `reports/results.json`.

```bash
make serve-base           # terminal 1
make eval                 # terminal 2: conditions A and B
# stop the base server, then:
make serve-student        # terminal 1
make eval                 # terminal 2: condition C
make report               # fills the README table and writes reports/chart.svg
```

### 7. Run the demo app

```bash
make serve-base           # terminal 1 (needed for Compare)
make serve-student        # terminal 2
make app                  # terminal 3: open http://127.0.0.1:8000
```

The UI loads without any model server. Extract and Compare show a "model server is not reachable" message
until the servers are up.

### 8. Deploy the web app on Vercel

Vercel hosts the FastAPI app and the UI. It runs `app.py` at the repo root, which loads `src/offerlens/api.py`.
Model servers cannot run on Vercel, so Extract and Compare return "model server is not reachable" until
the app can reach an SGLang server elsewhere.

```bash
vercel link --project offer-lens
vercel env add ENV production         # enter: demo  (turns off /docs)
vercel deploy --prod
```

`.vercelignore` keeps the virtual environment, data, media and docs out of the upload. On Vercel, rate limiting
uses the `x-real-ip` header that Vercel sets, so each visitor gets their own 30 requests per minute.

### 9. Make the online demo extract (hosted SGLang + fallback)

The live site calls SGLang on a [Modal](https://modal.com) serverless GPU. When that server can't answer
(the free credits are used up, it is down, or it is still cold-starting), the API switches to a free
[OpenRouter](https://openrouter.ai) model with the same prompt and JSON schema. The output is re-validated
the same way, and the UI tags the answer as **fallback · hosted API** with the model's name.

Order the API tries: requested SGLang model, then the base SGLang model (Extract only), then OpenRouter. A
server that fails is skipped for 60 seconds, so visitors don't wait out a cold start.

1. Modal (free tier: $30 of credits a month). Install and log in, then deploy:

   ```bash
   uv tool install modal                          # or: pip3 install modal
   modal setup                                    # opens a browser to log in
   modal secret create offerlens-sglang SGLANG_API_KEY=$(openssl rand -hex 32)
   modal deploy deploy/modal_sglang.py            # prints the server URL
   ```

   In the Modal dashboard, set a **workspace budget of $30**. Modal bills past the free credits otherwise; with
   the budget the GPU stops at $30 and the site moves to the fallback on its own.

2. OpenRouter: create an API key at https://openrouter.ai/keys. Free models allow 50 requests a day
   (1,000 a day after buying $10 of credits). The free list changes; pick one that supports structured outputs
   at https://openrouter.ai/models?supported_parameters=structured_outputs and set `OPENROUTER_MODEL`.

3. Vercel: add the variables (mark the keys as sensitive), then redeploy:

   ```bash
   vercel env add SGLANG_BASE_MODEL_URL production   # https://<modal-url>/v1
   vercel env add SGLANG_API_KEY production          # same value as the Modal secret
   vercel env add OPENROUTER_API_KEY production
   vercel env add OPENROUTER_MODEL production        # optional, default nvidia/nemotron-3-super-120b-a12b:free
   vercel deploy --prod
   ```

`/healthz` reports `sglang_base`, `sglang_student` and `openrouter_fallback`. The fine-tuned model isn't hosted
yet; after training, deploy it with `OFFERLENS_MODEL`/`OFFERLENS_SERVED_NAME=student` and set
`SGLANG_STUDENT_URL`.

### Other targets

```bash
make check                # ruff, mypy, pytest, bandit, pip-audit, gitleaks
make fmt                  # auto-format
make clean                # remove caches and reports/runs
```

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/extract` | `{text, reference_date?, model: "student" or "base"}` | `{extraction, latency_ms, model, valid, prompt_version}` |
| POST | `/api/compare` | `{text, reference_date?}` | `{base, student}` |
| GET | `/api/results` | none | contents of `reports/results.json` |
| GET | `/api/examples` | none | the 8 demo examples |
| GET | `/healthz` | none | `{ok, sglang_student, sglang_base}` |

`text` must be 1 to 2,000 characters. Errors are returned as `application/problem+json`.

## Project layout

```
configs/          models.yaml (pinned revisions), data.yaml, train.yaml, eval.yaml
src/offerlens/    schema.py, prompt.py, settings.py, sglang_client.py, api.py
  data/           seeds.py, generate.py, verify.py, curate.py
  train/          sft.py, merge.py
  eval/           metrics.py, run.py, report.py
web/              index.html, app.js, styles.css, fonts/, icon.svg
scripts/          fetch_fonts.py
media/            screenshots and the 600x600 icon
docs/             PLAN, SPEC, DATA, TRAINING, EVAL, DESIGN, SECURITY, DECISIONS, DEMO_SCRIPT
```

## Security

- SGLang servers bind to `127.0.0.1` only. The FastAPI app is the only public surface.
- Offer text is wrapped in `<offer_text>` delimiters and treated as untrusted data. Grammar-constrained decoding
  means injected instructions cannot make the model emit prose, HTML or its system prompt.
- The API enforces an 8 KB body limit, 30 requests per minute per IP, a concurrency cap and a strict CSP
  (no inline scripts or styles). It also sends nosniff, no-referrer and Permissions-Policy headers.
- The frontend renders model output with `textContent` only, never `innerHTML`.
- Logs record a SHA-256 hash of the input, not the raw text.
- Model revisions are pinned, `trust_remote_code` is always false, and weights are safetensors only.

Full list: `docs/SECURITY.md`.

## Known gaps

- **No measured results yet.** All stages are implemented, but the end-to-end run was stopped during data
  generation because the 7B teacher saturated a 16 GB laptop. Nothing in this repo claims an accuracy number.
- Built on an Apple M4 without an NVIDIA GPU, so it uses the SGLang MLX backend and AlignTune's `trl` backend
  instead of unsloth.
- On Apple Silicon, `--mlx-enable-sampling` is required. Without it SGLang silently ignores the JSON schema.
- The data verification gate is a deterministic fact-presence check rather than the teacher round-trip in
  `docs/DATA.md`. See `docs/DECISIONS.md` for why.
- The real DealFeed test set (30 hand-labelled offers) still needs to be built.
- Unit tests and CI are not written yet.
- The online demo runs the **base** 1.5B with grammar constraints (or the OpenRouter fallback). The fine-tuned model is not hosted until training has run.

The full list is in `docs/EVAL.md`, and every shortcut is logged in `docs/DECISIONS.md`.

## License notes

CuratorKIT and AlignTune are source-available for non-commercial use. Commercial use of this pipeline (for
example inside DealFeed production) needs a license from Lexsi Labs. Check each kit's LICENSE.

## Devlopers

1. M. Likhit Naidu
2. Mustafiz Ahmed
3. Chitturi Srikar
