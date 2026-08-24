from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('trial_batches', '0008_trialbatchcycle_additionalsamplerequest_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='trialbatchcycle',
            name='customer_confirmed_done_at',
            field=models.DateTimeField(
                blank=True,
                null=True,
                verbose_name='customer confirmed done at',
            ),
        ),
    ]
