from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('specifications', '0017_specificationsheet_sent_at_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='specificationsheet',
            name='customer_rejected_at',
            field=models.DateTimeField(
                blank=True,
                null=True,
                verbose_name='customer rejected at',
            ),
        ),
        migrations.AddField(
            model_name='specificationsheet',
            name='customer_rejection_reason',
            field=models.TextField(
                blank=True,
                default='',
                verbose_name='customer rejection reason',
            ),
        ),
    ]
