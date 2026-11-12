"use client";

import { useState, useEffect } from 'react';
import { Sparkles, Database } from 'lucide-react';
import type { InventoryItem, PatientRecord, Consultation } from '@/types';
import { initializeFirebase, dbRef, firestore } from '@/lib/firebase';
import { nextPatientId } from '@/lib/patients';
import {
  MAX_PATIENT_DOC_BYTES,
  firestoreDocBytes,
  formatBytes
} from '@/lib/images';
import { LoginScreen } from '@/components/LoginScreen';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { DashboardHome } from '@/components/DashboardHome';
import { PatientRecordsView } from '@/components/PatientRecordsView';
import { InventoryControlView } from '@/components/InventoryControlView';
import { AILaboratoryView } from '@/components/AILaboratoryView';
import { SystemSettingsView } from '@/components/SystemSettingsView';
import { AccountSettingsView } from '@/components/AccountSettingsView';
import { StaffPayrollView } from '@/components/StaffPayrollView';
import { ClinicWorkspaceScreen } from '@/components/ClinicWorkspaceScreen';
import { ClinicTeamView } from '@/components/ClinicTeamView';
import { renameClinic, setClinicAIEnabled, subscribeClinicAI } from '@/lib/clinics';
import type { ClinicMembership, ClinicRole, ClinicSessionUser } from '@/types';

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [currentClinicId, setCurrentClinicId] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [sessionUser, setSessionUser] = useState<ClinicSessionUser | null>(null);
  const [currentClinicName, setCurrentClinicName] = useState('');
  const [currentClinicRole, setCurrentClinicRole] = useState<ClinicRole | null>(null);
  const [inviteClinicId, setInviteClinicId] = useState('');
  const [inviteId, setInviteId] = useState('');
  const [clinicAI, setClinicAI] = useState<{ clinicId: string; enabled: boolean } | null>(null);
  const [demoAIEnabled, setDemoAIEnabled] = useState(false);
  const aiEnabled = currentClinicId === 'demo-clinic'
    ? demoAIEnabled
    : clinicAI?.clinicId === currentClinicId && clinicAI.enabled;

  useEffect(() => {
    if (!isAuthenticated || !currentClinicId || currentClinicId === 'demo-clinic') return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    subscribeClinicAI(
      currentClinicId,
      enabled => { if (!cancelled) setClinicAI({ clinicId: currentClinicId, enabled }); },
      error => {
        console.error('[Clinic] Could not listen to AI settings:', error);
        if (!cancelled) setClinicAI({ clinicId: currentClinicId, enabled: false });
      }
    ).then(stop => {
      if (cancelled) stop();
      else unsubscribe = stop;
    }).catch(error => console.error('[Clinic] Could not load AI settings:', error));
    return () => { cancelled = true; unsubscribe?.(); };
  }, [isAuthenticated, currentClinicId]);

  // --- RECONCILED IN-MEMORY STATE FOR TEAM PRESENTATION ---
  const [patients, setPatients] = useState<PatientRecord[]>([
    { 
      id: 'PAT-00101', name: 'Dobby', species: 'Canine', breed: 'Pomeranian', gender: 'Male', 
      ownerName: 'Kiel Dizon', ownerContact: '0917-123-4567', ownerEmail: 'kiel@example.com', 
      ownerAddress: '123 San Vicente St., Biñan, Laguna',
      weight: 4.2, admissionTypes: ['Medical Checkup'], reason: 'Lethargy and loss of appetite since yesterday.', 
      balance: 1500, status: 'In Treatment',
      pictures: [
        'https://images.unsplash.com/photo-1583511655857-d19b40a7a54e?auto=format&fit=crop&q=80&w=400',
        'https://images.unsplash.com/photo-1576091160550-2173dba999ef?auto=format&fit=crop&q=80&w=400'
      ],
      labResults: [
        {
          id: 'LAB-901',
          date: '06/22/2026',
          testName: 'Complete Blood Count (CBC)',
          findings: 'Mild anemia indicated by slightly low HGB. WBC count elevated suggesting active immunological response to minor inflammation.',
          metrics: { 'WBC': '18.5 10^9/L (High)', 'RBC': '4.8 10^12/L (Low)', 'HGB': '9.8 g/dL (Low)', 'PLT': '190 10^9/L (Normal)' }
        }
      ]
    },
    { 
      id: 'PAT-00102', name: 'Max', species: 'Canine', breed: 'Golden Retriever', gender: 'Male', 
      ownerName: 'Sarah Cruz', ownerContact: '0918-987-6543', ownerEmail: 'sarah.cruz@gmail.com',
      ownerAddress: 'Block 5 Lot 2, South Springs Subdivision, Biñan',
      weight: 31.5, admissionTypes: ['Grooming'], reason: 'Full grooming package, short trim.', 
      balance: 0, status: 'Ready for Pickup',
      pictures: ['https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&q=80&w=400'],
      labResults: []
    },
    { 
      id: 'PAT-00103', name: 'Luna', species: 'Feline', breed: 'Persian', gender: 'Female', 
      ownerName: 'Miguel Santos', ownerContact: '0920-555-8888', ownerEmail: 'miggy@example.com',
      ownerAddress: '22 Laurel St., Canlalay, Biñan',
      weight: 3.8, admissionTypes: ['Surgery', 'Confinement'], reason: 'Spaying procedure and post-op care.', 
      balance: 4500, status: 'Confined',
      pictures: [
        'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&q=80&w=400',
        'https://images.unsplash.com/photo-1559757175-5700dde675bc?auto=format&fit=crop&q=80&w=400'
      ],
      labResults: [
        {
          id: 'LAB-902',
          date: '06/20/2026',
          testName: 'Pre-Anesthetic Chemistry Profile',
          findings: 'Kidney and liver values are well within baseline ranges. Patient is safe for systemic general anesthesia.',
          metrics: { 'ALT': '45 U/L (Normal)', 'ALKP': '112 U/L (Normal)', 'BUN': '18 mg/dL (Normal)', 'CREA': '1.1 mg/dL (Normal)' }
        }
      ]
    },
  ]);

  const [inventory, setInventory] = useState<InventoryItem[]>([
    { itemCode: 'ITM-00140', itemName: 'Vetmedin Vet', category: 'Medicine', stock: 25, buyingPrice: 210.00, sellingPrice: 350.00, threshold: 10 },
    { itemCode: 'ITM-00141', itemName: '3 Way Test (CPV/CCV/GIA)', category: 'Medicine', stock: 2, buyingPrice: 350.00, sellingPrice: 500.00, threshold: 10 },
    { itemCode: 'ITM-00142', itemName: 'Amoxicillin Clavulanate', category: 'Medicine', stock: 5, buyingPrice: 8.50, sellingPrice: 15.00, threshold: 15 },
    { itemCode: 'ITM-00143', itemName: 'Pet Metro multivitamins gel', category: 'Supplies', stock: 18, buyingPrice: 140.00, sellingPrice: 220.00, threshold: 5 },
    { itemCode: 'ITM-00144', itemName: 'Meloxivet Oral Suspension', category: 'Medicine', stock: 12, buyingPrice: 520.00, sellingPrice: 800.00, threshold: 4 },
    { itemCode: 'SRV-00101', itemName: 'Professional Fee', category: 'Service', stock: 999, buyingPrice: 0, sellingPrice: 500.00, threshold: 0 },
    { itemCode: 'SRV-00102', itemName: 'Tumor Removal (Large)', category: 'Service', stock: 999, buyingPrice: 0, sellingPrice: 15000.00, threshold: 0 }
  ]);

  const [consultations, setConsultations] = useState<Consultation[]>([
    { id: 'SOAP-00010', date: '06/22/2026', client: 'Kiel Dizon', patient: 'Dobby', type: 'Consultation', status: 'Draft', notes: 'Patient showing leg discomfort. Scheduled diagnostic test scans.' },
    { id: 'SOAP-00011', date: '06/21/2026', client: 'Sarah Cruz', patient: 'Max', type: 'Vaccination', status: 'Completed', notes: 'Annual 5-in-1 booster vaccine administered.' },
    { id: 'SOAP-00012', date: '06/20/2026', client: 'Miguel Santos', patient: 'Luna', type: 'Lab Test', status: 'Draft', notes: 'CBC requested to assess high body temperature.' },
  ]);

  // --- TRIGGER FLOATING TOAST ---
  const triggerToast = (msg: string) => {
    setSuccessToast(msg);
    setTimeout(() => {
      setSuccessToast(null);
    }, 4000);
  };

  useEffect(() => {
    if (!isAuthenticated || !currentClinicId || currentClinicId === 'demo-clinic') return;
    let cancelled = false;
    const syncCloudData = async () => {
      try {
        const { db, firestore: fs } = await initializeFirebase();
        if (!db || !fs) throw new Error('Firebase is unavailable.');
        const [patientsSnapshot, inventorySnapshot, consultationsSnapshot] = await Promise.all([
          fs.getDocs(fs.collection(db, 'clinics', currentClinicId, 'patients')),
          fs.getDocs(fs.collection(db, 'clinics', currentClinicId, 'inventory')),
          fs.getDocs(fs.collection(db, 'clinics', currentClinicId, 'consultations'))
        ]);
        if (cancelled) return;
        setPatients(patientsSnapshot.docs.map(item => item.data() as PatientRecord));
        setInventory(inventorySnapshot.docs.map(item => item.data() as InventoryItem));
        setConsultations(consultationsSnapshot.docs.map(item => item.data() as Consultation));
      } catch (error) {
        console.error('[Firebase Error] Failed to synchronize clinic datasets:', error);
        if (!cancelled) {
          setSuccessToast('Failed to load clinic records from the cloud database.');
        }
      }
    };
    void syncCloudData();
    return () => { cancelled = true; };
  }, [isAuthenticated, currentClinicId]);

  const createQuickPatient = async (
    name: string, 
    species: string, 
    breed: string, 
    gender: 'Male' | 'Female' | 'Unknown',
    ownerName: string, 
    ownerContact: string,
    weight: number,
    admissionTypes: string[],
    reason: string,
    pictures: string[] = []
  ) => {
    const newId = nextPatientId(patients);
    const newPat: PatientRecord = { 
      id: newId, 
      name, 
      species, 
      breed, 
      gender, 
      ownerName, 
      ownerContact, 
      balance: 0, 
      weight, 
      admissionTypes, 
      reason, 
      status: 'Waiting',
      pictures,
      labResults: []
    };

    // The demo workspace runs offline on purpose. Skipping the write keeps the
    // console clean during a presentation and stops demo records leaking into
    // Firestore if the rules ever allow it.
    if (currentClinicId === 'demo-clinic') {
      setPatients(prev => [newPat, ...prev]);
      triggerToast(`Successfully admitted ${newPat.name} to the clinic queue.`);
      return true;
    }

    try {
      await initializeFirebase();
    } catch (e) {
      console.error('[Firebase Error] Write aborted: Database initialization failed.', e);
      triggerToast('Cloud sync failed. Patient was not saved; please try again.');
      return false;
    }

    if (!dbRef || !firestore) {
      console.error('[Firebase Error] Write aborted: Database is offline.');
      triggerToast('Database unavailable. Patient was not saved; please try again.');
      return false;
    }

    // Firestore caps documents at 1 MiB. Refuse before the write so the admission
    // form stays filled instead of the record being lost on a failed commit.
    const recordBytes = firestoreDocBytes(newPat);
    if (recordBytes > MAX_PATIENT_DOC_BYTES) {
      triggerToast(
        `Patient photos are too large to store (${formatBytes(recordBytes)} of ${formatBytes(MAX_PATIENT_DOC_BYTES)} allowed). Remove a photo and try again.`
      );
      return false;
    }

    try {
      console.log(`[Firebase] Pushing new patient document ${newPat.id} to cloud...`);
      if (!currentClinicId) {
        triggerToast('No clinic workspace detected. Please login again.');
        return false;
      }

      await firestore.setDoc(
        firestore.doc(dbRef, 'clinics', currentClinicId, 'patients', newPat.id),
        newPat
      );
      console.log(`[Firebase] Successfully committed patient record ${newPat.id} to cloud!`);
      setPatients(prev => [newPat, ...prev]);
      triggerToast(`Successfully admitted ${newPat.name} to the clinic queue.`);
      return true;
    } catch (e) {
      console.error('[Firebase Error] Failed to write patient document:', e);
      triggerToast('Cloud save failed. Patient was not saved; please try again.');
      return false;
    }
  };

  // --- ADDITIONAL DATABASE WRITE OPERATIONS ---
  const createInventoryItem = async (newItem: InventoryItem) => {
    try {
      await initializeFirebase();
    } catch (e) {
      console.error('[Inventory] init failed', e);
      return triggerToast('Database initialization failed.');
    }

    if (!dbRef || !firestore) return triggerToast("Database not connected yet.");
    try {
      console.log('[Inventory] creating item', newItem.itemCode, newItem.itemName);
      if (!currentClinicId) {
        triggerToast('No clinic workspace detected. Please login again.');
        return;
      }

      const docRef = firestore.doc(
        dbRef,
        'clinics',
        currentClinicId,
        'inventory',
        newItem.itemCode
      );
      await firestore.setDoc(docRef, newItem);
      console.log('[Inventory] create success', newItem.itemCode);
      setInventory(prev => [
        newItem,
        ...prev.filter(item => item.itemCode !== newItem.itemCode)
      ]);

      triggerToast(`Product ${newItem.itemName} saved to cloud database.`);
    } catch (e) {
      console.error('[Inventory] create failed', e);
      triggerToast("Failed to save product to cloud.");
    }
  };

  const updateInventoryItem = async (updatedItem: InventoryItem) => {
    try {
      await initializeFirebase();
    } catch (e) {
      console.error('[Inventory] init failed', e);
      return triggerToast('Database initialization failed.');
    }
    if (!dbRef || !firestore) return triggerToast('Database not connected yet');
    try {
      console.log('[Inventory] updating item', updatedItem.itemCode);
      if (!currentClinicId) {
        triggerToast('No clinic workspace detected. Please login again.');
        return;
      }

      const docRef = firestore.doc(
        dbRef,
        'clinics',
        currentClinicId,
        'inventory',
        updatedItem.itemCode
      );
      await firestore.updateDoc(docRef, { ...updatedItem });
      setInventory(inventory.map(item => item.itemCode === updatedItem.itemCode ? updatedItem : item));
      console.log('[Inventory] update success', updatedItem.itemCode);
      triggerToast(`Product ${updatedItem.itemName} updated in cloud.`);
    } catch (e) {
      console.error('[Inventory] update failed', e);
      triggerToast("Failed to update product in cloud.");
    }
  };

  const deleteInventoryItem = async (itemCode: string) => {
    try {
      await initializeFirebase();
    } catch (e) {
      console.error('[Inventory] init failed', e);
      return triggerToast('Database initialization failed.');
    }
    if (!dbRef || !firestore) return triggerToast('Database not connected yet');
    try {
      console.log('[Inventory] deleting item', itemCode);
      if (!currentClinicId) {
        triggerToast('No clinic workspace detected. Please login again.');
        return;
      }

      const docRef = firestore.doc(
        dbRef,
        'clinics',
        currentClinicId,
        'inventory',
        itemCode
      );
      await firestore.deleteDoc(docRef);
      setInventory(inventory.filter(item => item.itemCode !== itemCode));
      console.log('[Inventory] delete success', itemCode);
      triggerToast(`Product removed from cloud database.`);
    } catch (e) {
      console.error('[Inventory] delete failed', e);
      triggerToast("Failed to delete product.");
    }
  };

  const updatePatientRecord = async (updatedRecord: PatientRecord) => {
    if (currentClinicId === 'demo-clinic') {
      setPatients(prev => prev.map(p => p.id === updatedRecord.id ? updatedRecord : p));
      triggerToast('Clinical record updated in the demo workspace.');
      return true;
    }

    if (!dbRef || !firestore) {
      triggerToast('Database unavailable. Changes were not saved; please try again.');
      return false;
    }

    try {
      console.log(`[Firebase] Overwriting patient document ${updatedRecord.id} in cloud...`);
      if (!currentClinicId) {
        triggerToast('No clinic workspace detected. Please login again.');
        return false;
      }

      const recordBytes = firestoreDocBytes(updatedRecord);
      if (recordBytes > MAX_PATIENT_DOC_BYTES) {
        triggerToast(
          `Patient photos are too large to store (${formatBytes(recordBytes)} of ${formatBytes(MAX_PATIENT_DOC_BYTES)} allowed). Remove a photo and save again.`
        );
        return false;
      }

      await firestore.setDoc(
        firestore.doc(dbRef, 'clinics', currentClinicId, 'patients', updatedRecord.id),
        updatedRecord
      );

      console.log(`[Firebase] Successfully updated patient record ${updatedRecord.id} in cloud.`);
      setPatients(prev => prev.map(p => p.id === updatedRecord.id ? updatedRecord : p));
      triggerToast(`Clinical record updated successfully.`);
      return true;
    } catch (e) {
      console.error('[Firebase Error] Failed to update patient document:', e);
      triggerToast('Failed to save edit modifications to cloud storage.');
      return false;
    }
  };

  const deletePatientRecord = async (id: string) => {
    if (currentClinicId === 'demo-clinic') {
      setPatients(prev => prev.filter(p => p.id !== id));
      triggerToast('Clinical record removed from the demo workspace.');
      return;
    }

    if (!dbRef || !firestore) {
      setPatients(prev => prev.filter(p => p.id !== id));
      return;
    }

    try {
      console.log(`[Firebase] Deleting patient document ${id} from cloud...`);
      if (!currentClinicId) {
        triggerToast('No clinic workspace detected. Please login again.');
        return;
      }

      await firestore.deleteDoc(
        firestore.doc(dbRef, 'clinics', currentClinicId, 'patients', id)
      );

      console.log(`[Firebase] Successfully deleted patient record ${id} from cloud.`);
      setPatients(prev => prev.filter(p => p.id !== id));
      triggerToast('Clinical record purged from system ledger.');
    } catch (e) {
      console.error('[Firebase Error] Failed to delete patient document:', e);
      triggerToast('Failed to complete purge request from cloud server.');
    }
  };

  const toggleConsultationStatus = (id: string) => {
    setConsultations(consultations.map(c => {
      if (c.id === id) {
        const nextStatus = c.status === 'Draft' ? 'Completed' : 'Draft';
        return { ...c, status: nextStatus };
      }
      return c;
    }));
    triggerToast(`Consultation status toggled.`);
  };

  // --- RENDER CONTENT DEPENDING ON NAVIGATION TABS ---
  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return (
          <DashboardHome 
            patients={patients} 
            inventory={inventory} 
            consultations={consultations} 
            onToggleStatus={toggleConsultationStatus}
          />
        );
      case 'patients':
        return (
          <PatientRecordsView 
            patients={patients} 
            consultations={consultations}
            inventory={inventory}
            clinicId={currentClinicId}
            clinicName={currentClinicName}
            aiEnabled={aiEnabled}
            searchQuery={searchQuery}
            onCreatePatient={createQuickPatient}
            onUpdatePatient={updatePatientRecord}
            onUpdateInventoryItem={updateInventoryItem}
            onDeletePatient={deletePatientRecord}
            onToggleStatus={toggleConsultationStatus}
            triggerToast={triggerToast}
          />
        );
      case 'inventory':
        return (
          <InventoryControlView 
            inventory={inventory} 
            clinicName={currentClinicName}
            onAddInventoryItem={createInventoryItem}
            onUpdateInventoryItem={updateInventoryItem}
            onDeleteInventoryItem={deleteInventoryItem}
            searchQuery={searchQuery}
            triggerToast={triggerToast}
          />
        );
      case 'laboratory':
        return aiEnabled ? <AILaboratoryView triggerToast={triggerToast} /> : null;
      case 'settings':
        return (
          <SystemSettingsView
            inventory={inventory}
            setInventory={setInventory}
            onAddInventoryItem={createInventoryItem}
            aiEnabled={aiEnabled}
            canManageAI={currentClinicRole === 'owner' || sessionUser?.isDemo === true}
            isDemo={sessionUser?.isDemo ?? false}
            onSetAIEnabled={async enabled => {
              if (currentClinicId === 'demo-clinic') setDemoAIEnabled(enabled);
              else if (currentClinicId) await setClinicAIEnabled(currentClinicId, enabled);
              else throw new Error('No clinic is selected.');
            }}
            triggerToast={triggerToast}
          />
        );
      case 'account':
        return (
          <AccountSettingsView
            clinicId={currentClinicId}
            clinicName={currentClinicName}
            role={currentClinicRole}
            email={sessionUser?.email ?? ''}
            displayName={sessionUser?.displayName ?? ''}
            isDemo={sessionUser?.isDemo ?? false}
            onRenameClinic={handleRenameClinic}
            triggerToast={triggerToast}
          />
        );
      case 'staff':
        return (
          <StaffPayrollView
            clinicId={currentClinicId}
            clinicName={currentClinicName}
            user={sessionUser}
            role={currentClinicRole}
            isDemo={sessionUser?.isDemo ?? false}
            triggerToast={triggerToast}
          />
        );
      case 'team':
        return sessionUser && currentClinicId && currentClinicRole ? (
          <ClinicTeamView
            clinicId={currentClinicId}
            clinicName={currentClinicName}
            user={sessionUser}
            role={currentClinicRole}
            onOwnershipTransferred={nextRole => {
              setCurrentClinicRole(nextRole);
              setActiveTab('dashboard');
            }}
            triggerToast={triggerToast}
          />
        ) : null;
      default:
        return <DashboardHome 
          patients={patients} 
          inventory={inventory} 
          consultations={consultations} 
          onToggleStatus={toggleConsultationStatus}
        />;
    }
  };
    const handleLogout = async () => {
      const clinicId = currentClinicId;

      if (sessionUser && !sessionUser.isDemo) {
        try {
          const { auth } = await initializeFirebase();
          const { signOut } = await import('firebase/auth');
          await signOut(auth);
        } catch (error) {
          console.error('[Auth] Sign-out failed:', error);
        }
      }

      setIsAuthenticated(false);
      setCurrentUser(null);
      setSessionUser(null);
      setCurrentClinicId(null);
      setCurrentClinicName('');
      setCurrentClinicRole(null);
      setInviteClinicId('');
      setInviteId('');

      // Keep the seeded demo workspace so logging back in during a presentation
      // doesn't show an empty dashboard. Real clinics refetch on login anyway.
      if (clinicId !== 'demo-clinic') {
        setPatients([]);
        setInventory([]);
        setConsultations([]);
      }

      triggerToast("Securely logged out of the system.");
    };

    const handleSelectClinic = (membership: ClinicMembership) => {
      setCurrentClinicId(membership.clinicId);
      setCurrentClinicName(membership.clinicName);
      setCurrentClinicRole(membership.role);
      setCurrentUser(`${membership.clinicName} (${sessionUser?.email || ''})`);
      setActiveTab('dashboard');
      setPatients([]);
      setInventory([]);
      setConsultations([]);
      setInviteClinicId('');
      setInviteId('');
      window.history.replaceState({}, '', window.location.pathname);
      triggerToast(`Opening ${membership.clinicName}.`);
    };

    const handleSwitchClinic = () => {
      setCurrentClinicId(null);
      setCurrentClinicName('');
      setCurrentClinicRole(null);
      setCurrentUser(sessionUser ? `${sessionUser.displayName} (${sessionUser.email})` : null);
      setActiveTab('dashboard');
      setPatients([]);
      setInventory([]);
      setConsultations([]);
    };

    const handleRenameClinic = async (name: string) => {
      if (!currentClinicId) throw new Error('No clinic is selected.');
      const clinicName = await renameClinic(currentClinicId, name);
      setCurrentClinicName(clinicName);
      setCurrentUser(`${clinicName} (${sessionUser?.email || ''})`);
    };

    if (!isAuthenticated) {
    return (
      <LoginScreen
        onLoginSuccess={(user) => {
          setSessionUser(user);
          setCurrentUser(user.isDemo ? `Demo Clinic (${user.email})` : `${user.displayName} (${user.email})`);
          const inviteUrl = new URL(window.location.href);
          setInviteClinicId(inviteUrl.searchParams.get('inviteClinic') || '');
          setInviteId(inviteUrl.searchParams.get('invite') || '');

          // Clear previous visible data immediately before clinic-scoped sync loads.
          // The demo workspace has no cloud backend, so keep its seeded records.
          if (user.isDemo) {
            setCurrentClinicId('demo-clinic');
            setCurrentClinicName('Demo Clinic');
            setCurrentClinicRole(null);
          } else {
            setCurrentClinicId(null);
            setCurrentClinicName('');
            setCurrentClinicRole(null);
            setPatients([]);
            setInventory([]);
            setConsultations([]);
          }

          setIsAuthenticated(true);
          triggerToast(user.isDemo ? 'Demo workspace ready.' : 'Signed in. Choose a clinic or accept an invitation.');
        }}
      />
    );
  }

  if (!currentClinicId && sessionUser) {
    return (
      <ClinicWorkspaceScreen
        user={sessionUser}
        invitationClinicId={inviteClinicId}
        invitationId={inviteId}
        onSelectClinic={handleSelectClinic}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <div className="flex h-screen bg-slate-100 font-sans overflow-hidden">
      {/* Toast Notification Container */}
      {successToast && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-3 bg-slate-900 border border-slate-800 text-white px-5 py-4 rounded-xl shadow-2xl animate-bounce">
          <Sparkles className="w-5 h-5 text-teal-400" />
          <span className="text-sm font-medium">{successToast}</span>
        </div>
      )}

      {/* Overlay for mobile devices */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-slate-900/50 z-40 md:hidden backdrop-blur-sm transition-opacity"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar
        activeTab={activeTab} 
        setActiveTab={setActiveTab} 
        isOpen={sidebarOpen} 
        setIsOpen={setSidebarOpen}
        currentUser={currentUser}
        currentClinicName={currentClinicName}
        currentClinicRole={currentClinicRole}
        isDemo={sessionUser?.isDemo ?? false}
        aiEnabled={aiEnabled}
        onSwitchClinic={handleSwitchClinic}
        onLogout={handleLogout}
      />

      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        <Header
          toggleSidebar={() => setSidebarOpen(!sidebarOpen)} 
          searchQuery={searchQuery} 
          setSearchQuery={setSearchQuery}
          currentUser={currentUser}
        />
        
        <main className="flex-1 overflow-y-auto p-4 sm:p-8">
          <div className="max-w-7xl mx-auto">
            {renderContent()}
          </div>
        </main>
      </div>
    </div>
  );
}
