"use client";

import { useEffect, useRef, useState } from 'react';
import { Copy, Crown, Loader2, MailPlus, RefreshCw, Shield, Trash2, UserRound, X } from 'lucide-react';
import type { ClinicInvitation, ClinicMember, ClinicRole, ClinicSessionUser } from '@/types';
import {
  changeClinicMemberRole,
  createClinicInvitation,
  listClinicInvitations,
  listClinicMembers,
  removeClinicMember,
  revokeClinicInvitation,
  transferClinicOwnership
} from '@/lib/clinics';

export const ClinicTeamView = ({
  clinicId,
  clinicName,
  user,
  role,
  onOwnershipTransferred,
  triggerToast
}: {
  clinicId: string;
  clinicName: string;
  user: ClinicSessionUser;
  role: ClinicRole;
  onOwnershipTransferred: (nextRole: ClinicRole) => void;
  triggerToast: (message: string) => void;
}) => {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [members, setMembers] = useState<ClinicMember[]>([]);
  const [invitations, setInvitations] = useState<ClinicInvitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('viewer');
  const [newInviteUrl, setNewInviteUrl] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    const [nextMembers, nextInvitations] = await Promise.all([
      listClinicMembers(clinicId),
      listClinicInvitations(clinicId)
    ]);
    setMembers(nextMembers);
    setInvitations(nextInvitations);
  };

  useEffect(() => {
    let active = true;
    Promise.all([listClinicMembers(clinicId), listClinicInvitations(clinicId)])
      .then(([nextMembers, nextInvitations]) => {
        if (active) {
          setMembers(nextMembers);
          setInvitations(nextInvitations);
          setError('');
        }
      })
      .catch(loadError => {
        console.error('[Clinic team] Failed to load team:', loadError);
        if (active) setError('Could not load the team. Clinic membership rules may not be published yet.');
      })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [clinicId]);

  const handleCreateInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsWorking(true);
    setError('');
    setNewInviteUrl('');
    try {
      const invitation = await createClinicInvitation({
        clinicId,
        clinicName,
        email: inviteEmail,
        role: inviteRole,
        user
      });
      const url = new URL(window.location.href);
      url.search = '';
      url.searchParams.set('inviteClinic', clinicId);
      url.searchParams.set('invite', invitation.id);
      setNewInviteUrl(url.toString());
      setInviteEmail('');
      await refresh();
      triggerToast('Invitation created. Copy the link and send it to the invitee.');
    } catch (createError) {
      console.error('[Clinic team] Failed to create invitation:', createError);
      setError(createError instanceof Error ? createError.message : 'Could not create the invitation.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      triggerToast('Invite link copied.');
    } catch {
      setNewInviteUrl(url);
      triggerToast('Select and copy the invite link from the field.');
    }
  };

  const invitationUrl = (invitationId: string) => {
    const url = new URL('/', window.location.origin);
    url.searchParams.set('inviteClinic', clinicId);
    url.searchParams.set('invite', invitationId);
    return url.toString();
  };

  const handleRevoke = async (invitation: ClinicInvitation) => {
    if (!window.confirm(`Revoke the pending invite for ${invitation.email}?`)) return;
    setIsWorking(true);
    try {
      await revokeClinicInvitation(clinicId, invitation.id);
      setInvitations(previous => previous.filter(item => item.id !== invitation.id));
      if (newInviteUrl.includes(invitation.id)) setNewInviteUrl('');
      triggerToast('Invitation revoked.');
    } catch (revokeError) {
      console.error('[Clinic team] Failed to revoke invitation:', revokeError);
      setError(revokeError instanceof Error ? revokeError.message : 'Could not revoke the invitation.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleRoleChange = async (member: ClinicMember, nextRole: 'editor' | 'viewer') => {
    if (nextRole === member.role) return;
    if (!window.confirm(`Change ${member.email || member.displayName} to ${nextRole} access?`)) return;

    setIsWorking(true);
    setError('');
    try {
      await changeClinicMemberRole(clinicId, member.uid, nextRole);
      setMembers(previous => previous.map(item => (item.uid === member.uid ? { ...item, role: nextRole } : item)));
      triggerToast(`${member.email || member.displayName} is now ${nextRole}.`);
    } catch (changeError) {
      console.error('[Clinic team] Failed to change role:', changeError);
      setError(changeError instanceof Error ? changeError.message : 'Could not change this member’s role.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleRemoveMember = async (member: ClinicMember) => {
    if (!window.confirm(`Remove ${member.email || member.displayName} from ${clinicName}? They lose access immediately.`)) return;

    setIsWorking(true);
    setError('');
    try {
      await removeClinicMember(clinicId, member.uid);
      setMembers(previous => previous.filter(item => item.uid !== member.uid));
      triggerToast('Member removed from the clinic.');
    } catch (removeError) {
      console.error('[Clinic team] Failed to remove member:', removeError);
      setError(removeError instanceof Error ? removeError.message : 'Could not remove this member.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleTransferOwnership = async (member: ClinicMember) => {
    if (!window.confirm(`Make ${member.email || member.displayName} the owner of ${clinicName}? You will become an editor and lose owner-only access.`)) return;

    setIsWorking(true);
    setError('');
    try {
      await transferClinicOwnership(clinicId, user.uid, member.uid);
      // The parent checks workspace scope. A same-clinic tab change must still
      // downgrade its role even after this view unmounts.
      onOwnershipTransferred('editor');
      if (!mounted.current) return;
      triggerToast('Ownership transferred. You now have editor access.');
    } catch (transferError) {
      if (!mounted.current) return;
      console.error('[Clinic team] Failed to transfer ownership:', transferError);
      setError(transferError instanceof Error ? transferError.message : 'Could not transfer ownership.');
    } finally {
      if (mounted.current) setIsWorking(false);
    }
  };

  if (role !== 'owner') {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
        Only this clinic’s owner can manage invitations.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-black text-slate-900">Team &amp; Invitations</h2>
        <p className="text-sm text-slate-500 mt-1">Manage who can access {clinicName}.</p>
      </div>

      {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
        <div className="flex items-center gap-2">
          <MailPlus className="w-5 h-5 text-teal-700" />
          <h3 className="font-black text-slate-900">Invite someone</h3>
        </div>
        <p className="text-sm text-slate-500">
          Create a 7-day invite link, then copy and send it yourself. The invite is limited to the email address entered here.
        </p>
        <form onSubmit={handleCreateInvite} className="grid grid-cols-1 sm:grid-cols-[1fr_160px_auto] gap-3">
          <input
            type="email"
            required
            value={inviteEmail}
            onChange={event => setInviteEmail(event.target.value)}
            placeholder="person@example.com"
            className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-teal-500"
          />
          <select
            value={inviteRole}
            onChange={event => setInviteRole(event.target.value as 'editor' | 'viewer')}
            className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-teal-500"
          >
            <option value="viewer">Viewer — read only</option>
            <option value="editor">Editor — can edit</option>
          </select>
          <button
            type="submit"
            disabled={isWorking || !inviteEmail.trim()}
            className="rounded-xl bg-teal-700 px-5 py-3 text-sm font-black text-white hover:bg-teal-800 disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            {isWorking ? <Loader2 className="w-4 h-4 animate-spin" /> : <MailPlus className="w-4 h-4" />}
            Create invite
          </button>
        </form>
        {newInviteUrl && (
          <div className="flex flex-col sm:flex-row gap-2 rounded-xl bg-teal-50 border border-teal-200 p-3">
            <input
              aria-label="New invitation link"
              readOnly
              value={newInviteUrl}
              onFocus={event => event.currentTarget.select()}
              className="min-w-0 flex-1 bg-transparent px-2 py-2 text-xs font-mono text-slate-700 outline-none"
            />
            <button
              type="button"
              onClick={() => handleCopy(newInviteUrl)}
              className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-black text-white hover:bg-teal-800 inline-flex items-center justify-center gap-2"
            >
              <Copy className="w-4 h-4" /> Copy link
            </button>
          </div>
        )}
      </section>

      <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <UserRound className="w-5 h-5 text-teal-700" />
            <h3 className="font-black text-slate-900">Clinic members</h3>
          </div>
          <button
            type="button"
            onClick={() => { setIsLoading(true); refresh().catch(() => setError('Could not refresh clinic members.')).finally(() => setIsLoading(false)); }}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"
            aria-label="Refresh clinic team"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
        {isLoading ? (
          <div className="py-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-teal-700" /></div>
        ) : members.length ? (
          <div className="divide-y divide-slate-100">
            {members.map(member => (
              <div key={member.uid} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-sm text-slate-900 truncate">
                    {member.displayName || member.email || member.uid}
                    {member.uid === user.uid && (
                      <span className="ml-2 text-[10px] font-black uppercase tracking-wider text-teal-700">You</span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500 truncate">{member.email}</p>
                </div>

                {member.uid === user.uid || member.role === 'owner' ? (
                  <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-slate-600">
                    <Shield className="w-3 h-3" /> {member.role}
                  </span>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <select
                      value={member.role}
                      disabled={isWorking}
                      onChange={event => handleRoleChange(member, event.target.value as 'editor' | 'viewer')}
                      aria-label={`Access level for ${member.email}`}
                      className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-bold text-slate-700 outline-none disabled:opacity-50"
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                    </select>
                    <button
                      type="button"
                      disabled={isWorking}
                      onClick={() => handleTransferOwnership(member)}
                      className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      <Crown className="w-3.5 h-3.5" /> Make owner
                    </button>
                    <button
                      type="button"
                      disabled={isWorking}
                      onClick={() => handleRemoveMember(member)}
                      className="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-bold text-red-700 hover:bg-red-100 disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="py-4 text-sm text-slate-500">No members loaded yet.</p>
        )}
      </section>

      <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6">
        <div className="flex items-center gap-2 mb-4">
          <MailPlus className="w-5 h-5 text-teal-700" />
          <h3 className="font-black text-slate-900">Pending invitations</h3>
        </div>
        {invitations.length ? (
          <div className="space-y-3">
            {invitations.map(invitation => (
                <div key={invitation.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-slate-200 p-3">
                  <div>
                    <p className="text-sm font-bold text-slate-900">{invitation.email}</p>
                    <p className="text-xs text-slate-500 capitalize">
                      {invitation.role} access · {invitation.expiresAt?.toMillis
                        ? `expires ${new Date(invitation.expiresAt.toMillis()).toLocaleDateString()}`
                        : 'expiry unavailable'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => handleCopy(invitationUrl(invitation.id))} className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-200 inline-flex items-center gap-1">
                      <Copy className="w-3.5 h-3.5" /> Copy link
                    </button>
                    <button type="button" disabled={isWorking} onClick={() => handleRevoke(invitation)} className="rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-100 disabled:opacity-50 inline-flex items-center gap-1">
                      <X className="w-3.5 h-3.5" /> Revoke
                    </button>
                  </div>
                </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No pending invitations.</p>
        )}
      </section>
    </div>
  );
};
