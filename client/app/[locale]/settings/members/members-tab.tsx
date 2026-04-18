"use client";

import { Button, Modal } from "@heroui/react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  MailPlus,
  Pencil,
  RefreshCcw,
  Trash2,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Chip } from "@/components/ui/chip";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  useCreateInvitation,
  useInvitations,
  useResendInvitation,
  useRevokeInvitation,
  type InvitationDto,
  type InvitationStatus,
} from "@/services/invitations";
import {
  useMemberships,
  useModules,
  useRemoveMembership,
  useUpdateMembershipPermissions,
  type MembershipDto,
  type ModuleDefinitionDto,
  type PermissionsDict,
} from "@/services/members";

import { CapabilityGrid } from "./capability-grid";


interface MembersTabProps {
  readonly orgId: string;
  readonly currentUserId: string;
  readonly callerCapabilities: readonly string[];
  readonly initialMemberships: readonly MembershipDto[];
  readonly initialInvitations: readonly InvitationDto[];
  readonly modules: readonly ModuleDefinitionDto[];
  readonly catalogueSlugs: readonly string[];
}


/**
 * Members & permissions tab. Renders the membership table, the
 * pending-invitations list, and the "invite" + "edit permissions"
 * flows. Capability gating happens twice — the UI hides controls the
 * caller can't reach, and the backend re-checks on every request.
 */
export function MembersTab({
  orgId,
  currentUserId,
  callerCapabilities,
  initialMemberships,
  initialInvitations,
  modules,
  catalogueSlugs,
}: MembersTabProps) {
  const tSettings = useTranslations("settings");

  const membersQuery = useMemberships(orgId, {
    initialData: initialMemberships,
  });
  const invitationsQuery = useInvitations(orgId, {
    initialData: initialInvitations,
  });

  const memberships = membersQuery.data ?? initialMemberships;
  const invitations = invitationsQuery.data ?? initialInvitations;

  const canInvite = callerCapabilities.includes("invite");
  const canEditPermissions = callerCapabilities.includes("edit_permissions");
  const canRemove = callerCapabilities.includes("remove");

  const [editingMembership, setEditingMembership] =
    useState<MembershipDto | null>(null);
  const [confirmRemove, setConfirmRemove] =
    useState<MembershipDto | null>(null);
  const [isInviting, setIsInviting] = useState(false);

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col">
        <h2 className="text-lg font-semibold text-ink-1000">
          {tSettings("members.section_title")}
        </h2>
        <p className="mt-0.5 text-sm text-ink-500">
          {tSettings("members.section_subtitle")}
        </p>
      </div>

      <PendingInvitationsCard
        invitations={invitations}
        orgId={orgId}
        canInvite={canInvite}
        canRevoke={canRemove}
        onOpenInvite={() => setIsInviting(true)}
      />

      <MembersListCard
        memberships={memberships}
        currentUserId={currentUserId}
        canEditPermissions={canEditPermissions}
        canRemove={canRemove}
        onEdit={setEditingMembership}
        onRemove={setConfirmRemove}
      />

      {editingMembership ? (
        <EditPermissionsDrawer
          orgId={orgId}
          membership={editingMembership}
          modules={modules}
          catalogueSlugs={catalogueSlugs}
          onClose={() => setEditingMembership(null)}
        />
      ) : null}

      {confirmRemove ? (
        <RemoveMemberDialog
          orgId={orgId}
          membership={confirmRemove}
          onClose={() => setConfirmRemove(null)}
        />
      ) : null}

      {isInviting ? (
        <InviteMemberDialog
          orgId={orgId}
          modules={modules}
          catalogueSlugs={catalogueSlugs}
          onClose={() => setIsInviting(false)}
        />
      ) : null}
    </section>
  );
}


// ---------------------------------------------------------------------------
// Members list
// ---------------------------------------------------------------------------


function MembersListCard({
  memberships,
  currentUserId,
  canEditPermissions,
  canRemove,
  onEdit,
  onRemove,
}: {
  memberships: readonly MembershipDto[];
  currentUserId: string;
  canEditPermissions: boolean;
  canRemove: boolean;
  onEdit: (m: MembershipDto) => void;
  onRemove: (m: MembershipDto) => void;
}) {
  const tSettings = useTranslations("settings");

  return (
    <article className="overflow-hidden rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
      <header className="border-b border-ink-100 px-5 py-4">
        <h3 className="text-sm font-semibold text-ink-1000">
          {tSettings("members.list_title", { count: memberships.length })}
        </h3>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse">
          <thead className="bg-ink-50">
            <tr>
              <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
                {tSettings("members.col_name")}
              </th>
              <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
                {tSettings("members.col_role")}
              </th>
              <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
                {tSettings("members.col_joined")}
              </th>
              <th className="px-5 py-3 text-right text-xs font-medium uppercase tracking-wide text-ink-500">
                {tSettings("members.col_actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {memberships.map((m, idx) => (
              <MemberRow
                key={m.id}
                membership={m}
                currentUserId={currentUserId}
                canEditPermissions={canEditPermissions}
                canRemove={canRemove}
                isLast={idx === memberships.length - 1}
                onEdit={() => onEdit(m)}
                onRemove={() => onRemove(m)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}


function MemberRow({
  membership,
  currentUserId,
  canEditPermissions,
  canRemove,
  isLast,
  onEdit,
  onRemove,
}: {
  membership: MembershipDto;
  currentUserId: string;
  canEditPermissions: boolean;
  canRemove: boolean;
  isLast: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const tSettings = useTranslations("settings");
  const isSelf = membership.user.id === currentUserId;
  const isOwner = membership.is_owner;
  const disableEdit = !canEditPermissions || isOwner || isSelf;
  const disableRemove = !canRemove || isOwner || isSelf;

  return (
    <tr className={isLast ? "" : "border-b border-ink-100"}>
      <td className="px-5 py-4">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-ink-1000">
            {membership.user.full_name}
          </span>
          <span className="text-xs text-ink-500">{membership.user.email}</span>
        </div>
      </td>
      <td className="px-5 py-4">
        {isOwner ? (
          <Chip tone="orange">{tSettings("organization.role_owner")}</Chip>
        ) : (
          <Chip tone="neutral">{tSettings("organization.role_member")}</Chip>
        )}
      </td>
      <td className="px-5 py-4 text-sm text-ink-500">
        {formatRelativeDay(membership.created_at)}
      </td>
      <td className="px-5 py-4">
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            disabled={disableEdit}
            aria-label={tSettings("members.action_edit")}
            onClick={onEdit}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Pencil className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">
              {tSettings("members.action_edit")}
            </span>
          </button>
          <button
            type="button"
            disabled={disableRemove}
            aria-label={tSettings("members.action_remove")}
            onClick={onRemove}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}


// ---------------------------------------------------------------------------
// Pending invitations card
// ---------------------------------------------------------------------------


function PendingInvitationsCard({
  invitations,
  orgId,
  canInvite,
  canRevoke,
  onOpenInvite,
}: {
  invitations: readonly InvitationDto[];
  orgId: string;
  canInvite: boolean;
  canRevoke: boolean;
  onOpenInvite: () => void;
}) {
  const tSettings = useTranslations("settings");

  return (
    <article className="overflow-hidden rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-ink-1000">
            {tSettings("members.invitations_title")}
          </h3>
          <p className="mt-0.5 text-xs text-ink-500">
            {tSettings("members.invitations_hint", {
              count: invitations.length,
            })}
          </p>
        </div>
        {canInvite ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-3 text-sm font-medium text-ink-0 hover:bg-orange-600"
            onClick={onOpenInvite}
          >
            <MailPlus className="h-4 w-4" />
            {tSettings("members.invite_cta")}
          </Button>
        ) : null}
      </header>

      {invitations.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-sm text-ink-500">
            {tSettings("members.invitations_empty")}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-ink-100">
          {invitations.map((invite) => (
            <InvitationRow
              key={invite.id}
              invite={invite}
              orgId={orgId}
              canInvite={canInvite}
              canRevoke={canRevoke}
            />
          ))}
        </ul>
      )}
    </article>
  );
}


function InvitationRow({
  invite,
  orgId,
  canInvite,
  canRevoke,
}: {
  invite: InvitationDto;
  orgId: string;
  canInvite: boolean;
  canRevoke: boolean;
}) {
  const tSettings = useTranslations("settings");
  const tErrors = useTranslations("errors");

  const resendMutation = useResendInvitation(orgId);
  const revokeMutation = useRevokeInvitation(orgId);
  const [error, setError] = useState<string | null>(null);

  const handleResend = async () => {
    setError(null);
    try {
      await resendMutation.mutateAsync(invite.id);
    } catch (err) {
      setError(extractApiMessage(err, tErrors));
    }
  };

  const handleRevoke = async () => {
    if (!confirm(tSettings("members.revoke_confirm", { email: invite.email })))
      return;
    setError(null);
    try {
      await revokeMutation.mutateAsync(invite.id);
    } catch (err) {
      setError(extractApiMessage(err, tErrors));
    }
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-ink-1000">
          {invite.email}
        </span>
        <span className="truncate text-xs text-ink-500">
          {tSettings("members.invited_by", {
            name: invite.invited_by.full_name,
          })}{" "}
          · {formatRelativeDay(invite.created_at)}
        </span>
        {error ? (
          <span className="mt-1 text-xs font-medium text-danger">
            {error}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <StatusChip status={invite.status} />
        {canInvite ? (
          <button
            type="button"
            onClick={handleResend}
            disabled={resendMutation.isPending}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-50"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">
              {tSettings("members.action_resend")}
            </span>
          </button>
        ) : null}
        {canRevoke ? (
          <button
            type="button"
            onClick={handleRevoke}
            disabled={revokeMutation.isPending}
            aria-label={tSettings("members.action_revoke")}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </li>
  );
}


function StatusChip({ status }: { status: InvitationStatus }) {
  const tSettings = useTranslations("settings");
  if (status === "accepted") {
    return (
      <Chip tone="success" icon={<CheckCircle2 className="h-3 w-3" />}>
        {tSettings("members.status_accepted")}
      </Chip>
    );
  }
  if (status === "expired") {
    return (
      <Chip tone="danger" icon={<AlertTriangle className="h-3 w-3" />}>
        {tSettings("members.status_expired")}
      </Chip>
    );
  }
  return (
    <Chip tone="orange" icon={<Clock className="h-3 w-3" />}>
      {tSettings("members.status_pending")}
    </Chip>
  );
}


// ---------------------------------------------------------------------------
// Edit permissions drawer
// ---------------------------------------------------------------------------


function EditPermissionsDrawer({
  orgId,
  membership,
  modules,
  catalogueSlugs,
  onClose,
}: {
  orgId: string;
  membership: MembershipDto;
  modules: readonly ModuleDefinitionDto[];
  catalogueSlugs: readonly string[];
  onClose: () => void;
}) {
  const tSettings = useTranslations("settings");
  const tErrors = useTranslations("errors");

  const [draft, setDraft] = useState<PermissionsDict>(
    membership.permissions ?? {},
  );
  const [error, setError] = useState<string | null>(null);

  const mutation = useUpdateMembershipPermissions(orgId);

  // Reset the draft if the target changes (drawer reopens for a
  // different member without unmounting — unlikely today but cheap
  // to be defensive about).
  useEffect(() => {
    setDraft(membership.permissions ?? {});
    setError(null);
  }, [membership.id, membership.permissions]);

  const handleSave = async () => {
    setError(null);
    try {
      await mutation.mutateAsync({
        membershipId: membership.id,
        payload: { permissions: draft },
      });
      onClose();
    } catch (err) {
      setError(extractApiMessage(err, tErrors));
    }
  };

  return (
    <Modal isOpen onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
              <div className="flex min-w-0 flex-col">
                <Modal.Heading className="truncate text-base font-semibold text-ink-1000">
                  {tSettings("members.edit_title", {
                    name: membership.user.full_name,
                  })}
                </Modal.Heading>
                <p className="mt-0.5 truncate text-xs text-ink-500">
                  {membership.user.email}
                </p>
              </div>
              <button
                type="button"
                aria-label={tSettings("members.close")}
                onClick={onClose}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 hover:bg-ink-50"
              >
                <X className="h-4 w-4" />
              </button>
            </Modal.Header>
            <Modal.Body className="max-h-[70vh] overflow-y-auto px-6 py-6">
              <CapabilityGrid
                modules={modules}
                catalogueSlugs={catalogueSlugs}
                value={draft}
                onChange={setDraft}
                disabled={mutation.isPending}
              />
              {error ? (
                <p
                  role="alert"
                  className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                >
                  {error}
                </p>
              ) : null}
            </Modal.Body>
            <Modal.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
              <Button
                type="button"
                variant="outline"
                size="md"
                className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                onClick={onClose}
                isDisabled={mutation.isPending}
              >
                {tSettings("members.cancel")}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="md"
                className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
                onClick={handleSave}
                isDisabled={mutation.isPending}
              >
                {tSettings("members.save")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


// ---------------------------------------------------------------------------
// Remove member dialog
// ---------------------------------------------------------------------------


function RemoveMemberDialog({
  orgId,
  membership,
  onClose,
}: {
  orgId: string;
  membership: MembershipDto;
  onClose: () => void;
}) {
  const tSettings = useTranslations("settings");
  const tErrors = useTranslations("errors");
  const mutation = useRemoveMembership(orgId);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setError(null);
    try {
      await mutation.mutateAsync(membership.id);
      onClose();
    } catch (err) {
      setError(extractApiMessage(err, tErrors));
    }
  };

  return (
    <Modal isOpen onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <Modal.Backdrop>
        <Modal.Container size="sm">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <Modal.Header className="border-b border-ink-200 px-6 py-4">
              <Modal.Heading className="text-base font-semibold text-ink-1000">
                {tSettings("members.remove_title")}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="px-6 py-6">
              <p className="text-sm text-ink-500">
                {tSettings("members.remove_body", {
                  name: membership.user.full_name,
                })}
              </p>
              {error ? (
                <p
                  role="alert"
                  className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                >
                  {error}
                </p>
              ) : null}
            </Modal.Body>
            <Modal.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
              <Button
                type="button"
                variant="outline"
                size="md"
                className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                onClick={onClose}
                isDisabled={mutation.isPending}
              >
                {tSettings("members.cancel")}
              </Button>
              <Button
                type="button"
                variant="danger"
                size="md"
                className="h-10 rounded-lg bg-danger px-4 text-sm font-medium text-ink-0 hover:bg-danger/90"
                onClick={handleConfirm}
                isDisabled={mutation.isPending}
              >
                {tSettings("members.remove_confirm")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


// ---------------------------------------------------------------------------
// Invite dialog
// ---------------------------------------------------------------------------


function InviteMemberDialog({
  orgId,
  modules,
  catalogueSlugs,
  onClose,
}: {
  orgId: string;
  modules: readonly ModuleDefinitionDto[];
  catalogueSlugs: readonly string[];
  onClose: () => void;
}) {
  const tSettings = useTranslations("settings");
  const tErrors = useTranslations("errors");

  const [email, setEmail] = useState("");
  const [permissions, setPermissions] = useState<PermissionsDict>({});
  const [error, setError] = useState<string | null>(null);

  const mutation = useCreateInvitation(orgId);

  const handleSubmit = async () => {
    setError(null);
    try {
      await mutation.mutateAsync({
        email: email.trim(),
        permissions,
      });
      onClose();
    } catch (err) {
      setError(extractApiMessage(err, tErrors));
    }
  };

  return (
    <Modal isOpen onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
              <Modal.Heading className="text-base font-semibold text-ink-1000">
                {tSettings("members.invite_title")}
              </Modal.Heading>
              <button
                type="button"
                aria-label={tSettings("members.close")}
                onClick={onClose}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 hover:bg-ink-50"
              >
                <X className="h-4 w-4" />
              </button>
            </Modal.Header>
            <Modal.Body className="max-h-[70vh] overflow-y-auto px-6 py-6">
              <div className="flex flex-col gap-5">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tSettings("members.invite_email_label")}
                  </span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={tSettings("members.invite_email_placeholder")}
                    autoComplete="off"
                    className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  />
                </label>
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-ink-700">
                    {tSettings("members.invite_permissions_label")}
                  </span>
                  <CapabilityGrid
                    modules={modules}
                    catalogueSlugs={catalogueSlugs}
                    value={permissions}
                    onChange={setPermissions}
                    disabled={mutation.isPending}
                  />
                </div>
                {error ? (
                  <p
                    role="alert"
                    className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                  >
                    {error}
                  </p>
                ) : null}
              </div>
            </Modal.Body>
            <Modal.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
              <Button
                type="button"
                variant="outline"
                size="md"
                className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                onClick={onClose}
                isDisabled={mutation.isPending}
              >
                {tSettings("members.cancel")}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="md"
                className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
                onClick={handleSubmit}
                isDisabled={mutation.isPending || !email.trim()}
              >
                {tSettings("members.invite_submit")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function extractApiMessage(
  err: unknown,
  tErrors: ReturnType<typeof useTranslations<"errors">>,
): string {
  if (err instanceof ApiError) {
    for (const codes of Object.values(err.fieldErrors)) {
      if (Array.isArray(codes) && codes.length > 0) {
        return translateCode(tErrors, String(codes[0]));
      }
    }
  }
  return tErrors("generic");
}


// Deterministic UTC-day relative formatter — matches the one used on
// the formulations list so timestamps render identically across the
// app without hydration drift.
function formatRelativeDay(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffMs = now - then;
  const day = 86_400_000;
  if (diffMs < day) return "today";
  if (diffMs < 2 * day) return "yesterday";
  const days = Math.floor(diffMs / day);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
