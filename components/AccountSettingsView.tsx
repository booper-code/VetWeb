"use client";

import { useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, Database, Download, KeyRound, Loader2, Mail } from 'lucide-react';
import { initializeFirebase } from '@/lib/firebase';
import { exportClinicBackup } from '@/lib/backup';
import type { ClinicRole } from '@/types';

export const AccountSettingsView = ({
  clinicId,
  clinicName,
  role,
  email,
  displayName,
  isDemo,
  onRenameClinic,
  triggerToast
}: {
  clinicId: string | null;
  clinicName: string;
  role: ClinicRole | null;
  email: string;
  displayName: string;
  isDemo: boolean;
  onRenameClinic: (name: string) => Promise<void>;
  triggerToast: (msg: string) => void;
}) => {
  // `null` means "no unsaved edit", so the field always reflects the saved name
  // without syncing state from props inside an effect.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [isSavingName, setIsSavingName] = useState(false);
  const [isSendingReset, setIsSendingReset] = useState(false);
  const [isExportingBackup, setIsExportingBackup] = useState(false);
  const [nameError, setNameError] = useState('');

  const draftName = nameDraft ?? clinicName;
  const isOwner = !isDemo && role === 'owner' && Boolean(clinicId);
  const hasNameChange = draftName.trim() !== clinicName && draftName.trim().length > 0;

  const handleSaveName = async () => {
    const nextName = draftName.trim();
    if (!nextName) {
      setNameError('Clinic name cannot be empty.');
      return;
    }

    setIsSavingName(true);
    setNameError('');
    try {
      await onRenameClinic(nextName);
      setNameDraft(null);
      triggerToast('Clinic name updated.');
    } catch (error) {
      console.error('[Account settings] Failed to rename clinic:', error);
      setNameError(error instanceof Error ? error.message : 'Could not save the clinic name.');
    } finally {
      setIsSavingName(false);
    }
  };

  const handlePasswordReset = async () => {
    if (!email) {
      triggerToast('No account email detected.');
      return;
    }

    setIsSendingReset(true);
    try {
      const { sendPasswordResetEmail } = await import('firebase/auth');
      const { auth } = await initializeFirebase();
      await sendPasswordResetEmail(auth, email);
      triggerToast(`Password reset email sent to ${email}.`);
    } catch (error) {
      console.error('[Account settings] Password reset failed:', error);
      triggerToast(error instanceof Error ? error.message : 'Failed to send password reset email.');
    } finally {
      setIsSendingReset(false);
    }
  };

  const handleBackup = async () => {
    if (!clinicId) return;
    setIsExportingBackup(true);
    try {
      const result = await exportClinicBackup({ clinicId, clinicName });
      triggerToast(`Backup downloaded: ${result.documentCount} documents across ${result.collectionCount} collections.`);
    } catch (error) {
      console.error('[Account settings] Backup failed:', error);
      triggerToast(error instanceof Error ? error.message : 'Could not create the clinic backup.');
    } finally {
      setIsExportingBackup(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-800">Account Settings</h2>
        <p className="text-slate-500 font-medium">Manage this clinic&apos;s name and the account you sign in with.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* CLINIC PROFILE */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Building2 className="text-teal-600 w-5 h-5" />
              <h3 className="text-lg font-bold text-slate-800">Clinic Profile</h3>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">
              {isOwner
                ? 'The clinic name appears on the sidebar, invitations, and exported records.'
                : 'Only the clinic owner can rename this clinic.'}
            </p>

            <div className="space-y-2">
              <label htmlFor="clinicName" className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                Clinic Name
              </label>
              <input
                id="clinicName"
                type="text"
                maxLength={100}
                value={draftName}
                disabled={!isOwner || isSavingName}
                onChange={event => setNameDraft(event.target.value)}
                placeholder="e.g. Biñan Animal Clinic"
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-900 outline-none focus:ring-2 focus:ring-teal-500 disabled:text-slate-500 disabled:cursor-not-allowed"
              />

              <div className="flex items-center justify-between gap-3 pt-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  Your access · <span className="text-teal-700">{isDemo ? 'demo' : role || 'unknown'}</span>
                </span>
                {clinicId && (
                  <span className="text-[10px] font-mono text-slate-300 truncate max-w-[45%]" title={clinicId}>
                    {clinicId}
                  </span>
                )}
              </div>

              {nameError && (
                <p className="text-xs font-bold text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                  {nameError}
                </p>
              )}
            </div>
          </div>

          {isOwner ? (
            <button
              type="button"
              onClick={handleSaveName}
              disabled={isSavingName || !hasNameChange}
              className="w-full bg-teal-600 hover:bg-teal-700 text-white font-bold py-3 rounded-xl text-sm transition-all inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSavingName ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Save Clinic Name
            </button>
          ) : (
            <p className="text-[11px] text-slate-400 font-medium text-center">
              {isDemo ? 'Demo workspace — changes are not saved.' : 'Ask the clinic owner to rename this clinic.'}
            </p>
          )}
        </div>

        {/* SIGN-IN */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <KeyRound className="text-slate-700 w-5 h-5" />
              <h3 className="text-lg font-bold text-slate-800">Sign-in &amp; Security</h3>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">
              Clinic access is tied to this login. Your role applies to every clinic you belong to.
            </p>

            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                Login Email
              </label>
              <div className="w-full p-2.5 bg-slate-100 border border-slate-200 rounded-xl text-xs font-bold text-slate-500 flex items-center gap-2">
                <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span className="truncate">{email || 'No email detected'}</span>
              </div>

              {displayName && (
                <>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block pt-1">
                    Display Name
                  </label>
                  <div className="w-full p-2.5 bg-slate-100 border border-slate-200 rounded-xl text-xs font-bold text-slate-500 truncate">
                    {displayName}
                  </div>
                </>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={handlePasswordReset}
            disabled={!email || isSendingReset}
            className="w-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold py-3 rounded-xl text-sm transition-all border border-slate-200 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
          >
            {isSendingReset && <Loader2 className="w-4 h-4 animate-spin" />}
            Send Password Reset Email
          </button>
        </div>
      </div>

      {/* CLINIC BACKUP */}
      {isOwner && (
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <Database className="w-5 h-5 text-teal-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-lg font-bold text-slate-800">Clinic data backup</h3>
              <p className="text-sm text-slate-600 leading-relaxed mt-1">
                Download a JSON snapshot of patients, inventory, consultations, staff, payroll, members, and invitations. Keep it somewhere safe before bulk changes.
                Images stored in R2 are referenced by key, not included in this file; back up the R2 bucket separately.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleBackup}
            disabled={isExportingBackup}
            className="shrink-0 inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {isExportingBackup ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Download backup
          </button>
        </div>
      )}

      {/* DANGER ZONE */}
      <div className="bg-white p-6 rounded-2xl border border-red-200 shadow-sm">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-lg font-bold text-slate-800">Account deletion</h3>
            <p className="text-sm text-slate-600 leading-relaxed mt-1">
              Disabled for now. Deleting a login before clinic ownership can be transferred could lock everyone out of that clinic.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
