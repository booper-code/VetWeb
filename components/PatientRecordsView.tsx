"use client";

import React, { useState } from 'react';
import { PawPrint, TestTube, Search, Activity, User, Sparkles, FileSpreadsheet, PlusCircle, X, ZoomIn, CreditCard, Stethoscope, Trash2, Download, Loader2 } from 'lucide-react';
import type { InventoryItem, PatientBillableItem, PatientRecord, Consultation, ConsultationDraft } from '@/types';
import { compressImageFileToBlob, PROFILE_IMAGE_OPTIONS, DOCUMENT_IMAGE_OPTIONS } from '@/lib/images';
import { imageStorageConfigured, openStoredImage, uploadPatientImage } from '@/lib/imageStore';
import { StoredImage } from '@/components/StoredImage';
import { exportPatientsPdf } from '@/lib/pdf';
import { PageControls } from '@/components/PageControls';
import { WorkspaceModeStrip } from '@/components/WorkspaceModeStrip';
import { ClinicalActivity } from '@/components/ClinicalActivity';
import type { PageStatus } from '@/lib/useClinicPages';

type PendingImage = { blob: Blob; previewUrl: string };

export const PatientRecordsView = ({
  initialPatientId,
  initialTreatmentLink,
  patients, 
  consultations,
  inventory,
  clinicId,
  clinicName,
  aiEnabled,
  searchQuery,
  onCreatePatient,
  onUpdatePatient,
  onSaveBilling,
  onSaveConsultation,
  onDeletePatient,
  triggerToast,
  paging,
  canEdit = true,
  mode = 'quick',
  staffUid = '',
  staffName = ''
}: {
  initialPatientId?: string;
  initialTreatmentLink?: { patientId: string; appointmentId: string; occurredAt: string } | null;
  patients: PatientRecord[]; 
  consultations: Consultation[];
  inventory: InventoryItem[];
  clinicId: string | null;
  clinicName: string;
  aiEnabled: boolean;
  onCreatePatient: (name: string, species: string, breed: string, gender: PatientRecord['gender'], owner: string, contact: string, weight: number, admissionTypes: string[], reason: string, pictures?: string[]) => Promise<boolean>;
  onUpdatePatient: (record: PatientRecord) => Promise<boolean>;
  searchQuery: string;
  onSaveBilling: (patient: PatientRecord, inventory: InventoryItem[]) => Promise<boolean>;
  onSaveConsultation: (patient: PatientRecord, draft: ConsultationDraft) => Promise<boolean>;
  onDeletePatient: (id: string) => Promise<boolean>;
  onToggleStatus: (id: string) => void;
  triggerToast: (msg: string) => void;
  paging?: { active: PageStatus; discharged: PageStatus; load: (kind: 'Active' | 'Discharged') => void };
  canEdit?: boolean;
  mode?: 'quick' | 'advanced';
  staffUid?: string;
  staffName?: string;
}) => {
  const [isExporting, setIsExporting] = useState(false);
  const [isSavingPatient, setIsSavingPatient] = useState(false);
  const [pendingImages, setPendingImages] = useState(0);

  const handleExportPdf = async () => {
    setIsExporting(true);
    try {
      await exportPatientsPdf({ clinicName, patients, consultations });
      triggerToast('Patient records PDF exported.');
    } catch (error) {
      console.error('[Patients] PDF export failed:', error);
      triggerToast('Could not export the patient records PDF.');
    } finally {
      setIsExporting(false);
    }
  };

  // Form State
// Form State
  const [name, setName] = useState('');
  const [species, setSpecies] = useState('Canine');
  const [breed, setBreed] = useState('');
  const [gender, setGender] = useState<'Male' | 'Female' | 'Unknown'>('Male'); // FIXED: Explicit union type  

  // FIXED: Renamed from owner -> ownerName and contact -> ownerContact
  const [ownerName, setOwnerName] = useState('');
  const [ownerContact, setOwnerContact] = useState('');
  
  const [weight, setWeight] = useState<number | string>('');
  const [reason, setReason] = useState('');
  const [selectedAdmissions, setSelectedAdmissions] = useState<string[]>(['Medical Checkup']);
  
  const [newPatientImage, setNewPatientImage] = useState<PendingImage | null>(null);
  const [showFullReport, setShowFullReport] = useState(() =>
    patients.some(patient => patient.id === initialPatientId));

  // FIXED: Declared missing constant
  const admissionOptions = ['Grooming', 'Medical Checkup', 'Surgery', 'Confinement'];

  // Drawer & Verification State
  const [selectedPatientSnapshot, setSelectedPatient] = useState<PatientRecord | null>(() =>
    patients.find(patient => patient.id === initialPatientId) ?? null);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<PatientRecord | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [patientDirectoryFilter, setPatientDirectoryFilter] = useState<'Active' | 'Discharged'>(() =>
    patients.find(patient => patient.id === initialPatientId)?.status === 'Discharged' ? 'Discharged' : 'Active');
  const selectedPatient = selectedPatientSnapshot && !isEditing
    ? patients.find(patient => patient.id === selectedPatientSnapshot.id) ?? selectedPatientSnapshot
    : selectedPatientSnapshot;
  // Billing Module Calculation States

  // Payables / Dossier Billing State
  const [billableSearchQuery, setBillableSearchQuery] = useState('');
  const [selectedBillables, setSelectedBillables] = useState<Record<string, number>>({});
  const sanitizePhoneNumber = (value: string) => {
    return value.replace(/\D/g, '').slice(0, 15);
  };

  const isValidName = (value: string) => {
    return /^[A-Za-zÀ-ÿ .'-]{2,}$/.test(value.trim());
  };

  const isValidPhoneNumber = (value: string) => {
    return /^\d{10,15}$/.test(value);
  };
  const handleNewPatientImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const input = e.target;
    setPendingImages(count => count + 1);

    try {
      const image = await compressImageFileToBlob(file, PROFILE_IMAGE_OPTIONS);
      setNewPatientImage({ blob: image.blob, previewUrl: image.previewUrl });
    } catch (err) {
      console.error('[Images] Failed to encode patient photo', err);
      triggerToast("Could not read that image. Try a JPG or PNG file.");
    } finally {
      setPendingImages(count => count - 1);
      input.value = '';
    }
  };
  const handleEditProfilePictureUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editForm) return;
    const input = e.target;
    setPendingImages(count => count + 1);

    try {
      const image = await compressImageFileToBlob(file, PROFILE_IMAGE_OPTIONS);
      const key = await uploadPatientImage({
        clinicId,
        patientId: editForm.id,
        blob: image.blob
      });

      setEditForm((prev) => {
        if (!prev) return prev;

        const existingPictures = prev.pictures || [];

        return {
          ...prev,
          profilePicture: key,
          pictures:
            existingPictures.length > 0
              ? [key, ...existingPictures.slice(1)]
              : [key]
        };
      });
    } catch (err) {
      console.error('[Images] Failed to upload profile picture', err);
      triggerToast(err instanceof Error ? err.message : "Could not read that image. Try a JPG or PNG file.");
    } finally {
      setPendingImages(count => count - 1);
      input.value = '';
    }
  };
  const handleLabImageUpload = async (labId: string, file: File) => {
    if (!editForm) return;
    setPendingImages(count => count + 1);

    try {
      const image = await compressImageFileToBlob(file, DOCUMENT_IMAGE_OPTIONS);
      const key = await uploadPatientImage({
        clinicId,
        patientId: editForm.id,
        blob: image.blob
      });

      setEditForm(prev => {
        if (!prev) return prev;
        const labResults = [...(prev.labResults || [])];
        const index = labResults.findIndex(lab => lab.id === labId);
        if (index < 0) return prev;
        labResults[index] = { ...labResults[index], imageUrl: key };
        return { ...prev, labResults };
      });
    } catch (err) {
      console.error('[Images] Failed to upload lab printout', err);
      triggerToast(err instanceof Error ? err.message : "Could not read that image. Try a JPG or PNG file.");
    } finally {
      setPendingImages(count => count - 1);
    }
  };

  const toggleAdmission = (type: string) => {
    if (selectedAdmissions.includes(type)) {
      setSelectedAdmissions(selectedAdmissions.filter(t => t !== type));
    } else {
      setSelectedAdmissions([...selectedAdmissions, type]);
    }
  };

const handleAdmitPatient = async (e: React.FormEvent) => {
  e.preventDefault();
  if (isSavingPatient || pendingImages) return;

  const trimmedName = name.trim();
  const trimmedBreed = breed.trim();
  const trimmedOwnerName = ownerName.trim();
  const cleanedContact = sanitizePhoneNumber(ownerContact);
  const weightNumber = Number(weight);

  if (!trimmedName || !trimmedBreed || !trimmedOwnerName || !cleanedContact || !weight || selectedAdmissions.length === 0) {
    triggerToast("Please complete all required patient admission fields.");
    return;
  }

  if (!isValidName(trimmedName)) {
    triggerToast("Patient name should contain letters only and be at least 2 characters.");
    return;
  }

  if (!isValidName(trimmedOwnerName)) {
    triggerToast("Owner name should contain letters only and be at least 2 characters.");
    return;
  }

  if (!isValidPhoneNumber(cleanedContact)) {
    triggerToast("Owner contact number must contain 10 to 15 digits only.");
    return;
  }

  if (!weightNumber || weightNumber <= 0 || weightNumber > 200) {
    triggerToast("Weight must be a valid number between 0.1 and 200 kg.");
    return;
  }

  setIsSavingPatient(true);
  try {
  const pictures: string[] = [];
  if (newPatientImage) {
    try {
      pictures.push(
        await uploadPatientImage({
          clinicId,
          patientId: 'unassigned',
          blob: newPatientImage.blob
        })
      );
    } catch (error) {
      console.error('[Images] Failed to upload patient photo', error);
      triggerToast(error instanceof Error ? error.message : 'Could not upload the patient photo.');
      return;
    }
  }

  const saved = await onCreatePatient(
    trimmedName,
    species,
    trimmedBreed,
    gender,
    trimmedOwnerName,
    cleanedContact,
    weightNumber,
    selectedAdmissions,
    reason.trim(),
    pictures
  );
  if (!saved) return;

  // Reset form states completely
  setName('');
  setBreed('');
  setOwnerName('');
  setOwnerContact('');
  setWeight('');
  setReason('');
  setSelectedAdmissions(['Medical Checkup']);
  setNewPatientImage(null);
  } finally {
    setIsSavingPatient(false);
  }
};
  
  const handleEditChange = (field: keyof PatientRecord, value: PatientRecord[keyof PatientRecord]) => {
    if (editForm) {
      setEditForm({ ...editForm, [field]: value });
    }
  };

  const billableCatalog = inventory.filter(item =>
    item.category === 'Medicine' ||
    item.category === 'Service' ||
    item.category === 'Grooming'
  );

  const filteredBillableCatalog = billableCatalog.filter(item => {
    const q = billableSearchQuery.toLowerCase().trim();

    if (!q) return true;

    return (
      item.itemName.toLowerCase().includes(q) ||
      item.itemCode.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q)
    );
  });

  const toggleBillableSelection = (item: InventoryItem) => {
    setSelectedBillables(prev => {
      const next = { ...prev };

      if (next[item.itemCode]) {
        delete next[item.itemCode];
      } else {
        next[item.itemCode] = 1;
      }

      return next;
    });
  };

  const updateBillableQuantity = (itemCode: string, quantity: number) => {
    setSelectedBillables(prev => ({
      ...prev,
      [itemCode]: Math.max(1, quantity || 1)
    }));
  };

  const selectedBillableDetails = Object.entries(selectedBillables)
    .map(([itemCode, quantity]) => {
      const item = inventory.find(inv => inv.itemCode === itemCode);
      if (!item) return null;

      return {
        item,
        quantity,
        unitPrice: item.sellingPrice,
        total: item.sellingPrice * quantity
      };
    })
    .filter(Boolean) as {
      item: InventoryItem;
      quantity: number;
      unitPrice: number;
      total: number;
    }[];

  const billableSubtotal = selectedBillableDetails.reduce(
    (sum, entry) => sum + entry.total,
    0
  );

  const applyBillablesToPatient = async () => {
    if (!canEdit || isSavingPatient || !selectedPatient || selectedBillableDetails.length === 0) return;
    if (selectedBillableDetails.some(entry => !Number.isSafeInteger(entry.quantity) || entry.quantity < 1 ||
      !Number.isFinite(entry.unitPrice) || entry.unitPrice < 0 ||
      ((entry.item.category === 'Medicine' || entry.item.category === 'Supplies') && entry.quantity > entry.item.stock))) {
      triggerToast('Choose whole positive quantities within available stock. Nothing was saved.');
      return;
    }
    const stockChanges = selectedBillableDetails
      .filter(entry => entry.item.category === 'Medicine' || entry.item.category === 'Supplies')
      .map(entry => ({ ...entry.item, stock: entry.item.stock - entry.quantity }));

    // ✅ STEP 2: Create billable records
    const newBillableItems: PatientBillableItem[] = selectedBillableDetails.map(entry => ({
      id: `BILL-${Date.now()}-${entry.item.itemCode}`,
      itemCode: entry.item.itemCode,
      itemName: entry.item.itemName,
      category: entry.item.category,
      quantity: entry.quantity,
      unitPrice: entry.unitPrice,
      total: entry.total,
      date: new Date().toLocaleDateString()
    }));

    // ✅ STEP 3: Update patient balance
    const updatedRecord: PatientRecord = {
      ...selectedPatient,
      balance: selectedPatient.balance + billableSubtotal,
      billableItems: [
        ...(selectedPatient.billableItems || []),
        ...newBillableItems
      ]
    };

    setIsSavingPatient(true);
    let saved = false;
    try { saved = await onSaveBilling(updatedRecord, stockChanges); }
    finally { setIsSavingPatient(false); }
    if (!saved) return;
    setSelectedPatient(updatedRecord);

    // ✅ STEP 4: Reset UI
    setSelectedBillables({});
    setBillableSearchQuery('');

    triggerToast(`Added PHP ${billableSubtotal.toFixed(2)} to patient payables.`);
  };
  const removeBillableFromPatient = async (billableItem: PatientBillableItem) => {
    if (!canEdit || isSavingPatient || !selectedPatient) return;

    const confirmed = window.confirm(
      `Remove "${billableItem.itemName}" from this patient's billing history?`
    );

    if (!confirmed) return;

    const stockChanges: InventoryItem[] = [];
    if (billableItem.category === 'Medicine' || billableItem.category === 'Supplies') {
      const inventoryItem = inventory.find(
        item => item.itemCode === billableItem.itemCode
      );

      if (inventoryItem) {
        const restoredItem: InventoryItem = {
          ...inventoryItem,
          stock: inventoryItem.stock + billableItem.quantity
        };

        stockChanges.push(restoredItem);
      } else {
        triggerToast('Load the referenced inventory item before removing this stock-linked bill. Nothing was changed.');
        return;
      }
    }

    const updatedBillableItems = (selectedPatient.billableItems || []).filter(
      item => item.id !== billableItem.id
    );

    const updatedRecord: PatientRecord = {
      ...selectedPatient,
      balance: Math.max(0, selectedPatient.balance - billableItem.total),
      billableItems: updatedBillableItems
    };

    setIsSavingPatient(true);
    let saved = false;
    try { saved = await onSaveBilling(updatedRecord, stockChanges); }
    finally { setIsSavingPatient(false); }
    if (!saved) return;
    setSelectedPatient(updatedRecord);

    triggerToast(`Removed ${billableItem.itemName} from billing history.`);
  };


const searchedPatients = patients.filter((pat) => {
  const q = searchQuery.toLowerCase();

  return (
    pat.name.toLowerCase().includes(q) ||
    pat.ownerName.toLowerCase().includes(q) ||
    pat.id.toLowerCase().includes(q) ||
    pat.species.toLowerCase().includes(q) ||
    pat.breed.toLowerCase().includes(q)
  );
});

const activePatients = searchedPatients.filter(
  (pat) => pat.status !== 'Discharged'
);

const dischargedPatients = searchedPatients.filter(
  (pat) => pat.status === 'Discharged'
);

const visiblePatients =
  patientDirectoryFilter === 'Active'
    ? activePatients
    : dischargedPatients;


  return (
    <div className="space-y-6 relative">
      {!canEdit && <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        Read-only workspace. Changes require an online owner or editor.
      </p>}
      <WorkspaceModeStrip mode={mode} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-ink">
            Admission &amp; Patient Records
          </h2>
          <p className="font-medium text-muted">
            Unifies client cards, patient profiles, and workflow tagging in one screen.
            {paging && ' Search and PDF exports cover loaded records only.'}
          </p>
        </div>
        <button
          type="button"
          onClick={handleExportPdf}
          disabled={isExporting || patients.length === 0}
          className="vc-btn ml-auto"
        >
          {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Export {paging ? 'loaded records ' : ''}PDF
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        {/* --- LEFT COLUMN: ADMISSION FORM --- */}
        <div className="h-fit rounded-[14px] border border-line bg-white p-6 shadow-[0_2px_10px_#243e5607]">
          <h3 className="mb-4 flex items-center gap-2 text-lg font-bold text-ink">
            <Activity className="w-5 h-5 text-accent" />
            Add Patient
          </h3>

          <form onSubmit={handleAdmitPatient} className="space-y-4">
            <fieldset disabled={!canEdit || isSavingPatient} className="contents">
            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">
                Patient Name *
              </label>
              <input
                type="text"
                required
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none font-bold"
                placeholder="e.g. Buster"
                value={name}
                onChange={e => setName(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  Species
                </label>
                <select
                  className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-900 outline-none"
                  value={species}
                  onChange={e => setSpecies(e.target.value)}
                >
                  <option value="Canine">Canine</option>
                  <option value="Feline">Feline</option>
                  <option value="Avian">Avian</option>
                  <option value="Exotic">Exotic</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  Breed
                </label>
                <input
                  type="text"
                  className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 outline-none"
                  placeholder="e.g. Aspin"
                  value={breed}
                  onChange={e => setBreed(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  Weight (kg)
                </label>
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="200"
                  className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 outline-none"
                  placeholder="0.0"
                  value={weight}
                  onChange={e => {
                    const value = e.target.value;
                    setWeight(value === '' ? '' : Math.max(0, Number(value)));
                  }}
                />
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  Gender
                </label>
                <select
                  className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-900 outline-none"
                  value={gender}
                  onChange={e =>
                    setGender(e.target.value as 'Male' | 'Female' | 'Unknown')
                  }
                >
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Unknown">Unknown</option>
                </select>
              </div>
            </div>
            <div className="border-t border-slate-100 pt-4 space-y-3">
              <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
                Patient Profile Image
              </h4>

              <div className="flex items-center gap-4">
                <div className="w-20 h-20 rounded-2xl border border-slate-200 bg-slate-50 overflow-hidden flex items-center justify-center shrink-0">           
                  {newPatientImage ? (
                    <StoredImage
                      value={newPatientImage.previewUrl}
                      alt="Patient preview"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <PawPrint className="w-8 h-8 text-slate-300" />
                  )}
                </div>


                <div className="flex-1 space-y-2">
                  <input
                    type="file"
                    id="newPatientImageUpload"
                    accept="image/*"
                    className="hidden"
                    disabled={isSavingPatient || pendingImages > 0}
                    onChange={handleNewPatientImageUpload}
                  />

                  <label
                    htmlFor="newPatientImageUpload"
                    className="vc-btn vc-btn-primary cursor-pointer text-xs"
                  >
                    <PlusCircle className="w-4 h-4" />
                    {newPatientImage ? 'Change Patient Photo' : 'Upload Patient Photo'}
                  </label>

                  {newPatientImage && (
                    <button
                      type="button"
                      onClick={() => setNewPatientImage(null)}
                      className="ml-2 inline-flex items-center justify-center gap-2 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-xs font-bold px-4 py-2.5 rounded-xl transition-all"
                    >
                      <Trash2 className="w-4 h-4" />
                      Remove
                    </button>
                  )}

                  <p className="text-[10px] text-slate-400 font-medium">
                    Optional. This image will appear as the patient avatar in the directory and dossier.
                  </p>
                </div>
              </div>
            </div>
            <div className="border-t border-slate-100 pt-3 space-y-3">
              <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
                Owner Contact Details
              </h4>

              <input
                type="text"
                required
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-900 outline-none"
                placeholder="Guardian Name *"
                value={ownerName}
                onChange={e => setOwnerName(e.target.value)}
              />

              <input
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                required
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 outline-none"
                placeholder="Phone Number *"
                value={ownerContact}
                onChange={e => setOwnerContact(sanitizePhoneNumber(e.target.value))}
              />
            </div>

            <div className="border-t border-slate-100 pt-3 space-y-2">
              <label className="text-xs font-bold text-slate-700 block">
                Admission Purpose *
              </label>

              <div className="flex flex-wrap gap-1.5">
                {admissionOptions.map(option => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => toggleAdmission(option)}
                    className={`px-3 py-1 rounded-full text-[10px] font-bold border transition-all ${
                      selectedAdmissions.includes(option)
                        ? 'bg-teal-600 text-white border-teal-600 shadow-sm'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-teal-300'
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">
                Chief Complaint
              </label>
              <textarea
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 outline-none h-16 resize-none"
                placeholder="Clinical symptoms..."
                value={reason}
                onChange={e => setReason(e.target.value)}
              />
            </div>

            <button
              type="submit"
              disabled={isSavingPatient || pendingImages > 0}
              className="vc-btn vc-btn-primary w-full py-3 text-xs"
            >
              Admit Patient to Directory
            </button>
            </fieldset>
          </form>
        </div>

        {/* --- RIGHT COLUMN: ACTIVE DIRECTORY TABLE --- */}
<div className="flex h-fit flex-col overflow-hidden rounded-[14px] border border-line bg-white shadow-[0_2px_10px_#243e5607] xl:col-span-2">
  <div className="p-6 border-b border-slate-200 bg-slate-50/50 space-y-4">
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div>
        <h3 className="text-lg font-bold text-ink">
          Patient Directory
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          Filter admissions between active patients and discharged records.
        </p>
      </div>

      <span className="text-xs font-bold text-slate-500 bg-slate-200 px-3 py-1 rounded-full w-fit">
        {visiblePatients.length} Records
      </span>
    </div>

    <div className="flex flex-wrap gap-2">
      {(['Active', 'Discharged'] as const).map((filter) => (
        <button
          key={filter}
          type="button"
          onClick={() => {
            setPatientDirectoryFilter(filter);
            if (paging && filter === 'Discharged' && !paging.discharged.loaded) paging.load(filter);
          }}
          className={`px-4 py-2 rounded-xl text-xs font-bold border transition-all ${
            patientDirectoryFilter === filter
              ? 'border-accent bg-accent text-white shadow-sm'
              : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
          }`}
        >
          {filter === 'Active'
            ? `Active (${activePatients.length})`
            : `Discharged (${dischargedPatients.length})`}
        </button>
      ))}
    </div>
  </div>
          {paging && <PageControls label={patientDirectoryFilter === 'Active' ? 'active patients' : 'discharged patients'}
            status={patientDirectoryFilter === 'Active' ? paging.active : paging.discharged}
            onLoad={() => paging.load(patientDirectoryFilter)} />}

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-[10px] font-black tracking-wider uppercase border-b border-slate-200">
                  <th className="p-4">Patient Profile</th>
                  <th className="p-4">Admission Tags</th>
                  <th className="p-4">Status</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 text-sm">
                {visiblePatients.map((pat) => (
                  <tr
                    key={pat.id}
                    className="hover:bg-slate-50/80 transition-colors cursor-pointer group"
                    onClick={() => {
                      setSelectedPatient(pat);
                      setIsEditing(false);
                      setShowFullReport(true);
                    }}
                  >
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl border border-slate-200 overflow-hidden bg-slate-100 flex items-center justify-center flex-shrink-0">
                          {pat.profilePicture || pat.pictures?.[0] ? (
                            <StoredImage
                              value={pat.profilePicture || pat.pictures?.[0]}
                              alt={pat.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <PawPrint className="w-5 h-5 text-teal-600" />
                          )}
                        </div>

                        <div>
                          <p className="font-bold text-slate-900 group-hover:text-teal-600 transition-colors">
                            {pat.name}
                          </p>
                          <p className="text-xs text-slate-400 font-medium">
                            {pat.species} • {pat.breed}
                          </p>
                          <p className="text-[10px] text-slate-400 uppercase mt-0.5">
                            Owner: {pat.ownerName}
                          </p>
                        </div>
                      </div>
                    </td>

                    <td className="p-4">
                      <div className="flex flex-wrap gap-1">
                        {(pat.admissionTypes || pat.tags || ['Medical Checkup']).map(
                          (type: string, i: number) => (
                            <span
                              key={i}
                              className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200"
                            >
                              {type}
                            </span>
                          )
                        )}
                      </div>
                    </td>

                    <td className="p-4">
                      <span
                        className={`inline-flex px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider border ${
                          pat.status === 'Ready for Pickup' ||
                          pat.status === 'Discharged'
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : pat.status === 'Confined' ||
                              pat.status === 'Waiting'
                            ? 'bg-amber-50 text-amber-700 border-amber-200'
                            : 'bg-blue-50 text-blue-700 border-blue-200'
                        }`}
                      >
                        {pat.status}
                      </span>
                    </td>
                  </tr>
                ))}

                {visiblePatients.length === 0 && (
                  <tr>
                    <td colSpan={3} className="p-12 text-center text-slate-400">
                      <PawPrint className="w-8 h-8 mx-auto mb-2 opacity-20" />
                      No {patientDirectoryFilter.toLowerCase()} patients found in the directory.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>            
      {/* --- PURGED: SLIDE OUT DETAILED PROFILE DRAWER HAS BEEN REMOVED TO PREVENT UI LEAKAGE --- */}
      {/* --- CLINICAL DOSSIER FULL REPORT MODAL --- */}
      {showFullReport && selectedPatient && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-md flex justify-center p-4 md:p-10">
          <div className="relative w-full max-w-5xl bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col my-auto max-h-[90vh]">
            
            {/* Modal Header */}
            <div className="bg-slate-900 text-white px-8 py-5 flex items-center justify-between sticky top-0 z-10 border-b border-slate-800">
              <div className="flex items-center gap-3">
                <Activity className="w-6 h-6 text-teal-400" />
                <div>
                  <h2 className="text-xl font-bold tracking-wide">
                    {isEditing ? `Editing Dossier: ${selectedPatient.name}` : 'Patient Clinical Dossier'}
                  </h2>
                  <p className="text-xs text-slate-400">Veterinary SOAP Report • Biñan Animal Practice System</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!isEditing && (
                  <button 
                    type="button"
                    onClick={() => window.print()}
                    className="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 border border-slate-700"
                  >
                    <FileSpreadsheet className="w-4 h-4" /> Print / Export
                  </button>
                )}
                <button 
                  type="button"
                  aria-label="Close dossier"
                  disabled={isSavingPatient || pendingImages > 0}
                  onClick={() => {
                    setShowFullReport(false);
                    setIsEditing(false);
                    setSelectedPatient(null);
                  }}
                  className="bg-teal-500 hover:bg-teal-600 text-slate-950 font-bold p-2.5 rounded-full transition-all"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Dossier Report Body */}
            <div className="flex-1 overflow-y-auto p-8 space-y-6 bg-slate-50 text-slate-800">
              
              {isEditing && editForm ? (
                // ==========================================
                // --- EDIT MODE VIEW ---
                // ==========================================
                <fieldset disabled={!canEdit || isSavingPatient} className="space-y-6 animate-in fade-in duration-200">
                  {/* Patient Profile Picture Editor */}
                <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                    <PawPrint className="w-4 h-4" />
                    Patient Profile Picture
                  </h3>

                  <div className="flex items-center gap-4">
                    <div className="w-24 h-24 rounded-2xl border border-slate-200 bg-slate-50 overflow-hidden flex items-center justify-center shrink-0">
                      {editForm.profilePicture || editForm.pictures?.[0] ? (
                        <StoredImage
                          value={editForm.profilePicture || editForm.pictures?.[0]}
                          alt={`${editForm.name} profile`}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <PawPrint className="w-10 h-10 text-slate-300" />
                      )}
                    </div>

                    <div className="flex-1 space-y-2">
                      <input
                        type="file"
                        id="editPatientProfilePictureUpload"
                        accept="image/*"
                        className="hidden"
                        disabled={isSavingPatient || pendingImages > 0}
                        onChange={handleEditProfilePictureUpload}
                      />

                      <label
                        htmlFor="editPatientProfilePictureUpload"
                        className="vc-btn vc-btn-primary cursor-pointer text-xs"
                      >
                        <PlusCircle className="w-4 h-4" />
                        {editForm.profilePicture || editForm.pictures?.[0]
                          ? 'Change Profile Picture'
                          : 'Upload Profile Picture'}
                      </label>

                      {(editForm.profilePicture || editForm.pictures?.[0]) && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditForm(prev =>
                              prev ? { ...prev, profilePicture: '', pictures: [] } : prev
                            );
                          }}
                          className="ml-2 inline-flex items-center justify-center gap-2 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-xs font-bold px-4 py-2.5 rounded-xl transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                          Remove
                        </button>
                      )}

                      <p className="text-[10px] text-slate-400 font-medium">
                        This image appears in the patient directory and clinical dossier after saving.
                        {!imageStorageConfigured() &&
                          ' Cloud image storage is not configured, so the photo stays inside the patient record.'}
                      </p>
                    </div>
                  </div>
                </div>
                  {/* TOP: Core Demographics & Owner Details */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm md:col-span-1 space-y-4">
                      <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5 mb-2">
                        <PawPrint className="w-4 h-4 text-slate-400" /> Patient Info
                      </h4>
                      <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Name</label>
                        <input type="text" className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold text-slate-900 outline-none" value={editForm.name} onChange={e => handleEditChange('name', e.target.value)} />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                         <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Species</label>
                          <select className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-900 outline-none" value={editForm.species} onChange={e => handleEditChange('species', e.target.value)}>
                            <option value="Canine">Canine</option>
                            <option value="Feline">Feline</option>
                            <option value="Avian">Avian</option>
                            <option value="Exotic">Exotic</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Breed</label>
                          <input type="text" className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-900 outline-none" value={editForm.breed} onChange={e => handleEditChange('breed', e.target.value)} />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Weight (kg)</label>
                          <input type="number" step="0.1" className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-900 outline-none" value={editForm.weight} onChange={e => handleEditChange('weight', parseFloat(e.target.value) || 0)} />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Gender</label>
                          <select className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-900 outline-none" value={editForm.gender} onChange={e => handleEditChange('gender', e.target.value)}>
                            <option value="Male">Male</option>
                            <option value="Female">Female</option>
                            <option value="Unknown">Unknown</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Admit Status</label>
                        <select className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-900 outline-none" value={editForm.status} onChange={e => handleEditChange('status', e.target.value)}>
                          <option value="Waiting">Waiting</option>
                          <option value="In Treatment">In Treatment</option>
                          <option value="Confined">Confined</option>
                          <option value="Ready for Pickup">Ready for Pickup</option>
                          <option value="Discharged">Discharged</option>
                        </select>
                      </div>
                    </div>

                    <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm md:col-span-2 space-y-4">
                      <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5 mb-2">
                        <User className="w-4 h-4 text-slate-400" /> Owner & Contact Info
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Authorized Guardian</label>
                          <input type="text" className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold text-slate-900 outline-none" value={editForm.ownerName} onChange={e => handleEditChange('ownerName', e.target.value)} />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Contact Number</label>
                          <input
                            type="tel"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold text-slate-900 outline-none"
                            value={editForm.ownerContact}
                            onChange={e => handleEditChange('ownerContact', sanitizePhoneNumber(e.target.value))}
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Email Address</label>
                          <input type="email" className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold text-slate-900 outline-none" value={editForm.ownerEmail || ''} onChange={e => handleEditChange('ownerEmail', e.target.value)} />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Residence Address</label>
                          <input type="text" className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold text-slate-900 outline-none" value={editForm.ownerAddress || ''} onChange={e => handleEditChange('ownerAddress', e.target.value)} />
                        </div>
                      </div>

                      <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center justify-between mt-4">
                        <div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase block">Ledger Balance (PHP)</span>
                          <input type="number" step="0.01" className="w-32 p-1.5 bg-white border border-slate-200 rounded-lg text-sm font-black text-slate-800 outline-none" value={editForm.balance} onChange={e => handleEditChange('balance', parseFloat(e.target.value) || 0)} />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* SECTION 1: LAB RESULTS (Image First OCR Approach) */}
                  <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-4">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                      <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                        <TestTube className="w-4 h-4 text-teal-600" /> 1. Laboratory Printouts & Analytes
                      </h4>
                      <button 
                        type="button"
                        onClick={() => {
                          const newPanels = [...(editForm.labResults || []), { 
                            id: String(Date.now()),
                            testName: 'New Diagnostic Panel', 
                            date: new Date().toLocaleDateString(), 
                            imageUrl: '', 
                            metrics: {} 
                          }];
                          handleEditChange('labResults', newPanels);
                        }}
                        className="bg-teal-50 hover:bg-teal-100 text-teal-700 font-bold px-3 py-1 rounded-lg text-xs transition-colors border border-teal-200"
                      >
                        + Add Lab Printout
                      </button>
                    </div>

                    {editForm.labResults && editForm.labResults.length > 0 ? (
                      <div className="space-y-6">
                        {editForm.labResults.map((result, index) => (
                          <div key={result.id || index} className="p-5 rounded-2xl border border-slate-200 bg-slate-50/50 space-y-4 shadow-sm">
                            
                            {/* Panel Header */}
                            <div className="flex gap-3 items-center">
                              <input 
                                type="text"
                                className="flex-1 p-2 bg-white border border-slate-200 rounded-lg text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-teal-500"
                                value={result.testName}
                                onChange={(e) => {
                                  const updated = [...(editForm.labResults || [])];
                                  updated[index].testName = e.target.value;
                                  handleEditChange('labResults', updated);
                                }}
                                placeholder="Panel Name (e.g. Complete Blood Count)"
                              />
                              <input 
                                type="text"
                                className="w-32 p-2 bg-white border border-slate-200 rounded-lg text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-teal-500 text-right"
                                value={result.date}
                                onChange={(e) => {
                                  const updated = [...(editForm.labResults || [])];
                                  updated[index].date = e.target.value;
                                  handleEditChange('labResults', updated);
                                }}
                                placeholder="MM/DD/YYYY"
                              />
                              <button 
                                type="button"
                                onClick={() => {
                                  const filtered = (editForm.labResults || []).filter((_, i) => i !== index);
                                  handleEditChange('labResults', filtered);
                                }}
                                className="text-slate-400 hover:text-red-500 p-2 bg-white border border-slate-200 rounded-lg transition-colors"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>

                            {/* Image Dropzone & Metrics Split */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                              
                              {/* Left: Image Upload Area */}
                              <div className="col-span-1">
                                {result.imageUrl ? (
                                  <div className="relative w-full h-48 bg-slate-900 rounded-xl overflow-hidden group shadow-inner">
                                    <StoredImage value={result.imageUrl} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" alt="Lab Printout" />
                                    
                                    <button 
                                      type="button"
                                      onClick={() => {
                                        setEditForm(prev => {
                                          if (!prev) return prev;
                                          const updated = [...(prev.labResults || [])];
                                          if (!updated[index]) return prev;
                                          updated[index] = { ...updated[index], imageUrl: '' };
                                          return { ...prev, labResults: updated };
                                        });
                                      }} 
                                      className="absolute top-2 right-2 bg-red-500/90 text-white rounded-lg p-1.5 shadow backdrop-blur-sm hover:bg-red-600 transition-colors"
                                      title="Remove Image"
                                    >
                                      <X className="w-4 h-4"/>
                                    </button>

                                    {/* MOCK AI EXTRACTION BUTTON */}
                                    {aiEnabled && <button
                                      type="button"
                                      onClick={() => {
                                        if (typeof triggerToast === 'function') {
                                          triggerToast("Demo only: inserting example lab data, not analyzing this image.");
                                        }
                                        
                                        setTimeout(() => {
                                          const updated = [...(editForm.labResults || [])];
                                          updated[index].testName = "IDEXX HealthChek Plus (CHEM 25 w/ SDMA)";
                                          updated[index].metrics = {
                                            'ALP': '163 H (Ref: 5-160)',
                                            'BUN': '41 H (Ref: 9-31)',
                                            'CREA': '0.9 N (Ref: 0.5-1.5)',
                                            'BUN/CREA': '45.6 H',
                                            'HEMOLYSIS': '+++ (Gross)',
                                            'LIPEMIA': 'N (Gross Lipemia Flagged)'
                                          };
                                          handleEditChange('labResults', updated);
                                          
                                          const advancedAISummary = 
                                            "CRITICAL CLINICAL SYNTHESIS (AI CLINICAL SYNTHESIS):\n\n" +
                                            "1. HEPATOBILIARY ASSESSMENT:\n" +
                                            "   - ALP is mildly elevated at 163 U/L (Reference: 5-160 U/L).\n" +
                                            "   - CRUCIAL QUALITY FLAG: The sample exhibits severe hemolysis (Hemolysis Index: +++). Per laboratory controls, severe hemolysis can artificially suppress measured ALP by 25-50%. Therefore, the patient's true biological ALP activity is severely underestimated and likely ranges between 200–320 U/L. Clinical investigation for hepatobiliary pathology or drug-induced (steroid) induction is strongly recommended.\n\n" +
                                            "2. RENAL ARCHITECTURE & FLUID BALANCE:\n" +
                                            "   - BUN is elevated at 41 mg/dL (Reference: 9-31 mg/dL).\n" +
                                            "   - Creatinine is completely unremarkable at 0.9 mg/dL (Reference: 0.5-1.5 mg/dL).\n" +
                                            "   - The resulting BUN/Creatinine ratio is markedly high at 45.6.\n" +
                                            "   - CLINICAL INTERPRETATION: The lack of concurrent Creatinine elevation rules out primary renal failure. This presentation is strongly indicative of pre-renal azotemia, most commonly secondary to severe dehydration, recent high-protein meal ingestion, or gastrointestinal hemorrhage. This correlates with the Gross Lipemia notification requiring ultracentrifugation.\n\n" +
                                            "RECOMMENDED ACTION PIPELINE:\n" +
                                            "   - Initiate proactive fluid therapy to resolve potential pre-renal dehydration components.\n" +
                                            "   - Schedule a recheck chemistry panel utilizing a strictly fasted, unhemolyzed sample to get a true diagnostic baseline for ALP.";

                                          handleEditChange('aiLabSummary', advancedAISummary);
                                          
                                          if (typeof triggerToast === 'function') {
                                            triggerToast("Demo example inserted. Do not use it for clinical decisions.");
                                          }
                                        }, 1500);
                                      }} 
                                      className="absolute bottom-2 left-2 right-2 bg-purple-600/95 hover:bg-purple-500 text-white text-xs font-bold px-3 py-2 rounded-lg shadow-lg backdrop-blur-sm transition-colors flex justify-center items-center gap-2 border border-purple-400/50"
                                    >
                                      <Sparkles className="w-4 h-4 text-yellow-300"/> Demo extraction (example data)
                                    </button>}
                                  </div>
                                ) : (
                                  <label className="flex flex-col items-center justify-center w-full h-48 border-2 border-dashed border-slate-300 rounded-xl bg-white hover:bg-slate-50 cursor-pointer transition-colors group">
                                    <div className="bg-slate-100 p-3 rounded-full mb-2 group-hover:bg-teal-50 transition-colors">
                                      <FileSpreadsheet className="w-6 h-6 text-slate-400 group-hover:text-teal-500" />
                                    </div>
                                    <span className="text-xs font-bold text-slate-600">Upload Lab Printout</span>
                                    <span className="text-[10px] text-slate-400 mt-1 text-center px-4">Snap a photo of the CBC or Chemistry printout</span>
                                    <input 
                                      type="file" 
                                      className="hidden" 
                                      accept="image/*" 
                                      disabled={isSavingPatient || pendingImages > 0}
                                      onChange={async (e) => {
                                        const file = e.target.files?.[0];
                                        if (!file) return;

                                        const input = e.target;
                                        await handleLabImageUpload(result.id, file);
                                        input.value = '';
                                      }} 
                                    />
                                  </label>
                                )}
                              </div>

                              {/* Right: Metrics Key Values */}
                              <div className="col-span-2 flex flex-col">
                                <div className="flex items-center justify-between mb-2">
                                  <label className="text-[10px] font-bold text-slate-400 uppercase">{aiEnabled ? 'Analyte Data (Manual or Demo)' : 'Analyte Data (Manual)'}</label>
                                  <button 
                                    type="button"
                                    onClick={() => {
                                      const updated = [...(editForm.labResults || [])];
                                      const newKey = prompt("Enter new metric name (e.g. 'GLU'):");
                                      if (newKey) {
                                        updated[index].metrics = { ...updated[index].metrics, [newKey]: '' };
                                        handleEditChange('labResults', updated);
                                      }
                                    }}
                                    className="text-[10px] font-bold text-teal-600 bg-teal-50 px-2 py-1 rounded"
                                  >
                                    + Add Metric Row
                                  </button>
                                </div>
                                
                                <div className="bg-white border border-slate-200 rounded-xl p-3 flex-1 overflow-y-auto max-h-48 space-y-2">
                                  {Object.keys(result.metrics || {}).length === 0 ? (
                                    <div className="flex h-full items-center justify-center text-xs text-slate-400 italic text-center">
                                      {aiEnabled ? 'Use the demo extraction for example data, or manually add metric rows.' : 'Manually add metric rows.'}
                                    </div>
                                  ) : (
                                    Object.entries(result.metrics || {}).map(([key, val]) => (
                                      <div key={key} className="flex items-center bg-slate-50 border border-slate-100 rounded-lg overflow-hidden focus-within:ring-1 focus-within:ring-teal-500">
                                        <span className="bg-slate-200/50 px-3 py-2 text-xs font-black text-slate-600 uppercase border-r border-slate-200 min-w-[70px] text-center">
                                          {key}
                                        </span>
                                        <input 
                                          type="text"
                                          className="w-full p-2 text-sm font-bold text-slate-800 outline-none bg-transparent"
                                          value={val as string}
                                          placeholder="e.g. Normal, High, 12.5"
                                          onChange={(e) => {
                                            const updated = [...(editForm.labResults || [])];

                                            updated[index] = {
                                              ...updated[index],
                                              metrics: {
                                                ...(updated[index].metrics || {}),
                                                [key]: e.target.value
                                              }
                                            };

                                            handleEditChange('labResults', updated);
                                          }}
                                        />
                                        <button
                                          type="button"
                                          onClick={() => {
                                            const updated = [...(editForm.labResults || [])];

                                            const nextMetrics = {
                                              ...(updated[index]?.metrics || {})
                                            };

                                            delete nextMetrics[key];

                                            updated[index] = {
                                              ...updated[index],
                                              metrics: nextMetrics
                                            };

                                            handleEditChange('labResults', updated);
                                          }}
                                          className="px-2 text-slate-300 hover:text-red-500"
                                        >
                                          <X className="w-3 h-3" />
                                        </button>
                                      </div>
                                    ))
                                  )}
                                </div>
                              </div>

                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-8 bg-slate-50/50 rounded-xl border border-slate-200 border-dashed">
                        <FileSpreadsheet className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                        <p className="text-sm text-slate-500 font-medium">No laboratory records attached.</p>
                        <p className="text-xs text-slate-400">Add a lab printout to upload CBC or chemistry images.</p>
                      </div>
                    )}
                  </div>

                  {/* SECTION 2: AI SUMMARY (Smart Interpretation) */}
                  {aiEnabled && <div className="bg-gradient-to-br from-purple-950/5 via-indigo-950/5 to-slate-50 rounded-2xl p-6 border border-purple-200/80 shadow-sm space-y-3 relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-1.5 h-full bg-purple-600" />
                    <div className="flex items-center justify-between mb-1">
                      <h4 className="text-xs font-bold text-purple-950 uppercase tracking-wider flex items-center gap-1.5">
                        <Sparkles className="w-4 h-4 text-purple-600" /> 2. AI Synthesis of Clinical Data
                      </h4>
                      <span className="text-[10px] font-black tracking-widest uppercase bg-purple-100 text-purple-700 px-2 py-0.5 rounded border border-purple-200">Gemini Output Window</span>
                    </div>
                    <p className="text-xs text-purple-800/60 mb-2">Paste a summary here. Demo extraction inserts example data only and does not analyze the image.</p>
                    <textarea 
                      className="w-full p-4 bg-white/90 border border-purple-200 rounded-xl text-sm text-slate-800 font-medium focus:ring-2 focus:ring-purple-500 outline-none resize-y min-h-[120px] shadow-sm"
                      placeholder="Waiting for AI synthesis of the blood work... (e.g. 'Elevated WBC suggests acute localized infection...')"
                      value={editForm.aiLabSummary || ""}
                      onChange={e => handleEditChange('aiLabSummary', e.target.value)}
                    />
                  </div>}

                  {/* SECTION 3: VET NOTES (Private Remarks) */}
                  <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-3">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Stethoscope className="w-4 h-4 text-slate-600" /> {aiEnabled ? '3.' : '2.'} Vet&apos;s Personal Notes &amp; SOAP
                    </h4>
                    <textarea 
                      className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none resize-y min-h-[120px]"
                      placeholder="Attending veterinarian clinical observations, physical exam notes, prognosis, or internal team warnings..."
                      value={editForm.notes !== undefined ? editForm.notes : (editForm.reason || "")}
                      onChange={e => handleEditChange('notes', e.target.value)}
                    />
                  </div>

                </fieldset>
              ) : (
                // ==========================================
                // --- READ-ONLY VIEW ---
                // ==========================================
                <div className="space-y-6 animate-in fade-in duration-200">
                  
                  {/* TOP: Demographics & Owner Cards */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm flex flex-col items-center text-center">
                      <div className="w-24 h-24 rounded-2xl bg-teal-50 border border-teal-200 flex items-center justify-center overflow-hidden mb-4 shadow-inner">
                        {selectedPatient.profilePicture || selectedPatient.pictures?.[0] ? (
                          <StoredImage value={selectedPatient.profilePicture || selectedPatient.pictures?.[0]} alt={selectedPatient.name} className="w-full h-full object-cover" />
                        ) : (
                          <PawPrint className="w-12 h-12 text-teal-600" />
                        )}
                      </div>
                      <h3 className="text-2xl font-black text-slate-900">{selectedPatient.name}</h3>
                      <span className="text-xs text-slate-500 font-bold uppercase tracking-wider">{selectedPatient.species} • {selectedPatient.breed}</span>
                      
                      <div className="w-full border-t border-slate-100 my-4" />
                      
                      <div className="grid grid-cols-2 gap-4 w-full text-left">
                        <div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase block">ID Tag</span>
                          <span className="text-xs font-black text-slate-800">{selectedPatient.id}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase block">Current Weight</span>
                          <span className="text-xs font-black text-slate-800">{selectedPatient.weight} kg</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase block">Gender</span>
                          <span className="text-xs font-black text-slate-800">{selectedPatient.gender}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase block">Admit Status</span>
                          <span className="inline-block text-[10px] bg-teal-50 text-teal-700 px-2 py-0.5 rounded font-bold border border-teal-200 mt-1">{selectedPatient.status}</span>
                        </div>
                      </div>
                    </div>

                    <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm md:col-span-2 space-y-4 flex flex-col justify-between">
                      <div>
                        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5 mb-3">
                          <User className="w-4 h-4 text-slate-400" /> Certified Owner & Contact Info
                        </h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <span className="text-[10px] text-slate-400 font-bold uppercase block">Authorized Guardian</span>
                            <p className="text-sm font-bold text-slate-900">{selectedPatient.ownerName}</p>
                          </div>
                          <div>
                            <span className="text-[10px] text-slate-400 font-bold uppercase block">Contact Number</span>
                            <p className="text-sm font-bold text-slate-900">{selectedPatient.ownerContact}</p>
                          </div>
                          <div>
                            <span className="text-[10px] text-slate-400 font-bold uppercase block">Email Address</span>
                            <p className="text-sm font-bold text-slate-900">{selectedPatient.ownerEmail || "N/A"}</p>
                          </div>
                          <div>
                            <span className="text-[10px] text-slate-400 font-bold uppercase block">Residence Address</span>
                            <p className="text-xs font-medium text-slate-700">{selectedPatient.ownerAddress || "No address on file"}</p>
                          </div>
                        </div>
                      </div>

                      <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center justify-between mt-auto">
                        <div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase block">Ledger Balance Summary</span>
                          <p className="text-lg font-black text-slate-800">PHP {selectedPatient.balance.toFixed(2)}</p>
                        </div>
                        <button 
                          type="button"
                          disabled={!canEdit || isSavingPatient}
                          onClick={async () => {
                            if (!canEdit || !window.confirm('Clear this patient’s outstanding balance? This does not remove billing history.')) return;
                            const updated = { ...selectedPatient, balance: 0 };
                            setIsSavingPatient(true);
                            let saved = false;
                            try { saved = await onUpdatePatient(updated); }
                            finally { setIsSavingPatient(false); }
                            if (!saved) return;
                            setSelectedPatient(updated);
                            if (typeof triggerToast === 'function') triggerToast(`Ledger balance cleared.`);
                          }}
                          className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-4 py-2 rounded-lg transition-all"
                        >
                          Clear Account Balance
                        </button>
                      </div>
                    </div>
                  </div>
                  
                {/* SECTION: Structured clinical activity / treatments */}
                <ClinicalActivity
                  patient={selectedPatient}
                  consultations={consultations}
                  inventory={inventory}
                  canEdit={canEdit}
                  staffUid={staffUid}
                  staffName={staffName}
                  appointmentId={initialTreatmentLink?.patientId === selectedPatient.id
                    ? initialTreatmentLink.appointmentId : null}
                  initialOccurredAt={initialTreatmentLink?.patientId === selectedPatient.id
                    ? initialTreatmentLink.occurredAt : undefined}
                  onSave={draft => onSaveConsultation(selectedPatient, draft)}
                  triggerToast={triggerToast}
                />

                {/* SECTION 0: Patient Payables / Billing */}
                <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-5">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-100 pb-3">
                    <div>
                      <h4 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                        <CreditCard className="w-5 h-5 text-teal-600" />
                        Patient Payables
                      </h4>
                      <p className="text-xs text-slate-500 mt-1">
                        Search loaded medicines and services, select whole quantities, then save the ledger and stock together.
                        Apply at most two stock items per operation.
                      </p>
                    </div>

                    <div className="text-right">
                      <p className="text-[10px] text-slate-400 font-bold uppercase">
                        Current Balance
                      </p>
                      <p className="text-lg font-black text-slate-900">
                        PHP {selectedPatient.balance.toFixed(2)}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                    <div className="space-y-3">
                      <label className="text-xs font-bold text-slate-700 block">
                        Search Medicine / Service
                      </label>

                      <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 focus-within:ring-2 focus-within:ring-teal-500">
                        <Search className="w-4 h-4 text-slate-400" />
                        <input
                          type="text"
                          value={billableSearchQuery}
                          onChange={e => setBillableSearchQuery(e.target.value)}
                          placeholder="Search medicine, medical service, grooming..."
                          className="bg-transparent outline-none border-none text-sm text-slate-800 w-full"
                        />
                      </div>

                      <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100 bg-slate-50/60">
                        {filteredBillableCatalog.map(item => {
                          const isSelected = selectedBillables[item.itemCode] !== undefined;

                          return (
                            <div
                              key={item.itemCode}
                              className="p-3 bg-white flex items-center justify-between gap-3"
                            >
                              <label className="flex items-start gap-3 cursor-pointer flex-1">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleBillableSelection(item)}
                                  className="mt-1"
                                />

                                <div>
                                  <p className="text-sm font-bold text-slate-900">
                                    {item.itemName}
                                  </p>
                                  <p className="text-[10px] text-slate-400 uppercase font-bold">
                                    {item.category} • {item.itemCode}
                                  </p>
                                  <p className="text-xs text-teal-700 font-black mt-1">
                                    PHP {item.sellingPrice.toFixed(2)}
                                  </p>
                                </div>
                              </label>

                              {isSelected && (
                                <div className="w-20">
                                  <label className="text-[10px] text-slate-400 font-bold block mb-1">
                                    Qty
                                  </label>
                                  <input
                                    type="number"
                                    min={1}
                                    value={selectedBillables[item.itemCode]}
                                    onChange={e =>
                                      updateBillableQuantity(
                                        item.itemCode,
                                        Number(e.target.value)
                                      )
                                    }
                                    className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-900 outline-none"
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}

                        {filteredBillableCatalog.length === 0 && (
                          <div className="p-6 text-center text-sm text-slate-400">
                            No matching medicine or service found.
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <h5 className="text-xs font-black text-slate-400 uppercase tracking-wider">
                        Selected Payables
                      </h5>

                      <div className="border border-slate-200 rounded-xl bg-slate-50/60 divide-y divide-slate-100 min-h-[120px]">
                        {selectedBillableDetails.length > 0 ? (
                          selectedBillableDetails.map(entry => (
                            <div
                              key={entry.item.itemCode}
                              className="p-3 bg-white flex items-center justify-between gap-3"
                            >
                              <div>
                                <p className="text-sm font-bold text-slate-900">
                                  {entry.item.itemName}
                                </p>
                                <p className="text-xs text-slate-500">
                                  PHP {entry.unitPrice.toFixed(2)} × {entry.quantity}
                                </p>
                              </div>

                              <p className="text-sm font-black text-slate-900">
                                PHP {entry.total.toFixed(2)}
                              </p>
                            </div>
                          ))
                        ) : (
                          <div className="p-6 text-center text-sm text-slate-400">
                            No payables selected yet.
                          </div>
                        )}
                      </div>

                      <div className="bg-teal-50 border border-teal-100 rounded-xl p-4 flex items-center justify-between">
                        <div>
                          <p className="text-[10px] text-teal-700 font-black uppercase">
                            Payables Subtotal
                          </p>
                          <p className="text-xl font-black text-teal-800">
                            PHP {billableSubtotal.toFixed(2)}
                          </p>
                        </div>

                        <button
                          type="button"
                          disabled={!canEdit || isSavingPatient || selectedBillableDetails.length === 0}
                          onClick={applyBillablesToPatient}
                          className="bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-all disabled:opacity-50"
                        >
                          Add to Ledger
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-slate-100 pt-4">
                    <h5 className="text-xs font-black text-slate-400 uppercase tracking-wider mb-3">
                      Dossier Billing History
                    </h5>

                    {selectedPatient.billableItems && selectedPatient.billableItems.length > 0 ? (
                      <div className="space-y-2">
                        {selectedPatient.billableItems.map(item => (
                          <div
                            key={item.id}
                            className="bg-slate-50 border border-slate-100 rounded-xl p-3 flex justify-between items-center text-xs gap-3"
                          >
                            <div>
                              <p className="font-bold text-slate-900">
                                {item.itemName}
                              </p>
                              <p className="text-slate-500">
                                {item.date} • {item.category} • Qty {item.quantity}
                              </p>
                            </div>

                            <div className="flex items-center gap-3">
                              <p className="font-black text-slate-900 whitespace-nowrap">
                                PHP {item.total.toFixed(2)}
                              </p>

                              <button
                                type="button"
                                disabled={!canEdit || isSavingPatient}
                                onClick={() => void removeBillableFromPatient(item)}
                                className="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1"
                              >
                                <Trash2 className="w-3 h-3" />
                                Remove
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-slate-400 italic">
                        No medicine or service charges added yet.
                      </p>
                    )}
                  </div>
                </div>             
                            
                  {/* SECTION 1: LAB RESULTS (Read View w/ Images) */}
                  <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-4">
                    <h4 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3">
                      <TestTube className="w-5 h-5 text-teal-600" />
                      1. Laboratory Panels & Documents
                    </h4>
                    
                    {selectedPatient.labResults && selectedPatient.labResults.length > 0 ? (
                      <div className="space-y-4">
                        {selectedPatient.labResults.map((result, i) => (
                          <div key={result.id || i} className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 flex flex-col sm:flex-row gap-5">
                            
                            {/* Document Thumbnail */}
                            {result.imageUrl && (
                              <div 
                                className="w-full sm:w-32 h-32 flex-shrink-0 bg-slate-900 rounded-lg overflow-hidden relative cursor-pointer group shadow-sm border border-slate-300"
                                onClick={() => {
                                  if (!result.imageUrl) return;
                                  void openStoredImage(result.imageUrl).catch(error => {
                                    console.error('[Images] Could not open lab document:', error);
                                    triggerToast(error instanceof Error ? error.message : 'Could not open the lab document.');
                                  });
                                }}
                                title="Click to enlarge"
                              >
                                <StoredImage value={result.imageUrl} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" alt="Lab Document" />
                                <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                  <ZoomIn className="text-white w-6 h-6" />
                                </div>
                              </div>
                            )}

                            {/* Data Breakdown */}
                            <div className="flex-1 flex flex-col justify-center">
                              <div className="mb-3 border-b border-slate-200/60 pb-2">
                                <span className="font-bold text-sm text-slate-900 block">{result.testName}</span>
                                <span className="text-xs text-slate-400 font-medium">Logged: {result.date}</span>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {Object.keys(result.metrics || {}).length > 0 ? (
                                  Object.entries(result.metrics || {}).map(([mKey, mVal]) => (
                                    mVal ? (
                                      <span key={mKey} className="text-xs bg-white border border-slate-200 pl-2 pr-3 py-1.5 rounded-md font-mono shadow-sm flex items-center gap-2">
                                        <span className="text-[10px] text-slate-400 font-sans font-bold bg-slate-100 px-1.5 py-0.5 rounded">{mKey}</span>
                                        <strong className="text-slate-800">{mVal as string}</strong>
                                      </span>
                                    ) : null
                                  ))
                                ) : (
                                  <span className="text-xs text-slate-400 italic">No extracted metrics available.</span>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-6 bg-slate-50/50 rounded-xl border border-slate-200 border-dashed">
                        <p className="text-sm text-slate-400 font-medium">No laboratory records attached to this profile.</p>
                      </div>
                    )}
                  </div>

                  {/* SECTION 2: AI SUMMARY (Read View) */}
                  {aiEnabled && <div className="bg-gradient-to-br from-purple-900/5 via-indigo-900/5 to-slate-50 rounded-2xl p-6 border border-purple-200/70 shadow-sm space-y-3 relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-1.5 h-full bg-purple-600" />
                    <div className="flex items-center justify-between border-b border-purple-100/80 pb-2">
                      <h4 className="text-sm font-bold text-purple-950 flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-purple-600" />
                        2. AI Summary of Clinical Data
                      </h4>
                      <span className="text-[10px] uppercase tracking-widest font-black text-purple-400">Automated Synthesis</span>
                    </div>
                    <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap font-medium pt-1">
                      {selectedPatient.aiLabSummary || "No AI synthesis generated for these laboratory panels yet."}
                    </p>
                  </div>}

                  {/* SECTION 3: VET NOTES (Read View) */}
                  <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-3">
                    <h4 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3">
                      <Stethoscope className="w-5 h-5 text-slate-600" />
                      {aiEnabled ? '3.' : '2.'} Vet&apos;s Personal Notes
                    </h4>
                    <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 text-sm text-slate-700 font-medium min-h-[60px]">
                      {selectedPatient.notes || selectedPatient.reason ? (
                        <p className="whitespace-pre-wrap leading-relaxed">{selectedPatient.notes || selectedPatient.reason}</p>
                      ) : (
                        <p className="text-slate-400 italic">No attending doctor&apos;s remarks or SOAP notes recorded.</p>
                      )}
                    </div>
                  </div>

                </div>
              )}

            </div>

            {/* Modal Footer */}
            <div className="p-6 bg-white border-t border-slate-200 flex justify-between items-center">
              {isEditing ? (
  <div className="flex w-full gap-4 items-stretch">
    {showDeleteConfirm ? (
      <div className="flex flex-1 gap-3 bg-red-50 border border-red-200 p-2 rounded-xl animate-in fade-in zoom-in-95 duration-200">
        <button
          type="button"
          disabled={!canEdit || isSavingPatient}
          onClick={async () => {
            if (!selectedPatient || !canEdit) return;
            setIsSavingPatient(true);
            let removed = false;
            try { removed = await onDeletePatient(selectedPatient.id); }
            finally { setIsSavingPatient(false); }
            if (!removed) return;
            setShowFullReport(false);
            setSelectedPatient(null);
            setEditForm(null);
            setIsEditing(false);
            setShowDeleteConfirm(false);

            if (typeof triggerToast === 'function') {
              triggerToast("Patient record permanently deleted.");
            }
          }}
          className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold px-4 py-3 rounded-xl text-xs transition-all shadow-md flex items-center justify-center gap-2"
        >
          <Trash2 className="w-4 h-4" />
          Confirm Delete
        </button>

        <button
          type="button"
          onClick={() => setShowDeleteConfirm(false)}
          className="bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 font-bold px-4 py-3 rounded-xl text-xs transition-all"
        >
          Cancel
        </button>
      </div>
    ) : (
      <button
        type="button"
        disabled={!canEdit || isSavingPatient || pendingImages > 0}
        onClick={() => setShowDeleteConfirm(true)}
        className="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 font-bold px-4 py-3 rounded-xl text-sm transition-all shadow-sm flex items-center justify-center gap-2"
        title="Permanently delete this patient record"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    )}

    <button
      type="button"
      disabled={!canEdit || isSavingPatient || pendingImages > 0}
      onClick={() => {
        setIsEditing(false);
        setShowDeleteConfirm(false);
      }}
      className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold px-6 py-3 rounded-xl text-sm transition-all shadow-sm"
    >
      Cancel Editing
    </button>

    <button
      type="button"
      disabled={!canEdit || isSavingPatient || pendingImages > 0}
      onClick={async () => {
        if (!editForm) return;
        setIsSavingPatient(true);
        let saved: boolean;
        try {
          saved = await onUpdatePatient(editForm);
        } finally {
          setIsSavingPatient(false);
        }
        if (!saved) return;
        setSelectedPatient(editForm);
        setIsEditing(false);
        setShowDeleteConfirm(false);
      }}
      className="flex-1 bg-teal-600 hover:bg-teal-700 text-white font-bold px-6 py-3 rounded-xl text-sm transition-all shadow-md shadow-teal-600/20"
    >
      Save Changes to Dossier
    </button>
  </div>
) : (
                <>
                  <button 
                    type="button"
                    disabled={!canEdit}
                    onClick={() => {
                      setEditForm(JSON.parse(JSON.stringify(selectedPatient)));
                      setIsEditing(true);
                    }}
                    className="bg-slate-100 hover:bg-slate-200 text-slate-900 border border-slate-300 font-bold px-6 py-3 rounded-xl text-sm transition-all shadow-sm flex items-center gap-2"
                  >
                    <PawPrint className="w-4 h-4"/> Edit Dossier Details
                  </button>
                  <button 
                    type="button"
                    onClick={() => {
                      setShowFullReport(false);
                      setIsEditing(false);
                      setSelectedPatient(null);
                    }}
                    className="bg-slate-900 hover:bg-slate-800 text-white font-bold px-6 py-3 rounded-xl text-sm transition-all shadow-md"
                  >
                    Close Clinical Dossier
                  </button>
                </>
              )}
            </div>

          </div>
        </div>
      )}
    </div>
  );
};
