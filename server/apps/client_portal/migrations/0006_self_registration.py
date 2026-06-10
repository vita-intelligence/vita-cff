"""Self-registration schema.

Three changes:

1. New :class:`ClientAccountRegistration` model — stages an in-flight
   customer-driven registration between step 1 (form submit) and step
   2 (code confirm).
2. ``ClientAccount.privacy_accepted_at`` + ``privacy_policy_version``
   — durable consent record so a future policy revision can compare
   what each customer agreed to.
3. New ``PortalEvent.Kind`` choice ``self_registered`` so the staff
   activity panel can tell self-served onboarding apart from staff-
   issued invites.
"""

import django.db.models.deletion
import django.utils.timezone
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("client_portal", "0005_portalevent"),
        ("organizations", "0010_backfill_proposals_manual_close"),
    ]

    operations = [
        migrations.AddField(
            model_name="clientaccount",
            name="privacy_accepted_at",
            field=models.DateTimeField(
                blank=True,
                help_text=(
                    "Set when the customer ticked the privacy-policy "
                    "checkbox on the self-registration form. NULL for "
                    "accounts that predate the registration flow "
                    "(kiosk-link / staff-issued invite) since those "
                    "paths never asked for consent."
                ),
                null=True,
                verbose_name="privacy policy accepted at",
            ),
        ),
        migrations.AddField(
            model_name="clientaccount",
            name="privacy_policy_version",
            field=models.CharField(
                blank=True,
                default="",
                help_text=(
                    "Identifier of the privacy policy the customer "
                    "accepted at registration time. Stored as a URL "
                    "today; switching to a semantic version later is "
                    "a write-only change (older rows keep whatever "
                    "URL they accepted). Empty string for accounts "
                    "created via kiosk / invite."
                ),
                max_length=255,
                verbose_name="privacy policy version",
            ),
        ),
        migrations.AlterField(
            model_name="portalevent",
            name="kind",
            field=models.CharField(
                choices=[
                    ("link_opened", "Activation link opened"),
                    ("activation_code_requested", "Verification code requested"),
                    ("activated", "Account activated"),
                    ("self_registered", "Self-registered via portal"),
                    ("signed_in", "Signed in"),
                    ("signed_out", "Signed out"),
                    ("proposal_viewed", "Proposal opened"),
                    ("proposal_pdf_downloaded", "Proposal PDF downloaded"),
                    ("proposal_signed", "Proposal signed"),
                    ("proposal_rejected", "Proposal rejected"),
                    ("spec_viewed", "Spec sheet opened"),
                    ("spec_signed", "Spec sheet signed"),
                ],
                max_length=40,
            ),
        ),
        migrations.CreateModel(
            name="ClientAccountRegistration",
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
                    "token",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        help_text=(
                            "Opaque handle the FE keeps between step "
                            "1 (form submit) and step 2 (code "
                            "confirm). Lives only in the React form "
                            "state — never carried in a URL — so a "
                            "leaked client log can't be replayed "
                            "without the code that's only in the "
                            "customer's inbox."
                        ),
                        unique=True,
                    ),
                ),
                (
                    "email",
                    models.EmailField(
                        help_text=(
                            "Address the customer typed into the "
                            "register form. Lower-cased + trimmed so "
                            "the confirm step can match against "
                            "``normalize_email`` output without a "
                            "second normalisation pass."
                        ),
                        max_length=254,
                    ),
                ),
                (
                    "name",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text=(
                            "Primary contact name the customer typed. "
                            "Stored verbatim (no case normalisation) "
                            "and copied onto the new "
                            ":class:`apps.customers.models.Customer` "
                            "row at confirm."
                        ),
                        max_length=200,
                    ),
                ),
                (
                    "company",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text=(
                            "Company name the customer typed. Same "
                            "handling as ``name`` above."
                        ),
                        max_length=200,
                    ),
                ),
                (
                    "code_hash",
                    models.CharField(
                        help_text=(
                            "SHA-256 of the plaintext 6-digit code "
                            "mailed to the customer's address. Stored "
                            "hashed so a DB dump can't be turned into "
                            "a working confirmation."
                        ),
                        max_length=64,
                    ),
                ),
                (
                    "privacy_policy_version",
                    models.CharField(
                        help_text=(
                            "Identifier of the privacy policy the "
                            "form linked to at the moment the "
                            "customer ticked the box. Copied to "
                            ":attr:`ClientAccount.privacy_policy_"
                            "version` on confirm so the consent "
                            "record survives a later policy URL "
                            "change."
                        ),
                        max_length=255,
                    ),
                ),
                (
                    "request_ip",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text=(
                            "IP of the step-1 submit. Audit "
                            "breadcrumb only — never gated on. Same "
                            "Azure XFF parsing as the rest of the "
                            "portal (see ``_extract_client_ip`` in "
                            "services.py)."
                        ),
                        max_length=45,
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(default=django.utils.timezone.now),
                ),
                ("expires_at", models.DateTimeField()),
                ("used_at", models.DateTimeField(blank=True, null=True)),
                (
                    "invalidated_at",
                    models.DateTimeField(
                        blank=True,
                        help_text=(
                            "Set when a fresher registration "
                            "superseded this one. A repeat step-1 "
                            "submit by the same email re-issues a "
                            "code and stamps the prior row; only the "
                            "newest code in the customer's inbox is "
                            "consumable. Distinct from ``used_at`` "
                            "so the audit log can tell an abandoned "
                            "attempt from a consumed one."
                        ),
                        null=True,
                    ),
                ),
                (
                    "organization",
                    models.ForeignKey(
                        help_text=(
                            "The org the new customer + portal "
                            "account will land in. Resolved at "
                            "registration time to the single active "
                            "Organization (vita-cff is single-org in "
                            "production); pinned on the row so a "
                            "later org flip can't silently redirect "
                            "an in-flight registration."
                        ),
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="client_registrations",
                        to="organizations.organization",
                    ),
                ),
            ],
            options={
                "verbose_name": "client account registration",
                "verbose_name_plural": "client account registrations",
                "indexes": [
                    models.Index(
                        fields=["email", "-created_at"],
                        name="client_port_email_041f8a_idx",
                    ),
                    models.Index(
                        fields=["expires_at"],
                        name="client_port_expires_86c304_idx",
                    ),
                ],
            },
        ),
    ]
