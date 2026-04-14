"""Unit tests for :class:`apps.accounts.managers.UserManager`."""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD

UserModel = get_user_model()

pytestmark = pytest.mark.django_db


class TestCreateUser:
    def test_creates_active_non_staff_user(self) -> None:
        user = UserModel.objects.create_user(
            email="scientist@vita.test",
            first_name="Ada",
            last_name="Lovelace",
            password=DEFAULT_TEST_PASSWORD,
        )

        assert user.pk is not None
        assert user.email == "scientist@vita.test"
        assert user.first_name == "Ada"
        assert user.last_name == "Lovelace"
        assert user.is_active is True
        assert user.is_staff is False
        assert user.is_superuser is False

    def test_password_is_hashed_not_stored_in_plaintext(self) -> None:
        user = UserModel.objects.create_user(
            email="hashed@vita.test",
            first_name="Grace",
            last_name="Hopper",
            password=DEFAULT_TEST_PASSWORD,
        )

        assert user.password != DEFAULT_TEST_PASSWORD
        assert user.check_password(DEFAULT_TEST_PASSWORD) is True

    def test_email_domain_is_normalized(self) -> None:
        user = UserModel.objects.create_user(
            email="Mixed@VITA.TEST",
            first_name="Edsger",
            last_name="Dijkstra",
            password=DEFAULT_TEST_PASSWORD,
        )

        # Django's normalizer lowercases the domain; the local part is left alone.
        assert user.email == "Mixed@vita.test"

    @pytest.mark.parametrize(
        ("missing_field", "kwargs"),
        [
            (
                "email",
                {"email": "", "first_name": "Alan", "last_name": "Turing"},
            ),
            (
                "first_name",
                {"email": "a@vita.test", "first_name": "", "last_name": "Turing"},
            ),
            (
                "last_name",
                {"email": "a@vita.test", "first_name": "Alan", "last_name": ""},
            ),
        ],
    )
    def test_missing_required_field_raises(
        self, missing_field: str, kwargs: dict[str, str]
    ) -> None:
        with pytest.raises(ValueError):
            UserModel.objects.create_user(password=DEFAULT_TEST_PASSWORD, **kwargs)


class TestCreateSuperuser:
    def test_creates_staff_and_superuser(self) -> None:
        user = UserModel.objects.create_superuser(
            email="root@vita.test",
            first_name="Root",
            last_name="Admin",
            password=DEFAULT_TEST_PASSWORD,
        )

        assert user.is_staff is True
        assert user.is_superuser is True
        assert user.is_active is True
        assert user.check_password(DEFAULT_TEST_PASSWORD) is True

    def test_rejects_is_staff_false(self) -> None:
        with pytest.raises(ValueError, match="is_staff=True"):
            UserModel.objects.create_superuser(
                email="root@vita.test",
                first_name="Root",
                last_name="Admin",
                password=DEFAULT_TEST_PASSWORD,
                is_staff=False,
            )

    def test_rejects_is_superuser_false(self) -> None:
        with pytest.raises(ValueError, match="is_superuser=True"):
            UserModel.objects.create_superuser(
                email="root@vita.test",
                first_name="Root",
                last_name="Admin",
                password=DEFAULT_TEST_PASSWORD,
                is_superuser=False,
            )


class TestUserModelBehaviour:
    def test_str_returns_email(self) -> None:
        user = UserModel.objects.create_user(
            email="print@vita.test",
            first_name="Linus",
            last_name="Torvalds",
            password=DEFAULT_TEST_PASSWORD,
        )
        assert str(user) == "print@vita.test"

    def test_full_name_property(self) -> None:
        user = UserModel.objects.create_user(
            email="full@vita.test",
            first_name="Barbara",
            last_name="Liskov",
            password=DEFAULT_TEST_PASSWORD,
        )
        assert user.full_name == "Barbara Liskov"
        assert user.get_full_name() == "Barbara Liskov"
        assert user.get_short_name() == "Barbara"

    def test_email_must_be_unique(self) -> None:
        UserModel.objects.create_user(
            email="unique@vita.test",
            first_name="First",
            last_name="User",
            password=DEFAULT_TEST_PASSWORD,
        )
        from django.db import IntegrityError

        with pytest.raises(IntegrityError):
            UserModel.objects.create_user(
                email="unique@vita.test",
                first_name="Second",
                last_name="User",
                password=DEFAULT_TEST_PASSWORD,
            )
