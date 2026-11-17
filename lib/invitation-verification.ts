import { initializeFirebase } from '@/lib/firebase';

/** Refresh both the user record and token: reload alone leaves stale claims. */
export const refreshInvitationVerification = async (uid: string): Promise<boolean> => {
  const { auth } = await initializeFirebase();
  const user = auth.currentUser;
  if (!user || user.uid !== uid) throw new Error('Sign in again to verify your email.');
  await user.reload();
  const token = await user.getIdTokenResult(true);
  if (auth.currentUser?.uid !== uid) throw new Error('Your signed-in account changed. Sign in again.');
  return user.emailVerified && token.claims.email_verified === true;
};

export const sendInvitationVerification = async (uid: string): Promise<void> => {
  const { auth } = await initializeFirebase();
  const user = auth.currentUser;
  if (!user || user.uid !== uid) throw new Error('Sign in again to verify your email.');
  const { sendEmailVerification } = await import('firebase/auth');
  // Keep the invitation query in the continue URL, including after a new login.
  await sendEmailVerification(user, { url: window.location.href });
};

export const verificationErrorMessage = (error: unknown): string => {
  const code = (error as { code?: string })?.code;
  if (code === 'auth/too-many-requests') return 'Too many verification requests. Wait a minute before trying again.';
  if (code === 'auth/network-request-failed') return 'Cannot reach Firebase. Check your connection and try again.';
  return error instanceof Error ? error.message : 'Email verification failed. Please try again.';
};
