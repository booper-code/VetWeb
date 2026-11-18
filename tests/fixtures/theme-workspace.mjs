import { build } from 'esbuild';

const source = `
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { ClinicWorkspaceScreen } from '@/components/ClinicWorkspaceScreen';
  import { ClinicTeamView } from '@/components/ClinicTeamView';
  import { AuditLogView } from '@/components/AuditLogView';
  import { ImageStorageControls } from '@/components/ImageStorageControls';
  import { AILaboratoryView } from '@/components/AILaboratoryView';
  import { Sidebar } from '@/components/Sidebar';
  import { Header } from '@/components/Header';

  const scenario = new URLSearchParams(location.search);
  const user = { uid: 'fixture', displayName: 'Theme Fixture',
    email: scenario.has('long-email') ? 'longfirstnameandlastnamewithnobreaks@localfixture.example.test' : 'local-fixture@example.test' };
  function Fixture() {
    const [clinic, setClinic] = useState(null);
    const [search, setSearch] = useState('');
    const [tab, setTab] = useState('team');
    const [open, setOpen] = useState(false);
    if (!clinic) return <ClinicWorkspaceScreen user={user}
      invitationClinicId="fixture-clinic" invitationId="fixture-invitation"
      onSelectClinic={choice => { setClinic(choice); setTab(choice.role === 'owner' ? 'team' : 'settings'); }} onLogout={() => {}} />;
    return <div className="flex min-h-screen bg-canvas">
      <Sidebar currentUser={user.displayName} currentClinicName={clinic.clinicName} currentClinicRole={clinic.role}
        activeTab={tab} setActiveTab={setTab} isOpen={open} setIsOpen={setOpen} aiEnabled={clinic.role === 'owner'} isDemo={false}
        onLogout={() => setClinic(null)} onSwitchClinic={() => setClinic(null)} />
      <div className="min-w-0 flex-1">
        <Header toggleSidebar={() => setOpen(!open)} searchQuery={search} setSearchQuery={setSearch}
          currentClinicRole={clinic.role} onRecordVisit={() => {}} canEdit={clinic.role === 'owner'} />
        <main className="p-4">
          {clinic.role === 'owner' && tab === 'team' && <ClinicTeamView clinicId={clinic.clinicId} clinicName={clinic.clinicName}
            role={clinic.role} user={user} onOwnershipTransferred={() => {}} triggerToast={() => {}} />}
          {clinic.role === 'owner' && tab === 'audit' && <AuditLogView clinicId={clinic.clinicId} searchQuery={search} />}
          {clinic.role === 'owner' && tab === 'settings' && <ImageStorageControls clinicId={clinic.clinicId} online />}
          {clinic.role === 'owner' && tab === 'laboratory' && <AILaboratoryView triggerToast={() => {}} />}
          {clinic.role === 'viewer' && <p role="status">Viewer workspace</p>}
        </main>
      </div>
    </div>;
  }
  if (scenario.has('loading')) window.fixtureLoad = new Promise(resolve => { window.releaseFixtureLoad = resolve; });
  createRoot(document.getElementById('theme-fixture')).render(<Fixture />);
`;

const adapters = {
  '@/lib/clinics': `
    const unavailable = async () => { throw new Error('No writes in the theme fixture'); };
    export async function listUserClinics() {
      await window.fixtureLoad;
      if (new URLSearchParams(location.search).has('load-error')) throw new Error('Simulated unavailable clinic list');
      return [{ clinicId: 'fixture-clinic', clinicName: 'Owner clinic', role: 'owner' },
        { clinicId: 'viewer-clinic', clinicName: 'Viewer clinic', role: 'viewer' }];
    }
    export async function listClinicMembers() {
      return [{ uid: 'fixture', displayName: 'Theme Fixture', email: 'local-fixture@example.test', role: 'owner' }];
    }
    export async function listClinicInvitations() { return []; }
    export async function subscribeClinicImageUploads(_clinicId, onValue) { onValue(true); return () => {}; }
    export const acceptClinicInvitation = unavailable, createClinic = unavailable, getClinicInvitation = unavailable,
      changeClinicMemberRole = unavailable, createClinicInvitation = unavailable, removeClinicMember = unavailable,
      revokeClinicInvitation = unavailable, transferClinicOwnership = unavailable, setClinicImageUploadsEnabled = unavailable;
  `,
  '@/lib/invitation-verification': `
    export async function refreshInvitationVerification() { return false; }
    export async function sendInvitationVerification() {}
    export function verificationErrorMessage() { return 'Simulated verification error'; }
  `,
  '@/lib/firebase': `
    export async function initializeFirebase() {
      return { db: {}, firestore: {
        orderBy: () => null, limit: () => null, startAfter: () => null, collection: () => null, query: () => null,
        getDocs: async () => ({ size: 1, docs: [{ id: 'fixture-audit', data: () => ({
          actorUid: 'fixture', action: 'save', entityType: 'patients', entityId: 'fixture-patient', seq: 1,
        }) }] }),
      } };
    }
  `,
};

export async function buildThemeWorkspaceFixture() {
  const output = await build({
    stdin: { contents: source, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'theme-fixture-local-adapters',
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/(clinics|invitation-verification|firebase)$/ }, args =>
          ({ path: args.path, namespace: 'theme-adapter' }));
        build.onLoad({ filter: /.*/, namespace: 'theme-adapter' }, args => ({ contents: adapters[args.path], loader: 'js' }));
      },
    }],
  });
  return output.outputFiles[0].text;
}
