"""Sample pricing config + discount tiers.

Backing data for the sample-selection stage on the customer portal:
finance sets the free allowance + per-extra-sample price + a list of
quantity-threshold discount tiers per organization. Every column has
a safe default so an org that never touches the settings page still
gets sensible customer-portal behaviour (2 free, £0 per extra → no
extras offered → sample selection collapses to "you get 2 free").
"""

from __future__ import annotations

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
from django.utils import timezone


class Migration(migrations.Migration):

    dependencies = [
        ("organizations", "0018_backfill_manage_page_builder_templates"),
        ("payments", "0006_payment_customer"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="SamplePricingConfig",
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
                    "free_samples_included",
                    models.PositiveIntegerField(
                        default=2, verbose_name="free samples included",
                    ),
                ),
                (
                    "price_per_extra_sample",
                    models.DecimalField(
                        decimal_places=2,
                        default=0,
                        max_digits=12,
                        verbose_name="price per extra sample",
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
                    "created_at",
                    models.DateTimeField(
                        default=timezone.now, editable=False,
                    ),
                ),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "organization",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="sample_pricing_config",
                        to="organizations.organization",
                    ),
                ),
                (
                    "updated_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "verbose_name": "sample pricing config",
                "verbose_name_plural": "sample pricing configs",
            },
        ),
        migrations.CreateModel(
            name="SamplePricingDiscountTier",
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
                    "quantity_threshold",
                    models.PositiveIntegerField(
                        verbose_name="quantity threshold",
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
                    "sort_order",
                    models.PositiveIntegerField(
                        default=0, verbose_name="sort order",
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(
                        default=timezone.now, editable=False,
                    ),
                ),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "config",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="discount_tiers",
                        to="payments.samplepricingconfig",
                    ),
                ),
            ],
            options={
                "verbose_name": "sample pricing discount tier",
                "verbose_name_plural": "sample pricing discount tiers",
                "ordering": ("sort_order", "quantity_threshold"),
                "constraints": [
                    models.UniqueConstraint(
                        fields=("config", "quantity_threshold"),
                        name="uniq_sample_pricing_tier_threshold",
                    ),
                ],
            },
        ),
    ]
