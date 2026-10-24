"""Calls SGLang's OpenAI-compatible endpoint, with or without JSON-schema constrained decoding."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import date
from functools import lru_cache
from typing import Any

import httpx
from pydantic import ValidationError

from offerlens import prompt
from offerlens.schema import SCHEMA_PATH, Extraction
from offerlens.settings import Role, get_settings

log = logging.getLogger("offerlens.sglang")
_RETRIES = 2


@dataclass(frozen=True)
class Result:
    raw: str
    extraction: Extraction | None
    latency_ms: float
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def valid(self) -> bool:
        return self.extraction is not None


@lru_cache
def schema() -> dict[str, Any]:
    data = json.loads(SCHEMA_PATH.read_text())
    assert isinstance(data, dict)
    return data


def first_json_object(text: str) -> str:
    """Condition A: free-text output; pull the first {...} block (handles ```json fences)."""
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fenced:
        return fenced.group(1)
    start = text.find("{")
    if start < 0:
        return text
    depth = 0
    for i, ch in enumerate(text[start:], start):
        depth += {"{": 1, "}": -1}.get(ch, 0)
        if depth == 0:
            return text[start : i + 1]
    return text[start:]


def parse(raw: str) -> Extraction | None:
    try:
        return Extraction.model_validate_json(first_json_object(raw))
    except (ValidationError, ValueError):
        return None


def payload(
    role: Role,
    msgs: list[dict[str, str]],
    *,
    constrained: bool,
    temperature: float = 0.0,
    max_tokens: int = 512,
    json_schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": role,
        "messages": msgs,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if constrained:
        body["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "offer_extraction", "schema": json_schema or schema()},
        }
    return body


def _headers() -> dict[str, str]:
    key = get_settings().sglang_api_key
    return {"Authorization": f"Bearer {key.get_secret_value()}"} if key else {}


def _content(resp: httpx.Response) -> tuple[str, dict[str, int]]:
    resp.raise_for_status()
    data = resp.json()
    content = data["choices"][0]["message"]["content"]
    return (content if isinstance(content, str) else ""), data.get("usage") or {}


def _log(role: Role, text: str, latency_ms: float, valid: bool) -> None:
    digest = hashlib.sha256(text.encode()).hexdigest()[:16]
    log.info(
        json.dumps(
            {"role": role, "input_sha256": digest, "len": len(text), "ms": round(latency_ms), "valid": valid}
        )
    )


async def achat(
    client: httpx.AsyncClient, role: Role, body: dict[str, Any], timeout: float | None = None
) -> str:
    return (await achat_usage(client, role, body, timeout))[0]


async def achat_usage(
    client: httpx.AsyncClient,
    role: Role,
    body: dict[str, Any],
    timeout: float | None = None,
    retries: int = _RETRIES,
) -> tuple[str, dict[str, int]]:
    settings = get_settings()
    for attempt in range(retries + 1):
        try:
            resp = await client.post(
                f"{settings.base_url(role)}/chat/completions",
                json=body,
                headers=_headers(),
                timeout=timeout or settings.sglang_timeout_s,
            )
            return _content(resp)
        except (httpx.TransportError, httpx.HTTPStatusError):
            if attempt == retries:
                raise
            await asyncio.sleep(0.5 * 2**attempt)
    raise AssertionError("unreachable")


async def aextract(
    client: httpx.AsyncClient,
    role: Role,
    text: str,
    reference_date: date,
    *,
    constrained: bool = True,
    timeout: float | None = None,
    retries: int = _RETRIES,
) -> Result:
    t0 = time.perf_counter()
    body = payload(role, prompt.messages(text, reference_date), constrained=constrained)
    raw, usage = await achat_usage(client, role, body, timeout, retries)
    ms = (time.perf_counter() - t0) * 1000
    extraction = parse(raw)
    _log(role, text, ms, extraction is not None)
    return Result(
        raw=raw,
        extraction=extraction,
        latency_ms=ms,
        prompt_tokens=usage.get("prompt_tokens", 0),
        completion_tokens=usage.get("completion_tokens", 0),
    )


async def healthy(client: httpx.AsyncClient, role: Role) -> bool:
    try:
        resp = await client.get(get_settings().health_url(role), headers=_headers(), timeout=2.0)
    except httpx.HTTPError:
        return False
    return resp.status_code == 200


OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


async def aextract_openrouter(client: httpx.AsyncClient, text: str, reference_date: date) -> Result:
    """Fallback: same prompt and JSON schema, sent to an OpenRouter model. Output is re-validated like SGLang's."""
    settings = get_settings()
    key = settings.openrouter_api_key
    if key is None:
        raise httpx.ConnectError("OpenRouter fallback is not configured")
    body = payload("base", prompt.messages(text, reference_date), constrained=True)
    body["model"] = settings.openrouter_model
    body["provider"] = {
        "require_parameters": True,  # only providers that honour response_format
        "data_collection": settings.openrouter_data_collection,
    }
    t0 = time.perf_counter()
    resp = await client.post(
        OPENROUTER_URL,
        json=body,
        headers={"Authorization": f"Bearer {key.get_secret_value()}", "X-Title": "OfferLens"},
        timeout=settings.openrouter_timeout_s,
    )
    raw, usage = _content(resp)
    ms = (time.perf_counter() - t0) * 1000
    extraction = parse(raw)
    _log("base", text, ms, extraction is not None)
    return Result(
        raw=raw,
        extraction=extraction,
        latency_ms=ms,
        prompt_tokens=usage.get("prompt_tokens", 0),
        completion_tokens=usage.get("completion_tokens", 0),
    )
