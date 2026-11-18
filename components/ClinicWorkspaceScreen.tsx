"use client";

import { useEffect, useState } from 'react';
import { Building2, CheckCircle2, Loader2, LogOut, Plus, Users } from 'lucide-react';
import type { ClinicInvitation, ClinicMembership, ClinicSessionUser } from '@/types';
import { ThemeSelector } from '@/components/ThemeSelector';
import { refreshInvitationVerification, sendInvitationVerification, verificationErrorMessage } from '@/lib/invitation-verification';
import {
  acceptClinicInvitation,
  createClinic,
  getClinicInvitation,
  listUserClinics
} from '@/lib/clinics';

export const ClinicWorkspaceScreen = ({
  user,
  invitationClinicId,
  invitationId,
  onSelectClinic,
  onLogout
}: {
  user: ClinicSessionUser;
  invitationClinicId: string;
  invitationId: string;
  onSelectClinic: (membership: ClinicMembership) => void;
  onLogout: () => void;
}) => {
  const [clinics, setClinics] = useState<ClinicMembership[]>([]);
  const [invitation, setInvitation] = useState<ClinicInvitation | null>(null);
  const [clinicName, setClinicName] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState('');
  const [needsVerification, setNeedsVerification] = useState(false);
  const [verificationMessage, setVerificationMessage] = useState('');
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    const loadWorkspace = async () => {
      setIsLoading(true);
      setError('');
      setInvitation(null);
      setNeedsVerification(false);
      try {
        const memberships = await listUserClinics(user.uid);
        if (active) setClinics(memberships);

        if (invitationClinicId && invitationId) {
          // Leave the retry controls available if the network refresh fails.
          if (active) setNeedsVerification(true);
          if (!await refreshInvitationVerification(user.uid)) {
            if (active) setNeedsVerification(true);
            return;
          }
          if (active) setNeedsVerification(false);
          const invite = await getClinicInvitation(invitationClinicId, invitationId);
          if (active) setInvitation(invite);
        }
      } catch (loadError) {
        console.error('[Clinic workspace] Failed to load memberships:', loadError);
        if (active) {
          setError('Could not load the workspace or invitation. Check your connection and that the invitation is current and addressed to this account.');
        }
      } finally {
        if (active) setIsLoading(false);
      }
    };

    loadWorkspace();
    return () => { active = false; };
  }, [user.uid, invitationClinicId, invitationId, refreshKey]);

  const handleVerification = async (resend: boolean) => {
    setVerificationBusy(true);
    setVerificationMessage('');
    try {
      const verified = await refreshInvitationVerification(user.uid);
      if (verified) {
        setNeedsVerification(false);
        setVerificationMessage('Email verified.');
        setRefreshKey(value => value + 1);
      } else if (resend) {
        await sendInvitationVerification(user.uid);
        setVerificationMessage('Verification email sent. Check your inbox and spam folder, open the link, then choose “I’ve verified”.');
      } else {
        setVerificationMessage('This email is not verified yet. Open the verification link in your inbox, then try again.');
      }
    } catch (verificationError) {
      setVerificationMessage(verificationErrorMessage(verificationError));
    } finally {
      setVerificationBusy(false);
    }
  };

  const handleCreateClinic = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsWorking(true);
    setError('');
    try {
      const membership = await createClinic(user, clinicName);
      onSelectClinic(membership);
    } catch (createError) {
      console.error('[Clinic workspace] Failed to create clinic:', createError);
      setError(createError instanceof Error ? createError.message : 'Could not create the clinic.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleAcceptInvitation = async () => {
    if (!invitation || !invitationClinicId) return;
    setIsWorking(true);
    setError('');
    try {
      const membership = await acceptClinicInvitation(invitationClinicId, invitation.id, user);
      onSelectClinic(membership);
    } catch (acceptError) {
      console.error('[Clinic workspace] Failed to accept invitation:', acceptError);
      setError(acceptError instanceof Error ? acceptError.message : 'Could not accept this invitation.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleSelectClinic = (membership: ClinicMembership) => {
    setIsWorking(true);
    onSelectClinic(membership);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-3xl overflow-hidden rounded-[18px] border border-line bg-panel shadow-[0_24px_70px_#0b26381f]">
        <div className="flex items-center justify-between gap-4 bg-nav px-7 py-6 text-white">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.2em] font-bold text-teal-300">VetCloudPro</p>
            <h1 className="text-2xl font-black mt-1">Your clinic workspace</h1>
            <p className="mt-1 wrap-anywhere text-sm text-slate-300">Signed in as {user.email}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-center">
            <ThemeSelector />
            <button
              type="button"
              onClick={onLogout}
              className="shrink-0 inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-sm font-bold"
            >
              <LogOut className="w-4 h-4" /> Sign out
            </button>
          </div>
        </div>

        <div className="p-6 sm:p-8 space-y-7">
          {needsVerification && (
            <section className="rounded-xl border border-warning-stroke bg-warning-wash p-4 text-sm text-content-title">
              <h2 className="font-bold">Verify your email to open and accept this invitation</h2>
              <p className="mt-2 wrap-anywhere">Use the verification link sent to {user.email}. Your existing clinics remain available below.</p>
              <div className="mt-3 flex flex-wrap gap-3">
                <button type="button" disabled={verificationBusy} onClick={() => handleVerification(true)} className="rounded-lg bg-slate-900 px-3 py-2 text-white disabled:opacity-50">Send / resend email</button>
                <button type="button" disabled={verificationBusy} onClick={() => handleVerification(false)} className="rounded-lg border border-outline-strong px-3 py-2 disabled:opacity-50">I’ve verified</button>
              </div>
            </section>
          )}
          {verificationMessage && <p role="status" className="text-sm text-content-copy">{verificationMessage}</p>}
          {error && (
            <div role="alert" className="rounded-xl border border-danger-stroke bg-danger-wash px-4 py-3 text-sm text-danger-text-deep">
              {error}
              <button type="button" disabled={isLoading} onClick={() => setRefreshKey(value => value + 1)} className="ml-3 font-bold underline">Retry</button>
            </div>
          )}

          {isLoading ? (
            <div className="py-10 flex items-center justify-center gap-3 text-content-hint">
              <Loader2 className="w-5 h-5 animate-spin text-brand-text" /> Loading clinics…
            </div>
          ) : (
            <>
              {invitation && (
                <section className="rounded-2xl border border-brand-stroke bg-brand-wash p-5">
                  <div className="flex gap-3">
                    <div className="w-10 h-10 rounded-xl bg-brand-tint flex items-center justify-center shrink-0">
                      <Users className="w-5 h-5 text-brand-text-strong" />
                    </div>
                    <div className="flex-1">
                      <p className="text-xs font-black uppercase tracking-wider text-brand-text-strong">Clinic invitation</p>
                      <h2 className="text-lg font-black text-content-title mt-1">{invitation.clinicName}</h2>
                      <p className="mt-1 wrap-anywhere text-sm text-content-secondary">
                        Invited as <strong className="capitalize">{invitation.role}</strong> using {invitation.email}.
                      </p>
                      <button
                        type="button"
                        onClick={handleAcceptInvitation}
                        disabled={isWorking || invitation.status !== 'pending'}
                        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-teal-800 disabled:opacity-50"
                      >
                        {isWorking ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                        Accept invitation
                      </button>
                    </div>
                  </div>
                </section>
              )}

              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Building2 className="w-5 h-5 text-brand-text-strong" />
                  <h2 className="font-black text-content-title">Clinics you can access</h2>
                </div>
                {clinics.length ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {clinics.map(membership => (
                      <button
                        type="button"
                        key={membership.clinicId}
                        disabled={isWorking}
                        onClick={() => handleSelectClinic(membership)}
                        className="text-left rounded-2xl border border-outline-soft p-4 hover:border-teal-400 hover:bg-brand-wash transition-colors disabled:opacity-50"
                      >
                        <span className="block font-black text-content-title">{membership.clinicName}</span>
                        <span className="mt-1 block text-xs uppercase tracking-wider font-bold text-content-hint capitalize">
                          {membership.role}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-xl bg-panel-subtle border border-outline-soft px-4 py-3 text-sm text-content-hint">
                    No clinic memberships yet. Create a clinic or accept an invitation.
                  </p>
                )}
              </section>

              <section className="border-t border-outline-soft pt-6">
                <div className="flex items-center gap-2 mb-3">
                  <Plus className="w-5 h-5 text-brand-text-strong" />
                  <h2 className="font-black text-content-title">Create a new clinic</h2>
                </div>
                <form onSubmit={handleCreateClinic} className="flex flex-col sm:flex-row gap-3">
                  <input
                    required
                    maxLength={100}
                    value={clinicName}
                    onChange={event => setClinicName(event.target.value)}
                    placeholder="Clinic name"
                    className="flex-1 rounded-xl border border-field-outline bg-field-subtle px-4 py-3 text-sm font-medium text-content-title outline-none focus:ring-2 focus:ring-teal-500"
                  />
                  <button
                    type="submit"
                    disabled={isWorking || !clinicName.trim()}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-black text-white hover:bg-accent-strong disabled:opacity-50"
                  >
                    {isWorking && <Loader2 className="w-4 h-4 animate-spin" />}
                    Create clinic
                  </button>
                </form>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
