"""Provider registry.

Adapters implement :class:`AIProvider` and register themselves via
:func:`get_provider` — the service layer never reaches into a specific
adapter directly, so swapping Ollama for OpenAI is one line in the
caller plus a new adapter module here.
"""

from __future__ import annotations

from apps.ai.providers.base import (
    AIProvider,
    AIProviderError,
    AIProviderResult,
)
from apps.ai.providers.ollama import OllamaProvider


class UnknownAIProvider(AIProviderError):
    code = "unknown_provider"


def get_provider(name: str) -> AIProvider:
    """Return an :class:`AIProvider` instance by wire name.

    Unknown names raise :class:`UnknownAIProvider` — views should
    treat this as a client error (400), not a server error (500).
    """

    if name == "ollama":
        return OllamaProvider()
    raise UnknownAIProvider(f"unknown provider: {name}")


__all__ = [
    "AIProvider",
    "AIProviderError",
    "AIProviderResult",
    "OllamaProvider",
    "UnknownAIProvider",
    "get_provider",
]
