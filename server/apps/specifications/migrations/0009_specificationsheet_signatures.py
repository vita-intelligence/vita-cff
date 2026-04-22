from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("specifications", "0008_specificationsheet_weight_uniformity"),
    ]

    operations = [
        migrations.AddField(
            model_name="specificationsheet",
            name="prepared_by_user",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.deletion.PROTECT,
                related_name="prepared_spec_sheets",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="specificationsheet",
            name="prepared_by_signed_at",
            field=models.DateTimeField(
                blank=True, null=True, verbose_name="prepared-by signed at"
            ),
        ),
        migrations.AddField(
            model_name="specificationsheet",
            name="prepared_by_signature_image",
            field=models.TextField(
                blank=True,
                default="",
                verbose_name="prepared-by signature image",
            ),
        ),
        migrations.AddField(
            model_name="specificationsheet",
            name="director_user",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.deletion.PROTECT,
                related_name="approved_spec_sheets",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="specificationsheet",
            name="director_signed_at",
            field=models.DateTimeField(
                blank=True, null=True, verbose_name="director signed at"
            ),
        ),
        migrations.AddField(
            model_name="specificationsheet",
            name="director_signature_image",
            field=models.TextField(
                blank=True,
                default="",
                verbose_name="director signature image",
            ),
        ),
        migrations.AddField(
            model_name="specificationsheet",
            name="customer_name",
            field=models.CharField(
                blank=True,
                default="",
                max_length=200,
                verbose_name="customer signer name",
            ),
        ),
        migrations.AddField(
            model_name="specificationsheet",
            name="customer_email",
            field=models.EmailField(
                blank=True,
                default="",
                max_length=254,
                verbose_name="customer signer email",
            ),
        ),
        migrations.AddField(
            model_name="specificationsheet",
            name="customer_company",
            field=models.CharField(
                blank=True,
                default="",
                max_length=200,
                verbose_name="customer signer company",
            ),
        ),
        migrations.AddField(
            model_name="specificationsheet",
            name="customer_signed_at",
            field=models.DateTimeField(
                blank=True, null=True, verbose_name="customer signed at"
            ),
        ),
        migrations.AddField(
            model_name="specificationsheet",
            name="customer_signature_image",
            field=models.TextField(
                blank=True,
                default="",
                verbose_name="customer signature image",
            ),
        ),
    ]
