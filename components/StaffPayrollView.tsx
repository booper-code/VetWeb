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
import {
  advanceBalanceForStaff,
  appendPayrollEntry,
  basePayForPeriod,
  closePayrollPeriod,
  createPayrollPeriod,
  getPayrollHead,
  listPayProfiles,
  listPayrollEntries,
  listPayrollPeriods,
  listStaff,
  savePayProfile,
  saveStaffMember,
  verifyPayrollChain,
  type ChainVerification,
  type PayrollHead
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
  triggerToast
}: {
  clinicId: string | null;
  clinicName: string;
  user: ClinicSessionUser | null;
  role: ClinicRole | null;
  isDemo: boolean;
  triggerToast: (msg: string) => void;
}) => {
  const isOwner = role === 'owner' && !isDemo;
  const canEditRoster = isDemo || role === 'owner' || role === 'editor';

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

        if (isOwner) {
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
  }, [clinicId, isDemo, isOwner]);

  const activeStaff = useMemo(() => staff.filter(member => member.active), [staff]);
  const selectedPeriod = periods.find(period => period.id === selectedPeriodId) ?? null;
  const selectedPeriodIsOpen = selectedPeriod?.status === 'open';

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
    if (!staffDraft.name.trim()) {
      setError('Enter the staff member’s name.');
      return;
    }

    setIsWorking(true);
    setError('');

    try {
      if (isDemo) {
        const localMember: StaffMember = {
          id: staffDraft.id ?? `demo-staff-${Date.now()}`,
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
        const saved = await saveStaffMember(clinicId, {
          id: staffDraft.id,
          name: staffDraft.name,
          kind: staffDraft.kind,
          position: staffDraft.position,
          email: staffDraft.email,
          phone: staffDraft.phone,
          active: staffDraft.active,
          hiredAt: staffDraft.hiredAt,
          notes: staffDraft.notes
        });

        setStaff(previous =>
          staffDraft.id ? previous.map(member => (member.id === saved.id ? saved : member)) : [...previous, saved]
        );

        if (isOwner) {
          const rate = Number(staffDraft.rate);
          if (staffDraft.rate.trim() && Number.isFinite(rate) && rate >= 0) {
            await savePayProfile(clinicId, saved.id, { payBasis: staffDraft.payBasis, rate });
            setProfiles(previous => ({ ...previous, [saved.id]: { payBasis: staffDraft.payBasis, rate } }));
          }
        }
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
    if (!clinicId) return;

    setIsWorking(true);
    setError('');
    try {
      const period = await createPayrollPeriod(clinicId, periodStart, periodEnd);
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
    if (!clinicId || !selectedPeriod) return;
    if (!window.confirm(`Close payroll for ${selectedPeriod.startDate} to ${selectedPeriod.endDate}? New entries can still be recorded, but the period is marked closed.`)) {
      return;
    }

    setIsWorking(true);
    try {
      await closePayrollPeriod(clinicId, selectedPeriod.id);
      setPeriods(previous =>
        previous.map(period => (period.id === selectedPeriod.id ? { ...period, status: 'closed' } : period))
      );
      triggerToast('Payroll period closed.');
    } catch (closeError) {
      console.error('[Staff & payroll] Failed to close period:', closeError);
      setError(closeError instanceof Error ? closeError.message : 'Could not close the payroll period.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleAddLedgerEntry = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!clinicId || !user) return;

    const member = staff.find(item => item.id === ledgerStaffId);
    if (!member) {
      setError('Choose a staff member.');
      return;
    }

    setIsWorking(true);
    setError('');
    try {
      const entry = await appendPayrollEntry({
        clinicId,
        user,
        type: ledgerType,
        direction: ledgerType === 'adjustment' ? ledgerDirection : ledgerType === 'repayment' ? 'in' : 'out',
        staff: member,
        amount: Number(ledgerAmount),
        periodId: selectedPeriod?.id,
        note: ledgerNote
      });

      const nextEntries = [...entries, entry];
      const nextHead = { seq: entry.seq, hash: entry.hash };
      setEntries(nextEntries);
      setHead(nextHead);
      setChain(await verifyPayrollChain(nextEntries, nextHead));
      setLedgerAmount('');
      setLedgerNote('');
      triggerToast('Ledger entry recorded.');
    } catch (entryError) {
      console.error('[Staff & payroll] Failed to append ledger entry:', entryError);
      setError(entryError instanceof Error ? entryError.message : 'Could not record the ledger entry.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleRecordPayout = async (member: StaffMember) => {
    if (!clinicId || !user || !selectedPeriod) return;

    const profile = profiles[member.id];
    const base = basePayForPeriod(profile, selectedPeriod);
    const advance = advanceBalanceForStaff(entries, member.id);
    const net = Math.max(base - advance, 0);

    if (net <= 0) {
      triggerToast('Nothing to release for this staff member in this period.');
      return;
    }
    if (!window.confirm(`Record a payout of ${currency(net)} to ${member.name}?`)) return;

    setIsWorking(true);
    try {
      const entry = await appendPayrollEntry({
        clinicId,
        user,
        type: 'payout',
        direction: 'out',
        staff: member,
        amount: net,
        periodId: selectedPeriod.id,
        note: `Payroll ${selectedPeriod.startDate} to ${selectedPeriod.endDate}`
      });
      const nextEntries = [...entries, entry];
      const nextHead = { seq: entry.seq, hash: entry.hash };
      setEntries(nextEntries);
      setHead(nextHead);
      setChain(await verifyPayrollChain(nextEntries, nextHead));
      triggerToast(`Payout recorded for ${member.name}.`);
    } catch (payoutError) {
      console.error('[Staff & payroll] Failed to record payout:', payoutError);
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

            {isOwner && (
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
                  {isOwner && <th className="px-6 py-3 text-left">Pay</th>}
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
                      {isOwner && (
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

      {isOwner ? (
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
                    disabled={isWorking}
                    className="rounded-xl border border-outline-soft px-3 py-2 text-xs font-bold text-content-secondary hover:bg-panel-subtle disabled:opacity-50"
                  >
                    Close period
                  </button>
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
                      <th className="px-6 py-3 text-right">Net</th>
                      <th className="px-6 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {activeStaff.map(member => {
                      const profile = profiles[member.id];
                      const base = basePayForPeriod(profile, selectedPeriod);
                      const advance = advanceBalanceForStaff(entries, member.id);
                      const net = base - advance;
                      return (
                        <tr key={member.id}>
                          <td className="px-6 py-3 font-bold text-content-heading">{member.name}</td>
                          <td className="px-6 py-3 text-content-hint text-xs">
                            {profile ? `${profile.payBasis === 'monthly' ? 'Monthly' : 'Daily'} · ${currency(profile.rate)}` : 'No rate set'}
                          </td>
                          <td className="px-6 py-3 text-right text-content-copy">{currency(base)}</td>
                          <td className="px-6 py-3 text-right text-content-copy">{currency(advance)}</td>
                          <td className={`px-6 py-3 text-right font-bold ${net < 0 ? 'text-danger-icon' : 'text-content-title'}`}>{currency(net)}</td>
                          <td className="px-6 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => handleRecordPayout(member)}
                              disabled={isWorking || net <= 0 || !selectedPeriodIsOpen}
                              className="text-xs font-bold text-brand-text-strong hover:text-brand-text-max disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              Record payout
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-6 py-8 text-sm text-content-hint">Create a payroll period to compute base pay and net release.</p>
            )}
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <form onSubmit={handleAddLedgerEntry} className="bg-panel p-6 rounded-2xl border border-outline-soft shadow-sm space-y-3 h-fit">
              <h3 className="text-lg font-bold text-content-heading flex items-center gap-2">
                <Wallet className="w-5 h-5 text-brand-text" /> Cash in / out
              </h3>
              <p className="text-xs text-content-hint leading-relaxed">
                Record advances before payday, repayments, payouts, or corrections. Every entry is appended to the ledger and cannot be edited.
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
                disabled={isWorking}
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
          Payroll is visible to the clinic owner only.
        </div>
      )}
    </div>
  );
};
