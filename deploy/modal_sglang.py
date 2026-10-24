"""Host the OfferLens model on a Modal GPU with SGLang, for the online demo.

Structure follows Modal's own SGLang example (modal-labs/modal-examples, 06_gpu_and_ml/llm-serving/
sglang_low_latency.py), shrunk to one L4 for a 1.5B model. Scales to zero when idle.

    modal secret create offerlens-sglang SGLANG_API_KEY=<random string>
    modal deploy deploy/modal_sglang.py

Then set on Vercel: SGLANG_BASE_MODEL_URL=https://<printed-url>/v1 and the same SGLANG_API_KEY.
Serve the fine-tuned model instead by setting OFFERLENS_MODEL / OFFERLENS_SERVED_NAME at deploy time and
pointing SGLANG_STUDENT_URL at it.
"""

import os
import subprocess
import time

import modal

MINUTES = 60
PORT = 8000
MODEL = os.environ.get("OFFERLENS_MODEL", "Qwen/Qwen2.5-1.5B-Instruct")
REVISION = os.environ.get("OFFERLENS_REVISION", "989aa7980e4cf806f80c7fef2b1adb7bc71aa306")
SERVED_NAME = os.environ.get("OFFERLENS_SERVED_NAME", "base")  # the API sends model=<role>

HF_CACHE_PATH = "/root/.cache/huggingface"
hf_cache = modal.Volume.from_name("offerlens-hf-cache", create_if_missing=True)

image = (
    modal.Image.from_registry("lmsysorg/sglang:v0.5.12.post1-cu130")
    .entrypoint([])
    .run_commands("rm -rf /root/.cache/huggingface")
    .env({"HF_HUB_CACHE": HF_CACHE_PATH, "HF_XET_HIGH_PERFORMANCE": "1"})
)

with image.imports():
    import requests

app = modal.App(name=f"offerlens-sglang-{SERVED_NAME}")


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {os.environ['SGLANG_API_KEY']}"}


def wait_ready(process: subprocess.Popen, timeout: int = 15 * MINUTES) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if (rc := process.poll()) is not None:
            raise subprocess.CalledProcessError(rc, cmd=process.args)
        try:
            requests.get(f"http://127.0.0.1:{PORT}/health", headers=_auth(), timeout=5).raise_for_status()
            return
        except (requests.exceptions.ConnectionError, requests.exceptions.HTTPError):
            time.sleep(5)
    raise TimeoutError(f"SGLang not ready within {timeout} s")


@app.server(
    image=image,
    gpu="L4",
    volumes={HF_CACHE_PATH: hf_cache},
    secrets=[modal.Secret.from_name("offerlens-sglang")],
    min_containers=0,  # scale to zero: no GPU bill while idle
    startup_timeout=15 * MINUTES,
    port=PORT,
    exit_grace_period=15,
    target_concurrency=16,
    # Modal's proxy is open; SGLang itself rejects requests without the bearer key (--api-key).
    unauthenticated=True,
)
class OfferLensSGLang:
    @modal.enter()
    def startup(self) -> None:
        if len(os.environ.get("SGLANG_API_KEY", "")) < 32:  # never serve an open endpoint
            raise RuntimeError("SGLANG_API_KEY must be at least 32 characters")
        cmd = [
            "python", "-m", "sglang.launch_server",
            "--model-path", MODEL,
            "--revision", REVISION,
            "--served-model-name", SERVED_NAME,
            "--host", "0.0.0.0",  # inside the container, for Modal's proxy; --api-key guards it
            "--port", str(PORT),
            "--api-key", os.environ["SGLANG_API_KEY"],
            "--grammar-backend", "xgrammar",
            "--mem-fraction-static", "0.8",
        ]  # fmt: skip
        self.process = subprocess.Popen(cmd)
        wait_ready(self.process)

    @modal.exit()
    def stop(self) -> None:
        self.process.terminate()
