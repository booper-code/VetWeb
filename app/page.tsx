"use client";

import { useState, useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import type { InventoryItem, PatientRecord, Consultation, ConsultationDraft } from '@/types';
import { initializeFirebase, dbRef, firestore, restoreFirebaseSession } from '@/lib/firebase';
import { nextPatientId } from '@/lib/patients';
import { useClinicPages } from '@/lib/useClinicPages';
import { PageControls } from '@/components/PageControls';
import { mutateClinicalRecord, mutateClinicalRecords } from '@/lib/clinical-mutations';
import { getDevicePreference, watchDevicePreference } from '@/lib/offline-device';
import OfflineDeviceSettings from '@/components/OfflineDeviceSettings';
import { AuditLogView } from '@/components/AuditLogView';
import { patientValidationError, inventoryValidationError } from '@/lib/record-validation';
import { ImageStorageControls } from '@/components/ImageStorageControls';
import { createMutationScope } from '@/lib/mutation-scope';
import { useAppointments } from '@/lib/useAppointments';
import { AppointmentsView } from '@/components/AppointmentsView';
import { patientFromDocument } from '@/lib/clinic-pages';
import { saveConsultation } from '@/lib/consultations';
import {
  buildConsultationRecord,
  consultationValidationError,
  treatmentStockChanges
} from '@/lib/consultation-values';
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
  const [mutationScope] = useState(createMutationScope);
  const workspaceGeneration = mutationScope.capture();
  const leaving = useRef(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [patientToOpen, setPatientToOpen] = useState<string | null>(null);
  const [treatmentLink, setTreatmentLink] = useState<{
    patientId: string; appointmentId: string; occurredAt: string;
  } | null>(null);
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
  const [online, setOnline] = useState(true);
  const [deviceNotice, setDeviceNotice] = useState('');
  const canChangeRecords = currentClinicId === 'demo-clinic' ||
    (online && (currentClinicRole === 'owner' || currentClinicRole === 'editor'));
  const aiEnabled = currentClinicId === 'demo-clinic'
    ? demoAIEnabled
    : clinicAI?.clinicId === currentClinicId && clinicAI.enabled;

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    if (getDevicePreference() !== 'trusted') return;
    let active = true;
    const scope = mutationScope;
    const captured = scope.capture();
    void restoreFirebaseSession().then(user => {
      if (!active || !user || !scope.isCurrent(captured)) return;
      scope.invalidate();
      setSessionUser({ uid: user.uid, email: user.email || '', displayName: user.displayName || user.email || 'Staff' });
      setCurrentUser(user.displayName || user.email || 'Staff');
      setIsAuthenticated(true);
    }).catch(() => {
      if (active && scope.isCurrent(captured)) setDeviceNotice('Could not restore this device session. Sign in online or clear device data.');
    });
    return () => { active = false; };
  }, [mutationScope]);

  useEffect(() => {
    const scope = mutationScope;
    return () => { scope.invalidate(); };
  }, [mutationScope]);

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
  const notifyCurrentWorkspace = (message: string) => {
    if (mutationScope.isCurrent(workspaceGeneration)) triggerToast(message);
  };

  const clinicPages = useClinicPages({
    clinicId: currentClinicId, authenticated: isAuthenticated,
    setPatients, setInventory, setConsultations
  });
  const appointments = useAppointments({
    clinicId: currentClinicId, uid: sessionUser?.uid ?? null, online, canEdit: canChangeRecords,
    patients, scope: mutationScope, workspaceGeneration,
  });

  useEffect(() => watchDevicePreference(change => {
    if (change !== 'wipe' && getDevicePreference() !== 'memory') return;
    leaving.current = true;
    mutationScope.invalidate();
    setIsAuthenticated(false); setSessionUser(null); setCurrentUser(null);
    setCurrentClinicId(null); setCurrentClinicName(''); setCurrentClinicRole(null);
    setPatients([]); setInventory([]); setConsultations([]);
    setPatientToOpen(null); setSearchQuery('');
    setDeviceNotice('Device storage was disabled. Cached-data cleanup requires all other tabs to close. Restart this app after clearing completes.');
  }), [mutationScope]);

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
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration)) return false;
    const captured = mutationScope.capture();
    if (!canChangeRecords) {
      triggerToast('Clinical changes require an online owner or editor session.');
      return false;
    }
    // A partial page cannot allocate a sequential ID without collisions.
    const newId = currentClinicId === 'demo-clinic'
      ? nextPatientId(patients) : `PAT-${crypto.randomUUID()}`;
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
    const invalid = patientValidationError(newPat);
    if (invalid) { triggerToast(invalid); return false; }

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
      if (!mutationScope.isCurrent(captured)) return false;
    } catch (e) {
      if (!mutationScope.isCurrent(captured)) return false;
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

      const saved = await mutateClinicalRecord({
        clinicId: currentClinicId, collection: 'patients', id: newPat.id,
        expectedRevision: null, data: newPat, action: 'save'
      });
      console.log(`[Firebase] Successfully committed patient record ${newPat.id} to cloud!`);
      if (!mutationScope.isCurrent(captured)) return false;
      setPatients(prev => [{ ...newPat, revision: saved.revision }, ...prev]);
      triggerToast(`Successfully admitted ${newPat.name} to the clinic queue.`);
      return true;
    } catch (e) {
      if (!mutationScope.isCurrent(captured)) return false;
      console.error('[Firebase Error] Failed to write patient document:', e);
      triggerToast('Cloud save failed. Patient was not saved; please try again.');
      return false;
    }
  };

  // --- ADDITIONAL DATABASE WRITE OPERATIONS ---
  const createInventoryItem = async (newItem: InventoryItem) => {
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration)) throw new Error('Workspace is closing. No changes were started.');
    const captured = mutationScope.capture();
    if (!canChangeRecords) throw new Error('Inventory changes require an online owner or editor session.');
    const invalid = inventoryValidationError(newItem);
    if (invalid) throw new Error(invalid);
    if (currentClinicId === 'demo-clinic') {
      setInventory(previous => [newItem, ...previous]);
      triggerToast('Inventory item added to the offline demo.');
      return;
    }
    try {
      await initializeFirebase();
      if (!mutationScope.isCurrent(captured)) throw new Error('Workspace changed. Reload the active clinic.');
    } catch (e) {
      console.error('[Inventory] init failed', e);
      throw new Error('Database initialization failed.');
    }

    if (!dbRef || !firestore) throw new Error('Database is not connected yet.');
    try {
      console.log('[Inventory] creating item', newItem.itemCode, newItem.itemName);
      if (!currentClinicId) {
        triggerToast('No clinic workspace detected. Please login again.');
        throw new Error('No clinic is selected.');
      }

      const saved = await mutateClinicalRecord({
        clinicId: currentClinicId, collection: 'inventory', id: newItem.itemCode,
        expectedRevision: null, data: newItem, action: 'save'
      });
      console.log('[Inventory] create success', newItem.itemCode);
      if (!mutationScope.isCurrent(captured)) throw new Error('Workspace changed. The prior clinic’s save may have completed.');
      setInventory(prev => [
        { ...newItem, revision: saved.revision },
        ...prev.filter(item => item.itemCode !== newItem.itemCode)
      ]);

      triggerToast(`Product ${newItem.itemName} saved to cloud database.`);
    } catch (e) {
      if (!mutationScope.isCurrent(captured)) throw e;
      console.error('[Inventory] create failed', e);
      triggerToast("Failed to save product to cloud.");
      throw e;
    }
  };

  const updateInventoryItem = async (updatedItem: InventoryItem) => {
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration)) throw new Error('Workspace is closing. No changes were started.');
    const captured = mutationScope.capture();
    if (!canChangeRecords) throw new Error('Inventory changes require an online owner or editor session.');
    const invalid = inventoryValidationError(updatedItem);
    if (invalid) throw new Error(invalid);
    if (currentClinicId === 'demo-clinic') {
      setInventory(previous => previous.map(item => item.itemCode === updatedItem.itemCode ? updatedItem : item));
      return;
    }
    try {
      await initializeFirebase();
      if (!mutationScope.isCurrent(captured)) throw new Error('Workspace changed. Reload the active clinic.');
    } catch (e) {
      console.error('[Inventory] init failed', e);
      throw new Error('Database initialization failed.');
    }
    if (!dbRef || !firestore) throw new Error('Database is not connected yet.');
    try {
      console.log('[Inventory] updating item', updatedItem.itemCode);
      if (!currentClinicId) {
        triggerToast('No clinic workspace detected. Please login again.');
        throw new Error('No clinic is selected.');
      }

      const saved = await mutateClinicalRecord({
        clinicId: currentClinicId, collection: 'inventory', id: updatedItem.itemCode,
        expectedRevision: updatedItem.revision ?? 0, data: updatedItem, action: 'save'
      });
      if (!mutationScope.isCurrent(captured)) throw new Error('Workspace changed. The prior clinic’s save may have completed.');
      setInventory(previous => previous.map(item => item.itemCode === updatedItem.itemCode
        ? { ...updatedItem, revision: saved.revision } : item));
      console.log('[Inventory] update success', updatedItem.itemCode);
      triggerToast(`Product ${updatedItem.itemName} updated in cloud.`);
    } catch (e) {
      if (!mutationScope.isCurrent(captured)) throw e;
      console.error('[Inventory] update failed', e);
      triggerToast("Failed to update product in cloud.");
      throw e;
    }
  };

  const deleteInventoryItem = async (itemCode: string) => {
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration)) throw new Error('Workspace is closing. No changes were started.');
    const captured = mutationScope.capture();
    if (!canChangeRecords) throw new Error('Inventory changes require an online owner or editor session.');
    if (currentClinicId === 'demo-clinic') {
      setInventory(previous => previous.filter(item => item.itemCode !== itemCode));
      return;
    }
    try {
      await initializeFirebase();
      if (!mutationScope.isCurrent(captured)) throw new Error('Workspace changed. Reload the active clinic.');
    } catch (e) {
      console.error('[Inventory] init failed', e);
      throw new Error('Database initialization failed.');
    }
    if (!dbRef || !firestore) throw new Error('Database is not connected yet.');
    try {
      console.log('[Inventory] deleting item', itemCode);
      if (!currentClinicId) {
        triggerToast('No clinic workspace detected. Please login again.');
        throw new Error('No clinic is selected.');
      }

      const existing = inventory.find(item => item.itemCode === itemCode);
      if (!existing) throw new Error('Reload the item before deleting.');
      await mutateClinicalRecord({
        clinicId: currentClinicId, collection: 'inventory', id: itemCode,
        expectedRevision: existing.revision ?? 0, action: 'delete'
      });
      if (!mutationScope.isCurrent(captured)) throw new Error('Workspace changed. The prior clinic’s delete may have completed.');
      setInventory(previous => previous.filter(item => item.itemCode !== itemCode));
      console.log('[Inventory] delete success', itemCode);
      triggerToast(`Product removed from cloud database.`);
    } catch (e) {
      if (!mutationScope.isCurrent(captured)) throw e;
      console.error('[Inventory] delete failed', e);
      triggerToast("Failed to delete product.");
      throw e;
    }
  };

  const updatePatientRecord = async (updatedRecord: PatientRecord) => {
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration)) return false;
    const captured = mutationScope.capture();
    if (!canChangeRecords) {
      triggerToast('Clinical changes require an online owner or editor session.');
      return false;
    }
    const invalid = patientValidationError(updatedRecord);
    if (invalid) { triggerToast(invalid); return false; }
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

      const payload = updatedRecord.status === 'Discharged' && !updatedRecord.dischargedAt
        ? { ...updatedRecord, dischargedAt: new Date().toISOString() } : updatedRecord;
      const saved = await mutateClinicalRecord({
        clinicId: currentClinicId, collection: 'patients', id: updatedRecord.id,
        expectedRevision: updatedRecord.revision ?? 0, data: payload, action: 'save'
      });

      console.log(`[Firebase] Successfully updated patient record ${updatedRecord.id} in cloud.`);
      // Keep the returned version on both the list and the edit buffer.
      if (!mutationScope.isCurrent(captured)) return false;
      setPatients(prev => prev.map(p => p.id === updatedRecord.id
        ? { ...payload, revision: saved.revision } : p));
      triggerToast(`Clinical record updated successfully.`);
      return true;
    } catch (e) {
      if (!mutationScope.isCurrent(captured)) return false;
      console.error('[Firebase Error] Failed to update patient document:', e);
      triggerToast(e instanceof Error ? e.message : 'Could not save this record.');
      return false;
    }
  };

  const deletePatientRecord = async (id: string) => {
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration)) return false;
    const captured = mutationScope.capture();
    if (!canChangeRecords) {
      triggerToast('Clinical changes require an online owner or editor session.');
      return false;
    }
    if (currentClinicId === 'demo-clinic') {
      setPatients(prev => prev.filter(p => p.id !== id));
      triggerToast('Clinical record removed from the demo workspace.');
      return true;
    }

    if (!dbRef || !firestore) {
      triggerToast('Database unavailable. Nothing was deleted.');
      return false;
    }

    try {
      console.log(`[Firebase] Deleting patient document ${id} from cloud...`);
      if (!currentClinicId) {
        triggerToast('No clinic workspace detected. Please login again.');
        return false;
      }

      const existing = patients.find(patient => patient.id === id);
      if (!existing) throw new Error('Reload the patient before deleting.');
      await mutateClinicalRecord({
        clinicId: currentClinicId, collection: 'patients', id,
        expectedRevision: existing.revision ?? 0, action: 'delete'
      });

      console.log(`[Firebase] Successfully deleted patient record ${id} from cloud.`);
      if (!mutationScope.isCurrent(captured)) return false;
      setPatients(prev => prev.filter(p => p.id !== id));
      triggerToast('Clinical record purged from system ledger.');
      return true;
    } catch (e) {
      if (!mutationScope.isCurrent(captured)) return false;
      console.error('[Firebase Error] Failed to delete patient document:', e);
      triggerToast('Failed to complete purge request from cloud server.');
      return false;
    }
  };
  const savePatientAndInventory = async (patient: PatientRecord, changes: InventoryItem[]): Promise<boolean> => {
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration)) return false;
    const captured = mutationScope.capture();
    if (!canChangeRecords || !currentClinicId) return false;
    if (changes.length > 2) {
      triggerToast('Apply at most two stock items per operation; nothing was changed.');
      return false;
    }
    if (!Number.isFinite(patient.balance) || patient.balance < 0 ||
        changes.some(item => !Number.isFinite(item.stock) || item.stock < 0) ||
        firestoreDocBytes(patient) > MAX_PATIENT_DOC_BYTES) {
      triggerToast('Invalid stock, balance or record size. Nothing was changed.');
      return false;
    }
    if (currentClinicId === 'demo-clinic') {
      setPatients(previous => previous.map(record => record.id === patient.id ? patient : record));
      setInventory(previous => previous.map(item => changes.find(change => change.itemCode === item.itemCode) ?? item));
      return true;
    }
    try {
      const saved = await mutateClinicalRecords([
        { clinicId: currentClinicId, collection: 'patients', id: patient.id,
          expectedRevision: patient.revision ?? 0, data: patient, action: 'save' },
        ...changes.map(item => ({
          clinicId: currentClinicId, collection: 'inventory' as const, id: item.itemCode,
          expectedRevision: item.revision ?? 0, data: item, action: 'save' as const
        }))
      ]);
      if (!mutationScope.isCurrent(captured)) return false;
      setPatients(previous => previous.map(record => record.id === patient.id
        ? { ...patient, revision: saved[0].revision } : record));
      setInventory(previous => previous.map(item => {
        const index = changes.findIndex(change => change.itemCode === item.itemCode);
        return index < 0 ? item : { ...changes[index], revision: saved[index + 1].revision };
      }));
      return true;
    } catch (error) {
      if (!mutationScope.isCurrent(captured)) return false;
      triggerToast(error instanceof Error ? error.message : 'Billing was not saved. Reload the records and retry.');
      return false;
    }
  };

  const toggleConsultationStatus = async (id: string) => {
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration)) return;
    const captured = mutationScope.capture();
    if (!canChangeRecords || !currentClinicId) {
      triggerToast('Consultation changes require an online owner or editor.');
      return;
    }
    const current = consultations.find(record => record.id === id);
    if (!current) return;
    if (current.patientId) {
      triggerToast('Structured treatment records are locked. Record a new visit instead.');
      return;
    }
    const updated: Consultation = { ...current, status: current.status === 'Draft' ? 'Completed' : 'Draft' };
    try {
      if (currentClinicId !== 'demo-clinic') {
        const saved = await mutateClinicalRecord({
          clinicId: currentClinicId, collection: 'consultations', id,
          expectedRevision: current.revision ?? 0, data: updated, action: 'save'
        });
        updated.revision = saved.revision;
      }
      if (!mutationScope.isCurrent(captured)) return;
      setConsultations(previous => previous.map(record => record.id === id ? updated : record));
      triggerToast('Consultation status saved.');
    } catch (error) {
      if (!mutationScope.isCurrent(captured)) return;
      triggerToast(error instanceof Error ? error.message : 'Consultation was not changed.');
    }
  };

  const saveConsultationRecord = async (patient: PatientRecord, draft: ConsultationDraft): Promise<boolean> => {
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration)) return false;
    const captured = mutationScope.capture();
    if (!canChangeRecords || !currentClinicId) {
      triggerToast('Treatment records require an online owner or editor.');
      return false;
    }
    const invalid = consultationValidationError(draft, inventory);
    if (invalid) {
      triggerToast(invalid);
      return false;
    }

    if (currentClinicId === 'demo-clinic') {
      const record = buildConsultationRecord(
        `CON-${crypto.randomUUID()}`,
        draft,
        patient
      );
      const changes = treatmentStockChanges(draft.treatments, inventory);
      setConsultations(previous => [record, ...previous]);
      setInventory(previous => previous.map(item =>
        changes.find(change => change.itemCode === item.itemCode) ?? item));
      setTreatmentLink(null);
      return true;
    }

    try {
      const result = await saveConsultation({ clinicId: currentClinicId, draft, inventory });
      if (!mutationScope.isCurrent(captured)) return false;
      setConsultations(previous => [result.consultation, ...previous]);
      setInventory(previous => previous.map(item =>
        result.inventory.find(change => change.itemCode === item.itemCode) ?? item));
      setTreatmentLink(null);
      return true;
    } catch (error) {
      if (!mutationScope.isCurrent(captured)) return false;
      triggerToast(error instanceof Error ? error.message : 'The treatment record was not saved.');
      return false;
    }
  };

  const loadAppointmentPatient = async (id: string, stillOpen: () => boolean = () => true) => {
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration) || !currentClinicId || !stillOpen()) return null;
    let patient = patients.find(record => record.id === id);
    if (!patient && currentClinicId !== 'demo-clinic') {
      const { db, firestore: fs } = await initializeFirebase();
      if (!mutationScope.isCurrent(workspaceGeneration) || !stillOpen()) return null;
      const reference = fs.doc(db, 'clinics', currentClinicId, 'patients', id);
      const snapshot = await (online ? fs.getDoc(reference) : fs.getDocFromCache(reference));
      if (!mutationScope.isCurrent(workspaceGeneration) || !stillOpen()) return null;
      if (!snapshot.exists()) throw new Error('The linked patient is no longer available in this clinic.');
      patient = patientFromDocument(snapshot.id, snapshot.data());
      const loaded = patient;
      setPatients(previous => [...previous.filter(row => row.id !== id), loaded]);
    }
    if (!patient) throw new Error('The linked demo patient is no longer available.');
    return patient;
  };

  const openAppointmentPatient = async (id: string, stillOpen: () => boolean = () => true) => {
    const patient = await loadAppointmentPatient(id, stillOpen);
    if (!patient) return;
    setTreatmentLink(null);
    setPatientToOpen(patient.id); setSearchQuery(patient.id); setActiveTab('patients');
  };

  const openAppointmentTreatment = async (
    appointment: { id: string; patientId: string; occurredAt: string | null; dueAt: string },
    stillOpen: () => boolean = () => true
  ) => {
    if (!canChangeRecords) throw new Error('An online owner or editor session is required to record treatments.');
    const patient = await loadAppointmentPatient(appointment.patientId, stillOpen);
    if (!patient) return;
    setTreatmentLink({
      patientId: patient.id,
      appointmentId: appointment.id,
      occurredAt: appointment.occurredAt || appointment.dueAt
    });
    setPatientToOpen(patient.id); setSearchQuery(patient.id); setActiveTab('patients');
  };

  const handleRecordVisit = () => {
    setPatientToOpen(null);
    setTreatmentLink(null);
    setActiveTab('patients');
    triggerToast(canChangeRecords
      ? 'Choose a patient to record a visit.'
      : 'An online owner or editor session is required to record a visit.');
  };

  const navigateTo = (tab: string) => {
    setPatientToOpen(null);
    setTreatmentLink(null);
    setActiveTab(tab);
  };

  // --- RENDER CONTENT DEPENDING ON NAVIGATION TABS ---
  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
      default:
        return (
          <><DashboardHome
            patients={patients}
            inventory={inventory}
            consultations={consultations}
            appointments={appointments.rows}
            onToggleStatus={toggleConsultationStatus}
            partialData={currentClinicId !== 'demo-clinic'}
            clinicName={currentClinicName}
            canEdit={canChangeRecords}
            onNavigate={navigateTo}
            onRecordVisit={handleRecordVisit}
            onOpenPatient={openAppointmentPatient}
            onOpenAppointments={() => setActiveTab('appointments')}
            onRefreshAppointments={() => void appointments.load(true)}
            appointmentsBusy={appointments.busy}
            appointmentsError={appointments.error}
            appointmentsPartial={appointments.hasMore}
            appointmentsFromCache={appointments.fromCache}
            appointmentsRange={`${appointments.window.from} through ${appointments.window.through}`}
          />
          {currentClinicId !== 'demo-clinic' && <div className="mt-4">
            <PageControls label="consultations" status={clinicPages.state.consultations}
              onLoad={() => void clinicPages.load('consultations')} />
          </div>}</>
        );
      case 'appointments':
        return currentClinicId ? <AppointmentsView
          key={`${currentClinicId}:${sessionUser?.uid}`}
          {...appointments} patients={patients} canEdit={canChangeRecords}
          isDemo={sessionUser?.isDemo === true} online={online} clinicId={currentClinicId}
          searchQuery={searchQuery} onWindow={appointments.changeWindow} onLoad={appointments.load}
          onSave={appointments.save} onOpenPatient={openAppointmentPatient}
          onRecordTreatment={openAppointmentTreatment}
        /> : null;
      case 'patients':
        return (
          <PatientRecordsView 
            key={`${currentClinicId}:${patientToOpen ?? ''}`}
            initialPatientId={patientToOpen ?? undefined}
            initialTreatmentLink={treatmentLink}
            patients={patients} 
            consultations={consultations}
            inventory={inventory}
            clinicId={currentClinicId}
            clinicName={currentClinicName}
            aiEnabled={aiEnabled}
            searchQuery={searchQuery}
            onCreatePatient={createQuickPatient}
            onUpdatePatient={updatePatientRecord}
            onSaveBilling={savePatientAndInventory}
            onSaveConsultation={saveConsultationRecord}
            onDeletePatient={deletePatientRecord}
            onToggleStatus={toggleConsultationStatus}
            triggerToast={notifyCurrentWorkspace}
            paging={currentClinicId === 'demo-clinic' ? undefined : {
              active: clinicPages.state.activePatients,
              discharged: clinicPages.state.dischargedPatients,
              load: kind => void clinicPages.load(kind === 'Active' ? 'activePatients' : 'dischargedPatients')
            }}
            canEdit={canChangeRecords}
            staffUid={sessionUser?.uid ?? 'demo-user'}
            staffName={sessionUser?.displayName || 'Clinic staff'}
          />
        );
      case 'inventory':
        return (
          <><InventoryControlView
            key={currentClinicId}
            inventory={inventory} 
            clinicName={currentClinicName}
            onAddInventoryItem={createInventoryItem}
            onUpdateInventoryItem={updateInventoryItem}
            onDeleteInventoryItem={deleteInventoryItem}
            searchQuery={searchQuery}
            triggerToast={notifyCurrentWorkspace}
            partialData={currentClinicId !== 'demo-clinic'}
            canEdit={canChangeRecords}
          />
          {currentClinicId !== 'demo-clinic' && <PageControls label="inventory"
            status={clinicPages.state.inventory} onLoad={() => void clinicPages.load('inventory')} />}</>
        );
      case 'laboratory':
        return aiEnabled ? <AILaboratoryView triggerToast={notifyCurrentWorkspace} /> : null;
      case 'settings':
        return (
          <><OfflineDeviceSettings beforeClear={handleLogout} />
          {currentClinicId && currentClinicId !== 'demo-clinic' && currentClinicRole === 'owner' &&
            <ImageStorageControls key={currentClinicId} clinicId={currentClinicId} online={online} />}
          <SystemSettingsView
            inventory={inventory}
            onAddInventoryItem={createInventoryItem}
            aiEnabled={aiEnabled}
            canManageAI={(currentClinicRole === 'owner' && online) || sessionUser?.isDemo === true}
            isDemo={sessionUser?.isDemo ?? false}
            onSetAIEnabled={async enabled => {
              if (currentClinicId === 'demo-clinic') setDemoAIEnabled(enabled);
              else if (currentClinicId) await setClinicAIEnabled(currentClinicId, enabled);
              else throw new Error('No clinic is selected.');
            }}
            triggerToast={notifyCurrentWorkspace}
          /></>
        );
      case 'account':
        if (!online && currentClinicId !== 'demo-clinic') return <p>Account management requires a connection. No changes are queued offline.</p>;
        return (
          <AccountSettingsView
            key={`${currentClinicId}:${sessionUser?.uid}`}
            clinicId={currentClinicId}
            clinicName={currentClinicName}
            role={currentClinicRole}
            email={sessionUser?.email ?? ''}
            displayName={sessionUser?.displayName ?? ''}
            isDemo={sessionUser?.isDemo ?? false}
            onRenameClinic={handleRenameClinic}
            triggerToast={notifyCurrentWorkspace}
          />
        );
      case 'staff':
        if (!online && currentClinicId !== 'demo-clinic') return <p>Staff and payroll management require a connection. No changes are queued offline.</p>;
        return (
          <StaffPayrollView
            clinicId={currentClinicId}
            clinicName={currentClinicName}
            user={sessionUser}
            role={currentClinicRole}
            isDemo={sessionUser?.isDemo ?? false}
            triggerToast={notifyCurrentWorkspace}
          />
        );
      case 'team':
        if (!online) return <p>Team and invitation management require a connection.</p>;
        return sessionUser && currentClinicId && currentClinicRole ? (
          <ClinicTeamView
            key={`${currentClinicId}:${sessionUser.uid}`}
            clinicId={currentClinicId}
            clinicName={currentClinicName}
            user={sessionUser}
            role={currentClinicRole}
            onOwnershipTransferred={nextRole => {
              if (!mutationScope.isCurrent(workspaceGeneration)) return;
              setCurrentClinicRole(nextRole);
              setActiveTab(previous => previous === 'team' ? 'dashboard' : previous);
            }}
            triggerToast={notifyCurrentWorkspace}
          />
        ) : null;
      case 'audit':
        return currentClinicId && currentClinicId !== 'demo-clinic' && currentClinicRole === 'owner'
          ? <AuditLogView key={currentClinicId} clinicId={currentClinicId} searchQuery={searchQuery} />
          : <p>Audit events are available to the clinic owner in a connected clinic.</p>;
    }
  };
    const handleLogout = async () => {
      if (leaving.current) return;
      leaving.current = true;
      setLoggingOut(true);
      mutationScope.invalidate();
      const clinicId = currentClinicId;

      setIsAuthenticated(false);
      setCurrentUser(null);
      setSessionUser(null);
      setCurrentClinicId(null);
      setCurrentClinicName('');
      setCurrentClinicRole(null);
      setPatientToOpen(null);
      setSearchQuery('');
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
      try {
        if (sessionUser && !sessionUser.isDemo) {
          const { auth } = await initializeFirebase();
          const { signOut } = await import('firebase/auth');
          await signOut(auth);
        }
      } catch (error) {
        console.error('[Auth] Sign-out failed:', error);
      } finally {
        leaving.current = false;
        setLoggingOut(false);
      }
    };

    const handleSelectClinic = (membership: ClinicMembership) => {
      if (leaving.current) return;
      mutationScope.invalidate();
      setCurrentClinicId(membership.clinicId);
      setCurrentClinicName(membership.clinicName);
      setCurrentClinicRole(membership.role);
      setPatientToOpen(null); setSearchQuery('');
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
      if (leaving.current) return;
      mutationScope.invalidate();
      setCurrentClinicId(null);
      setCurrentClinicName('');
      setCurrentClinicRole(null);
      setPatientToOpen(null); setSearchQuery('');
      setCurrentUser(sessionUser ? `${sessionUser.displayName} (${sessionUser.email})` : null);
      setActiveTab('dashboard');
      setPatients([]);
      setInventory([]);
      setConsultations([]);
    };

    const handleRenameClinic = async (name: string) => {
      if (leaving.current || !mutationScope.isCurrent(workspaceGeneration)) throw new Error('Workspace is closing.');
      const captured = mutationScope.capture();
      if (!currentClinicId) throw new Error('No clinic is selected.');
      const clinicName = await renameClinic(currentClinicId, name);
      if (!mutationScope.isCurrent(captured)) return;
      setCurrentClinicName(clinicName);
      setCurrentUser(`${clinicName} (${sessionUser?.email || ''})`);
    };

    if (!isAuthenticated) {
    return (
      <>
      {deviceNotice && <p role="alert" className="bg-warning-tint p-3 text-center text-sm text-warning-text-max">{deviceNotice}</p>}
      {loggingOut ? <p role="status" className="p-4 text-center">Signing out…</p> : <LoginScreen
        onLoginSuccess={(user) => {
          if (leaving.current) return;
          mutationScope.invalidate();
          setPatientToOpen(null); setSearchQuery('');
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
      />}
      <div className="mx-auto w-full max-w-3xl p-4"><OfflineDeviceSettings /></div>
      </>
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
    <div className="flex h-screen overflow-hidden bg-canvas font-sans">
      {/* Toast Notification Container */}
      {successToast && (
        <div role="status" className="fixed bottom-5 right-5 z-[60] flex max-w-[min(460px,calc(100vw-40px))] items-center gap-3 rounded-xl bg-[#173b36] px-5 py-3.5 text-white shadow-[0_12px_36px_#10271e50]">
          <Sparkles className="w-4 h-4 shrink-0 text-[#9ef2d8]" aria-hidden="true" />
          <span className="text-[13px] font-medium">{successToast}</span>
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
        setActiveTab={tab => { setPatientToOpen(null); setActiveTab(tab); }}
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

      <div className="flex h-screen flex-1 flex-col overflow-hidden">
        <Header
          toggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          currentClinicRole={currentClinicRole}
          onRecordVisit={handleRecordVisit}
          canEdit={canChangeRecords}
        />

        <main tabIndex={-1} className="flex-1 overflow-y-auto px-4 py-6 sm:px-7 sm:py-7">
          <div className="mx-auto w-full max-w-[1450px]">
            {renderContent()}
          </div>
        </main>
      </div>
    </div>
  );
}
