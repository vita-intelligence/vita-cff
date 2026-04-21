"""Service-layer tests for the comments app."""

from __future__ import annotations

import pytest
from django.core.exceptions import ValidationError

from apps.accounts.tests.factories import UserFactory
from apps.audit.models import AuditLog
from apps.comments.models import (
    Comment,
    CommentMention,
    CommentNotification,
    CommentNotificationKind,
    CommentNotificationStatus,
)
from apps.comments.services import (
    CommentBodyBlank,
    CommentPermissionDenied,
    CommentReplyDepthExceeded,
    CommentResolveNonRoot,
    CommentTargetInvalid,
    create_comment,
    delete_comment,
    edit_comment,
    get_comment,
    list_thread,
    resolve_thread,
    unresolve_thread,
)
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)


pytestmark = pytest.mark.django_db


@pytest.fixture
def project(mailoutbox):
    """Canonical fixture: one org, owner + a second member, and a project."""

    org = OrganizationFactory()
    owner = org.created_by
    member = UserFactory(email="member@vita.test")
    MembershipFactory(
        user=member,
        organization=org,
        permissions={
            "formulations": [
                "view",
                "edit",
                "comments_view",
                "comments_write",
            ]
        },
    )
    formulation = FormulationFactory(organization=org, created_by=owner)
    return {
        "org": org,
        "owner": owner,
        "member": member,
        "formulation": formulation,
        "mail": mailoutbox,
    }


class TestCreateComment:
    def test_owner_posts_root_comment(self, project) -> None:
        comment = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="Hello",
        )
        assert isinstance(comment, Comment)
        assert comment.author_id == project["owner"].id
        assert comment.parent_id is None
        assert comment.formulation_id == project["formulation"].id
        assert comment.specification_sheet_id is None

    def test_blank_body_rejected(self, project) -> None:
        with pytest.raises(CommentBodyBlank):
            create_comment(
                organization=project["org"],
                actor=project["owner"],
                target=project["formulation"],
                body="   ",
            )

    def test_reply_to_root_succeeds(self, project) -> None:
        root = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="root question",
        )
        reply = create_comment(
            organization=project["org"],
            actor=project["member"],
            target=project["formulation"],
            body="my answer",
            parent=root,
        )
        assert reply.parent_id == root.id

    def test_reply_to_reply_rejected(self, project) -> None:
        root = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="root",
        )
        first_reply = create_comment(
            organization=project["org"],
            actor=project["member"],
            target=project["formulation"],
            body="reply 1",
            parent=root,
        )
        with pytest.raises(CommentReplyDepthExceeded):
            create_comment(
                organization=project["org"],
                actor=project["owner"],
                target=project["formulation"],
                body="reply to reply",
                parent=first_reply,
            )

    def test_reply_parent_must_match_target(self, project) -> None:
        other_formulation = FormulationFactory(
            organization=project["org"], created_by=project["owner"]
        )
        root = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="A",
        )
        with pytest.raises(CommentTargetInvalid):
            create_comment(
                organization=project["org"],
                actor=project["owner"],
                target=other_formulation,
                body="mismatched",
                parent=root,
            )

    def test_unsupported_target_rejected(self, project) -> None:
        with pytest.raises(CommentTargetInvalid):
            create_comment(
                organization=project["org"],
                actor=project["owner"],
                target=project["org"],  # not a Formulation / SpecificationSheet
                body="hi",
            )


class TestMentionNotifications:
    def test_mention_creates_notification_and_emails(
        self, project, django_capture_on_commit_callbacks
    ) -> None:
        with django_capture_on_commit_callbacks(execute=True):
            create_comment(
                organization=project["org"],
                actor=project["owner"],
                target=project["formulation"],
                body=f"Hey @{project['member'].email}, please check",
            )
        # Mention row persisted
        mentions = CommentMention.objects.all()
        assert mentions.count() == 1
        assert mentions.first().mentioned_user_id == project["member"].id

        # Dedupe ledger updated + email sent to member's inbox
        notif = CommentNotification.objects.get()
        assert notif.kind == CommentNotificationKind.MENTION
        assert notif.status == CommentNotificationStatus.SENT
        assert len(project["mail"]) == 1
        assert project["member"].email in project["mail"][0].to

    def test_mention_outside_org_dropped(
        self, project, django_capture_on_commit_callbacks
    ) -> None:
        outsider = UserFactory(email="outsider@vita.test")
        with django_capture_on_commit_callbacks(execute=True):
            create_comment(
                organization=project["org"],
                actor=project["owner"],
                target=project["formulation"],
                body=f"@{outsider.email} hi",
            )
        assert CommentMention.objects.count() == 0
        assert len(project["mail"]) == 0

    def test_self_mention_never_emails_self(
        self, project, django_capture_on_commit_callbacks
    ) -> None:
        with django_capture_on_commit_callbacks(execute=True):
            create_comment(
                organization=project["org"],
                actor=project["member"],
                target=project["formulation"],
                body=f"@{project['member'].email} note to self",
            )
        assert CommentNotification.objects.count() == 0
        assert len(project["mail"]) == 0

    def test_mention_deduped_when_also_a_reply(
        self, project, django_capture_on_commit_callbacks
    ) -> None:
        with django_capture_on_commit_callbacks(execute=True):
            root = create_comment(
                organization=project["org"],
                actor=project["member"],
                target=project["formulation"],
                body="original question",
            )
        project["mail"].clear()
        # Reply mentions the parent author: mention wins, no duplicate
        with django_capture_on_commit_callbacks(execute=True):
            create_comment(
                organization=project["org"],
                actor=project["owner"],
                target=project["formulation"],
                body=f"@{project['member'].email} yes see my reply",
                parent=root,
            )
        kinds = set(
            CommentNotification.objects.values_list("kind", flat=True)
        )
        assert kinds == {CommentNotificationKind.MENTION}
        assert len(project["mail"]) == 1


class TestReplyNotifications:
    def test_reply_emails_parent_author(
        self, project, django_capture_on_commit_callbacks
    ) -> None:
        with django_capture_on_commit_callbacks(execute=True):
            root = create_comment(
                organization=project["org"],
                actor=project["member"],
                target=project["formulation"],
                body="I have a question",
            )
        project["mail"].clear()
        with django_capture_on_commit_callbacks(execute=True):
            create_comment(
                organization=project["org"],
                actor=project["owner"],
                target=project["formulation"],
                body="Here is the answer",
                parent=root,
            )
        notif = CommentNotification.objects.get()
        assert notif.kind == CommentNotificationKind.REPLY
        assert notif.recipient_id == project["member"].id
        assert len(project["mail"]) == 1

    def test_self_reply_does_not_email(
        self, project, django_capture_on_commit_callbacks
    ) -> None:
        with django_capture_on_commit_callbacks(execute=True):
            root = create_comment(
                organization=project["org"],
                actor=project["owner"],
                target=project["formulation"],
                body="root",
            )
        project["mail"].clear()
        with django_capture_on_commit_callbacks(execute=True):
            create_comment(
                organization=project["org"],
                actor=project["owner"],
                target=project["formulation"],
                body="own reply",
                parent=root,
            )
        assert CommentNotification.objects.count() == 0
        assert len(project["mail"]) == 0


class TestEditAndDelete:
    def test_author_edits_own_comment(self, project) -> None:
        comment = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="v1",
        )
        updated = edit_comment(
            comment=comment, actor=project["owner"], body="v2"
        )
        assert updated.body == "v2"
        assert updated.is_edited is True
        assert updated.edited_at is not None

    def test_non_author_cannot_edit(self, project) -> None:
        comment = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="v1",
        )
        with pytest.raises(CommentPermissionDenied):
            edit_comment(
                comment=comment, actor=project["member"], body="v2"
            )

    def test_delete_sets_flag_and_clears_body(self, project) -> None:
        comment = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="will be gone",
        )
        delete_comment(comment=comment, actor=project["owner"])
        comment.refresh_from_db()
        assert comment.is_deleted is True
        assert comment.body == ""

    def test_moderator_can_delete_others(self, project) -> None:
        comment = create_comment(
            organization=project["org"],
            actor=project["member"],
            target=project["formulation"],
            body="spicy take",
        )
        delete_comment(
            comment=comment,
            actor=project["owner"],
            is_moderator=True,
        )
        comment.refresh_from_db()
        assert comment.is_deleted is True

    def test_non_moderator_non_author_cannot_delete(self, project) -> None:
        other = UserFactory(email="other@vita.test")
        MembershipFactory(
            user=other,
            organization=project["org"],
            permissions={"formulations": ["comments_view", "comments_write"]},
        )
        comment = create_comment(
            organization=project["org"],
            actor=project["member"],
            target=project["formulation"],
            body="member's comment",
        )
        with pytest.raises(CommentPermissionDenied):
            delete_comment(comment=comment, actor=other)


class TestResolveThread:
    def test_resolve_root_by_author(self, project) -> None:
        comment = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="please review",
        )
        resolved = resolve_thread(
            comment=comment, actor=project["owner"]
        )
        assert resolved.is_resolved is True
        assert resolved.resolved_by_id == project["owner"].id
        assert resolved.resolved_at is not None

    def test_resolve_on_reply_rejected(self, project) -> None:
        root = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="root",
        )
        reply = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="reply",
            parent=root,
        )
        with pytest.raises(CommentResolveNonRoot):
            resolve_thread(comment=reply, actor=project["owner"])

    def test_unresolve_clears_fields(self, project) -> None:
        comment = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="root",
        )
        resolve_thread(comment=comment, actor=project["owner"])
        comment.refresh_from_db()
        unresolve_thread(comment=comment, actor=project["owner"])
        comment.refresh_from_db()
        assert comment.is_resolved is False
        assert comment.resolved_at is None

    def test_non_author_non_moderator_cannot_resolve(self, project) -> None:
        comment = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="root",
        )
        with pytest.raises(CommentPermissionDenied):
            resolve_thread(comment=comment, actor=project["member"])


class TestListThread:
    def test_filter_out_resolved(self, project) -> None:
        alive = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="still open",
        )
        done = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="resolved",
        )
        resolve_thread(comment=done, actor=project["owner"])

        ids = {
            c.id
            for c in list_thread(
                organization=project["org"],
                target=project["formulation"],
                include_resolved=False,
            )
        }
        assert alive.id in ids
        assert done.id not in ids

    def test_tenant_isolation_between_orgs(self, project) -> None:
        # Post in project org
        create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="visible",
        )
        # Separate org + formulation — must not leak
        other_org = OrganizationFactory()
        other_formulation = FormulationFactory(
            organization=other_org, created_by=other_org.created_by
        )
        assert (
            list_thread(
                organization=other_org, target=other_formulation
            ).count()
            == 0
        )


class TestAuditEmission:
    def test_create_writes_one_audit_row(self, project) -> None:
        comment = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="hi",
        )
        rows = AuditLog.objects.filter(
            organization=project["org"],
            target_type="comment",
            target_id=str(comment.id),
            action="comment.create",
        )
        assert rows.count() == 1

    def test_edit_writes_audit_row(self, project) -> None:
        comment = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="first",
        )
        edit_comment(
            comment=comment, actor=project["owner"], body="second"
        )
        assert (
            AuditLog.objects.filter(
                action="comment.edit", target_id=str(comment.id)
            ).count()
            == 1
        )

    def test_resolve_and_unresolve_each_write_an_audit_row(
        self, project
    ) -> None:
        comment = create_comment(
            organization=project["org"],
            actor=project["owner"],
            target=project["formulation"],
            body="root",
        )
        resolve_thread(comment=comment, actor=project["owner"])
        comment.refresh_from_db()
        unresolve_thread(comment=comment, actor=project["owner"])
        assert (
            AuditLog.objects.filter(
                action="comment.resolve", target_id=str(comment.id)
            ).count()
            == 1
        )
        assert (
            AuditLog.objects.filter(
                action="comment.unresolve", target_id=str(comment.id)
            ).count()
            == 1
        )
