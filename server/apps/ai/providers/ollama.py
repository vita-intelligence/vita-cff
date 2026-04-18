"""Ollama adapter.

Ollama exposes a minimal HTTP API at ``http://<host>:11434``. The
``/api/chat`` endpoint takes messages + optional JSON format flag and
returns a single reply plus token counts. That's all we need.

The adapter speaks plain ``urllib.request`` so we don't pull in a new
HTTP dependency just for one provider — Ollama's wire format is dead
simple and stdlib handles timeouts via a keyword argument.
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from typing import Any

from django.conf import settings

from apps.ai.providers.base import (
    AIProvider,
    AIProviderBadResponse,
    AIProviderResult,
    AIProviderTimeout,
    AIProviderUnreachable,
)


class OllamaProvider(AIProvider):
    """Adapter for a local Ollama daemon.

    All configuration comes from Django settings:

    * ``AI_OLLAMA_URL`` — base URL (default ``http://127.0.0.1:11434``).
    * ``AI_OLLAMA_MODEL`` — default model tag (e.g. ``llama3.1:8b``).
    * ``AI_PROVIDER_TIMEOUT_SECONDS`` — hard cap on the request.
    """

    name = "ollama"

    def generate_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        model: str | None = None,
    ) -> AIProviderResult:
        selected_model = model or settings.AI_OLLAMA_MODEL
        url = f"{settings.AI_OLLAMA_URL.rstrip('/')}/api/chat"
        payload = {
            "model": selected_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            # Ollama's JSON mode constrains output to valid JSON. It
            # doesn't enforce a schema — we validate shape ourselves
            # in the service layer — but it reliably produces parseable
            # output, which is the hard part.
            "format": "json",
            "stream": False,
        }

        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(
                request,
                timeout=settings.AI_PROVIDER_TIMEOUT_SECONDS,
            ) as response:
                body = response.read()
        except socket.timeout as exc:
            raise AIProviderTimeout("ollama call timed out") from exc
        except urllib.error.URLError as exc:
            # URLError covers both "connection refused" (daemon not
            # running) and read timeouts wrapped by Python's HTTP
            # library on some platforms. Surface as unreachable by
            # default and upgrade to timeout if the reason looks like
            # one.
            reason = getattr(exc, "reason", None)
            if isinstance(reason, socket.timeout):
                raise AIProviderTimeout("ollama call timed out") from exc
            raise AIProviderUnreachable(
                f"ollama unreachable at {settings.AI_OLLAMA_URL}: {exc}"
            ) from exc

        try:
            envelope: dict[str, Any] = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AIProviderBadResponse(
                "ollama response was not valid JSON"
            ) from exc

        # ``message.content`` is the model's text; because we asked
        # for ``format=json``, that text itself is a JSON document we
        # need to parse once more.
        message = envelope.get("message") or {}
        raw_content = message.get("content")
        if not isinstance(raw_content, str) or not raw_content.strip():
            raise AIProviderBadResponse("ollama returned empty content")
        try:
            data = json.loads(raw_content)
        except json.JSONDecodeError as exc:
            raise AIProviderBadResponse(
                "ollama content was not parseable JSON"
            ) from exc
        if not isinstance(data, dict):
            raise AIProviderBadResponse(
                "ollama content was valid JSON but not an object"
            )

        # Ollama reports token counts on the envelope when available.
        # They're optional in older versions — fall back to ``None``
        # so the accounting row still writes successfully.
        prompt_tokens = _coerce_int(envelope.get("prompt_eval_count"))
        completion_tokens = _coerce_int(envelope.get("eval_count"))

        return AIProviderResult(
            data=data,
            model=selected_model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )


def _coerce_int(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return None
