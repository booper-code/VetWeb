export type GeminiPart = 
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

export type GeminiPayload = {
  contents: { parts: GeminiPart[] }[];
  generationConfig?: {
    responseMimeType: string;
    responseSchema: Record<string, unknown>;
  };
};

export type InventoryItem = {
  revision?: number;
  billingStockEntryId?: string;
  itemCode: string;
  itemName: string;
  category: 'Medicine' | 'Supplies' | 'Service' | 'Grooming';
  stock: number;
  buyingPrice: number;
  sellingPrice: number;
  threshold: number;
  /** Earliest recorded expiry among stocked units, Manila calendar date (YYYY-MM-DD). */
  expiryDate?: string;
};

export type LabResult = {
  id: string;
  date: string;
  testName: string;
  findings?: string;
  /** Legacy data URL, external URL, or R2 object key. See `lib/imageStore.ts`. */
  imageUrl?: string;
  metrics?: Record<string, string>;
};

export type PatientBillableItem = {
  id: string;
  itemCode: string;
  itemName: string;
  category: 'Medicine' | 'Supplies' | 'Service' | 'Grooming';
  quantity: number;
  unitPrice: number;
  total: number;
  date: string;
};

export type PatientRecord = {
  revision?: number;
  dischargedAt?: string;
  id: string;
  name: string;
  species: string;
  breed: string;
  gender: 'Male' | 'Female' | 'Unknown';
  ownerName: string;
  ownerContact: string;
  ownerEmail?: string;
  ownerAddress?: string;
  weight: number;
  admissionTypes: string[];
  reason: string;
  status: 'Waiting' | 'In Treatment' | 'Confined' | 'Ready for Pickup' | 'Discharged';
  balance: number;
  billing?: import('@/lib/billing-values').BillingState;
  /** Raw legacy numeric amount, or null when the cloud record needs manual review. */
  legacyBillingBalance?: number | null;
  /** Legacy data URL, external URL, or R2 object key. See `lib/imageStore.ts`. */
  pictures?: string[];
  /** Legacy data URL, external URL, or R2 object key. See `lib/imageStore.ts`. */
  profilePicture?: string;
  labResults?: LabResult[];
  tags?: string[];
  notes?: string;
  aiLabSummary?: string;
  billableItems?: PatientBillableItem[];
};

/** One structured treatment/service line recorded during a visit. */
export type TreatmentLine = {
  id: string;
  itemCode: string;
  itemName: string;
  category: InventoryItem['category'];
  quantity: number;
  unitPrice: number;
  dose: string;
  notes: string;
};

/** Bounded stock invariant checked by Firestore rules, one entry per stocked item. */
export type ConsultationStockMove = {
  itemCode: string;
  quantity: number;
};

export type Consultation = {
  revision?: number;
  id: string;
  /** Legacy display date. New records also store the precise `occurredAt`. */
  date: string;
  client: string;
  patient: string;
  type: string;
  status: 'Draft' | 'Completed';
  notes: string;
  /** Structured, day-end-friendly clinical activity fields. */
  patientId?: string;
  appointmentId?: string | null;
  /** Actual visit time as a UTC ISO string, separate from the entry/audit time. */
  occurredAt?: string;
  /** UTC sort key for history; null means the legacy visit date is unknown. */
  historySortAt?: string | null;
  /** Server-recorded entry time as a UTC ISO string. */
  recordedAt?: string;
  staffUid?: string;
  staffName?: string;
  treatments?: TreatmentLine[];
  stockMoves?: ConsultationStockMove[];
};

export type ConsultationDraft = {
  patientId: string;
  occurredAt: string;
  type: string;
  notes: string;
  appointmentId?: string | null;
  treatments: TreatmentLine[];
  staffUid: string;
  staffName: string;
};

export type AppointmentType = 'Checkup' | 'Vaccination' | 'Deworming' | 'Grooming' | 'Surgery' | 'Follow-up';
export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no-show';
export type FollowUpContact = { dueAt: string; contactedAt: string; contactedBy: string };
/** UI timestamps are UTC ISO strings; Firestore stores real timestamps. */
export type Appointment = {
  id: string;
  revision: number;
  patientId: string;
  patientName: string;
  ownerName: string;
  ownerContact: string;
  ownerEmail: string;
  type: AppointmentType;
  status: AppointmentStatus;
  dueAt: string;
  durationMinutes: number;
  notes: string;
  occurredAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  followUpContact?: FollowUpContact;
};
export type AppointmentDraft = Pick<Appointment,
  'patientId' | 'type' | 'status' | 'dueAt' | 'durationMinutes' | 'notes' | 'occurredAt'>;

export type ClinicRole = 'owner' | 'member';

export type ClinicSessionUser = {
  uid: string;
  email: string;
  displayName: string;
  isDemo?: boolean;
};

export type ClinicMembership = {
  clinicId: string;
  clinicName: string;
  role: ClinicRole;
};

export type ClinicMember = {
  uid: string;
  email: string;
  displayName: string;
  role: ClinicRole;
};

export type ClinicInvitation = {
  id: string;
  clinicId: string;
  clinicName: string;
  email: string;
  role: 'member' | 'editor' | 'viewer';
  status: 'pending' | 'accepted' | 'revoked';
  createdBy: string;
  createdByEmail: string;
  expiresAt?: { toMillis: () => number };
};

export type StaffKind = 'veterinarian' | 'employee';
export type PayBasis = 'daily' | 'monthly';

export type StaffMember = {
  id: string;
  revision?: number;
  name: string;
  kind: StaffKind;
  position: string;
  email?: string;
  phone?: string;
  active: boolean;
  hiredAt?: string;
  notes?: string;
};

/** Pay rates live in a separate collection from the staff roster. */
export type StaffPayProfile = {
  revision?: number;
  payBasis: PayBasis;
  rate: number;
};

export type PayrollPeriod = {
  id: string;
  revision?: number;
  startDate: string;
  endDate: string;
  status: 'open' | 'closed';
  createdAt?: { toMillis: () => number } | null;
  closedAt?: { toMillis: () => number } | null;
};

export type PayrollEntryType = 'advance' | 'repayment' | 'payout' | 'adjustment';

/** Append-only payroll ledger entry. `hash` covers the entry plus `prevHash`,
 *  so any later edit or deletion breaks verification of every following entry. */
export type PayrollEntry = {
  id: string;
  seq: number;
  type: PayrollEntryType;
  direction: 'in' | 'out';
  staffId: string;
  staffName: string;
  amount: number;
  periodId?: string;
  note?: string;
  createdBy: string;
  createdAt?: { toMillis: () => number } | null;
  prevHash: string;
  hash: string;
};
