"use client";

import { CalendarDays, Package, PawPrint, Plus } from 'lucide-react';
import type { Appointment, Consultation, InventoryItem, PatientRecord } from '@/types';

type WorkspaceView = 'quick' | 'advanced';

const startOfToday = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
};

const startOfTomorrow = () => startOfToday() + 24 * 60 * 60 * 1000;

const formatMoney = (amount: number) => `PHP ${amount.toFixed(2)}`;

const formatWhen = (iso: string) => {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso;
  return value.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

const appointmentStatus = (appointment: Appointment, today: number) => {
  if (appointment.status !== 'scheduled') return appointment.status;
  return new Date(appointment.dueAt).getTime() < today ? 'overdue' : 'scheduled';
};

const statusClass = (status: string) => {
  if (status === 'overdue' || status === 'no-show' || status === 'cancelled') return 'vc-badge vc-badge-red';
  if (status === 'completed') return 'vc-badge vc-badge-teal';
  if (status === 'scheduled') return 'vc-badge vc-badge-teal';
  return 'vc-badge';
};

export const DashboardHome = ({
  patients,
  inventory,
  consultations,
  appointments = [],
  onToggleStatus,
  partialData = false,
  mode = 'quick',
  clinicName = '',
  canEdit = false,
  onNavigate,
  onRecordVisit,
  onOpenPatient,
  onOpenAppointments,
  onRefreshAppointments,
  appointmentsBusy = false,
  appointmentsError = '',
  appointmentsPartial = false,
  appointmentsFromCache = false,
  appointmentsRange = ''
}: {
  patients: PatientRecord[];
  inventory: InventoryItem[];
  consultations: Consultation[];
  appointments?: Appointment[];
  onToggleStatus: (id: string) => void;
  partialData?: boolean;
  mode?: WorkspaceView;
  clinicName?: string;
  canEdit?: boolean;
  onNavigate?: (tab: string) => void;
  onRecordVisit?: () => void;
  onOpenPatient?: (id: string) => void;
  onOpenAppointments?: () => void;
  onRefreshAppointments?: () => void;
  appointmentsBusy?: boolean;
  appointmentsError?: string;
  appointmentsPartial?: boolean;
  appointmentsFromCache?: boolean;
  appointmentsRange?: string;
}) => {
  const todayLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date());
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const today = startOfToday();
  const tomorrow = startOfTomorrow();
  const isAdvanced = mode === 'advanced';

  const activePatients = patients.filter(patient => patient.status !== 'Discharged');
  const waitingPatients = patients.filter(patient => patient.status === 'Waiting');
  const treatmentPatients = patients.filter(patient => patient.status === 'In Treatment');
  const confinedPatients = patients.filter(patient => patient.status === 'Confined');
  const dischargedPatients = patients.filter(patient => patient.status === 'Discharged');
  const draftConsultations = consultations.filter(consultation => consultation.status === 'Draft');

  const lowStockItems = inventory.filter(item =>
    item.category !== 'Service' &&
    item.category !== 'Grooming' &&
    item.threshold > 0 &&
    item.stock <= item.threshold
  );

  const patientsWithBalance = patients.filter(patient => patient.balance > 0);
  const totalReceivables = patients.reduce((sum, patient) => sum + patient.balance, 0);

  const dueAppointments = appointments
    .filter(appointment =>
      appointment.status === 'scheduled' &&
      new Date(appointment.dueAt).getTime() < tomorrow
    )
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  const overdueCount = dueAppointments.filter(
    appointment => new Date(appointment.dueAt).getTime() < today
  ).length;

  const recentConsultations = consultations.slice(-5).reverse();
  const recentLegacyConsultations = recentConsultations.filter(item => !item.patientId);

  const recentBillables = patients
    .flatMap(patient => (patient.billableItems || []).map(billable => ({
      ...billable,
      patientName: patient.name,
      patientId: patient.id
    })))
    .slice(-5)
    .reverse();

  const go = (tab: string) => () => onNavigate?.(tab);

  const openAppointments = () => {
    if (onOpenAppointments) onOpenAppointments();
    else onNavigate?.('appointments');
  };

  const openPatient = (id: string) => {
    if (onOpenPatient) onOpenPatient(id);
    else onNavigate?.('patients');
  };

  const scheduleMeta = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="vc-note">
        Loaded schedule only{appointmentsRange ? ` · ${appointmentsRange}` : ''}
        {appointmentsPartial ? ' · More pages available' : ''}
        {appointmentsFromCache ? ' · Cached snapshot, may be incomplete' : ''}.
      </p>
      {onRefreshAppointments && (
        <button type="button" onClick={onRefreshAppointments} disabled={appointmentsBusy} className="vc-btn vc-btn-sm">
          Refresh appointments
        </button>
      )}
    </div>
  );

  const scheduleMessage = (
    <>
      {appointmentsBusy && <p role="status" className="vc-note">Loading appointments…</p>}
      {appointmentsError && (
        <p role="alert" className="rounded-[10px] border border-danger-stroke bg-danger-wash p-3 text-[12px] text-danger-text-max">
          {appointmentsError}
        </p>
      )}
    </>
  );

  const visitsList = (limit: number) => {
    const rows = dueAppointments.slice(0, limit);
    if (!rows.length) {
      return <p className="vc-empty">No visits are currently due or overdue in the loaded schedule.</p>;
    }
    return (
      <div className="vc-clean-list">
        {rows.map(appointment => {
          const status = appointmentStatus(appointment, today);
          return (
            <div key={appointment.id} className="vc-clean-row">
              <div className="vc-clean-item">
                <strong>
                  {appointment.patientName}
                  <span className="vc-muted"> · {appointment.type}</span>
                </strong>
                <p>{formatWhen(appointment.dueAt)} · {appointment.ownerName}</p>
              </div>
              <div className="vc-clean-actions">
                <span className={statusClass(status)}>{status}</span>
                <button type="button" onClick={openAppointments} className="vc-btn vc-btn-sm">
                  Open
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const attentionList = (limit: number) => {
    const stockRows = lowStockItems.slice(0, limit);
    const balanceRows = patientsWithBalance.slice(0, Math.max(0, limit - stockRows.length));
    if (!stockRows.length && !balanceRows.length) {
      return <p className="vc-empty">No stock or balance alerts in the loaded records.</p>;
    }
    return (
      <div className="vc-clean-list">
        {stockRows.map(item => (
          <div key={`stock-${item.itemCode}`} className="vc-clean-row">
            <div className="vc-clean-item">
              <strong>{item.itemName}</strong>
              <p>{item.stock} remaining · reorder threshold {item.threshold}</p>
            </div>
            <div className="vc-clean-actions">
              <span className="vc-badge vc-badge-red">Low stock</span>
              <button type="button" onClick={go('inventory')} className="vc-btn vc-btn-sm">
                View stock
              </button>
            </div>
          </div>
        ))}
        {balanceRows.map(patient => (
          <div key={`balance-${patient.id}`} className="vc-clean-row">
            <div className="vc-clean-item">
              <strong>
                {patient.name}
                <span className="vc-muted"> · {patient.ownerName}</span>
              </strong>
              <p>Outstanding balance: {formatMoney(patient.balance)}</p>
            </div>
            <div className="vc-clean-actions">
              <button type="button" onClick={() => openPatient(patient.id)} className="vc-btn vc-btn-sm">
                Open patient
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  };

  if (!isAdvanced) {
    return (
      <div className="flex flex-col gap-[17px]">
        {partialData && (
          <p role="note" className="rounded-[12px] border border-warning-stroke bg-warning-wash p-3 text-[12.5px] text-warning-text-deep">
            Loaded-page summary only, not clinic-wide totals. Patient history, inventory and
            consultations load in bounded pages.
          </p>
        )}

        <div className="vc-page-heading">
          <div>
            <div className="vc-kicker">Welcome to your clinic</div>
            <h1>Good day. What needs doing?</h1>
            <p suppressHydrationWarning>
              {clinicName || 'Clinic workspace'}
              {todayLabel ? ` · ${todayLabel}` : ''}
              {timezone ? ` · ${timezone}` : ''}
            </p>
          </div>
        </div>

        <div className="vc-action-grid" aria-label="Common clinic tasks">
          <button type="button" onClick={onRecordVisit} disabled={!canEdit} className="vc-action-card">
            <span className="vc-action-icon" aria-hidden="true"><Plus className="h-5 w-5" /></span>
            <strong>Record a visit</strong>
            <span className="vc-action-desc">Open the patient record to enter completed work, even from an earlier date.</span>
          </button>
          <button type="button" onClick={go('patients')} className="vc-action-card">
            <span className="vc-action-icon" aria-hidden="true"><PawPrint className="h-5 w-5" /></span>
            <strong>Find a patient</strong>
            <span className="vc-action-desc">Open their medical and owner information.</span>
          </button>
          <button type="button" onClick={go('appointments')} disabled={!canEdit} className="vc-action-card">
            <span className="vc-action-icon" aria-hidden="true"><CalendarDays className="h-5 w-5" /></span>
            <strong>Book an appointment</strong>
            <span className="vc-action-desc">Create or reschedule a clinic visit.</span>
          </button>
          <button type="button" onClick={go('inventory')} className="vc-action-card">
            <span className="vc-action-icon" aria-hidden="true"><Package className="h-5 w-5" /></span>
            <strong>Check stock</strong>
            <span className="vc-action-desc">Find supplies and see low-stock alerts.</span>
          </button>
        </div>

        <div className="vc-dual">
          <section className="vc-card vc-section">
            <div className="vc-section-head">
              <div>
                <h2>Visits needing attention</h2>
                <p>{dueAppointments.length} due or overdue in the loaded schedule</p>
              </div>
              <button type="button" onClick={openAppointments} className="vc-btn vc-btn-sm">All appointments</button>
            </div>
            {scheduleMeta}
            {scheduleMessage}
            {visitsList(4)}
          </section>

          <section className="vc-card vc-section">
            <div className="vc-section-head">
              <div>
                <h2>Things to review</h2>
                <p>Stock levels and loaded balances</p>
              </div>
              <button type="button" onClick={go('patients')} className="vc-btn vc-btn-sm">Patient directory</button>
            </div>
            {attentionList(4)}
          </section>
        </div>

        <div className="vc-bottom-strip">
          <span className="vc-led" aria-hidden="true" />
          <div>
            <strong>Need to enter several visits?</strong>
            <p>Open a patient, record the work, and review it before saving. Dates are always entered explicitly.</p>
          </div>
          <button type="button" onClick={onRecordVisit} disabled={!canEdit} className="vc-btn vc-btn-sm">
            Start recording
          </button>
        </div>

        {recentLegacyConsultations.length > 0 && (
          <details className="vc-card">
            <summary className="cursor-pointer text-sm font-bold">Recent legacy consultations</summary>
            <ul className="vc-clean-list mt-4">
              {recentLegacyConsultations.map(item => (
                <li key={item.id} className="vc-clean-row">
                  <div className="vc-clean-item">
                    <strong>{item.patient} · {item.type}</strong>
                    <p>{item.id} · {item.date}</p>
                  </div>
                  <div className="vc-clean-actions">
                    <span className={item.status === 'Draft' ? 'vc-badge vc-badge-amber' : 'vc-badge vc-badge-teal'}>
                      {item.status}
                    </span>
                    <button type="button" onClick={() => onToggleStatus(item.id)} disabled={!canEdit} className="vc-btn vc-btn-sm">
                      Change state
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}

        <p className="vc-note">
          Loaded records only. Balances are not payments received; no background synchronization or messaging occurs.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[17px]">
      {partialData && (
        <p role="note" className="rounded-[12px] border border-warning-stroke bg-warning-wash p-3 text-[12.5px] text-warning-text-deep">
          Loaded-page summary only, not clinic-wide totals. Patient history, inventory and
          consultations load in bounded pages.
        </p>
      )}

      <div className="vc-page-heading">
        <div>
          <div className="vc-kicker">Clinic operations</div>
          <h1>Overview</h1>
          <p suppressHydrationWarning>
            {clinicName || 'Clinic workspace'}
            {todayLabel ? ` · ${todayLabel}` : ''}
            {timezone ? ` · ${timezone}` : ''}
            {' · '}Loaded snapshot
          </p>
        </div>
        <div className="vc-lead-action">
          <button type="button" onClick={go('appointments')} disabled={!canEdit} className="vc-btn vc-btn-primary">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New appointment
          </button>
        </div>
      </div>

      <div className="vc-stat-grid">
        <div className="vc-stat">
          <p className="vc-eyebrow">Due / overdue visits</p>
          <p className="vc-metric">{dueAppointments.length}</p>
          <p className="vc-caption">Scheduled for today or earlier</p>
        </div>
        <div className="vc-stat">
          <p className="vc-eyebrow">Active patients</p>
          <p className="vc-metric">{activePatients.length}</p>
          <p className="vc-caption">Waiting or in treatment</p>
        </div>
        <div className="vc-stat">
          <p className="vc-eyebrow">Low-stock alerts</p>
          <p className="vc-metric">{lowStockItems.length}</p>
          <p className="vc-caption">At or under reorder threshold</p>
        </div>
        <div className="vc-stat">
          <p className="vc-eyebrow">Outstanding balances</p>
          <p className="vc-metric">{formatMoney(totalReceivables)}</p>
          <p className="vc-caption">Loaded balances, not collections</p>
        </div>
      </div>

      <div className="vc-dual">
        <section className="vc-card vc-section">
          <div className="vc-section-head">
            <div>
              <h2>Today &amp; overdue</h2>
              <p>{overdueCount} overdue · {dueAppointments.length} scheduled visits requiring review</p>
            </div>
            <button type="button" onClick={openAppointments} className="vc-btn vc-btn-sm">Full schedule</button>
          </div>
          {scheduleMeta}
          {scheduleMessage}
          {visitsList(5)}
        </section>

        <section className="vc-card vc-section">
          <div className="vc-section-head">
            <div>
              <h2>Needs attention</h2>
              <p>Inventory and balances requiring follow-up</p>
            </div>
            <button type="button" onClick={go('inventory')} className="vc-btn vc-btn-sm">Inventory</button>
          </div>
          {attentionList(5)}
        </section>
      </div>

      <section className="vc-card vc-section">
        <div className="vc-section-head">
          <div>
            <h2>Clinic status</h2>
            <p>Current loaded patient and consultation states</p>
          </div>
        </div>
        <div className="vc-chip-row">
          <span className="vc-badge vc-badge-amber">Waiting {waitingPatients.length}</span>
          <span className="vc-badge vc-badge-blue">In treatment {treatmentPatients.length}</span>
          <span className="vc-badge vc-badge-purple">Confined {confinedPatients.length}</span>
          <span className="vc-badge vc-badge-teal">Discharged {dischargedPatients.length}</span>
          <span className="vc-badge">Draft SOAPs {draftConsultations.length}</span>
        </div>
      </section>

      <section className="vc-card vc-section">
        <div className="vc-section-head">
          <div>
            <h2>Recent entered visits</h2>
            <p>Consultation records currently stored in the clinic ledger</p>
          </div>
          <button type="button" onClick={go('patients')} className="vc-btn vc-btn-sm">Patients &amp; history</button>
        </div>
        <div className="vc-table-wrap">
          <table className="vc-table">
            <thead>
              <tr>
                <th>Patient</th>
                <th>Record</th>
                <th>Date</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {recentConsultations.length ? recentConsultations.map(item => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.patient}</strong>
                    <small>{item.client}</small>
                  </td>
                  <td>
                    <strong>{item.id}</strong>
                    <small>{item.type}</small>
                  </td>
                  <td>{item.date}</td>
                  <td>
                    <span className={item.status === 'Draft' ? 'vc-badge vc-badge-amber' : 'vc-badge vc-badge-teal'}>
                      {item.status}
                    </span>
                  </td>
                  <td>
                    {item.patientId ? (
                      <span className="vc-note">Locked clinical record</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onToggleStatus(item.id)}
                        disabled={!canEdit}
                        className="vc-btn vc-btn-sm"
                      >
                        Change state
                      </button>
                    )}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={5}>
                    <span className="vc-note">No consultation records found.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="vc-card vc-section">
        <div className="vc-section-head">
          <div>
            <h2>Recent billing activity</h2>
            <p>Latest medicines, services and grooming items added to patient ledgers</p>
          </div>
          <span className="vc-badge">{recentBillables.length} recent</span>
        </div>
        {recentBillables.length ? (
          <div className="vc-clean-list">
            {recentBillables.map(item => (
              <div key={item.id} className="vc-clean-row">
                <div className="vc-clean-item">
                  <strong>{item.itemName}</strong>
                  <p>{item.patientName} · {item.category} · Qty {item.quantity} · {item.date}</p>
                </div>
                <div className="vc-clean-actions">
                  <strong className="text-[13px] text-ink">{formatMoney(item.total)}</strong>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="vc-empty">No billing activity recorded yet.</p>
        )}
      </section>

      <p className="vc-note">
        These counts cover loaded records only. Scheduling, clinical notes, stock use, charges and
        payments are distinct operations.
      </p>
    </div>
  );
};
