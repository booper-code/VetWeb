"use client";

import { useEffect, useState } from 'react';
import { Copy, Loader2, MailPlus, RefreshCw, Shield, Trash2, UserRound, X } from 'lucide-react';
import type { ClinicInvitation, ClinicMember, ClinicRole, ClinicSessionUser } from '@/types';
import {
  createClinicInvitation,
  listClinicInvitations,
  listClinicMembers,
  removeClinicMember,
  revokeClinicInvitation
} from '@/lib/clinics';

export const ClinicTeamView = ({
  clinicId,
  clinicName,
  user,
  role,
  triggerToast
}: {
  clinicId: string;
  clinicName: string;
  user: ClinicSessionUser;
  role: ClinicRole;
  triggerToast: (message: string) => void;
}) => {
  const [members, setMembers] = useState<ClinicMember[]>([]);
  const [invitations, setInvitations] = useState<ClinicInvitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
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
    if (role !== 'owner') return;
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
  }, [clinicId, role]);

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

  if (role !== 'owner') {
    return (
      <div className="rounded-2xl border border-outline-soft bg-panel p-6 text-sm text-content-secondary">
        Only this clinic’s owner can manage invitations.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-black text-content-title">Team &amp; Invitations</h2>
        <p className="text-sm text-content-hint mt-1">Manage who can access {clinicName}.</p>
      </div>

      {error && <div role="alert" className="rounded-xl border border-danger-stroke bg-danger-wash px-4 py-3 text-sm text-danger-text-deep">{error}</div>}

      <section className="bg-panel border border-outline-soft rounded-2xl p-5 sm:p-6 space-y-4">
        <div className="flex items-center gap-2">
          <MailPlus className="w-5 h-5 text-brand-text-strong" />
          <h3 className="font-black text-content-title">Invite someone</h3>
        </div>
        <p className="text-sm text-content-hint">
          Create a 7-day Member invite, then copy and send it yourself. Members have full clinic access except for managing invitations and removing members.
        </p>
        <form onSubmit={handleCreateInvite} className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
          <input
            type="email"
            required
            value={inviteEmail}
            onChange={event => setInviteEmail(event.target.value)}
            placeholder="person@example.com"
            className="rounded-xl border border-field-outline bg-field-subtle px-4 py-3 text-sm text-content-title outline-none focus:ring-2 focus:ring-teal-500"
          />
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
          <div className="flex flex-col sm:flex-row gap-2 rounded-xl bg-brand-wash border border-brand-stroke p-3">
            <input
              aria-label="New invitation link"
              readOnly
              value={newInviteUrl}
              onFocus={event => event.currentTarget.select()}
              className="min-w-0 flex-1 bg-transparent px-2 py-2 text-xs font-mono text-content-copy outline-none"
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

      <section className="bg-panel border border-outline-soft rounded-2xl p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <UserRound className="w-5 h-5 text-brand-text-strong" />
            <h3 className="font-black text-content-title">Clinic members</h3>
          </div>
          <button
            type="button"
            onClick={() => { setIsLoading(true); refresh().catch(() => setError('Could not refresh clinic members.')).finally(() => setIsLoading(false)); }}
            className="p-2 rounded-lg text-content-hint hover:bg-panel-raised"
            aria-label="Refresh clinic team"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
        {isLoading ? (
          <div className="py-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-brand-text-strong" /></div>
        ) : members.length ? (
          <div className="divide-y divide-hairline">
            {members.map(member => (
              <div key={member.uid} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-sm text-content-title truncate">
                    {member.displayName || member.email || member.uid}
                    {member.uid === user.uid && (
                      <span className="ml-2 text-[10px] font-black uppercase tracking-wider text-brand-text-strong">You</span>
                    )}
                  </p>
                  <p className="text-xs text-content-hint truncate">{member.email}</p>
                </div>

                {member.uid === user.uid || member.role === 'owner' ? (
                  <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-panel-raised px-3 py-1 text-[10px] font-black uppercase tracking-wider text-content-secondary">
                    <Shield className="w-3 h-3" /> {member.role}
                  </span>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <span className="text-xs font-bold text-content-copy">Member</span>
                    <button
                      type="button"
                      disabled={isWorking}
                      onClick={() => handleRemoveMember(member)}
                      className="rounded-lg bg-danger-wash px-2.5 py-1.5 text-xs font-bold text-danger-text hover:bg-danger-tint disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="py-4 text-sm text-content-hint">No members loaded yet.</p>
        )}
      </section>

      <section className="bg-panel border border-outline-soft rounded-2xl p-5 sm:p-6">
        <div className="flex items-center gap-2 mb-4">
          <MailPlus className="w-5 h-5 text-brand-text-strong" />
          <h3 className="font-black text-content-title">Pending invitations</h3>
        </div>
        {invitations.length ? (
          <div className="space-y-3">
            {invitations.map(invitation => (
                <div key={invitation.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-outline-soft p-3">
                  <div>
                    <p className="text-sm font-bold text-content-title">{invitation.email}</p>
                    <p className="text-xs text-content-hint capitalize">
                      {invitation.role === 'viewer' ? 'Legacy Viewer · Reissue required' : 'Member access'} · {invitation.expiresAt?.toMillis
                        ? `expires ${new Date(invitation.expiresAt.toMillis()).toLocaleDateString()}`
                        : 'expiry unavailable'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {invitation.role !== 'viewer' && <button type="button" onClick={() => handleCopy(invitationUrl(invitation.id))} className="rounded-lg bg-panel-raised px-3 py-2 text-xs font-bold text-content-copy hover:bg-panel-pressed inline-flex items-center gap-1">
                      <Copy className="w-3.5 h-3.5" /> Copy link
                    </button>}
                    <button type="button" disabled={isWorking} onClick={() => handleRevoke(invitation)} className="rounded-lg bg-danger-wash px-3 py-2 text-xs font-bold text-danger-text hover:bg-danger-tint disabled:opacity-50 inline-flex items-center gap-1">
                      <X className="w-3.5 h-3.5" /> Revoke
                    </button>
                  </div>
                </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-content-hint">No pending invitations.</p>
        )}
      </section>
    </div>
  );
};
