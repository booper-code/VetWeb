"use client";

import React, { useState } from 'react';
import { PawPrint, Loader2, AlertCircle, Lock, Mail, ShieldCheck, ChevronRight } from 'lucide-react';
import { initializeFirebase } from '@/lib/firebase';
import type { ClinicSessionUser } from '@/types';
import { sendInvitationVerification } from '@/lib/invitation-verification';
import { ThemeSelector } from '@/components/ThemeSelector';

export const LoginScreen = ({
  onLoginSuccess
}: {
  onLoginSuccess: (user: ClinicSessionUser) => void;
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin');
  const [error, setError] = useState('');
  const [resetSubmitted, setResetSubmitted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const isCreatingAccount = mode === 'signup';
  const isResettingPassword = mode === 'reset';

  const handleAuth = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isLoading) return;
    setIsLoading(true);
    setError('');
    setResetSubmitted(false);

    try {
      if (isResettingPassword) {
        const { auth } = await initializeFirebase();
        const { sendPasswordResetEmail } = await import('firebase/auth');
        await sendPasswordResetEmail(auth, email.trim().toLowerCase());
        setResetSubmitted(true);
        return;
      }

      // Keep the offline demo available independently of Firebase Auth.
      if (!isCreatingAccount && email === 'admin@binanvet.com' && password === 'admin123') {
        onLoginSuccess({
          uid: 'demo-user',
          email,
          displayName: 'Demo Clinic',
          isDemo: true
        });
        return;
      }

      const { auth } = await initializeFirebase();
      const normalizedEmail = email.trim().toLowerCase();
      const {
        createUserWithEmailAndPassword,
        signInWithEmailAndPassword,
        updateProfile
      } = await import('firebase/auth');

      const credential = isCreatingAccount
        ? await createUserWithEmailAndPassword(auth, normalizedEmail, password)
        : await signInWithEmailAndPassword(auth, normalizedEmail, password);

      if (isCreatingAccount && displayName.trim()) {
        await updateProfile(credential.user, { displayName: displayName.trim() });
      }

      if (isCreatingAccount) {
        try {
          await sendInvitationVerification(credential.user.uid);
        } catch (verificationError) {
          // The account exists already. Let the workspace offer a retry rather
          // than presenting this as a failed signup or blocking existing access.
          console.warn('[Auth] Verification email could not be sent:', verificationError);
        }
      }

      onLoginSuccess({
        uid: credential.user.uid,
        email: credential.user.email || normalizedEmail,
        displayName: credential.user.displayName || displayName.trim() || normalizedEmail.split('@')[0]
      });
    } catch (err: unknown) {
      const authError = err as { code?: string; message?: string } | null;
      const code = authError?.code ?? '';
      if (isResettingPassword) {
        if (code === 'auth/user-not-found' || code === 'auth/user-disabled') setResetSubmitted(true);
        else if (code === 'auth/invalid-email') setError('Enter a valid email address.');
        else if (code === 'auth/too-many-requests') setError('Too many requests. Wait and try again later.');
        else if (code === 'auth/network-request-failed') setError('Check your internet connection and try again.');
        else setError('Could not request a reset link. Try again later.');
        return;
      }

      // Expected sign-in failures are shown in the form, not the Next.js error overlay.
      if (code === 'auth/invalid-credential' || code === 'auth/user-not-found' || code === 'auth/wrong-password') {
        setError('Invalid email or password.');
      } else if (code === 'auth/email-already-in-use') {
        setError('An account already uses this email. Sign in instead.');
      } else if (code === 'auth/weak-password') {
        setError('Choose a stronger password (at least 6 characters).');
      } else if (code === 'auth/invalid-email') {
        setError('Enter a valid email address.');
      } else if (code === 'auth/too-many-requests') {
        setError('Too many attempts. Wait a minute and try again.');
      } else if (code === 'auth/network-request-failed') {
        setError('Cannot reach Firebase. Check your internet connection.');
      } else {
        console.error(`[Auth] ${isCreatingAccount ? 'Account creation' : 'Sign-in'} failed:`, err);
        setError(authError?.message || 'Authentication failed.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const changeMode = (nextMode: typeof mode) => {
    setMode(nextMode);
    setDisplayName('');
    setPassword('');
    setError('');
    setResetSubmitted(false);
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas p-4">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[320px] bg-[radial-gradient(circle_at_top_left,_rgba(12,130,118,0.10),_transparent_60%)]" />

      <div className="relative z-10 grid w-full max-w-6xl grid-cols-1 overflow-hidden rounded-[18px] border border-line bg-panel shadow-[0_24px_70px_#0b26381f] lg:grid-cols-2">
        {/* Left branding panel */}
        <div className="relative hidden flex-col justify-between overflow-hidden bg-nav p-10 text-white lg:flex">
          <div className="absolute inset-0 bg-gradient-to-br from-teal-500/20 via-transparent to-emerald-500/10" />

          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-10">
              <div className="w-12 h-12 rounded-2xl bg-teal-500/15 border border-teal-400/30 flex items-center justify-center">
                <PawPrint className="w-7 h-7 text-teal-300" />
              </div>
              <div>
                <h1 className="text-xl font-black tracking-wide">
                  VetCloud<span className="text-teal-300">Pro</span>
                </h1>
              </div>
            </div>

            <h2 className="text-4xl font-black leading-tight mb-4">
              Welcome back to your secure clinical workspace.
            </h2>

            <p className="text-slate-300 text-sm leading-relaxed max-w-md">
              Manage patient dossiers, laboratory records, inventory control, and service billing from one unified dashboard.
            </p>
          </div>

          <div className="relative z-10 grid grid-cols-3 gap-3">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
              <p className="text-2xl font-black text-teal-300">24/7</p>
              <p className="text-[10px] text-content-faint uppercase font-bold mt-1">
                Clinic Ready
              </p>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
              <p className="text-2xl font-black text-teal-300">LAB</p>
              <p className="text-[10px] text-content-faint uppercase font-bold mt-1">
                Diagnostics
              </p>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
              <p className="text-2xl font-black text-teal-300">POS</p>
              <p className="text-[10px] text-content-faint uppercase font-bold mt-1">
                Billing
              </p>
            </div>
          </div>
        </div>

        {/* Right auth panel */}
        <div className="flex flex-col justify-center p-7 sm:p-12">
          <div className="mx-auto w-full max-w-md">
            <div className="flex items-center gap-3 mb-8 lg:hidden">
              <div className="w-12 h-12 rounded-2xl bg-brand-wash border border-brand-stroke flex items-center justify-center">
                <PawPrint className="w-7 h-7 text-brand-text" />
              </div>
              <div>
                <h1 className="text-xl font-black text-content-title">
                  VetCloud<span className="text-brand-text">Pro</span>
                </h1>
              </div>
            </div>

            <div className="mb-8">
              <div className="mb-5 flex items-start justify-between gap-3">
                <div className="w-14 h-14 rounded-2xl bg-slate-900 flex items-center justify-center shadow-lg">
                  <ShieldCheck className="w-7 h-7 text-teal-300" />
                </div>
                <ThemeSelector />
              </div>

                <h2 className="text-3xl font-black text-content-title tracking-tight">
                {isResettingPassword ? 'Reset your password' : isCreatingAccount ? 'Create your account' : 'Secure Staff Login'}
                </h2>
                <p className="text-sm text-content-hint mt-2 font-medium">
                {isResettingPassword ? 'Enter the email you use to sign in.'
                  : isCreatingAccount
                  ? 'Create an account, then set up your clinic or accept an invitation.'
                  : 'Sign in to choose a clinic or accept an invitation.'}
                </p>
            </div>

            {error && (
              <div role="alert" className="bg-danger-wash border border-danger-stroke text-danger-text px-4 py-3 rounded-xl text-sm font-medium mb-6 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <p>{error}</p>
              </div>
            )}
            {resetSubmitted && (
              <p role="status" className="mb-6 text-sm font-medium text-content-secondary">
                If this email is eligible for a password reset, you&apos;ll get a link. Check your inbox and spam folder.
              </p>
            )}
            
            <form onSubmit={handleAuth} className="space-y-5">
              {isCreatingAccount && (
                <div>
                  <label htmlFor="signupName" className="text-xs font-black text-content-hint uppercase tracking-wider block mb-2">
                    Your Name
                  </label>
                  <input
                    id="signupName"
                    type="text"
                    required
                    maxLength={100}
                    className="w-full px-4 py-3.5 bg-field-subtle border border-field-outline rounded-2xl text-sm font-bold text-content-title focus:ring-2 focus:ring-teal-500 focus:border-teal-500 outline-none transition-all"
                    placeholder="Your full name"
                    value={displayName}
                    onChange={event => setDisplayName(event.target.value)}
                  />
                </div>
              )}
              <div>
                <label htmlFor="loginEmail" className="text-xs font-black text-content-hint uppercase tracking-wider block mb-2">
                    Email
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Mail className="h-5 w-5 text-content-faint" />
                  </div>
                  <input
                    id="loginEmail"
                    type="email"
                    autoComplete="email"
                    disabled={isLoading}
                    required
                    className="w-full pl-12 pr-4 py-3.5 bg-field-subtle border border-field-outline rounded-2xl text-sm font-bold text-content-title focus:ring-2 focus:ring-teal-500 focus:border-teal-500 outline-none transition-all"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setResetSubmitted(false); }}
                  />
                </div>
              </div>

              {!isResettingPassword && <div>
                <label htmlFor="loginPassword" className="text-xs font-black text-content-hint uppercase tracking-wider block mb-2">
                  Password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Lock className="h-5 w-5 text-content-faint" />
                  </div>
                  <input
                    id="loginPassword"
                    type="password"
                    autoComplete={isCreatingAccount ? 'new-password' : 'current-password'}
                    required
                    className="w-full pl-12 pr-4 py-3.5 bg-field-subtle border border-field-outline rounded-2xl text-sm font-bold text-content-title focus:ring-2 focus:ring-teal-500 focus:border-teal-500 outline-none transition-all"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              </div>}

              <button
                type="submit"
                disabled={isLoading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3.5 text-sm font-black text-white shadow-lg shadow-teal-900/15 transition-all hover:bg-accent-strong disabled:opacity-70"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin text-teal-300" />
                    {isResettingPassword ? 'Requesting link…' : isCreatingAccount ? 'Creating account…' : 'Authenticating…'}
                  </>
                ) : (
                  <>
                    {isResettingPassword ? 'Send reset link' : isCreatingAccount ? 'Create Account' : 'Sign In'}
                    <ChevronRight className="w-5 h-5 text-teal-300" />
                  </>
                )}
              </button>
            </form>

            {mode === 'signin' && (
              <p className="text-center text-sm mt-5">
                <button type="button" disabled={isLoading} onClick={() => changeMode('reset')}
                  className="font-bold text-brand-text-strong hover:text-brand-text-deep">
                  Forgot password?
                </button>
              </p>
            )}
            <p className="text-center text-sm text-content-hint mt-5">
              {isCreatingAccount ? 'Already have an account? ' : mode === 'signin' ? 'New to VetCloudPro? ' : ''}
              <button
                type="button"
                disabled={isLoading}
                onClick={() => changeMode(mode === 'signin' ? 'signup' : 'signin')}
                className="font-bold text-brand-text-strong hover:text-brand-text-deep"
              >
                {isResettingPassword ? 'Back to sign in' : isCreatingAccount ? 'Sign in' : 'Create an account'}
              </button>
            </p>

            <p className="text-center text-[10px] text-content-faint font-bold uppercase tracking-widest mt-8">
              Protected Clinic Workspace
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
