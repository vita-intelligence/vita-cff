"""Abstract provider interface.

Every adapter speaks a narrow JSON-generation API:

.. code-block:: python

    result = provider.generate_json(
        system_prompt="You are ...",
        user_prompt="I need a capsule with ...",
    )
    assert isinstance(result.data, dict)

The return type is :class:`AIProviderResult`, which carries both the
parsed JSON body and the lightweight accounting metadata the service
layer needs to write an :class:`AIUsage` row.

Errors raised as :class:`AIProviderError` subclasses so the view
layer can translate a code to an HTTP response without sniffing
provider-specific details.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


class AIProviderError(Exception):
    """Base class for provider errors.

    Subclasses declare a ``code`` attribute that surfaces in
    :attr:`AIUsage.error_code` and in the API error payload.
    """

    code: str = "provider_error"


class AIProviderUnreachable(AIProviderError):
    """The provider is not reachable (network error, server down)."""

    code = "provider_unreachable"


class AIProviderTimeout(AIProviderError):
    """The provider call exceeded ``AI_PROVIDER_TIMEOUT_SECONDS``."""

    code = "provider_timeout"


class AIProviderBadResponse(AIProviderError):
    """Response arrived but was not valid JSON / not the expected shape."""

    code = "provider_bad_response"


@dataclass(frozen=True)
class AIProviderResult:
    """Normalized output of a :meth:`AIProvider.generate_json` call.

    ``data`` is always the parsed JSON object the caller asked for;
    ``prompt_tokens`` and ``completion_tokens`` come from the provider
    when available (``None`` if not reported) and feed straight into
    :class:`AIUsage` for accounting.
    """

    data: dict[str, Any]
    model: str
    prompt_tokens: int | None
    completion_tokens: int | None


class AIProvider(ABC):
    """Minimal synchronous JSON-generation interface.

    Adapters enforce JSON output themselves (Ollama's ``format=json``,
    OpenAI's JSON mode, Anthropic's tool use). Callers get a parsed
    dict; schema validation happens in the service layer because it
    depends on the purpose (formulation draft vs ingredient match vs …).
    """

    #: Short wire name used by :func:`get_provider` and stored on
    #: :attr:`AIUsage.provider`.
    name: str = "base"

    @abstractmethod
    def generate_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        model: str | None = None,
    ) -> AIProviderResult:
        """Call the provider and return a parsed JSON object.

        ``model`` defaults to the adapter's configured default if
        omitted. Raises an :class:`AIProviderError` subclass on
        transport, timeout, or parsing failures — never returns a
        partial result.
        """
