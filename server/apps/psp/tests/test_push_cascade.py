"""Tests for the multi-stage BOM cascade — ``push_bom_to_psp``
walks each stage and pushes one BOM + one Routing per stage,
auto-creating semi-finished items on PSP for non-terminal stages.

Legacy flat behaviour (no stages) still fires as a single BOM push
against the finished-product item, so formulations that predate
the stages model keep syncing.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

import pytest

from apps.catalogues.tests.factories import (
    ItemFactory,
    raw_materials_catalogue,
)
from apps.formulations.models import FormulationStage
from apps.formulations.services import seed_default_stages
from apps.formulations.tests.factories import (
    FormulationFactory,
    FormulationLineFactory,
)
from apps.organizations.tests.factories import OrganizationFactory
from apps.psp import services as psp
from apps.psp.services import PspUnreachable, push_bom_to_psp, set_psp_config


pytestmark = pytest.mark.django_db


class _RecordingClient:
    """Test double that records every put_bom / put_routing /
    create_item call so assertions can inspect the cascade shape.
    ``create_item_responses`` is a deque-like list — each call
    pops the front so tests can pre-seed different return values
    per stage.
    """

    def __init__(self, cfg=None):
        self.bom_calls: list[tuple[str, dict]] = []
        self.routing_calls: list[tuple[str, dict]] = []
        self.create_item_calls: list[dict] = []
        # Mimic PSP's ``external_sku`` idempotency: repeat POSTs with
        # the same sku return the same uuid instead of spawning a new
        # row. Pre-seed with the finished-product sku so the terminal
        # stage's POST lands on the operator-linked uuid.
        self._sku_to_uuid: dict[str, str] = {}
        self._next_semi_uuid = iter(
            [
                "aaaaaaaa-0000-0000-0000-000000000001",
                "aaaaaaaa-0000-0000-0000-000000000002",
                "aaaaaaaa-0000-0000-0000-000000000003",
                "aaaaaaaa-0000-0000-0000-000000000004",
                "aaaaaaaa-0000-0000-0000-000000000005",
                "aaaaaaaa-0000-0000-0000-000000000006",
            ]
        )

    def preseed_sku(self, external_sku: str, uuid_value: str) -> None:
        """Pin ``external_sku`` to ``uuid_value`` so a subsequent
        ``create_item`` returns that uuid — used by tests that pre-
        link a formulation to a specific PSP finished-product uuid."""

        self._sku_to_uuid[external_sku] = uuid_value

    def put_bom(self, item_uuid: Any, payload: dict) -> dict | None:
        self.bom_calls.append((str(item_uuid), payload))
        return {"bom": {"uuid": "bom-x", "version_no": 1}}

    def put_routing(self, item_uuid: Any, **kwargs) -> dict | None:
        self.routing_calls.append((str(item_uuid), kwargs))
        return {"routing": {"uuid": "routing-x", "step_count": 1}}

    def create_item(self, **kwargs) -> dict | None:
        self.create_item_calls.append(kwargs)
        sku = kwargs["external_sku"]
        uuid_value = self._sku_to_uuid.get(sku)
        if uuid_value is None:
            uuid_value = next(self._next_semi_uuid)
            self._sku_to_uuid[sku] = uuid_value
        return {
            "uuid": uuid_value,
            "name": kwargs["name"],
            "item_type": kwargs["item_type"],
            "external_sku": sku,
            # ``created`` reflects whether this was a first-time POST
            # (uuid didn't exist yet) or an idempotent repeat.
            "created": len(
                [c for c in self.create_item_calls if c["external_sku"] == sku]
            )
            == 1,
        }


def _seed_live_psp_org() -> Any:
    """Org with a fully-populated PSP config so ``is_psp_live``
    returns True + the client factory would be reachable."""

    org = OrganizationFactory()
    set_psp_config(
        organization=org,
        actor=org.created_by,
        enabled=True,
        base_url="https://psp",
        integration_token="t",
    )
    return org


def _seed_line(
    formulation: Any,
    *,
    stage: Any | None,
    display_order: int = 0,
    label_claim_mg: str = "100",
) -> Any:
    """A formulation line pointing at a mirrored PSP item. The
    ``item.psp_source_uuid`` is the load-bearing field — the push
    skips lines that don't carry one (they were made before the
    PSP mirror existed)."""

    item = ItemFactory(
        catalogue=raw_materials_catalogue(formulation.organization),
        psp_source_uuid=uuid.uuid4(),
        attributes={"purity": "1.0"},
    )
    return FormulationLineFactory(
        formulation=formulation,
        item=item,
        stage=stage,
        display_order=display_order,
        label_claim_mg=Decimal(label_claim_mg),
        mg_per_serving_cached=Decimal(label_claim_mg),
    )


class TestFlatFallback:
    """Formulations with no stages fall through to the legacy flat
    BOM push. Guards backward compatibility for rows created before
    phase 2 landed."""

    def test_no_stages_pushes_one_flat_bom(self) -> None:
        org = _seed_live_psp_org()
        formulation = FormulationFactory(
            organization=org,
            psp_finished_product_uuid="11111111-2222-3333-4444-555555555555",
            dosage_form="liquid",  # liquid seeds no stages
        )
        # Two lines, both stage=NULL.
        _seed_line(formulation, stage=None, display_order=0, label_claim_mg="50")
        _seed_line(formulation, stage=None, display_order=1, label_claim_mg="200")

        client = _RecordingClient()
        psp._TEST_CLIENT = lambda cfg: client
        try:
            result = push_bom_to_psp(formulation=formulation)
        finally:
            psp._TEST_CLIENT = None

        assert result is not None
        assert len(client.bom_calls) == 1
        assert len(client.routing_calls) == 0
        item_uuid, payload = client.bom_calls[0]
        assert item_uuid == "11111111-2222-3333-4444-555555555555"
        assert len(payload["lines"]) == 2

    def test_no_finished_product_uuid_auto_creates(self) -> None:
        """A formulation not yet linked to PSP auto-creates the
        finished-product item on the first push via
        ``_ensure_finished_product``. Previously this returned None
        silently — leaving fresh formulations forever out-of-sync
        until an operator manually linked one through the picker."""

        org = _seed_live_psp_org()
        formulation = FormulationFactory(
            organization=org,
            psp_finished_product_uuid=None,
            dosage_form="liquid",  # no stages → flat push path
        )
        _seed_line(
            formulation, stage=None, display_order=0, label_claim_mg="50"
        )

        client = _RecordingClient()
        psp._TEST_CLIENT = lambda cfg: client
        try:
            result = push_bom_to_psp(formulation=formulation)
        finally:
            psp._TEST_CLIENT = None

        # A finished-product create_item call fired first.
        assert any(
            call["item_type"] == "finished_product"
            and call["external_sku"]
            == f"NPD-FINISHED-{formulation.id}"
            for call in client.create_item_calls
        )
        # The formulation is now bound to the returned uuid.
        formulation.refresh_from_db()
        assert formulation.psp_finished_product_uuid is not None
        # And the flat BOM push ran on that uuid.
        assert result is not None
        assert len(client.bom_calls) == 1
        item_uuid, _payload = client.bom_calls[0]
        assert item_uuid == str(formulation.psp_finished_product_uuid)


class TestStagedCascade:
    def test_walks_every_stage_and_creates_semi_finished(self) -> None:
        """A capsule formulation (4 stages) fires:

        * ``create_item`` for the 3 non-terminal stages (Blend,
          Encapsulate, Bottle);
        * one ``put_bom`` per stage that carries lines (blend +
          terminal);
        * one ``put_routing`` per stage that has a workstation.

        Subsequent stages consume the prior stage's semi-finished
        UUID at qty=1 so the multi-level chain resolves.
        """

        org = _seed_live_psp_org()
        formulation = FormulationFactory(
            organization=org,
            psp_finished_product_uuid="11111111-2222-3333-4444-555555555555",
            dosage_form="capsule",
        )
        stages = seed_default_stages(formulation=formulation)
        assert [s.stage_key for s in stages] == [
            "blend",
            "encapsulate",
            "bottle",
            "label",
        ]

        # Assign a workstation to the Blend stage so a routing push
        # fires — leave the rest bare to prove the "skip routing
        # when no workstation" branch works.
        blend = formulation.stages.get(stage_key="blend")
        blend.workstation_group_uuid = uuid.UUID(
            "cccccccc-0000-0000-0000-000000000001"
        )
        blend.workstation_group_name = "Blender"
        blend.setup_time_min = Decimal("5")
        blend.cycle_time_min = Decimal("45")
        blend.save()

        # Two blend lines + one line on the terminal stage (Label)
        # + one legacy NULL-stage line (should join the terminal).
        label = formulation.stages.get(stage_key="label")
        _seed_line(formulation, stage=blend, display_order=0, label_claim_mg="500")
        _seed_line(formulation, stage=blend, display_order=1, label_claim_mg="200")
        _seed_line(formulation, stage=label, display_order=2, label_claim_mg="1")
        _seed_line(formulation, stage=None, display_order=3, label_claim_mg="1")

        client = _RecordingClient()
        # Pin the finished-product sku to the operator-linked uuid so
        # the ``_ensure_finished_product`` POST returns the same row
        # (mimics PSP's ``existing_by_sku`` branch).
        client.preseed_sku(
            f"NPD-FINISHED-{formulation.id}",
            "11111111-2222-3333-4444-555555555555",
        )
        psp._TEST_CLIENT = lambda cfg: client
        try:
            result = push_bom_to_psp(formulation=formulation)
        finally:
            psp._TEST_CLIENT = None

        assert result is not None

        # 3 semi-finished stages + 1 finished stage = 4 create_item
        # calls now that ``_ensure_finished_product`` also POSTs on
        # every push (so name/description changes propagate). The
        # finished-product call carries a different sku prefix.
        assert len(client.create_item_calls) == 4
        semi_skus = {
            c["external_sku"]
            for c in client.create_item_calls
            if c["item_type"] == "semi_finished"
        }
        finished_skus = {
            c["external_sku"]
            for c in client.create_item_calls
            if c["item_type"] == "finished_product"
        }
        assert semi_skus == {
            f"NPD-STAGE-{formulation.id}-0",
            f"NPD-STAGE-{formulation.id}-1",
            f"NPD-STAGE-{formulation.id}-2",
        }
        assert finished_skus == {f"NPD-FINISHED-{formulation.id}"}

        # UUIDs are cached back onto the stages so a subsequent push
        # skips the create_item call.
        blend.refresh_from_db()
        assert blend.psp_semi_finished_uuid is not None

        # Routing push fires only for stages with a workstation.
        assert len(client.routing_calls) == 1
        routing_uuid, kwargs = client.routing_calls[0]
        assert routing_uuid == str(blend.psp_semi_finished_uuid)
        assert kwargs["steps"][0]["setup_time_min"] == "5.00"
        assert kwargs["steps"][0]["cycle_time_min"] == "45.00"

        # BOM pushes: Blend has 2 lines; Encapsulate + Bottle have
        # no assigned lines (no BOM row → no put_bom); Label has
        # its own 1 line + the NULL-stage row + the prior semi.
        # → 2 put_bom calls.
        bom_targets = [item_uuid for item_uuid, _ in client.bom_calls]
        # Blend BOM targets the just-created semi UUID.
        assert str(blend.psp_semi_finished_uuid) in bom_targets
        # Terminal BOM targets the finished-product UUID.
        assert "11111111-2222-3333-4444-555555555555" in bom_targets

        # Terminal-stage BOM prepends the prior stage's semi.
        terminal_payload = next(
            payload
            for item_uuid, payload in client.bom_calls
            if item_uuid == "11111111-2222-3333-4444-555555555555"
        )
        first_line = terminal_payload["lines"][0]
        # qty=1 — one serving of the prior semi feeds forward.
        assert first_line["qty"] == "1"

    def test_repush_syncs_name_and_preserves_cached_uuid(self) -> None:
        """A second push against a formulation that already has
        ``psp_semi_finished_uuid`` set on its stages STILL calls
        ``create_item`` for each non-terminal stage — the PSP
        endpoint is idempotent by external_sku AND propagates
        ``name`` / ``description`` updates to the existing row on
        repeat POST, so a stage rename in NPD lands on PSP without a
        separate PATCH. The cached UUID is preserved (PSP returns
        the same row) so BOMs still target the pre-existing item."""

        org = _seed_live_psp_org()
        formulation = FormulationFactory(
            organization=org,
            psp_finished_product_uuid="11111111-2222-3333-4444-555555555555",
            dosage_form="capsule",
        )
        seed_default_stages(formulation=formulation)
        # Pretend the first push already ran and cached UUIDs. The
        # RecordingClient's stub returns fresh uuids for each POST,
        # so we tell it to hand back the same cached uuid the stage
        # already carries by pre-seeding its create_item_responses.
        cached_uuids: list[str] = []
        for i, stage in enumerate(formulation.stages.order_by("sort_order")):
            if stage.stage_key == "label":
                continue
            uuid_value = f"aaaaaaaa-0000-0000-0000-00000000000{i + 1}"
            stage.psp_semi_finished_uuid = uuid_value
            stage.save()
            cached_uuids.append(uuid_value)

        _seed_line(
            formulation,
            stage=formulation.stages.get(stage_key="blend"),
            display_order=0,
        )

        client = _RecordingClient()
        # Pin each stage's sku to its cached uuid so PSP's existing-
        # by-sku branch returns the same rows the stages already
        # carry. The finished-product sku is pinned too so the
        # terminal ``_ensure_finished_product`` POST doesn't re-mint
        # a new uuid.
        for i, uuid_value in enumerate(cached_uuids):
            client.preseed_sku(f"NPD-STAGE-{formulation.id}-{i}", uuid_value)
        client.preseed_sku(
            f"NPD-FINISHED-{formulation.id}",
            "11111111-2222-3333-4444-555555555555",
        )
        psp._TEST_CLIENT = lambda cfg: client
        try:
            push_bom_to_psp(formulation=formulation)
        finally:
            psp._TEST_CLIENT = None

        # create_item fires for every stage (semi + finished) so a
        # rename on either side would propagate to PSP without a
        # separate PATCH call.
        assert len(client.create_item_calls) == len(cached_uuids) + 1
        # Blend BOM still fires; its target is the cached UUID.
        assert client.bom_calls  # at least one BOM was pushed
        # And each stage still carries its original cached UUID
        # (PSP returned the same row, we don't spawn duplicates).
        for stage in formulation.stages.filter(stage_key__in=("blend", "encapsulate", "bottle")):
            assert str(stage.psp_semi_finished_uuid) in cached_uuids


class TestSilentDegradation:
    def test_pspError_is_swallowed(self) -> None:
        """Any :class:`PspError` from the client is logged + swallowed.
        The formulation save path must never surface a PSP outage."""

        org = _seed_live_psp_org()
        formulation = FormulationFactory(
            organization=org,
            psp_finished_product_uuid="11111111-2222-3333-4444-555555555555",
            dosage_form="liquid",
        )
        _seed_line(formulation, stage=None, display_order=0)

        class _Boom:
            def __init__(self, cfg): ...

            def put_bom(self, *a, **kw):
                raise PspUnreachable("boom")

            def put_routing(self, *a, **kw):
                raise PspUnreachable("boom")

            def create_item(self, **kw):
                raise PspUnreachable("boom")

        psp._TEST_CLIENT = _Boom
        try:
            result = push_bom_to_psp(formulation=formulation)
        finally:
            psp._TEST_CLIENT = None

        assert result is None
