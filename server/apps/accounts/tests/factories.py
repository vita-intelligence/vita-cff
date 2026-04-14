"""Factory Boy factories for the accounts app."""

from __future__ import annotations

from typing import Any

import factory
from django.contrib.auth import get_user_model

UserModel = get_user_model()

DEFAULT_TEST_PASSWORD = "Sup3r$ecret!Test"


class UserFactory(factory.django.DjangoModelFactory):
    """Build realistic :class:`User` instances for tests.

    The factory routes creation through :meth:`UserManager.create_user` so
    passwords are hashed via the same code path the production registration
    endpoint uses. Callers can override any field, including ``password``.
    """

    class Meta:
        model = UserModel
        django_get_or_create = ("email",)
        skip_postgeneration_save = True

    email = factory.Sequence(lambda n: f"user{n}@vita.test")
    first_name = factory.Faker("first_name")
    last_name = factory.Faker("last_name")

    @classmethod
    def _create(cls, model_class: type[Any], *args: Any, **kwargs: Any) -> Any:
        password = kwargs.pop("password", DEFAULT_TEST_PASSWORD)
        manager = model_class._default_manager
        return manager.create_user(*args, password=password, **kwargs)


class StaffUserFactory(UserFactory):
    is_staff = True


class SuperUserFactory(UserFactory):
    is_staff = True
    is_superuser = True

    @classmethod
    def _create(cls, model_class: type[Any], *args: Any, **kwargs: Any) -> Any:
        password = kwargs.pop("password", DEFAULT_TEST_PASSWORD)
        manager = model_class._default_manager
        return manager.create_superuser(*args, password=password, **kwargs)
