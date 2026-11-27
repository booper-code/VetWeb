"use client";

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Briefcase,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  Loader2,
  PlusCircle,
  ShieldCheck,
  Wallet
} from 'lucide-react';
import type {
  ClinicRole,
  ClinicSessionUser,
  PayrollEntry,
  PayrollEntryType,
  PayrollPeriod,
  StaffKind,
  StaffMember,
  StaffPayProfile
} from '@/types';
import { parsePhpMinor } from '@/lib/billing-values';
import {
  appendPayrollEntry,
  closePayrollPeriod,
  confirmPayrollPayoutLimit,
  createPayrollPeriod,
  getPayrollHead,
  listPayProfiles,
  listPayrollEntries,
  listPayrollPeriods,
  listStaff,
  loadReconciledPayrollAmount,
  payrollBalanceForPeriod,
  PayrollPayoutLimitError,
  saveStaffMember,
  verifyPayrollChain,
  watchPayrollPayoutLimits,
  type ChainVerification,
  type PayrollHead,
  type PayrollPayoutLimit
} from '@/lib/payroll';

const currency = (value: number) =>
  `PHP ${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

const startOfWeek = () => {
  const today = new Date();
  const weekday = today.getDay();
  const diff = weekday === 0 ? -6 : 1 - weekday;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diff);
  return monday;
};

const DEMO_STAFF: StaffMember[] = [
  {
    id: 'demo-vet-1',
    name: 'Dr. Ana Reyes',
    kind: 'veterinarian',
    position: 'Senior Veterinarian',
    email: 'ana.reyes@example.com',
    phone: '0917-000-0001',
    active: true,
    hiredAt: '2023-02-01',
    notes: ''
  },
  {
    id: 'demo-vet-2',
    name: 'Dr. Marco Lim',
    kind: 'veterinarian',
    position: 'Associate Veterinarian',
    email: 'marco.lim@example.com',
    phone: '0917-000-0002',
    active: true,
    hiredAt: '2024-06-15',
    notes: ''
  },
  {
    id: 'demo-emp-1',
    name: 'Joy Santos',
    kind: 'employee',
    position: 'Veterinary Assistant',
    email: 'joy.santos@example.com',
    phone: '0917-000-0003',
    active: true,
    hiredAt: '2024-01-10',
    notes: ''
  }
];

type StaffDraft = {
  id?: string;
  revision?: number;
  payRevision?: number;
  name: string;
  kind: StaffKind;
  position: string;
  email: string;
  phone: string;
  active: boolean;
  hiredAt: string;
  notes: string;
  payBasis: StaffPayProfile['payBasis'];
  rate: string;
};

const emptyStaffDraft = (): StaffDraft => ({
  name: '',
  kind: 'employee',
  position: '',
  email: '',
  phone: '',
  active: true,
  hiredAt: '',
  notes: '',
  payBasis: 'daily',
  rate: ''
});

export const StaffPayrollView = ({
  clinicId,
  clinicName,
  user,
  role,
  isDemo,
  isCurrent,
  triggerToast
}: {
  clinicId: string | null;
  clinicName: string;
  user: ClinicSessionUser | null;
  role: ClinicRole | null;
  isDemo: boolean;
  isCurrent: () => boolean;
  triggerToast: (msg: string) => void;
}) => {
  const canManagePayroll = role !== null && !isDemo;
  const canEditRoster = isDemo || canManagePayroll;
  const payrollActor = { uid: user?.uid ?? '', isCurrent };

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [profiles, setProfiles] = useState<Record<string, StaffPayProfile>>({});
  const [periods, setPeriods] = useState<PayrollPeriod[]>([]);
  const [entries, setEntries] = useState<PayrollEntry[]>([]);
  const [head, setHead] = useState<PayrollHead | null>(null);
  const [chain, setChain] = useState<ChainVerification | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState('');

  const [showStaffForm, setShowStaffForm] = useState(false);
  const [staffDraft, setStaffDraft] = useState<StaffDraft>(emptyStaffDraft());

  const [showPeriodForm, setShowPeriodForm] = useState(false);
  const [periodStart, setPeriodStart] = useState(isoDate(startOfWeek()));
  const [periodEnd, setPeriodEnd] = useState(isoDate(new Date(startOfWeek().getTime() + 6 * 86400000)));
  const [selectedPeriodId, setSelectedPeriodId] = useState('');
  const [limitSnapshot, setLimitSnapshot] = useState<{
    clinicId: string;
    periodId: string;
    limits: Record<string, PayrollPayoutLimit>;
  } | null>(null);

  const [ledgerStaffId, setLedgerStaffId] = useState('');
  const [ledgerType, setLedgerType] = useState<PayrollEntryType>('advance');
  const [ledgerDirection, setLedgerDirection] = useState<'in' | 'out'>('out');
  const [ledgerAmount, setLedgerAmount] = useState('');
  const [ledgerNote, setLedgerNote] = useState('');

  useEffect(() => {
    let active = true;

    const load = async () => {
      setIsLoading(true);
      setError('');

      if (isDemo) {
        if (active) {
          setStaff(DEMO_STAFF);
          setIsLoading(false);
        }
        return;
      }

      if (!clinicId) {
        if (active) setIsLoading(false);
        return;
      }

      try {
        const members = await listStaff(clinicId);
        if (active) setStaff(members);

        if (canManagePayroll) {
          const [loadedProfiles, loadedPeriods, loadedEntries, loadedHead] = await Promise.all([
            listPayProfiles(clinicId),
            listPayrollPeriods(clinicId),
            listPayrollEntries(clinicId),
            getPayrollHead(clinicId)
          ]);
          if (!active) return;
          setProfiles(loadedProfiles);
          setPeriods(loadedPeriods);
          setEntries(loadedEntries);
          setHead(loadedHead);
          setChain(await verifyPayrollChain(loadedEntries, loadedHead));
          setSelectedPeriodId(previous => previous || loadedPeriods.find(period => period.status === 'open')?.id || loadedPeriods[0]?.id || '');
        }
      } catch (loadError) {
        console.error('[Staff & payroll] Failed to load:', loadError);
        if (active) setError('Could not load staff records. Check that the latest security rules are published.');
      } finally {
        if (active) setIsLoading(false);
      }
    };

    load();
    return () => { active = false; };
  }, [clinicId, isDemo, canManagePayroll]);

  const activeStaff = useMemo(() => staff.filter(member => member.active), [staff]);
  const selectedPeriod = periods.find(period => period.id === selectedPeriodId) ?? null;
  const selectedPeriodIsOpen = selectedPeriod?.status === 'open';
  const limits = limitSnapshot?.clinicId === clinicId && limitSnapshot.periodId === selectedPeriodId
    ? limitSnapshot.limits
    : null;
  const hasUnpaidLimit = limits !== null && Object.values(limits).some(limit => limit.paidMinor < limit.approvedMinor);

  useEffect(() => {
    if (!clinicId || !selectedPeriodId || !canManagePayroll) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const onError = (loadError: Error) => {
      console.error('[Staff & payroll] Failed to load payout limits:', loadError);
      if (active) {
        setLimitSnapshot(null);
        setError(previous => previous || 'Could not load confirmed payout limits.');
      }
    };
    void watchPayrollPayoutLimits(clinicId, selectedPeriodId, confirmed => {
      if (active) setLimitSnapshot(confirmed ? { clinicId, periodId: selectedPeriodId, limits: confirmed } : null);
    }, onError).then(stop => {
      if (active) unsubscribe = stop;
      else stop();
    }, onError);
    return () => { active = false; unsubscribe?.(); };
  }, [clinicId, selectedPeriodId, canManagePayroll]);

  const recentEntries = useMemo(
    () => [...entries].sort((a, b) => b.seq - a.seq).slice(0, 25),
    [entries]
  );

  const openStaffForm = (member?: StaffMember) => {
    const profile = member ? profiles[member.id] : undefined;
    setStaffDraft(
      member
        ? {
            id: member.id,
            revision: member.revision ?? 0,
            payRevision: profile?.revision,
            name: member.name,
            kind: member.kind,
            position: member.position,
            email: member.email ?? '',
            phone: member.phone ?? '',
            active: member.active,
            hiredAt: member.hiredAt ?? '',
            notes: member.notes ?? '',
            payBasis: profile?.payBasis ?? 'daily',
            rate: profile ? String(profile.rate) : ''
          }
        : emptyStaffDraft()
    );
    setShowStaffForm(true);
  };

  const handleSaveStaff = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isCurrent()) return;
    if (!staffDraft.name.trim()) {
      setError('Enter the staff member’s name.');
      return;
    }

    setIsWorking(true);
    setError('');

    try {
      if (isDemo) {
        const localMember: StaffMember = {
          id: staffDraft.id ?? `demo-staff-${crypto.randomUUID()}`,
          name: staffDraft.name.trim(),
          kind: staffDraft.kind,
          position: staffDraft.position.trim(),
          email: staffDraft.email.trim(),
          phone: staffDraft.phone.trim(),
          active: staffDraft.active,
          hiredAt: staffDraft.hiredAt,
          notes: staffDraft.notes.trim()
        };
        setStaff(previous =>
          staffDraft.id ? previous.map(member => (member.id === staffDraft.id ? localMember : member)) : [...previous, localMember]
        );
      } else if (clinicId) {
        const rate = Number(staffDraft.rate);
        const previous = staffDraft.id ? profiles[staffDraft.id] : undefined;
        const payProfile = canManagePayroll && staffDraft.rate.trim()
          && (previous?.rate !== rate || previous?.payBasis !== staffDraft.payBasis)
          ? { payBasis: staffDraft.payBasis, rate, revision: staffDraft.payRevision }
          : undefined;
        const saved = await saveStaffMember(clinicId, {
          id: staffDraft.id,
          revision: staffDraft.revision,
          name: staffDraft.name,
          kind: staffDraft.kind,
          position: staffDraft.position,
          email: staffDraft.email,
          phone: staffDraft.phone,
          active: staffDraft.active,
          hiredAt: staffDraft.hiredAt,
          notes: staffDraft.notes
        }, payProfile, payrollActor);
        if (!isCurrent()) return;

        setStaff(previous =>
          staffDraft.id ? previous.map(member => (member.id === saved.id ? saved : member)) : [...previous, saved]
        );

        if (payProfile) setProfiles(current => ({
          ...current, [saved.id]: { ...payProfile, revision: (payProfile.revision ?? 0) + 1 }
        }));
      }

      triggerToast(staffDraft.id ? 'Staff record updated.' : 'Staff member added.');
      setShowStaffForm(false);
      setStaffDraft(emptyStaffDraft());
    } catch (saveError) {
      console.error('[Staff & payroll] Failed to save staff:', saveError);
      setError(saveError instanceof Error ? saveError.message : 'Could not save the staff record.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleCreatePeriod = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!clinicId || !isCurrent()) return;

    setIsWorking(true);
    setError('');
    try {
      const period = await createPayrollPeriod(clinicId, periodStart, periodEnd, payrollActor);
      if (!isCurrent()) return;
      setPeriods(previous => [period, ...previous]);
      setSelectedPeriodId(period.id);
      setShowPeriodForm(false);
      triggerToast('Payroll period created.');
    } catch (createError) {
      console.error('[Staff & payroll] Failed to create period:', createError);
      setError(createError instanceof Error ? createError.message : 'Could not create the payroll period.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleClosePeriod = async () => {
    if (!clinicId || !selectedPeriod || !limits || hasUnpaidLimit || !isCurrent()) return;
    if (!window.confirm(`Close payroll for ${selectedPeriod.startDate} to ${selectedPeriod.endDate}? No further salary payouts can be recorded for this period.`)) {
      return;
    }

    setIsWorking(true);
    try {
      await closePayrollPeriod(clinicId, selectedPeriod.id, selectedPeriod.revision ?? 0, payrollActor);
      if (!isCurrent()) return;
      setPeriods(previous =>
        previous.map(period => period.id === selectedPeriod.id
          ? { ...period, status: 'closed', revision: (period.revision ?? 0) + 1 } : period)
      );
      triggerToast('Payroll period closed.');
    } catch (closeError) {
      console.error('[Staff & payroll] Failed to close period:', closeError);
      setError(closeError instanceof Error ? closeError.message : 'Could not close the payroll period.');
    } finally {
      setIsWorking(false);
    }
  };

  const showLedger = async (nextEntries: PayrollEntry[], nextHead: PayrollHead | null) => {
    const nextChain = await verifyPayrollChain(nextEntries, nextHead);
    if (!isCurrent()) return;
    setEntries(nextEntries);
    setHead(nextHead);
    setChain(nextChain);
  };

  const refreshLedger = async () => {
    if (!clinicId || !isCurrent()) return;
    try {
      // Read the head after the entries so verification can detect an append
      // that landed during the refresh.
      const nextEntries = await listPayrollEntries(clinicId);
      const nextHead = await getPayrollHead(clinicId);
      await showLedger(nextEntries, nextHead);
    } catch (refreshError) {
      console.error('[Staff & payroll] Failed to refresh ledger:', refreshError);
    }
  };

  const showSavedEntry = async (entry: PayrollEntry) => {
    const nextHead = { seq: entry.seq, hash: entry.hash };
    await showLedger([...entries, entry], nextHead);
    if (entry.seq !== (head?.seq ?? 0) + 1) await refreshLedger();
  };

  const handleAddLedgerEntry = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!clinicId || !user || !isCurrent()) return;

    const member = staff.find(item => item.id === ledgerStaffId);
    if (!member) {
      setError('Choose a staff member.');
      return;
    }
    if (ledgerType === 'payout' && !selectedPeriodIsOpen) {
      setError('Choose an open payroll period before recording a salary payout.');
      return;
    }

    setIsWorking(true);
    setError('');
    try {
      const entry = await appendPayrollEntry({
        clinicId,
        actor: payrollActor,
        type: ledgerType,
        direction: ledgerType === 'adjustment' ? ledgerDirection : ledgerType === 'repayment' ? 'in' : 'out',
        staff: member,
        amount: Number(ledgerAmount),
        periodId: selectedPeriod?.id,
        note: ledgerNote
      });

      await showSavedEntry(entry);
      if (!isCurrent()) return;
      setLedgerAmount('');
      setLedgerNote('');
      triggerToast('Ledger entry recorded.');
    } catch (entryError) {
      if (!isCurrent()) return;
      console.error('[Staff & payroll] Failed to append ledger entry:', entryError);
      if (entryError instanceof PayrollPayoutLimitError) await refreshLedger();
      setError(entryError instanceof Error ? entryError.message : 'Could not record the ledger entry.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleConfirmPayoutLimit = async (member: StaffMember) => {
    if (!clinicId || !user || !selectedPeriodIsOpen || !selectedPeriod || !limits || !isCurrent()) return;
    const { approvedMinor, paidMinor, unassignedMinor, remaining } = payrollBalanceForPeriod(
      profiles[member.id], selectedPeriod, entries, member.id
    );
    if (remaining <= 0) return;

    setError('');
    setIsWorking(true);
    try {
      let unassignedPaidMinor = 0;
      const appliedMinor = unassignedMinor > 0 ? await loadReconciledPayrollAmount(clinicId, member.id, payrollActor) : 0;
      const availableMinor = Math.max(unassignedMinor - appliedMinor, 0);
      if (availableMinor > 0) {
        const amount = window.prompt(
          `${member.name} has ${currency(availableMinor / 100)} left to assign from older payouts without a period. `
          + `Enter how much of those payouts belongs to ${selectedPeriod.startDate} to ${selectedPeriod.endDate}. Enter 0 if none.`
        );
        if (amount === null) return;
        unassignedPaidMinor = parsePhpMinor(amount);
        if (unassignedPaidMinor > availableMinor || paidMinor + unassignedPaidMinor > approvedMinor) {
          setError('The reconciled amount cannot exceed the older unassigned payouts or the total pay for this period.');
          return;
        }
      }
      const reconciledPaidMinor = paidMinor + unassignedPaidMinor;
      if (!window.confirm(
        `Confirm ${currency(approvedMinor / 100)} total pay for ${member.name} (${selectedPeriod.startDate} to ${selectedPeriod.endDate})?\n`
        + `Already paid: ${currency(reconciledPaidMinor / 100)}. Remaining: ${currency((approvedMinor - reconciledPaidMinor) / 100)}.\n`
        + 'This locks the payout limit. It does not record a payment.'
      )) return;

      await confirmPayrollPayoutLimit(clinicId, selectedPeriod.id, member.id, {
        approvedMinor, paidMinor: reconciledPaidMinor, unassignedPaidMinor
      }, payrollActor);
      if (isCurrent()) triggerToast(`Payout limit confirmed for ${member.name}.`);
    } catch (confirmationError) {
      if (!isCurrent()) return;
      console.error('[Staff & payroll] Failed to confirm payout limit:', confirmationError);
      await refreshLedger();
      if (isCurrent()) setError(confirmationError instanceof Error ? confirmationError.message : 'Could not confirm the payout limit.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleRecordPayout = async (member: StaffMember) => {
    if (!clinicId || !user || !selectedPeriodIsOpen || !selectedPeriod || !isCurrent()) return;

    const limit = limits?.[member.id];
    if (!limit) return;
    const remaining = (limit.approvedMinor - limit.paidMinor) / 100;

    if (remaining <= 0) {
      triggerToast('Nothing to release for this staff member in this period.');
      return;
    }
    if (!window.confirm(`Record a payout of ${currency(remaining)} to ${member.name}?`)) return;

    setIsWorking(true);
    setError('');
    try {
      const entry = await appendPayrollEntry({
        clinicId,
        actor: payrollActor,
        type: 'payout',
        direction: 'out',
        staff: member,
        amount: remaining,
        periodId: selectedPeriod.id,
        note: `Payroll ${selectedPeriod.startDate} to ${selectedPeriod.endDate}`
      });
      await showSavedEntry(entry);
      if (!isCurrent()) return;
      triggerToast(`Payout recorded for ${member.name}.`);
    } catch (payoutError) {
      if (!isCurrent()) return;
      console.error('[Staff & payroll] Failed to record payout:', payoutError);
      if (payoutError instanceof PayrollPayoutLimitError) await refreshLedger();
      setError(payoutError instanceof Error ? payoutError.message : 'Could not record the payout.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleVerifyChain = async () => {
    setChain(await verifyPayrollChain(entries, head));
    triggerToast('Ledger integrity check complete.');
  };

  if (isLoading) {
    return (
      <div className="py-20 flex items-center justify-center gap-3 text-content-hint">
        <Loader2 className="w-5 h-5 animate-spin text-brand-text" /> Loading staff records…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-content-heading">Staff &amp; Payroll</h2>
          <p className="text-content-hint font-medium">
            {clinicName || 'Clinic'} roster, pay rates, advances, and an append-only payroll ledger.
          </p>
        </div>
        {canEditRoster && (
          <button
            type="button"
            onClick={() => openStaffForm()}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-bold text-white hover:bg-slate-800"
          >
            <PlusCircle className="w-4 h-4" /> Add staff
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-danger-stroke bg-danger-wash px-4 py-3 text-sm text-danger-text-deep">
          {error}
        </div>
      )}

      {isDemo && (
        <div className="rounded-xl border border-warning-stroke bg-warning-wash px-4 py-3 text-sm text-warning-text-deep">
          Demo workspace: the roster is editable in memory, but payroll history needs a real clinic.
        </div>
      )}

      {showStaffForm && canEditRoster && (
        <form onSubmit={handleSaveStaff} className="bg-panel p-6 rounded-2xl border border-outline-soft shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-content-heading flex items-center gap-2">
              <Briefcase className="w-5 h-5 text-brand-text" />
              {staffDraft.id ? 'Edit staff member' : 'New staff member'}
            </h3>
            <button type="button" onClick={() => setShowStaffForm(false)} className="text-xs font-bold text-content-faint hover:text-content-copy">
              Cancel
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs font-bold text-content-secondary">
              Full name
              <input
                required
                maxLength={100}
                value={staffDraft.name}
                onChange={event => setStaffDraft({ ...staffDraft, name: event.target.value })}
                className="mt-1 w-full rounded-xl border border-field-outline bg-field-subtle px-3 py-2.5 text-sm font-medium text-content-title outline-none focus:ring-2 focus:ring-teal-500"
              />
            </label>
            <label className="text-xs font-bold text-content-secondary">
              Type
              <select
                value={staffDraft.kind}
                onChange={event => setStaffDraft({ ...staffDraft, kind: event.target.value as StaffKind })}
                className="mt-1 w-full rounded-xl border border-field-outline bg-field-subtle px-3 py-2.5 text-sm font-medium text-content-title outline-none"
              >
                <option value="veterinarian">Veterinarian</option>
                <option value="employee">Employee</option>
              </select>
            </label>
            <label className="text-xs font-bold text-content-secondary">
              Position
              <input
                value={staffDraft.position}
                onChange={event => setStaffDraft({ ...staffDraft, position: event.target.value })}
                placeholder="e.g. Veterinary Assistant"
                className="mt-1 w-full rounded-xl border border-field-outline bg-field-subtle px-3 py-2.5 text-sm font-medium text-content-title outline-none focus:ring-2 focus:ring-teal-500"
              />
            </label>
            <label className="text-xs font-bold text-content-secondary">
              Email
              <input
                type="email"
                value={staffDraft.email}
                onChange={event => setStaffDraft({ ...staffDraft, email: event.target.value })}
                className="mt-1 w-full rounded-xl border border-field-outline bg-field-subtle px-3 py-2.5 text-sm font-medium text-content-title outline-none focus:ring-2 focus:ring-teal-500"
              />
            </label>
            <label className="text-xs font-bold text-content-secondary">
              Phone
              <input
                value={staffDraft.phone}
                onChange={event => setStaffDraft({ ...staffDraft, phone: event.target.value })}
                className="mt-1 w-full rounded-xl border border-field-outline bg-field-subtle px-3 py-2.5 text-sm font-medium text-content-title outline-none focus:ring-2 focus:ring-teal-500"
              />
            </label>
            <label className="text-xs font-bold text-content-secondary">
              Hired on
              <input
                type="date"
                value={staffDraft.hiredAt}
                onChange={event => setStaffDraft({ ...staffDraft, hiredAt: event.target.value })}
                className="mt-1 w-full rounded-xl border border-field-outline bg-field-subtle px-3 py-2.5 text-sm font-medium text-content-title outline-none focus:ring-2 focus:ring-teal-500"
              />
            </label>

            {canManagePayroll && (
              <>
                <label className="text-xs font-bold text-content-secondary">
                  Pay basis
                  <select
                    value={staffDraft.payBasis}
                    onChange={event => setStaffDraft({ ...staffDraft, payBasis: event.target.value as StaffPayProfile['payBasis'] })}
                    className="mt-1 w-full rounded-xl border border-field-outline bg-field-subtle px-3 py-2.5 text-sm font-medium text-content-title outline-none"
                  >
                    <option value="daily">Daily</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </label>
                <label className="text-xs font-bold text-content-secondary">
                  Rate (PHP)
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={staffDraft.rate}
                    onChange={event => setStaffDraft({ ...staffDraft, rate: event.target.value })}
                    className="mt-1 w-full rounded-xl border border-field-outline bg-field-subtle px-3 py-2.5 text-sm font-medium text-content-title outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </label>
              </>
            )}
          </div>

          <label className="text-xs font-bold text-content-secondary block">
            Notes
            <textarea
              rows={2}
              value={staffDraft.notes}
              onChange={event => setStaffDraft({ ...staffDraft, notes: event.target.value })}
              className="mt-1 w-full rounded-xl border border-field-outline bg-field-subtle px-3 py-2.5 text-sm font-medium text-content-title outline-none focus:ring-2 focus:ring-teal-500"
            />
          </label>

          <label className="inline-flex items-center gap-2 text-xs font-bold text-content-secondary">
            <input
              type="checkbox"
              checked={staffDraft.active}
              onChange={event => setStaffDraft({ ...staffDraft, active: event.target.checked })}
              className="h-4 w-4 rounded border-outline text-brand-text"
            />
            Active
          </label>

          <button
            type="submit"
            disabled={isWorking}
            className="inline-flex items-center gap-2 rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {isWorking && <Loader2 className="w-4 h-4 animate-spin" />}
            {staffDraft.id ? 'Save changes' : 'Add to roster'}
          </button>
        </form>
      )}

      <div className="bg-panel rounded-2xl border border-outline-soft shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-hairline flex items-center justify-between">
          <h3 className="text-lg font-bold text-content-heading">Clinic roster</h3>
          <span className="text-xs font-bold text-content-faint">{activeStaff.length} active / {staff.length} total</span>
        </div>

        {staff.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-panel-subtle text-[10px] uppercase tracking-wider text-content-faint">
                <tr>
                  <th className="px-6 py-3 text-left">Name</th>
                  <th className="px-6 py-3 text-left">Type</th>
                  <th className="px-6 py-3 text-left">Position</th>
                  <th className="px-6 py-3 text-left">Contact</th>
                  {canManagePayroll && <th className="px-6 py-3 text-left">Pay</th>}
                  <th className="px-6 py-3 text-left">Status</th>
                  {canEditRoster && <th className="px-6 py-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {staff.map(member => {
                  const profile = profiles[member.id];
                  return (
                    <tr key={member.id} className={member.active ? '' : 'opacity-50'}>
                      <td className="px-6 py-3 font-bold text-content-heading">{member.name}</td>
                      <td className="px-6 py-3 text-content-secondary capitalize">{member.kind}</td>
                      <td className="px-6 py-3 text-content-secondary">{member.position || '-'}</td>
                      <td className="px-6 py-3 text-content-hint text-xs">
                        {member.email && <div>{member.email}</div>}
                        {member.phone && <div>{member.phone}</div>}
                        {!member.email && !member.phone && '-'}
                      </td>
                      {canManagePayroll && (
                        <td className="px-6 py-3 text-content-secondary">
                          {profile ? `${currency(profile.rate)} / ${profile.payBasis === 'monthly' ? 'month' : 'day'}` : '-'}
                        </td>
                      )}
                      <td className="px-6 py-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${member.active ? 'bg-success-wash text-success-text' : 'bg-panel-raised text-content-hint'}`}>
                          {member.active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      {canEditRoster && (
                        <td className="px-6 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => openStaffForm(member)}
                            className="text-xs font-bold text-brand-text-strong hover:text-brand-text-max"
                          >
                            Edit
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-6 py-8 text-sm text-content-hint">No staff yet. Add your veterinarians and employees to start tracking payroll.</p>
        )}
      </div>

      {canManagePayroll ? (
        <div className="space-y-6">
          <div className="bg-panel rounded-2xl border border-outline-soft shadow-sm">
            <div className="px-6 py-4 border-b border-hairline flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CalendarRange className="w-5 h-5 text-brand-text" />
                <h3 className="text-lg font-bold text-content-heading">Payroll periods</h3>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <select
                    value={selectedPeriodId}
                    onChange={event => setSelectedPeriodId(event.target.value)}
                    className="appearance-none rounded-xl border border-field-outline bg-field-panel px-3 py-2 pr-8 text-xs font-bold text-content-copy outline-none"
                  >
                    <option value="">Select a period</option>
                    {periods.map(period => (
                      <option key={period.id} value={period.id}>
                        {period.startDate} → {period.endDate} ({period.status})
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-2.5 w-4 h-4 text-content-faint" />
                </div>
                <button
                  type="button"
                  onClick={() => setShowPeriodForm(value => !value)}
                  className="inline-flex items-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-xs font-bold text-white hover:bg-slate-800"
                >
                  <PlusCircle className="w-3.5 h-3.5" /> New period
                </button>
                {selectedPeriod && selectedPeriod.status === 'open' && (
                  <button
                    type="button"
                    onClick={handleClosePeriod}
                    disabled={isWorking || limits === null || hasUnpaidLimit}
                    className="rounded-xl border border-outline-soft px-3 py-2 text-xs font-bold text-content-secondary hover:bg-panel-subtle disabled:opacity-50"
                  >
                    Close period
                  </button>
                )}
                {selectedPeriodIsOpen && hasUnpaidLimit && (
                  <span className="text-xs text-content-hint">Finish confirmed payouts before closing.</span>
                )}
              </div>
            </div>

            {showPeriodForm && (
              <form onSubmit={handleCreatePeriod} className="px-6 py-4 border-b border-hairline flex flex-wrap items-end gap-3 bg-panel-subtle">
                <label className="text-xs font-bold text-content-secondary">
                  Start
                  <input
                    type="date"
                    required
                    value={periodStart}
                    onChange={event => setPeriodStart(event.target.value)}
                    className="mt-1 block rounded-xl border border-field-outline bg-field-panel px-3 py-2 text-sm text-content-title outline-none"
                  />
                </label>
                <label className="text-xs font-bold text-content-secondary">
                  End
                  <input
                    type="date"
                    required
                    value={periodEnd}
                    onChange={event => setPeriodEnd(event.target.value)}
                    className="mt-1 block rounded-xl border border-field-outline bg-field-panel px-3 py-2 text-sm text-content-title outline-none"
                  />
                </label>
                <button
                  type="submit"
                  disabled={isWorking}
                  className="rounded-xl bg-teal-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  Create period
                </button>
              </form>
            )}

            {selectedPeriod ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-panel-subtle text-[10px] uppercase tracking-wider text-content-faint">
                    <tr>
                      <th className="px-6 py-3 text-left">Staff</th>
                      <th className="px-6 py-3 text-left">Basis</th>
                      <th className="px-6 py-3 text-right">Base pay</th>
                      <th className="px-6 py-3 text-right">Advances</th>
                      <th className="px-6 py-3 text-right">Paid</th>
                      <th className="px-6 py-3 text-right">Remaining payable</th>
                      <th className="px-6 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {activeStaff.map(member => {
                      const profile = profiles[member.id];
                      const calculated = payrollBalanceForPeriod(profile, selectedPeriod, entries, member.id);
                      const limit = limits?.[member.id];
                      const paid = (limit ? limit.paidMinor : calculated.paidMinor) / 100;
                      const remaining = limit ? (limit.approvedMinor - limit.paidMinor) / 100 : calculated.remaining;
                      return (
                        <tr key={member.id}>
                          <td className="px-6 py-3 font-bold text-content-heading">{member.name}</td>
                          <td className="px-6 py-3 text-content-hint text-xs">
                            {profile ? `${profile.payBasis === 'monthly' ? 'Monthly' : 'Daily'} · ${currency(profile.rate)}` : 'No rate set'}
                          </td>
                          <td className="px-6 py-3 text-right text-content-copy">{currency(calculated.base)}</td>
                          <td className="px-6 py-3 text-right text-content-copy">{currency(calculated.advance)}</td>
                          <td className="px-6 py-3 text-right text-content-copy">{currency(paid)}</td>
                          <td className="px-6 py-3 text-right font-bold text-content-title">{currency(remaining)}</td>
                          <td className="px-6 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => limit ? handleRecordPayout(member) : handleConfirmPayoutLimit(member)}
                              disabled={isWorking || !limits || remaining <= 0 || !selectedPeriodIsOpen}
                              className="text-xs font-bold text-brand-text-strong hover:text-brand-text-max disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {limit ? 'Record payout' : 'Confirm payout limit'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-6 py-8 text-sm text-content-hint">Create a payroll period to compute base pay and remaining pay.</p>
            )}
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <form onSubmit={handleAddLedgerEntry} className="bg-panel p-6 rounded-2xl border border-outline-soft shadow-sm space-y-3 h-fit">
              <h3 className="text-lg font-bold text-content-heading flex items-center gap-2">
                <Wallet className="w-5 h-5 text-brand-text" /> Cash in / out
              </h3>
              <p className="text-xs text-content-hint leading-relaxed">
                Record advances, repayments, payouts, or corrections. Confirm the staff member’s payout limit above before recording a salary payout. Posted entries cannot be edited.
              </p>

              <label className="text-xs font-bold text-content-secondary block">
                Staff
                <select
                  required
                  value={ledgerStaffId}
                  onChange={event => setLedgerStaffId(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-field-outline bg-field-subtle px-3 py-2.5 text-sm text-content-title outline-none"
                >
                  <option value="">Select staff</option>
                  {activeStaff.map(member => (
                    <option key={member.id} value={member.id}>{member.name}</option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-content-secondary block">
                  Entry type
                  <select
                    value={ledgerType}
                    onChange={event => setLedgerType(event.target.value as PayrollEntryType)}
                    className="mt-1 w-full rounded-xl border border-field-outline bg-field-subtle px-3 py-2.5 text-sm text-content-title outline-none"
                  >
                    <option value="advance">Cash advance</option>
                    <option value="repayment">Repayment</option>
                    <option value="payout">Salary payout</option>
                    <option value="adjustment">Adjustment</option>
                  </select>
                </label>
                <label className="text-xs font-bold text-content-secondary block">
                  Amount (PHP)
                  <input
                    type="number"
                    required
                    min="0.01"
                    step="0.01"
                    value={ledgerAmount}
                    onChange={event => setLedgerAmount(event.target.value)}
                    className="mt-1 w-full rounded-xl border border-field-outline bg-field-subtle px-3 py-2.5 text-sm text-content-title outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </label>
              </div>

              {ledgerType === 'adjustment' && (
                <label className="text-xs font-bold text-content-secondary block">
                  Direction
                  <select
                    value={ledgerDirection}
                    onChange={event => setLedgerDirection(event.target.value as 'in' | 'out')}
                    className="mt-1 w-full rounded-xl border border-field-outline bg-field-subtle px-3 py-2.5 text-sm text-content-title outline-none"
                  >
                    <option value="out">Cash out</option>
                    <option value="in">Cash in</option>
                  </select>
                </label>
              )}

              <label className="text-xs font-bold text-content-secondary block">
                Note
                <input
                  value={ledgerNote}
                  onChange={event => setLedgerNote(event.target.value)}
                  placeholder="e.g. Advance for school fees"
                  className="mt-1 w-full rounded-xl border border-field-outline bg-field-subtle px-3 py-2.5 text-sm text-content-title outline-none focus:ring-2 focus:ring-teal-500"
                />
              </label>

              <button
                type="submit"
                disabled={isWorking || (ledgerType === 'payout' && !selectedPeriodIsOpen)}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-teal-700 disabled:opacity-50"
              >
                {isWorking && <Loader2 className="w-4 h-4 animate-spin" />}
                Record entry
              </button>
            </form>

            <div className="xl:col-span-2 bg-panel rounded-2xl border border-outline-soft shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-hairline flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-bold text-content-heading">Ledger history</h3>
                <button
                  type="button"
                  onClick={handleVerifyChain}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-outline-soft px-3 py-1.5 text-xs font-bold text-content-secondary hover:bg-panel-subtle"
                >
                  <ShieldCheck className="w-3.5 h-3.5" /> Verify integrity
                </button>
              </div>

              {chain && (
                <div className={`mx-6 mt-4 rounded-xl px-3 py-2 text-xs font-bold inline-flex items-center gap-2 ${chain.ok ? 'bg-success-wash text-success-text' : 'bg-danger-wash text-danger-text'}`}>
                  {chain.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                  {chain.ok
                    ? `Chain verified · ${chain.count} entries`
                    : `Chain broken at entry #${chain.brokenAt}: ${chain.reason}`}
                </div>
              )}

              {recentEntries.length ? (
                <div className="overflow-x-auto mt-4">
                  <table className="w-full text-sm">
                    <thead className="bg-panel-subtle text-[10px] uppercase tracking-wider text-content-faint">
                      <tr>
                        <th className="px-6 py-3 text-left">#</th>
                        <th className="px-6 py-3 text-left">Staff</th>
                        <th className="px-6 py-3 text-left">Type</th>
                        <th className="px-6 py-3 text-right">Amount</th>
                        <th className="px-6 py-3 text-left">Note</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                      {recentEntries.map(entry => (
                        <tr key={entry.id}>
                          <td className="px-6 py-3 text-xs font-mono text-content-faint">{entry.seq}</td>
                          <td className="px-6 py-3 font-bold text-content-heading">{entry.staffName}</td>
                          <td className="px-6 py-3 text-content-secondary capitalize">
                            {entry.type} <span className="text-[10px] uppercase text-content-faint">({entry.direction})</span>
                          </td>
                          <td className={`px-6 py-3 text-right font-bold ${entry.direction === 'out' ? 'text-danger-icon' : 'text-success-icon'}`}>
                            {entry.direction === 'out' ? '-' : '+'}{currency(entry.amount)}
                          </td>
                          <td className="px-6 py-3 text-xs text-content-hint">{entry.note || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="px-6 py-8 text-sm text-content-hint">No ledger entries yet.</p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-outline-soft bg-panel px-6 py-5 text-sm text-content-hint flex items-center gap-2">
          <BadgeCheck className="w-4 h-4 text-content-faint" />
          Payroll requires a connected clinic.
        </div>
      )}
    </div>
  );
};
