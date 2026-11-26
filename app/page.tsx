"use client";

import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { Sparkles } from 'lucide-react';
import type { InventoryItem, PatientRecord, Consultation, ConsultationDraft } from '@/types';
import { initializeFirebase, dbRef, firestore, restoreFirebaseSession } from '@/lib/firebase';
import { nextPatientId } from '@/lib/patients';
import { useClinicPages } from '@/lib/useClinicPages';
import { PageControls } from '@/components/PageControls';
import { ConsultationHistory } from '@/components/ConsultationHistory';
import { mutateClinicalRecord } from '@/lib/clinical-mutations';
import { checkBillingReconciliation, commitBilling, loadBillingHistory, loadBillingRecords, loadPaymentReceipt, type BillingOperation, type BillingRecords } from '@/lib/billing';
import { reconcileBillingLedger } from '@/lib/billing-reconciliation';
import { createDemoBilling } from '@/lib/demo-billing';
import { createDemoEndOfDayLoader, loadEndOfDayPage, type ClosePageLoader } from '@/lib/end-of-day';
import type { BillingGateway } from '@/lib/useBilling';
import { getDevicePreference, watchDevicePreference } from '@/lib/offline-device';
import OfflineDeviceSettings from '@/components/OfflineDeviceSettings';
import { AuditLogView } from '@/components/AuditLogView';
import { patientValidationError, inventoryValidationError } from '@/lib/record-validation';
import { ImageStorageControls } from '@/components/ImageStorageControls';
import { createMutationScope } from '@/lib/mutation-scope';
import { useAppointments } from '@/lib/useAppointments';
import { AppointmentsView } from '@/components/AppointmentsView';
import { FollowUpQueue } from '@/components/FollowUpQueue';
import { loadDemoFollowUpPage, loadFollowUpPage, recordFollowUpContact, subscribeFollowUps, type FollowUpCursor, type FollowUpSubscription } from '@/lib/follow-up';
import type { Appointment } from '@/types';
import { inventoryFromDocument, loadClinicScanPage, loadDemoClinicScanPage, loadInventoryCatalogCount, patientFromDocument } from '@/lib/clinic-pages';
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
import { WorkspaceAssistant } from '@/components/WorkspaceAssistant';
import { assistantEditorTime, matchAssistantReschedule, type AssistantReschedule, type AssistantSchedule } from '@/lib/workspace-assistant';
import { readAssistantRole, watchAssistantRole } from '@/lib/workspace-assistant-access';
import { workspaceAIConfigIdentity, resetWorkspaceAIContext, workspaceAIPreviewAvailable,
  workspaceAIHistoryLimit, planWorkspaceClinicQuery, type ClinicPlanTurn } from '@/lib/workspace-ai';
import { executeClinicQueries, type ClinicQueryReply } from '@/lib/clinic-query';
import { readClinicQuerySource } from '@/lib/clinic-query-client';
import { loadDailyBriefing } from '@/lib/daily-briefing-client';
import type { DailyBriefingOutcome } from '@/lib/daily-briefing';
import { assistantResourceId, type AssistantToolCall } from '@/lib/assistant-tools';
import { assistantToolEndpoint, requestAssistantTool, type AssistantLookup } from '@/lib/assistant-tool-client';
import { DashboardHome } from '@/components/DashboardHome';
import { WorkspaceEndOfDayClose } from '@/components/EndOfDayClose';
import { AIClerkDemo } from '@/components/AIClerkDemo';
import { PatientRecordsView } from '@/components/PatientRecordsView';
import { InventoryControlView } from '@/components/InventoryControlView';
import { StockAlerts } from '@/components/StockAlerts';
import { AILaboratoryView } from '@/components/AILaboratoryView';
import { SystemSettingsView } from '@/components/SystemSettingsView';
import { AccountSettingsView } from '@/components/AccountSettingsView';
import { StaffPayrollView } from '@/components/StaffPayrollView';
import { ClinicWorkspaceScreen } from '@/components/ClinicWorkspaceScreen';
import { ClinicTeamView } from '@/components/ClinicTeamView';
import { renameClinic, setClinicAIEnabled, subscribeClinicAI } from '@/lib/clinics';
import type { ClinicMembership, ClinicRole, ClinicSessionUser } from '@/types';

const assistantWorker = process.env.NEXT_PUBLIC_ASSISTANT_TOOLS_URL;

export default function App() {
  const [mutationScope] = useState(createMutationScope);
  // Give React Compiler a primitive snapshot to track in callback dependencies.
  const workspaceGeneration = Number(mutationScope.capture());
  const leaving = useRef(false);
  // Chat history is owned here, keyed by workspace scope + saved AI setup, so a
  // provider/model/key change can never forward the previous setup's turns.
  const clinicQueryHistory = useRef<{ key: string; turns: ClinicPlanTurn[] }>({ key: '', turns: [] });
  const [loggingOut, setLoggingOut] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [assistantHandoff, setAssistantHandoff] = useState<{ scopeKey: string; proposal: AssistantReschedule } | null>(null);
  const [assistantAccess, setAssistantAccess] = useState<{ workspace: string; role: ClinicRole | null; version: number } | null>(null);
  const assistantAccessRef = useRef<typeof assistantAccess>(null);
  const assistantAccessVersion = useRef(0);
  const assistantCurrent = useRef<{ scopeKey: string; schedule: AssistantSchedule } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [patientToOpen, setPatientToOpen] = useState<PatientRecord | null>(null);
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
  const demoBilling = useRef<ReturnType<typeof createDemoBilling> | null>(null);
  const pendingBilling = useRef(new Map<string, BillingOperation>());
  const [online, setOnline] = useState(true);
  const [deviceNotice, setDeviceNotice] = useState('');
  const canChangeRecords = currentClinicId === 'demo-clinic' ||
    (online && currentClinicRole !== null);
  const canOpenClose = !!currentClinicId && !!sessionUser && (currentClinicId === 'demo-clinic'
    || currentClinicRole !== null);
  const canReadClinic = !!currentClinicId && !!sessionUser && (currentClinicId === 'demo-clinic' || currentClinicRole !== null);
  const clinicScanOnline = currentClinicId === 'demo-clinic' || online;
  const clinicScanKey = `${currentClinicId}:${sessionUser?.uid ?? ''}:${workspaceGeneration}:${clinicScanOnline}`;
  const aiEnabled = currentClinicId === 'demo-clinic'
    ? demoAIEnabled
    : clinicAI?.clinicId === currentClinicId && clinicAI.enabled;
  const isDemoWorkspace = currentClinicId === 'demo-clinic';
  const assistantWorkspace = JSON.stringify([currentClinicId, sessionUser?.uid, currentClinicRole, workspaceGeneration]);
  const shouldWatchAssistant = aiEnabled && canReadClinic && !isDemoWorkspace;
  const verifiedAccess = shouldWatchAssistant && assistantAccess?.workspace === assistantWorkspace ? assistantAccess : null;
  if (assistantAccess && !verifiedAccess) setAssistantAccess(null);
  const assistantAllowed = aiEnabled && canReadClinic && (isDemoWorkspace || !!verifiedAccess?.role);
  const assistantCanEdit = assistantAllowed && canChangeRecords;
  const assistantScopeKey = `${assistantWorkspace}:${verifiedAccess?.version ?? 0}`;
  const assistantReview = activeTab === 'appointments' && assistantCanEdit &&
    assistantHandoff?.scopeKey === assistantScopeKey ? assistantHandoff.proposal : undefined;
  if (assistantHandoff && !assistantReview) setAssistantHandoff(null);

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

  const assistantUid = sessionUser?.uid;
  useEffect(() => {
    if (!shouldWatchAssistant || !currentClinicId || !assistantUid) return;
    let active = true, stop: (() => void) | undefined;
    const publish = (role: ClinicRole | null) => {
      if (!active || !mutationScope.isCurrent(workspaceGeneration)) return;
      if (assistantAccessRef.current?.workspace === assistantWorkspace && assistantAccessRef.current.role === role) return;
      const access = { workspace: assistantWorkspace, role, version: ++assistantAccessVersion.current };
      assistantAccessRef.current = access;
      setAssistantAccess(access);
    };
    void watchAssistantRole(currentClinicId, assistantUid, publish).then(unsubscribe => {
      if (active) stop = unsubscribe;
      else unsubscribe();
    }).catch(() => publish(null));
    return () => { active = false; assistantAccessRef.current = null; stop?.(); };
  }, [shouldWatchAssistant, currentClinicId, assistantUid, assistantWorkspace, workspaceGeneration, mutationScope]);

  // A different workspace/account must not inherit the previous chat context.
  useEffect(() => { resetWorkspaceAIContext(); }, [assistantScopeKey]);

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
    clinicId: currentClinicId, uid: sessionUser?.uid ?? null, authenticated: isAuthenticated,
    setPatients, setInventory, setConsultations
  });
  const appointments = useAppointments({
    clinicId: currentClinicId, uid: sessionUser?.uid ?? null, online, canEdit: canChangeRecords,
    patients, scope: mutationScope, workspaceGeneration,
  });
  const { demoRecords: demoAppointments } = appointments;
  const loadDemoClosePage: ClosePageLoader = useCallback((kind, params) => createDemoEndOfDayLoader({
    entries: demoBilling.current?.allEntries() ?? [], patients, consultations, appointments: demoAppointments(),
  })(kind, params), [consultations, demoAppointments, patients]);
  const followUpUid = sessionUser?.uid ?? '';
  const followUpIsCurrent = useCallback(() => !leaving.current && mutationScope.isCurrent(workspaceGeneration),
    [mutationScope, workspaceGeneration]);
  const clinicScanIsCurrent = () => followUpIsCurrent() && (currentClinicId === 'demo-clinic' || (online && navigator.onLine));
  const loadFollowUps = useCallback(async (after: FollowUpCursor, endMs: number) => {
    if (!currentClinicId || !followUpUid || !followUpIsCurrent()) throw new Error('Choose a clinic workspace.');
    return currentClinicId === 'demo-clinic' ? loadDemoFollowUpPage(demoAppointments(), endMs, after)
      : loadFollowUpPage({ clinicId: currentClinicId, uid: followUpUid, after, endMs });
  }, [currentClinicId, demoAppointments, followUpIsCurrent, followUpUid]);
  const watchFollowUps = useCallback<FollowUpSubscription>((...args) => {
    if (!currentClinicId || !followUpUid || !followUpIsCurrent()) return Promise.reject(new Error('Choose a clinic workspace.'));
    return subscribeFollowUps({ clinicId: currentClinicId, uid: followUpUid }, ...args);
  }, [currentClinicId, followUpIsCurrent, followUpUid]);

  useEffect(() => watchDevicePreference(change => {
    if (change !== 'wipe' && getDevicePreference() !== 'memory') return;
    leaving.current = true;
    mutationScope.invalidate();
    setIsAuthenticated(false); setSessionUser(null); setCurrentUser(null);
    setCurrentClinicId(null); setCurrentClinicName(''); setCurrentClinicRole(null);
    demoBilling.current = null;
    pendingBilling.current.clear();
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
      triggerToast('Clinical changes require an online clinic session.');
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
      setPatients(prev => prev.some(row => row.id === newPat.id) ? prev : [{ ...newPat, revision: saved.revision }, ...prev]);
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
  const createInventoryItem = async (newItem: InventoryItem, csvBatchId?: string) => {
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration)) throw new Error('Workspace is closing. No changes were started.');
    const captured = mutationScope.capture();
    if (!canChangeRecords) throw new Error('Inventory changes require an online clinic session.');
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
        expectedRevision: null, data: newItem, action: 'save',
        ...(csvBatchId && { inventoryImportBatchId: csvBatchId, expectedUid: sessionUser?.uid }),
      });
      console.log('[Inventory] create success', newItem.itemCode);
      if (!mutationScope.isCurrent(captured)) throw new Error('Workspace changed. The prior clinic’s save may have completed.');
      // The confirmed prefix owns the list. Only refresh a row already on
      // screen; a newly saved item outside that prefix arrives via the listener.
      setInventory(prev => {
        const current = prev.find(item => item.itemCode === newItem.itemCode);
        if (!current || (current.revision ?? 0) > (saved.revision ?? 0)) return prev;
        return prev.map(item => item.itemCode === newItem.itemCode
          ? { ...newItem, revision: saved.revision } : item);
      });

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
    if (!canChangeRecords) throw new Error('Inventory changes require an online clinic session.');
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
        && (item.revision ?? 0) <= (saved.revision ?? 0)
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
    if (!canChangeRecords) throw new Error('Inventory changes require an online clinic session.');
    const existing = inventory.find(item => item.itemCode === itemCode);
    if (existing?.billingStockEntryId) throw new Error('This item is part of billing history and must remain available for stock returns.');
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

      if (!existing) throw new Error('Reload the item before deleting.');
      const saved = await mutateClinicalRecord({
        clinicId: currentClinicId, collection: 'inventory', id: itemCode,
        expectedRevision: existing.revision ?? 0, action: 'delete'
      });
      if (!mutationScope.isCurrent(captured)) throw new Error('Workspace changed. The prior clinic’s delete may have completed.');
      setInventory(previous => previous.filter(item => item.itemCode !== itemCode
        || (item.revision ?? 0) > (saved.revision ?? 0)));
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
      triggerToast('Clinical changes require an online clinic session.');
      return false;
    }
    const invalid = patientValidationError(updatedRecord);
    if (invalid) { triggerToast(invalid); return false; }
    if (currentClinicId === 'demo-clinic') {
      setPatients(prev => prev.map(p => p.id === updatedRecord.id ? {
        ...updatedRecord, balance: p.balance, billing: p.billing, legacyBillingBalance: p.legacyBillingBalance,
        billableItems: p.billableItems, revision: p.revision,
      } : p));
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
        expectedRevision: updatedRecord.revision ?? 0, data: payload, action: 'save', preservePatientBilling: true
      });

      console.log(`[Firebase] Successfully updated patient record ${updatedRecord.id} in cloud.`);
      // Keep the returned version on both the list and the edit buffer.
      if (!mutationScope.isCurrent(captured)) return false;
      setPatients(prev => prev.map(p => p.id === updatedRecord.id && (p.revision ?? 0) < saved.revision
        ? { ...payload, revision: saved.revision, balance: p.balance, billing: p.billing,
          legacyBillingBalance: p.legacyBillingBalance, billableItems: p.billableItems } : p));
      triggerToast(`Clinical record updated successfully.`);
      return true;
    } catch (e) {
      if (!mutationScope.isCurrent(captured)) return false;
      console.error('[Firebase Error] Failed to update patient document:', e);
      triggerToast(e instanceof Error ? e.message : 'Could not save this record.');
      return false;
    }
  };

  const deletePatientRecord = async (id: string, selected?: PatientRecord) => {
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration)) return false;
    const captured = mutationScope.capture();
    if (!canChangeRecords) {
      triggerToast('Clinical changes require an online clinic session.');
      return false;
    }
    const existing = selected?.id === id ? selected : patients.find(patient => patient.id === id);
    if (existing?.billing || existing?.balance || existing?.billableItems?.length
      || (existing?.legacyBillingBalance !== undefined && existing.legacyBillingBalance !== 0)) {
      triggerToast('This patient has financial history. Discharge the patient instead of deleting the record.');
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
  const activeBillingClinic = () => {
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration) || !canChangeRecords || !currentClinicId
      || (currentClinicId !== 'demo-clinic' && !navigator.onLine)) throw new Error('Open an editable clinic to use billing.');
    return currentClinicId;
  };
  const pendingKey = (clinic: string, patientId: string) => JSON.stringify([sessionUser?.uid ?? 'demo', clinic, patientId]);
  const applyBillingRecords = (patientId: string, records: BillingRecords) => {
    const patient = patientFromDocument(patientId, records.patient);
    setPatients(rows => rows.map(row => row.id === patientId && (row.revision ?? 0) <= (patient.revision ?? 0) ? patient : row));
    if (!records.inventory.length && !records.missingItemCodes?.length) return;
    setInventory(rows => rows.filter(row => !records.missingItemCodes?.includes(row.itemCode)).map(row => {
      const stock = records.inventory.find(item => item.itemCode === row.itemCode);
      return stock && (row.revision ?? 0) <= (stock.revision ?? 0) ? inventoryFromDocument(row.itemCode, stock) : row;
    }));
  };
  const billingGateway: BillingGateway = {
    pending(patientId) {
      return pendingBilling.current.get(pendingKey(activeBillingClinic(), patientId)) ?? null;
    },
    async submit(operationId, draft, patientId, expectedPatientRevision, selected) {
      const clinicId = activeBillingClinic();
      const operation = { clinicId, operationId, draft, patientId, expectedPatientRevision };
      const patient = selected?.id === patientId ? selected : patients.find(row => row.id === patientId);
      if (!patient) throw new Error('Reload this patient before saving.');
      if (firestoreDocBytes(patient) > MAX_PATIENT_DOC_BYTES) throw new Error('This patient record is too large to update safely.');
      const key = pendingKey(clinicId, patientId);
      const unresolved = pendingBilling.current.get(key);
      if (unresolved && JSON.stringify(unresolved) !== JSON.stringify(operation)) {
        throw new Error('Resolve the unconfirmed billing save before starting a new one.');
      }
      if (clinicId !== 'demo-clinic') pendingBilling.current.set(key, operation);
      let result;
      try {
        result = clinicId === 'demo-clinic'
          ? (demoBilling.current ??= createDemoBilling()).commit(operation, patient, inventory, currentClinicName, sessionUser?.uid ?? 'demo')
          : await commitBilling(operation);
      } catch (error) {
        if (error instanceof Error && error.name === 'ClinicalConflictError' && pendingBilling.current.get(key) === operation) {
          pendingBilling.current.delete(key);
        }
        throw error;
      }
      activeBillingClinic();
      if (pendingBilling.current.get(key) === operation) pendingBilling.current.delete(key);
      if (result.records) {
        applyBillingRecords(patientId, result.records);
        return result;
      }
      setPatients(rows => rows.map(row => row.id === patientId && (row.revision ?? 0) <= result.patientRevision ? {
        ...row, legacyBillingBalance: row.legacyBillingBalance === undefined ? row.balance : row.legacyBillingBalance,
        balance: result.state.balanceMinor / 100, billing: result.state, revision: result.patientRevision,
      } : row));
      setInventory(rows => rows.map(row => {
        const stock = result.stock.find(item => item.itemCode === row.itemCode);
        return stock && (row.revision ?? 0) <= stock.revision ? { ...row, ...stock } : row;
      }));
      return result;
    },
    async history(patientId, after) {
      const clinicId = activeBillingClinic();
      const result = clinicId === 'demo-clinic' ? demoBilling.current?.history(patientId) ?? { entries: [], next: null }
        : await loadBillingHistory({ clinicId, patientId, after });
      activeBillingClinic();
      return result;
    },
    async reconcile(patientId) {
      const clinicId = activeBillingClinic();
      if (clinicId === 'demo-clinic') {
        const patient = patients.find(row => row.id === patientId);
        if (!patient) throw new Error('This patient is no longer available.');
        return reconcileBillingLedger(patient.billing ?? null, demoBilling.current?.history(patientId).entries ?? []);
      }
      return checkBillingReconciliation(clinicId, patientId, activeBillingClinic);
    },
    async refreshRecords(patientId, itemCodes) {
      const clinicId = activeBillingClinic();
      if (clinicId === 'demo-clinic') return;
      const records = await loadBillingRecords({ clinicId, patientId, itemCodes });
      activeBillingClinic();
      applyBillingRecords(patientId, records);
    },
    async receipt(patientId, entryId) {
      const clinicId = activeBillingClinic();
      const result = clinicId === 'demo-clinic' ? demoBilling.current?.receipt(patientId, entryId)
        : await loadPaymentReceipt({ clinicId, patientId, entryId });
      activeBillingClinic();
      if (!result) throw new Error('No posted receipt for that patient.');
      return result;
    },
  };

  const toggleConsultationStatus = async (id: string) => {
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration)) return;
    const captured = mutationScope.capture();
    if (!canChangeRecords || !currentClinicId) {
      triggerToast('Consultation changes require an online clinic session.');
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
          expectedRevision: current.revision ?? 0, data: { status: updated.status }, action: 'save',
          expectedUid: sessionUser?.uid, consultationStatusOnly: true
        });
        updated.revision = saved.revision;
      }
      if (!mutationScope.isCurrent(captured)) return;
      setConsultations(previous => previous.map(record => record.id === id && record.revision === current.revision
        ? { ...record, status: updated.status, revision: updated.revision }
        : record));
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
      triggerToast('Treatment records require an online clinic session.');
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
      setInventory(previous => previous.map(item => {
        const change = result.inventory.find(row => row.itemCode === item.itemCode);
        return change && (change.revision ?? 0) >= (item.revision ?? 0) ? change : item;
      }));
      setTreatmentLink(null);
      return true;
    } catch (error) {
      if (!mutationScope.isCurrent(captured)) return false;
      triggerToast(error instanceof Error ? error.message : 'The treatment record was not saved.');
      return false;
    }
  };

  const loadAppointmentPatient = async (id: string, stillOpen: () => boolean = () => true, freshRecord = false) => {
    if (leaving.current || !mutationScope.isCurrent(workspaceGeneration) || !currentClinicId || !stillOpen()) return null;
    let patient = freshRecord ? undefined : patients.find(record => record.id === id);
    if (!patient && currentClinicId !== 'demo-clinic') {
      const { db, firestore: fs } = await initializeFirebase();
      if (!mutationScope.isCurrent(workspaceGeneration) || !stillOpen()) return null;
      const reference = fs.doc(db, 'clinics', currentClinicId, 'patients', id);
      const snapshot = await (freshRecord ? fs.getDocFromServer(reference)
        : online ? fs.getDoc(reference) : fs.getDocFromCache(reference));
      if (!mutationScope.isCurrent(workspaceGeneration) || !stillOpen()) return null;
      if (!snapshot.exists()) throw new Error('The linked patient is no longer available in this clinic.');
      patient = patientFromDocument(snapshot.id, snapshot.data());
    }
    if (!patient) throw new Error('The linked demo patient is no longer available.');
    return patient;
  };

  const openAppointmentPatient = async (id: string, stillOpen: () => boolean = () => true, freshRecord = false) => {
    const patient = await loadAppointmentPatient(id, stillOpen, freshRecord);
    if (!patient) return;
    setTreatmentLink(null);
    setPatientToOpen(patient); setSearchQuery(patient.id); setActiveTab('patients');
  };

  const openAppointmentTreatment = async (
    appointment: { id: string; patientId: string; occurredAt: string | null; dueAt: string },
    stillOpen: () => boolean = () => true
  ) => {
    if (!canChangeRecords) throw new Error('An online clinic session is required to record treatments.');
    const patient = await loadAppointmentPatient(appointment.patientId, stillOpen);
    if (!patient) return;
    setTreatmentLink({
      patientId: patient.id,
      appointmentId: appointment.id,
      occurredAt: appointment.occurredAt || appointment.dueAt
    });
    setPatientToOpen(patient); setSearchQuery(patient.id); setActiveTab('patients');
  };

  const handleRecordVisit = () => {
    setPatientToOpen(null);
    setTreatmentLink(null);
    setActiveTab('patients');
    triggerToast(canChangeRecords
      ? 'Choose a patient to record a visit.'
      : 'An online clinic session is required to record a visit.');
  };

  const navigateTo = (tab: string) => {
    setPatientToOpen(null);
    setTreatmentLink(null);
    setActiveTab(tab);
  };

  const assistantSchedule = useMemo<AssistantSchedule>(() => ({
    window: appointments.window,
    availability: (currentClinicId !== 'demo-clinic' && !online) || appointments.fromCache ? 'offline' :
      appointments.busy ? 'loading' : appointments.error ? 'error' : appointments.loaded ? 'ready' : 'loading',
    partial: appointments.hasMore,
    rows: assistantAllowed ? appointments.rows.filter(row => row.status === 'scheduled')
      .map(({ id, revision, patientName, dueAt, type }) => ({ id, revision, patientName, dueAt, type })) : [],
  }), [appointments.window, appointments.fromCache, appointments.busy, appointments.error, appointments.loaded,
    appointments.hasMore, appointments.rows, assistantAllowed, currentClinicId, online]);

  useLayoutEffect(() => {
    assistantCurrent.current = assistantCanEdit ? { scopeKey: assistantScopeKey, schedule: assistantSchedule } : null;
    return () => { assistantCurrent.current = null; };
  }, [assistantCanEdit, assistantScopeKey, assistantSchedule]);

  const currentReviewProblem = (proposal: AssistantReschedule, stillOpen: () => boolean): string | null => {
    const current = assistantCurrent.current;
    if (!stillOpen() || leaving.current || !currentClinicId || !assistantUid ||
        !mutationScope.isCurrent(workspaceGeneration) || current?.scopeKey !== assistantScopeKey ||
        (!isDemoWorkspace && assistantAccessRef.current !== verifiedAccess)) {
      return 'This workspace cannot review the change. No appointment was edited.';
    }
    if (current.schedule.availability !== 'ready' || !matchAssistantReschedule(proposal, current.schedule.rows)) {
      return 'The appointment or schedule changed. Ask again before reviewing.';
    }
    return null;
  };

  const verifyAssistantReview = async (proposal: AssistantReschedule, stillOpen: () => boolean) => {
    const problem = currentReviewProblem(proposal, stillOpen);
    if (problem) return problem;
    if (!isDemoWorkspace && currentClinicId && assistantUid) {
      const role = await readAssistantRole(currentClinicId, assistantUid);
      if (!role || role !== verifiedAccess?.role) {
        return 'Your clinic access changed or could not be verified. Reopen the assistant before continuing.';
      }
    }
    return currentReviewProblem(proposal, stillOpen);
  };

  const reviewAssistantReschedule = async (proposal: AssistantReschedule, stillOpen: () => boolean): Promise<string | null> => {
    const problem = await verifyAssistantReview(proposal, stillOpen) ?? currentReviewProblem(proposal, stillOpen);
    if (problem) return problem;
    if (!assistantEditorTime(proposal.proposedDueAt)) {
      return 'This device cannot represent the proposed time in the appointment editor. Choose a different time.';
    }
    setAssistantHandoff({ scopeKey: assistantScopeKey, proposal });
    navigateTo('appointments');
    return null;
  };

  const mayInvestigate = () => !!currentClinicId && !!assistantUid && online && !isDemoWorkspace && assistantAllowed &&
    !leaving.current && mutationScope.isCurrent(workspaceGeneration) && assistantAccessRef.current === verifiedAccess;

  const lookupAssistantTool = async (call: AssistantToolCall, signal: AbortSignal): Promise<AssistantLookup> => {
    if (!assistantWorker || !currentClinicId || !mayInvestigate() || signal.aborted) return { error: 'access-denied' };
    const { auth } = await initializeFirebase();
    const user = auth.currentUser;
    if (!mayInvestigate() || signal.aborted || !user || user.uid !== assistantUid) return { error: 'access-denied' };
    const token = await user.getIdToken();
    if (!mayInvestigate() || signal.aborted || auth.currentUser?.uid !== assistantUid) return { error: 'access-denied' };
    const reply = await requestAssistantTool(assistantWorker, currentClinicId, token, call, signal);
    return mayInvestigate() && !signal.aborted && auth.currentUser?.uid === assistantUid ? reply : { error: 'access-denied' };
  };

  const countAssistantInventory = async (signal: AbortSignal): Promise<number | null> => {
    if (signal.aborted || !assistantAllowed || leaving.current || !mutationScope.isCurrent(workspaceGeneration)) return null;
    if (isDemoWorkspace) return inventory.length;
    if (!currentClinicId || !mayInvestigate()) return null;
    const { auth } = await initializeFirebase();
    const current = () => !signal.aborted && navigator.onLine && mayInvestigate() && auth.currentUser?.uid === assistantUid;
    if (!current()) return null;
    const count = await loadInventoryCatalogCount(currentClinicId);
    return current() ? count : null;
  };

  const chatWithClinicQuery = async (
    prompt: string, history: readonly ClinicPlanTurn[], signal: AbortSignal,
  ): Promise<ClinicQueryReply> => {
    const unavailable = () => new Error('Clinic queries are unavailable. Reopen the assistant in the signed-in localhost sample workspace.');
    const configKey = workspaceAIConfigIdentity();
    if (!workspaceAIPreviewAvailable() || !currentClinicId || !assistantUid || signal.aborted || !mayInvestigate()) throw unavailable();
    const { app, auth } = await initializeFirebase();
    const current = () => !signal.aborted && navigator.onLine && mayInvestigate() &&
      auth.currentUser?.uid === assistantUid && app.options.projectId === 'vetcloudpro-staging-6f819b';
    if (!current()) throw unavailable();
    const configIsCurrent = () => workspaceAIConfigIdentity() === configKey;
    const setupChanged = () => new Error('AI setup changed. Ask again to use the saved configuration.');
    if (!configIsCurrent()) throw setupChanged();

    // The provider returns plans only, never clinic evidence.
    // The component's empty history also marks the first send after Clear chat.
    const historyKey = `${assistantScopeKey}:${configKey}`;
    if (!history.length || clinicQueryHistory.current.key !== historyKey) {
      clinicQueryHistory.current = { key: historyKey, turns: [] };
    }
    const context = clinicQueryHistory.current;
    const action = await planWorkspaceClinicQuery(prompt, context.turns, signal);
    if (!current()) throw unavailable();
    if (!configIsCurrent()) throw setupChanged();
    if (action.kind === 'conversation') {
      context.turns = [...context.turns, { prompt, plan: null }].slice(-workspaceAIHistoryLimit);
      return { kind: 'decline', message: action.message, plan: null };
    }
    if (action.kind === 'decline') return { kind: 'decline',
      message: 'I couldn’t verify an answer from clinic records for that question. Try naming the record, list, or field you want me to check.', plan: null };

    const plans = 'plans' in action ? action.plans : [action.plan];
    const notice = 'notice' in action ? action.notice : undefined;
    const outcomes = await executeClinicQueries(plans, table => readClinicQuerySource(
      { clinicId: currentClinicId, uid: assistantUid, role: verifiedAccess?.role ?? null },
      table, signal, () => current() && configIsCurrent(),
    ));
    if (!current()) throw unavailable();
    if (!configIsCurrent()) throw setupChanged();
    // The verified answer with patient names or amounts is rendered locally and
    // never leaves this device; only plans with verified sources are retained.
    const verified = plans.filter((_, index) => outcomes[index].status === 'ok' || outcomes[index].status === 'partial');
    if (verified.length && !notice && clinicQueryHistory.current === context) {
      const turn = verified.length === 1 ? { prompt, plan: verified[0] } : { prompt, plans: verified };
      context.turns = [...context.turns, turn].slice(-workspaceAIHistoryLimit);
    }
    if (plans.length === 1) return { kind: 'result', outcome: outcomes[0], plan: plans[0], ...(notice ? { notice } : {}) };
    return { kind: 'results', results: plans.map((plan, index) => ({ plan, outcome: outcomes[index] })) };
  };

  // Local, read-only front-desk briefing. It reads the signed-in clinic's real
  // staging records, makes no provider call and forwards nothing. The same
  // localhost/staging and access gates as the other preview callbacks apply.
  const briefingForClinic = async (signal: AbortSignal): Promise<DailyBriefingOutcome> => {
    const unavailable = (): DailyBriefingOutcome => ({ kind: 'unavailable',
      message: 'Today’s briefing is unavailable. Reopen the assistant in the signed-in localhost staging workspace.' });
    if (!workspaceAIPreviewAvailable() || !currentClinicId || !assistantUid || signal.aborted || !mayInvestigate()) return unavailable();
    const { app, auth } = await initializeFirebase();
    const current = () => !signal.aborted && navigator.onLine && mayInvestigate() &&
      auth.currentUser?.uid === assistantUid && app.options.projectId === 'vetcloudpro-staging-6f819b';
    if (!current()) return unavailable();
    const outcome = await loadDailyBriefing({
      clinicId: currentClinicId, uid: assistantUid, role: verifiedAccess?.role ?? null,
      signal, isCurrent: current,
    });
    return current() ? outcome : unavailable();
  };

  const openAssistantPerson = async (id: string, stillOpen: () => boolean): Promise<string | null> => {
    const problem = 'Clinic access changed or could not be verified. Ask again before opening a record.';
    const current = () => stillOpen() && mayInvestigate();
    if (!currentClinicId || !assistantUid || !assistantResourceId.test(id) || !current()) return problem;
    const role = await readAssistantRole(currentClinicId, assistantUid);
    if (!current() || !role || role !== verifiedAccess?.role) return problem;
    // After a staff click, this is the existing patient-view handoff, not a
    // data source for the assistant. Refresh rather than opening a cached row.
    await openAppointmentPatient(id, current, true);
    return null;
  };

  const saveAppointmentFromEditor = async (
    id: string, revision: number | null, draft: Parameters<typeof appointments.save>[2],
    proposal?: AssistantReschedule, stillOpen = () => true,
  ) => {
    if (proposal) {
      const problem = await verifyAssistantReview(proposal, stillOpen) ?? currentReviewProblem(proposal, stillOpen);
      if (problem) throw new Error(problem);
    }
    return appointments.save(id, revision, draft);
  };

  const handleFollowUpContact = async (row: Appointment, contacted: boolean) => {
    if (!currentClinicId || !followUpUid || !canChangeRecords || !followUpIsCurrent()) throw new Error('Choose an online editable clinic.');
    if (currentClinicId === 'demo-clinic') return appointments.recordDemoFollowUpContact(row, contacted);
    const updated = await recordFollowUpContact({ clinicId: currentClinicId, uid: followUpUid, row, contacted });
    if (!followUpIsCurrent()) throw new Error('The clinic workspace changed.');
    appointments.applyFollowUpContact(updated);
    return updated;
  };

  // --- RENDER CONTENT DEPENDING ON NAVIGATION TABS ---
  const renderContent = () => {
    switch (activeTab === 'end-of-day-close' && !canOpenClose ? 'dashboard' : activeTab) {
      case 'end-of-day-close':
        return currentClinicId && sessionUser && <WorkspaceEndOfDayClose
          key={JSON.stringify([currentClinicId, sessionUser.uid])}
          clinicId={currentClinicId} uid={sessionUser.uid} workspaceGeneration={workspaceGeneration}
          isCurrent={mutationScope.isCurrent} enabled={canOpenClose} online={online || currentClinicId === 'demo-clinic'}
          load={currentClinicId === 'demo-clinic' ? loadDemoClosePage : loadEndOfDayPage}
          clerkPreview={currentClinicId === 'demo-clinic' && sessionUser.isDemo && aiEnabled
            ? <AIClerkDemo key={workspaceGeneration} /> : undefined}
          onOpenPatient={openAppointmentPatient} onBack={() => navigateTo('dashboard')}
        />;
      case 'follow-ups':
        return canReadClinic ? <FollowUpQueue
          key={JSON.stringify([currentClinicId, followUpUid, currentClinicRole, online, workspaceGeneration])}
          canEdit={canChangeRecords} online={online || currentClinicId === 'demo-clinic'} isCurrent={followUpIsCurrent}
           load={loadFollowUps} subscribe={currentClinicId === 'demo-clinic' ? undefined : watchFollowUps}
           onContact={handleFollowUpContact} onOpenPatient={openAppointmentPatient} onBack={() => navigateTo('dashboard')}
        /> : null;
      case 'dashboard':
      default:
        return (
          <><DashboardHome
            patients={patients}
            inventory={inventory}
            consultations={consultations}
            chronologicalConsultations={clinicPages.state.consultations.chronological}
            appointments={appointments.rows}
            onToggleStatus={toggleConsultationStatus}
            partialData={currentClinicId !== 'demo-clinic'}
            clinicName={currentClinicName}
            canEdit={canChangeRecords}
            canOpenClose={canOpenClose}
            canOpenFollowUps={canReadClinic}
            canOpenStockAlerts={canReadClinic}
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
          <ConsultationHistory rows={consultations}
            status={currentClinicId === 'demo-clinic' ? undefined : clinicPages.state.consultations}
            onLoad={() => void clinicPages.load('consultations')}
            canEdit={canChangeRecords} onToggleStatus={toggleConsultationStatus} /></>
        );
      case 'appointments':
        return currentClinicId ? <AppointmentsView
          key={JSON.stringify([currentClinicId, sessionUser?.uid, workspaceGeneration])}
          {...appointments} patients={patients} canEdit={canChangeRecords}
          isDemo={sessionUser?.isDemo === true} online={online} clinicId={currentClinicId}
          searchQuery={searchQuery} onWindow={appointments.changeWindow} onLoad={appointments.load}
          onSave={saveAppointmentFromEditor} onOpenPatient={openAppointmentPatient}
          onRecordTreatment={openAppointmentTreatment}
          assistantEnabled={assistantCanEdit}
          assistantReview={assistantReview}
        /> : null;
      case 'patients':
        return (
          <PatientRecordsView 
            key={`${currentClinicId}:${patientToOpen?.id ?? ''}`}
            initialPatientId={patientToOpen?.id}
            initialPatient={patientToOpen ?? undefined}
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
            billingGateway={billingGateway}
            onSaveConsultation={saveConsultationRecord}
            onDeletePatient={deletePatientRecord}
            onToggleStatus={toggleConsultationStatus}
            triggerToast={notifyCurrentWorkspace}
            patientSearch={currentClinicId && canReadClinic ? {
              scopeKey: clinicScanKey, online: clinicScanOnline, isCurrent: clinicScanIsCurrent,
              load: async after => currentClinicId === 'demo-clinic'
                ? loadDemoClinicScanPage(patients, patient => patient.id, after)
                : loadClinicScanPage(currentClinicId, 'patients', after),
              loadPatient: async (id, stillOpen) => {
                const patient = await loadAppointmentPatient(id, stillOpen);
                if (patient && stillOpen()) setTreatmentLink(null);
                return patient;
              },
            } : undefined}
            paging={currentClinicId === 'demo-clinic' ? undefined : {
              active: clinicPages.state.activePatients,
              discharged: clinicPages.state.dischargedPatients,
              load: kind => void clinicPages.load(kind === 'Active' ? 'activePatients' : 'dischargedPatients')
            }}
            consultationPaging={currentClinicId === 'demo-clinic' ? undefined : {
              status: clinicPages.state.consultations, load: () => void clinicPages.load('consultations')
            }}
            canEdit={canChangeRecords}
            staffUid={sessionUser?.uid ?? 'demo-user'}
            staffName={sessionUser?.displayName || 'Clinic staff'}
          />
        );
      case 'inventory':
        if (clinicPages.state.inventory?.accessDenied) {
          return <p role="alert" className="rounded-xl border border-danger-stroke bg-danger-wash p-3 text-sm text-danger-text-deep">
            {clinicPages.state.inventory.error}
          </p>;
        }
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
            stockAlerts={currentClinicId && canReadClinic ? <StockAlerts
              key={clinicScanKey} online={clinicScanOnline} isCurrent={clinicScanIsCurrent}
              load={async after => currentClinicId === 'demo-clinic'
                ? loadDemoClinicScanPage(inventory, item => item.itemCode, after)
                : loadClinicScanPage(currentClinicId, 'inventory', after)}
            /> : undefined}
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
          {currentClinicId && currentClinicId !== 'demo-clinic' && currentClinicRole &&
            <ImageStorageControls key={currentClinicId} clinicId={currentClinicId} online={online} />}
          <SystemSettingsView
            key={JSON.stringify([currentClinicId, sessionUser?.uid, workspaceGeneration])}
            inventory={inventory}
            onAddInventoryItem={createInventoryItem}
            aiEnabled={aiEnabled}
            canManageAI={canChangeRecords}
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
            key={JSON.stringify([currentClinicId, sessionUser?.uid, workspaceGeneration])}
            clinicId={currentClinicId}
            clinicName={currentClinicName}
            user={sessionUser}
            role={currentClinicRole}
            isDemo={sessionUser?.isDemo ?? false}
            isCurrent={followUpIsCurrent}
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
            triggerToast={notifyCurrentWorkspace}
          />
        ) : null;
      case 'audit':
        return currentClinicId && currentClinicId !== 'demo-clinic' && currentClinicRole
          ? <AuditLogView key={currentClinicId} clinicId={currentClinicId} searchQuery={searchQuery} />
          : <p>Audit events are available to members of a connected clinic.</p>;
    }
  };
    const handleLogout = async () => {
      if (leaving.current) return;
      leaving.current = true;
      setLoggingOut(true);
      mutationScope.invalidate();
      const clinicId = currentClinicId;
      pendingBilling.current.clear();

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
      const demo = demoBilling.current;
      demoBilling.current = null;
      if (clinicId === 'demo-clinic' && demo) {
        setPatients(rows => rows.map(row => {
          const original = demo.startingBalances.get(row.id);
          return original ? { ...row, ...original, billing: undefined } : row;
        }));
        setInventory(rows => rows.map(row => {
          const change = demo.stockDeltas.get(row.itemCode);
          return change === undefined ? row : { ...row, stock: Math.max(0, row.stock - change), billingStockEntryId: undefined };
        }));
      } else if (clinicId !== 'demo-clinic') {
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
    <div className="flex min-h-0 flex-1 overflow-hidden bg-canvas font-sans">
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

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Header
          toggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          currentClinicRole={currentClinicRole}
          onRecordVisit={handleRecordVisit}
          canEdit={canChangeRecords}
          assistantAction={assistantAllowed ? <WorkspaceAssistant
            key={assistantScopeKey} schedule={assistantSchedule} canEdit={assistantCanEdit}
            onNavigate={navigateTo} onReview={reviewAssistantReschedule}
            onCountInventory={countAssistantInventory}
            onClinicQuery={!isDemoWorkspace && workspaceAIPreviewAvailable() ? chatWithClinicQuery : undefined}
            onDailyBriefing={!isDemoWorkspace && workspaceAIPreviewAvailable() ? briefingForClinic : undefined}
            onLookup={!isDemoWorkspace && assistantToolEndpoint(assistantWorker) ? lookupAssistantTool : undefined}
            onOpenPerson={openAssistantPerson}
          /> : undefined}
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
