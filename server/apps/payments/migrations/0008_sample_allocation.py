"""Sample allocation — customer's post-proposal choice of "how many
trial samples do I want" for a project.

Snapshots the price breakdown at confirm-time so a subsequent
settings-page edit never retroactively re-prices a locked
allocation. Depends on :class:`SamplePricingConfig` (PR #1) for the
compute; on :class:`Formulation` for the project link; on
:class:`Organization` for the org scope; on ``ClientAccount`` for
the confirming user pointer.
"""

from __future__ import annotations

import uuid

import django.db.models.deletion
from django.db import migrations, models
from django.utils import timezone


class Migration(migrations.Migration):

    dependencies = [
        ("client_portal", "0006_self_registration"),
        ("formulations", "0058_formulationversion_is_auto"),
        ("organizations", "0018_backfill_manage_page_builder_templates"),
        ("payments", "0007_sample_pricing"),
    ]

    operations = [
        migrations.CreateModel(
            name="SampleAllocation",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("draft", "Draft"),
                            ("confirmed", "Confirmed"),
                        ],
                        default="draft",
                        max_length=16,
                        verbose_name="status",
                    ),
                ),
                (
                    "quantity_ordered",
                    models.PositiveIntegerField(
                        default=0, verbose_name="quantity ordered",
                    ),
                ),
                (
                    "free_samples_included_snapshot",
                    models.PositiveIntegerField(
                        default=0,
                        verbose_name="free samples included (snapshot)",
                    ),
                ),
                (
                    "extras_count",
                    models.PositiveIntegerField(
                        default=0, verbose_name="extras count",
                    ),
                ),
                (
                    "unit_price",
                    models.DecimalField(
                        decimal_places=2,
                        default=0,
                        max_digits=12,
                        verbose_name="unit price",
                    ),
                ),
                (
                    "subtotal",
                    models.DecimalField(
                        decimal_places=2,
                        default=0,
                        max_digits=12,
                        verbose_name="subtotal",
                    ),
                ),
                (
                    "discount_percent",
                    models.DecimalField(
                        decimal_places=2,
                        default=0,
                        max_digits=5,
                        verbose_name="discount percent",
                    ),
                ),
                (
                    "discount_amount",
                    models.DecimalField(
                        decimal_places=2,
                        default=0,
                        max_digits=12,
                        verbose_name="discount amount",
                    ),
                ),
                (
                    "total_extras_cost",
                    models.DecimalField(
                        decimal_places=2,
                        default=0,
                        max_digits=12,
                        verbose_name="total extras cost",
                    ),
                ),
                (
                    "currency_code",
                    models.CharField(
                        blank=True,
                        default="",
                        max_length=3,
                        verbose_name="currency code",
                    ),
                ),
                (
                    "tier_threshold",
                    models.PositiveIntegerField(
                        blank=True,
                        null=True,
                        verbose_name="winning tier threshold",
                    ),
                ),
                ("confirmed_at", models.DateTimeField(blank=True, null=True)),
                (
                    "created_at",
                    models.DateTimeField(
                        default=timezone.now, editable=False,
                    ),
                ),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "confirmed_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="client_portal.clientaccount",
                    ),
                ),
                (
                    "formulation",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="sample_allocation",
                        to="formulations.formulation",
                    ),
                ),
                (
                    "organization",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="organizations.organization",
                    ),
                ),
            ],
            options={
                "verbose_name": "sample allocation",
                "verbose_name_plural": "sample allocations",
            },
        ),
    ]
