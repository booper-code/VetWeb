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
  itemCode: string;
  itemName: string;
  category: 'Medicine' | 'Supplies' | 'Service' | 'Grooming';
  stock: number;
  buyingPrice: number;
  sellingPrice: number;
  threshold: number;
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

export type Consultation = {
  id: string;
  date: string;
  client: string;
  patient: string;
  type: string;
  status: 'Draft' | 'Completed';
  notes: string;
};

export type ClinicRole = 'owner' | 'editor' | 'viewer';

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
  role: Exclude<ClinicRole, 'owner'>;
  status: 'pending' | 'accepted' | 'revoked';
  createdBy: string;
  createdByEmail: string;
  expiresAt?: { toMillis: () => number };
};

export type StaffKind = 'veterinarian' | 'employee';
export type PayBasis = 'daily' | 'monthly';

export type StaffMember = {
  id: string;
  name: string;
  kind: StaffKind;
  position: string;
  email?: string;
  phone?: string;
  active: boolean;
  hiredAt?: string;
  notes?: string;
};

/** Pay rates live in a separate owner-only collection because Firestore rules
 *  cannot hide individual fields on a document. */
export type StaffPayProfile = {
  payBasis: PayBasis;
  rate: number;
};

export type PayrollPeriod = {
  id: string;
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
