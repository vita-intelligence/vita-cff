from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('trial_batches', '0009_trialbatchcycle_customer_confirmed_done_at'),
    ]

    operations = [
        migrations.AddField(
            model_name='trialbatchcycle',
            name='slots_display_offset',
            field=models.PositiveIntegerField(
                default=0,
                verbose_name='slots display offset',
            ),
        ),
    ]
