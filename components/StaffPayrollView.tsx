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
      <div className="py-20 flex items-center justify-center gap-3 text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin text-teal-600" /> Loading staff records…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Staff &amp; Payroll</h2>
          <p className="text-slate-500 font-medium">
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
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {isDemo && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Demo workspace: the roster is editable in memory, but payroll history needs a real clinic.
        </div>
      )}

      {showStaffForm && canEditRoster && (
        <form onSubmit={handleSaveStaff} className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <Briefcase className="w-5 h-5 text-teal-600" />
              {staffDraft.id ? 'Edit staff member' : 'New staff member'}
            </h3>
            <button type="button" onClick={() => setShowStaffForm(false)} className="text-xs font-bold text-slate-400 hover:text-slate-700">
              Cancel
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs font-bold text-slate-600">
              Full name
              <input
                required
                maxLength={100}
                value={staffDraft.name}
                onChange={event => setStaffDraft({ ...staffDraft, name: event.target.value })}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-900 outline-none focus:ring-2 focus:ring-teal-500"
              />
            </label>
            <label className="text-xs font-bold text-slate-600">
              Type
              <select
                value={staffDraft.kind}
                onChange={event => setStaffDraft({ ...staffDraft, kind: event.target.value as StaffKind })}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-900 outline-none"
              >
                <option value="veterinarian">Veterinarian</option>
                <option value="employee">Employee</option>
              </select>
            </label>
            <label className="text-xs font-bold text-slate-600">
              Position
              <input
                value={staffDraft.position}
                onChange={event => setStaffDraft({ ...staffDraft, position: event.target.value })}
                placeholder="e.g. Veterinary Assistant"
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-900 outline-none focus:ring-2 focus:ring-teal-500"
              />
            </label>
            <label className="text-xs font-bold text-slate-600">
              Email
              <input
                type="email"
                value={staffDraft.email}
                onChange={event => setStaffDraft({ ...staffDraft, email: event.target.value })}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-900 outline-none focus:ring-2 focus:ring-teal-500"
              />
            </label>
            <label className="text-xs font-bold text-slate-600">
              Phone
              <input
                value={staffDraft.phone}
                onChange={event => setStaffDraft({ ...staffDraft, phone: event.target.value })}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-900 outline-none focus:ring-2 focus:ring-teal-500"
              />
            </label>
            <label className="text-xs font-bold text-slate-600">
              Hired on
              <input
                type="date"
                value={staffDraft.hiredAt}
                onChange={event => setStaffDraft({ ...staffDraft, hiredAt: event.target.value })}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-900 outline-none focus:ring-2 focus:ring-teal-500"
              />
            </label>

            {isOwner && (
              <>
                <label className="text-xs font-bold text-slate-600">
                  Pay basis
                  <select
                    value={staffDraft.payBasis}
                    onChange={event => setStaffDraft({ ...staffDraft, payBasis: event.target.value as StaffPayProfile['payBasis'] })}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-900 outline-none"
                  >
                    <option value="daily">Daily</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </label>
                <label className="text-xs font-bold text-slate-600">
                  Rate (PHP)
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={staffDraft.rate}
                    onChange={event => setStaffDraft({ ...staffDraft, rate: event.target.value })}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-900 outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </label>
              </>
            )}
          </div>

          <label className="text-xs font-bold text-slate-600 block">
            Notes
            <textarea
              rows={2}
              value={staffDraft.notes}
              onChange={event => setStaffDraft({ ...staffDraft, notes: event.target.value })}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-900 outline-none focus:ring-2 focus:ring-teal-500"
            />
          </label>

          <label className="inline-flex items-center gap-2 text-xs font-bold text-slate-600">
            <input
              type="checkbox"
              checked={staffDraft.active}
              onChange={event => setStaffDraft({ ...staffDraft, active: event.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-teal-600"
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

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-800">Clinic roster</h3>
          <span className="text-xs font-bold text-slate-400">{activeStaff.length} active / {staff.length} total</span>
        </div>

        {staff.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
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
              <tbody className="divide-y divide-slate-100">
                {staff.map(member => {
                  const profile = profiles[member.id];
                  return (
                    <tr key={member.id} className={member.active ? '' : 'opacity-50'}>
                      <td className="px-6 py-3 font-bold text-slate-800">{member.name}</td>
                      <td className="px-6 py-3 text-slate-600 capitalize">{member.kind}</td>
                      <td className="px-6 py-3 text-slate-600">{member.position || '-'}</td>
                      <td className="px-6 py-3 text-slate-500 text-xs">
                        {member.email && <div>{member.email}</div>}
                        {member.phone && <div>{member.phone}</div>}
                        {!member.email && !member.phone && '-'}
                      </td>
                      {isOwner && (
                        <td className="px-6 py-3 text-slate-600">
                          {profile ? `${currency(profile.rate)} / ${profile.payBasis === 'monthly' ? 'month' : 'day'}` : '-'}
                        </td>
                      )}
                      <td className="px-6 py-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${member.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                          {member.active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      {canEditRoster && (
                        <td className="px-6 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => openStaffForm(member)}
                            className="text-xs font-bold text-teal-700 hover:text-teal-900"
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
          <p className="px-6 py-8 text-sm text-slate-500">No staff yet. Add your veterinarians and employees to start tracking payroll.</p>
        )}
      </div>

      {isOwner ? (
        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
            <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CalendarRange className="w-5 h-5 text-teal-600" />
                <h3 className="text-lg font-bold text-slate-800">Payroll periods</h3>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <select
                    value={selectedPeriodId}
                    onChange={event => setSelectedPeriodId(event.target.value)}
                    className="appearance-none rounded-xl border border-slate-200 bg-white px-3 py-2 pr-8 text-xs font-bold text-slate-700 outline-none"
                  >
                    <option value="">Select a period</option>
                    {periods.map(period => (
                      <option key={period.id} value={period.id}>
                        {period.startDate} → {period.endDate} ({period.status})
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-2.5 w-4 h-4 text-slate-400" />
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
                    className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Close period
                  </button>
                )}
              </div>
            </div>

            {showPeriodForm && (
              <form onSubmit={handleCreatePeriod} className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-end gap-3 bg-slate-50">
                <label className="text-xs font-bold text-slate-600">
                  Start
                  <input
                    type="date"
                    required
                    value={periodStart}
                    onChange={event => setPeriodStart(event.target.value)}
                    className="mt-1 block rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none"
                  />
                </label>
                <label className="text-xs font-bold text-slate-600">
                  End
                  <input
                    type="date"
                    required
                    value={periodEnd}
                    onChange={event => setPeriodEnd(event.target.value)}
                    className="mt-1 block rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none"
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
                  <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="px-6 py-3 text-left">Staff</th>
                      <th className="px-6 py-3 text-left">Basis</th>
                      <th className="px-6 py-3 text-right">Base pay</th>
                      <th className="px-6 py-3 text-right">Advances</th>
                      <th className="px-6 py-3 text-right">Net</th>
                      <th className="px-6 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {activeStaff.map(member => {
                      const profile = profiles[member.id];
                      const base = basePayForPeriod(profile, selectedPeriod);
                      const advance = advanceBalanceForStaff(entries, member.id);
                      const net = base - advance;
                      return (
                        <tr key={member.id}>
                          <td className="px-6 py-3 font-bold text-slate-800">{member.name}</td>
                          <td className="px-6 py-3 text-slate-500 text-xs">
                            {profile ? `${profile.payBasis === 'monthly' ? 'Monthly' : 'Daily'} · ${currency(profile.rate)}` : 'No rate set'}
                          </td>
                          <td className="px-6 py-3 text-right text-slate-700">{currency(base)}</td>
                          <td className="px-6 py-3 text-right text-slate-700">{currency(advance)}</td>
                          <td className={`px-6 py-3 text-right font-bold ${net < 0 ? 'text-red-600' : 'text-slate-900'}`}>{currency(net)}</td>
                          <td className="px-6 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => handleRecordPayout(member)}
                              disabled={isWorking || net <= 0 || !selectedPeriodIsOpen}
                              className="text-xs font-bold text-teal-700 hover:text-teal-900 disabled:opacity-40 disabled:cursor-not-allowed"
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
              <p className="px-6 py-8 text-sm text-slate-500">Create a payroll period to compute base pay and net release.</p>
            )}
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <form onSubmit={handleAddLedgerEntry} className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-3 h-fit">
              <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                <Wallet className="w-5 h-5 text-teal-600" /> Cash in / out
              </h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                Record advances before payday, repayments, payouts, or corrections. Every entry is appended to the ledger and cannot be edited.
              </p>

              <label className="text-xs font-bold text-slate-600 block">
                Staff
                <select
                  required
                  value={ledgerStaffId}
                  onChange={event => setLedgerStaffId(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none"
                >
                  <option value="">Select staff</option>
                  {activeStaff.map(member => (
                    <option key={member.id} value={member.id}>{member.name}</option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-slate-600 block">
                  Entry type
                  <select
                    value={ledgerType}
                    onChange={event => setLedgerType(event.target.value as PayrollEntryType)}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none"
                  >
                    <option value="advance">Cash advance</option>
                    <option value="repayment">Repayment</option>
                    <option value="payout">Salary payout</option>
                    <option value="adjustment">Adjustment</option>
                  </select>
                </label>
                <label className="text-xs font-bold text-slate-600 block">
                  Amount (PHP)
                  <input
                    type="number"
                    required
                    min="0.01"
                    step="0.01"
                    value={ledgerAmount}
                    onChange={event => setLedgerAmount(event.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </label>
              </div>

              {ledgerType === 'adjustment' && (
                <label className="text-xs font-bold text-slate-600 block">
                  Direction
                  <select
                    value={ledgerDirection}
                    onChange={event => setLedgerDirection(event.target.value as 'in' | 'out')}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none"
                  >
                    <option value="out">Cash out</option>
                    <option value="in">Cash in</option>
                  </select>
                </label>
              )}

              <label className="text-xs font-bold text-slate-600 block">
                Note
                <input
                  value={ledgerNote}
                  onChange={event => setLedgerNote(event.target.value)}
                  placeholder="e.g. Advance for school fees"
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-teal-500"
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

            <div className="xl:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-bold text-slate-800">Ledger history</h3>
                <button
                  type="button"
                  onClick={handleVerifyChain}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
                >
                  <ShieldCheck className="w-3.5 h-3.5" /> Verify integrity
                </button>
              </div>

              {chain && (
                <div className={`mx-6 mt-4 rounded-xl px-3 py-2 text-xs font-bold inline-flex items-center gap-2 ${chain.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                  {chain.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                  {chain.ok
                    ? `Chain verified · ${chain.count} entries`
                    : `Chain broken at entry #${chain.brokenAt}: ${chain.reason}`}
                </div>
              )}

              {recentEntries.length ? (
                <div className="overflow-x-auto mt-4">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
                      <tr>
                        <th className="px-6 py-3 text-left">#</th>
                        <th className="px-6 py-3 text-left">Staff</th>
                        <th className="px-6 py-3 text-left">Type</th>
                        <th className="px-6 py-3 text-right">Amount</th>
                        <th className="px-6 py-3 text-left">Note</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {recentEntries.map(entry => (
                        <tr key={entry.id}>
                          <td className="px-6 py-3 text-xs font-mono text-slate-400">{entry.seq}</td>
                          <td className="px-6 py-3 font-bold text-slate-800">{entry.staffName}</td>
                          <td className="px-6 py-3 text-slate-600 capitalize">
                            {entry.type} <span className="text-[10px] uppercase text-slate-400">({entry.direction})</span>
                          </td>
                          <td className={`px-6 py-3 text-right font-bold ${entry.direction === 'out' ? 'text-red-600' : 'text-emerald-600'}`}>
                            {entry.direction === 'out' ? '-' : '+'}{currency(entry.amount)}
                          </td>
                          <td className="px-6 py-3 text-xs text-slate-500">{entry.note || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="px-6 py-8 text-sm text-slate-500">No ledger entries yet.</p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white px-6 py-5 text-sm text-slate-500 flex items-center gap-2">
          <BadgeCheck className="w-4 h-4 text-slate-400" />
          Payroll is visible to the clinic owner only.
        </div>
      )}
    </div>
  );
};
