"""Tests for the @-mention parser."""

from __future__ import annotations

from apps.comments.mentions import extract_mention_emails


class TestExtractMentionEmails:
    def test_empty_body_returns_empty(self) -> None:
        assert extract_mention_emails("") == []
        assert extract_mention_emails(None) == []  # type: ignore[arg-type]

    def test_plain_body_without_mentions(self) -> None:
        assert extract_mention_emails("just a normal sentence") == []

    def test_single_mention(self) -> None:
        assert extract_mention_emails("Hi @alice@example.com") == [
            "alice@example.com"
        ]

    def test_mention_trailing_punctuation_stripped(self) -> None:
        assert extract_mention_emails("Hi @alice@example.com, how are you?") == [
            "alice@example.com"
        ]

    def test_mention_is_case_folded(self) -> None:
        assert extract_mention_emails("ping @Alice@Example.COM") == [
            "alice@example.com"
        ]

    def test_multiple_mentions_deduped_preserving_order(self) -> None:
        body = "@bob@test.io @alice@test.io @bob@test.io"
        assert extract_mention_emails(body) == [
            "bob@test.io",
            "alice@test.io",
        ]

    def test_bare_email_is_not_a_mention(self) -> None:
        assert extract_mention_emails("reach me at alice@example.com") == []

    def test_fenced_code_block_is_ignored(self) -> None:
        body = (
            "See log:\n"
            "```\n"
            "ERROR @root@machine.local failed\n"
            "```\n"
            "real mention @alice@example.com"
        )
        assert extract_mention_emails(body) == ["alice@example.com"]

    def test_inline_code_span_is_ignored(self) -> None:
        body = "escape sequence `@nobody@foo.com` and real @alice@example.com"
        assert extract_mention_emails(body) == ["alice@example.com"]

    def test_mention_requires_word_boundary_before_at(self) -> None:
        # An email-like sequence glued onto another character is not
        # a mention (``foo@alice@bar.com`` shouldn't produce anything).
        assert extract_mention_emails("foo@alice@bar.com") == []
