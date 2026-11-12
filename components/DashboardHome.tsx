"use client";

import { PawPrint, Package, TestTube, Activity, FileText, AlertCircle, Lock, Unlock, CreditCard } from 'lucide-react';
import type { InventoryItem, PatientRecord, Consultation } from '@/types';

export const DashboardHome = ({
  patients, 
  inventory, 
  consultations, 
  onToggleStatus
}: { 
  patients: PatientRecord[]; 
  inventory: InventoryItem[]; 
  consultations: Consultation[]; 
  onToggleStatus: (id: string) => void;
}) => {
  const activePatients = patients.filter(patient => patient.status !== 'Discharged');
  const dischargedPatients = patients.filter(patient => patient.status === 'Discharged');
  const confinedPatients = patients.filter(patient => patient.status === 'Confined');
  const waitingPatients = patients.filter(patient => patient.status === 'Waiting');
  const treatmentPatients = patients.filter(patient => patient.status === 'In Treatment');

  const patientsWithLabs = patients.filter(
    patient => patient.labResults && patient.labResults.length > 0
  );

  const lowStockItems = inventory.filter(item =>
    item.category !== 'Service' &&
    item.category !== 'Grooming' &&
    item.threshold > 0 &&
    item.stock <= item.threshold
  );

  const medicineAndSupplies = inventory.filter(item =>
    item.category === 'Medicine' || item.category === 'Supplies'
  );

  const serviceItems = inventory.filter(item =>
    item.category === 'Service' || item.category === 'Grooming'
  );

  const totalReceivables = patients.reduce(
    (sum, patient) => sum + patient.balance,
    0
  );

  const draftConsultations = consultations.filter(
    consultation => consultation.status === 'Draft'
  );

  const completedConsultations = consultations.filter(
    consultation => consultation.status === 'Completed'
  );

  const recentBillables = patients
    .flatMap(patient =>
      (patient.billableItems || []).map(billable => ({
        ...billable,
        patientName: patient.name,
        patientId: patient.id
      }))
    )
    .slice(-6)
    .reverse();

  const formatMoney = (amount: number) => `PHP ${amount.toFixed(2)}`;

  return (
    <div className="space-y-6">
      {/* Dashboard Header */}
      <div className="bg-slate-900 text-white p-6 rounded-2xl border border-slate-800 shadow-sm overflow-hidden relative">
        <div className="absolute top-0 right-0 w-64 h-64 bg-teal-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />

        <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-teal-300 mb-2">
              Clinic Operations Overview
            </p>
            <h2 className="text-2xl font-black tracking-tight">
              Dashboard
            </h2>
            <p className="text-slate-400 text-sm mt-1">
              Live summary of admissions, billing, inventory, laboratory records, and consultation workflow.
            </p>
          </div>

          <div className="bg-white/5 border border-white/10 rounded-2xl px-5 py-4">
            <p className="text-[10px] uppercase tracking-widest text-slate-400 font-black">
              Total Receivables
            </p>
            <p className="text-2xl font-black text-teal-300">
              {formatMoney(totalReceivables)}
            </p>
          </div>
        </div>
      </div>

      {/* Main KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-500 font-black block uppercase tracking-wider">
              Active Patients
            </span>
            <span className="text-3xl font-black text-slate-900 mt-1 block">
              {activePatients.length}
            </span>
            <p className="text-xs text-slate-400 mt-1">
              Excludes discharged records
            </p>
          </div>
          <div className="p-4 bg-teal-50 text-teal-600 rounded-xl">
            <PawPrint className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-500 font-black block uppercase tracking-wider">
              Patient Balances
            </span>
            <span className={`text-3xl font-black mt-1 block ${totalReceivables > 0 ? 'text-amber-600' : 'text-slate-900'}`}>
              {formatMoney(totalReceivables)}
            </span>
            <p className="text-xs text-slate-400 mt-1">
              Unpaid ledger total
            </p>
          </div>
          <div className="p-4 bg-amber-50 text-amber-600 rounded-xl">
            <CreditCard className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-500 font-black block uppercase tracking-wider">
              Low Stock Alerts
            </span>
            <span className={`text-3xl font-black mt-1 block ${lowStockItems.length > 0 ? 'text-red-500' : 'text-slate-900'}`}>
              {lowStockItems.length}
            </span>
            <p className="text-xs text-slate-400 mt-1">
              Medicines and supplies only
            </p>
          </div>
          <div className="p-4 bg-red-50 text-red-500 rounded-xl">
            <Package className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-500 font-black block uppercase tracking-wider">
              Lab Records
            </span>
            <span className="text-3xl font-black text-slate-900 mt-1 block">
              {patientsWithLabs.length}
            </span>
            <p className="text-xs text-slate-400 mt-1">
              Patients with lab panels
            </p>
          </div>
          <div className="p-4 bg-purple-50 text-purple-600 rounded-xl">
            <TestTube className="w-6 h-6" />
          </div>
        </div>
      </div>

      {/* Secondary Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
            Waiting
          </p>
          <p className="text-2xl font-black text-amber-600 mt-1">
            {waitingPatients.length}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
            In Treatment
          </p>
          <p className="text-2xl font-black text-blue-600 mt-1">
            {treatmentPatients.length}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
            Confined
          </p>
          <p className="text-2xl font-black text-orange-600 mt-1">
            {confinedPatients.length}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
            Discharged
          </p>
          <p className="text-2xl font-black text-emerald-600 mt-1">
            {dischargedPatients.length}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
            Draft SOAPs
          </p>
          <p className="text-2xl font-black text-slate-900 mt-1">
            {draftConsultations.length}
          </p>
        </div>
      </div>

      {/* Main Dashboard Body */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Recent Patient Ledger Activity */}
        <div className="xl:col-span-2 bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-6 border-b border-slate-200 bg-slate-50/50 flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                <CreditCard className="w-5 h-5 text-teal-600" />
                Recent Billing Activity
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                Latest medicines, services, and grooming items added to patient ledgers.
              </p>
            </div>

            <span className="text-xs font-bold text-slate-500 bg-slate-200 px-3 py-1 rounded-full">
              {recentBillables.length} Recent
            </span>
          </div>

          <div className="divide-y divide-slate-100">
            {recentBillables.length > 0 ? (
              recentBillables.map(item => (
                <div
                  key={item.id}
                  className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50 transition-colors"
                >
                  <div>
                    <p className="text-sm font-bold text-slate-900">
                      {item.itemName}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {item.patientName} • {item.category} • Qty {item.quantity} • {item.date}
                    </p>
                  </div>

                  <p className="text-sm font-black text-slate-900">
                    {formatMoney(item.total)}
                  </p>
                </div>
              ))
            ) : (
              <div className="p-10 text-center text-slate-400">
                <CreditCard className="w-8 h-8 mx-auto mb-2 opacity-20" />
                <p className="text-sm font-medium">
                  No billing activity recorded yet.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Inventory Snapshot */}
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden p-6">
            <h3 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
              <Package className="w-5 h-5 text-amber-600" />
              Inventory Snapshot
            </h3>

            <div className="space-y-3">
              <div className="flex justify-between items-center bg-slate-50 border border-slate-100 rounded-xl p-3">
                <span className="text-xs font-bold text-slate-500 uppercase">
                  Medicines / Supplies
                </span>
                <span className="text-sm font-black text-slate-900">
                  {medicineAndSupplies.length}
                </span>
              </div>

              <div className="flex justify-between items-center bg-slate-50 border border-slate-100 rounded-xl p-3">
                <span className="text-xs font-bold text-slate-500 uppercase">
                  Services / Grooming
                </span>
                <span className="text-sm font-black text-slate-900">
                  {serviceItems.length}
                </span>
              </div>

              <div className="flex justify-between items-center bg-red-50 border border-red-100 rounded-xl p-3">
                <span className="text-xs font-bold text-red-600 uppercase">
                  Critical Stock
                </span>
                <span className="text-sm font-black text-red-600">
                  {lowStockItems.length}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden p-6">
            <h3 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-red-500" />
              Critical Stock Alerts
            </h3>

            <div className="space-y-3">
              {lowStockItems.length > 0 ? (
                lowStockItems.map(item => (
                  <div
                    key={item.itemCode}
                    className="p-4 bg-red-50 border border-red-200 rounded-xl"
                  >
                    <h4 className="text-sm font-bold text-slate-900">
                      {item.itemName}
                    </h4>
                    <p className="text-xs text-red-600 font-medium mt-1">
                      Stock: {item.stock} / Threshold: {item.threshold}
                    </p>
                    <p className="text-[10px] text-slate-400 font-bold uppercase mt-1">
                      {item.category} • {item.itemCode}
                    </p>
                  </div>
                ))
              ) : (
                <div className="p-4 bg-emerald-50 text-emerald-800 border border-emerald-100 rounded-xl text-center text-sm font-medium">
                  Medicines and supplies are above reorder thresholds.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Consultation Queue */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-slate-50/50">
          <div>
            <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <FileText className="w-5 h-5 text-slate-600" />
              Consultation Queue
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Draft and completed consultation records currently stored in the clinic ledger.
            </p>
          </div>

          <div className="flex gap-2">
            <span className="text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200 px-3 py-1 rounded-full">
              {draftConsultations.length} Draft
            </span>
            <span className="text-xs font-bold bg-teal-50 text-teal-700 border border-teal-200 px-3 py-1 rounded-full">
              {completedConsultations.length} Completed
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-xs font-semibold uppercase border-b border-slate-200">
                <th className="p-4">Record ID</th>
                <th className="p-4">Patient</th>
                <th className="p-4">Consultation Notes</th>
                <th className="p-4">Status</th>
                <th className="p-4 text-right">Action</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100">
              {consultations.length > 0 ? (
                consultations.map(item => (
                  <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-4 text-sm font-bold text-slate-800">
                      {item.id}
                    </td>

                    <td className="p-4 text-sm font-bold text-slate-800">
                      <div>
                        {item.patient}
                        <span className="text-xs text-slate-500 block">
                          Owner: {item.client}
                        </span>
                      </div>
                    </td>

                    <td className="p-4 text-sm text-slate-600 max-w-xs truncate">
                      {item.notes}
                    </td>

                    <td className="p-4 text-sm">
                      <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${
                        item.status === 'Draft'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-teal-100 text-teal-800'
                      }`}>
                        {item.status === 'Draft' ? (
                          <Unlock className="w-3 h-3" />
                        ) : (
                          <Lock className="w-3 h-3" />
                        )}
                        {item.status}
                      </span>
                    </td>

                    <td className="p-4 text-right">
                      <button
                        type="button"
                        onClick={() => onToggleStatus(item.id)}
                        className="text-xs font-bold text-slate-700 bg-slate-100 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-200 transition-all"
                      >
                        Change State
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="p-10 text-center text-slate-400">
                    <FileText className="w-8 h-8 mx-auto mb-2 opacity-20" />
                    No consultation records found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
