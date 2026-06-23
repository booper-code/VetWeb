"use client";

import React, { useState } from 'react';
import { 
  LayoutDashboard, 
  PawPrint, 
  Package, 
  TestTube, 
  Settings, 
  Search, 
  Bell, 
  Menu, 
  Plus, 
  Activity,
  User,
  Sparkles,
  Loader2,
  FileText,
  AlertCircle,
  TrendingUp,
  FileSpreadsheet,
  CheckCircle,
  Lock,
  Unlock,
  PlusCircle,
  Database,
  X,
  Phone,
  Mail,
  MapPin,
  Calendar,
  CreditCard,
  Stethoscope,
  Trash2
} from 'lucide-react';

// Firebase is loaded dynamically at runtime to avoid requiring the package during static type checks

type GeminiPayload = {
  contents: { parts: { text: string }[] }[];
  generationConfig?: {
    responseMimeType: string;
    responseSchema: Record<string, unknown>;
  };
};

type InventoryItem = {
  itemCode: string;
  itemName: string;
  category: 'Medicine' | 'Supplies' | 'Service' | 'Grooming';
  stock: number;
  buyingPrice: number;
  sellingPrice: number;
  threshold: number;
};

type PatientRecord = {
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
  balance: number;
  status: 'Waiting' | 'In Treatment' | 'Confined' | 'Ready for Pickup' | 'Discharged';
  pictures?: string[];
  labResults?: Array<{
    id: string;
    date: string;
    testName: string;
    findings: string;
    metrics: Record<string, string>;
  }>;
};

type Consultation = {
  id: string;
  date: string;
  client: string;
  patient: string;
  type: string;
  status: 'Draft' | 'Completed';
  notes: string;
};

// --- GEMINI API CONFIGURATION ---
const apiKey = "AQ.Ab8RN6KnlvQMlnLKYkfn8tqWUg48MdsGj9ytMMrmjBnj4Ayvaw"; // API key is injected by the execution environment

// Safeguard for the firebase configuration object
declare const __firebase_config: string | undefined;

const getFirebaseConfig = () => {
  try {
    // Check if the variable exists and is a non-empty string
    if (typeof __firebase_config !== 'undefined' && __firebase_config) {
      return JSON.parse(__firebase_config);
    }
  } catch (e) {
    console.error("Error parsing __firebase_config:", e);
  }
  
  // Return a fallback or throw a descriptive error if config is missing
  throw new Error("Firebase configuration is missing or invalid. Ensure __firebase_config is correctly provided by the environment.");
};

// Initialize only after verifying config. Load Firebase modules dynamically
let app: any = null;
let auth: any = null;
let db: any = null;

const initializeFirebase = async () => {
  if (app) return { app, auth, db };
  const config = getFirebaseConfig();
  try {
    // @ts-ignore - dynamic import, dependency may not be installed in every environment
    const firebaseApp = await import('firebase/app');
    // @ts-ignore - dynamic import, dependency may not be installed in every environment
    const firebaseAuth = await import('firebase/auth');
    // @ts-ignore - dynamic import, dependency may not be installed in every environment
    const firebaseFirestore = await import('firebase/firestore');
    app = firebaseApp.initializeApp(config);
    auth = firebaseAuth.getAuth(app);
    db = firebaseFirestore.getFirestore(app);
    return { app, auth, db };
  } catch (e) {
    console.error('Firebase dynamic import failed:', e);
    throw e;
  }
};

const callGeminiAPI = async (payload: GeminiPayload, retries = 5) => {
  const delays = [1000, 2000, 4000, 8000, 16000];
  
  // We add a 'cors-anywhere' style proxy prefix if needed, 
  // but for the native Gemini API, ensure we are using the official base URL.
  // The 403 often resolves by ensuring the request header is strictly set.
const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          // Adding these headers helps prevent some CORS rejections
          "Origin": window.location.origin 
        },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error("API Error Response:", errorData);
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (i === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, delays[i]));
    }
  }
};

const generateGeminiText = async (prompt: string) => {
  const payload = {
    contents: [{ parts: [{ text: prompt }] }]
  };
  const data = await callGeminiAPI(payload);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";
};

const generateGeminiJSON = async (prompt: string) => {
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { 
      responseMimeType: "application/json", 
      responseSchema: { 
        type: "OBJECT", 
        properties: {
          items: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                itemName: { type: "STRING" },
                quantity: { type: "INTEGER" }
              }
            }
          }
        } 
      } 
    }
  };
  const data = await callGeminiAPI(payload);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return text ? JSON.parse(text) : { items: [] };
};

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);

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

  const createQuickPatient = (
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
    const newId = `PAT-00${100 + patients.length + 1}`;
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
    setPatients([newPat, ...patients]);
    triggerToast(`Record for ${name} added successfully.`);
  };

  const updatePatientRecord = (updatedRecord: PatientRecord) => {
    setPatients(patients.map(p => p.id === updatedRecord.id ? updatedRecord : p));
    triggerToast(`Patient record for ${updatedRecord.name} updated.`);
  };

  const deletePatientRecord = (id: string) => {
    setPatients(patients.filter(p => p.id !== id));
    triggerToast(`Patient record has been permanently deleted.`);
  };

  const toggleConsultationStatus = (id: string) => {
    setConsultations(consultations.map(c => {
      if (c.id === id) {
        const nextStatus = c.status === 'Draft' ? 'Completed' : 'Draft';
        return { ...c, status: nextStatus };
      }
      return c;
    }));
    triggerToast(`Consultation status toggled.`);
  };

  // --- RENDER CONTENT DEPENDING ON NAVIGATION TABS ---
  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return (
          <DashboardHome 
            patients={patients} 
            inventory={inventory} 
            consultations={consultations} 
            onToggleStatus={toggleConsultationStatus}
          />
        );
      case 'patients':
        return (
          <PatientRecordsView 
            patients={patients} 
            consultations={consultations}
            inventory={inventory}
            onCreatePatient={createQuickPatient}
            onUpdatePatient={updatePatientRecord}
            onDeletePatient={deletePatientRecord}
            onToggleStatus={toggleConsultationStatus}
            triggerToast={triggerToast}
          />
        );
      case 'inventory':
        return (
          <InventoryControlView 
            inventory={inventory} 
            setInventory={setInventory} 
            triggerToast={triggerToast}
          />
        );
      case 'laboratory':
        return <AILaboratoryView />;
      case 'settings':
        return <SystemSettingsView inventory={inventory} setInventory={setInventory} triggerToast={triggerToast} />;
      default:
        return <DashboardHome 
          patients={patients} 
          inventory={inventory} 
          consultations={consultations} 
          onToggleStatus={toggleConsultationStatus}
        />;
    }
  };

  return (
    <div className="flex h-screen bg-slate-100 font-sans overflow-hidden">
      {/* Toast Notification Container */}
      {successToast && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-3 bg-slate-900 border border-slate-800 text-white px-5 py-4 rounded-xl shadow-2xl animate-bounce">
          <Sparkles className="w-5 h-5 text-teal-400" />
          <span className="text-sm font-medium">{successToast}</span>
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
        setActiveTab={setActiveTab} 
        isOpen={sidebarOpen} 
        setIsOpen={setSidebarOpen} 
      />

      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        <Header toggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
        
        <main className="flex-1 overflow-y-auto p-4 sm:p-8">
          <div className="max-w-7xl mx-auto">
            {renderContent()}
          </div>
        </main>
      </div>
    </div>
  );
}

const Sidebar = ({ activeTab, setActiveTab, isOpen, setIsOpen }: { activeTab: string; setActiveTab: (tab: string) => void; isOpen: boolean; setIsOpen: (open: boolean) => void; }) => {
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'patients', label: 'Admission & Medical', icon: PawPrint },
    { id: 'inventory', label: 'Inventory Control', icon: Package },
    { id: 'laboratory', label: 'Laboratory & AI', icon: TestTube },
    { id: 'settings', label: 'Clinic Setup', icon: Settings },
  ];

  return (
    <div className={`fixed inset-y-0 left-0 z-50 w-64 bg-slate-900 text-slate-300 transition-transform duration-300 ease-in-out transform ${isOpen ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0 flex flex-col`}>
      <div className="flex items-center justify-center h-20 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Activity className="w-8 h-8 text-teal-400" />
          <span className="text-xl font-bold text-white tracking-wide">VetCloud<span className="text-teal-400">Pro</span></span>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto py-6 px-4">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4 px-2">Core Clinical Hub</p>
        <ul className="space-y-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <li key={item.id}>
                <button
                  onClick={() => { setActiveTab(item.id); setIsOpen(false); }}
                  className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all ${isActive ? 'bg-teal-500/10 text-teal-400 font-medium' : 'hover:bg-slate-800 hover:text-white'}`}
                >
                  <Icon className={`w-5 h-5 ${isActive ? 'text-teal-400' : 'text-slate-400'}`} />
                  {item.label}
                  {(item.id === 'laboratory' || item.id === 'inventory') && (
                    <Sparkles className="w-3 h-3 text-yellow-400 ml-auto" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="p-4 border-t border-slate-800">
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center overflow-hidden">
            <User className="w-6 h-6 text-slate-400" />
          </div>
          <div className="flex flex-col text-left">
            <span className="text-sm font-medium text-white">Dr. R. Capitan</span>
            <span className="text-xs text-slate-500">Clinic Director</span>
          </div>
        </div>
      </div>
    </div>
  );
};

const Header = ({ toggleSidebar }: { toggleSidebar: () => void }) => (
  <header className="bg-white border-b border-slate-200 h-20 flex items-center justify-between px-4 sm:px-8 sticky top-0 z-40">
    <div className="flex items-center gap-4">
      <button onClick={toggleSidebar} className="md:hidden p-2 text-slate-500 hover:bg-slate-100 rounded-lg">
        <Menu className="w-6 h-6" />
      </button>
      <div>
        <h1 className="text-xl font-bold text-slate-800 hidden sm:block">Biñan Animal Clinic & Grooming Center</h1>
        <p className="text-sm text-slate-500 hidden sm:block">Unified Practice Management Platform</p>
      </div>
    </div>

    <div className="flex items-center gap-4 border border-slate-200 rounded-full px-4 py-2 bg-slate-50 md:w-96 focus-within:ring-2 focus-within:ring-teal-500 focus-within:border-teal-500 transition-all">
      <Search className="w-5 h-5 text-slate-400" />
      <input 
        type="text" 
        placeholder="Search patient records or active stock catalog..." 
        className="bg-transparent border-none outline-none w-full text-sm text-slate-700 placeholder-slate-400"
      />
    </div>

    <div className="flex items-center gap-3">
      <span className="text-xs font-semibold px-3 py-1.5 bg-teal-50 text-teal-700 rounded-full border border-teal-200 uppercase tracking-wider">
        Local Dev Server
      </span>
    </div>
  </header>
);

const DashboardHome = ({ 
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
  const lowStockCount = inventory.filter(i => i.stock <= i.threshold).length;

  return (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-2xl border border-slate-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Clinic Dashboard</h2>
          <p className="text-slate-500 font-medium">Consolidated diagnostic and workflow overview replacing legacy paper records.</p>
        </div>
      </div>

      {/* Top Level KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-sm text-slate-500 font-bold block uppercase tracking-wider">Active Admits</span>
            <span className="text-3xl font-black text-slate-900 mt-1 block">{patients.length}</span>
          </div>
          <div className="p-4 bg-teal-50 text-teal-600 rounded-xl">
            <PawPrint className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-sm text-slate-500 font-bold block uppercase tracking-wider">Action Required Labs</span>
            <span className="text-3xl font-black text-slate-900 mt-1 block">1</span>
          </div>
          <div className="p-4 bg-emerald-50 text-emerald-600 rounded-xl">
            <TestTube className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-sm text-slate-500 font-bold block uppercase tracking-wider">Low Stock Warnings</span>
            <span className={`text-3xl font-black mt-1 block ${lowStockCount > 0 ? 'text-red-500' : 'text-slate-900'}`}>{lowStockCount}</span>
          </div>
          <div className="p-4 bg-amber-50 text-amber-600 rounded-xl">
            <Package className="w-6 h-6" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Dynamic Consultation Registry */}
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col">
          <div className="p-6 border-b border-slate-200 flex justify-between items-center bg-slate-50/50">
            <div>
              <h3 className="text-lg font-bold text-slate-800">Dynamic Consultation Queue</h3>
              <p className="text-xs text-slate-500 mt-1">Vets can toggle draft records to avoid locking clinical notes prematurely.</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-xs font-semibold uppercase border-b border-slate-200">
                  <th className="p-4">Record ID</th>
                  <th className="p-4">Patient</th>
                  <th className="p-4">Consultation Details</th>
                  <th className="p-4">Authorization</th>
                  <th className="p-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {consultations.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-4 text-sm font-bold text-slate-800">{item.id}</td>
                    <td className="p-4 text-sm font-bold text-slate-800">
                      <div>
                        {item.patient}
                        <span className="text-xs text-slate-500 block">Owner: {item.client}</span>
                      </div>
                    </td>
                    <td className="p-4 text-sm text-slate-600 max-w-xs truncate">{item.notes}</td>
                    <td className="p-4 text-sm">
                      <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${
                        item.status === 'Draft' 
                          ? 'bg-amber-100 text-amber-800' 
                          : 'bg-teal-100 text-teal-800'
                      }`}>
                        {item.status === 'Draft' ? <Unlock className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
                        {item.status}
                      </span>
                    </td>
                    <td className="p-4 text-right">
                      <button 
                        onClick={() => onToggleStatus(item.id)}
                        className="text-xs font-bold text-slate-700 bg-slate-100 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-200 transition-all text-slate-900"
                      >
                        Change State
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Panel for Live Warnings */}
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden p-6">
            <h3 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-red-500" />
              Critical Stock Alerts
            </h3>
            <div className="space-y-3">
              {inventory.filter(i => i.stock <= i.threshold).map((item, idx) => (
                <div key={idx} className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-bold text-slate-900">{item.itemName}</h4>
                    <span className="text-xs text-red-600 block font-medium mt-1">Current Stock: {item.stock} unit/s (Threshold: {item.threshold})</span>
                  </div>
                </div>
              ))}
              {inventory.filter(i => i.stock <= i.threshold).length === 0 && (
                <div className="p-4 bg-emerald-50 text-emerald-800 border border-emerald-100 rounded-xl text-center text-sm font-medium">
                  All active inventories are safely above reorder thresholds.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const PatientRecordsView = ({ 
  patients, 
  consultations,
  inventory,
  onCreatePatient,
  onUpdatePatient,
  onDeletePatient,
  onToggleStatus,
  triggerToast
}: { 
  patients: PatientRecord[]; 
  consultations: Consultation[];
  inventory: InventoryItem[];
  onCreatePatient: (name: string, species: string, breed: string, gender: any, owner: string, contact: string, weight: number, admissionTypes: string[], reason: string, pictures?: string[]) => void;
  onUpdatePatient: (record: PatientRecord) => void;
  onDeletePatient: (id: string) => void;
  onToggleStatus: (id: string) => void;
  triggerToast: (msg: string) => void;
}) => {
  // Form State
  const [name, setName] = useState('');
  const [species, setSpecies] = useState('Canine');
  const [breed, setBreed] = useState('');
  const [gender, setGender] = useState<'Male' | 'Female' | 'Unknown'>('Male');
  const [owner, setOwner] = useState('');
  const [contact, setContact] = useState('');
  const [weight, setWeight] = useState<number | string>('');
  const [reason, setReason] = useState('');
  const [selectedAdmissions, setSelectedAdmissions] = useState<string[]>(['Medical Checkup']);
  
  const [formPictures, setFormPictures] = useState<string[]>([]);
  const [showFullReport, setShowFullReport] = useState(false);

  const admissionOptions = ['Grooming', 'Medical Checkup', 'Surgery', 'Confinement'];

  // Drawer & Verification State
  const [selectedPatient, setSelectedPatient] = useState<PatientRecord | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<PatientRecord | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Billing Module Calculation States
  const [clinicalProcedureFee, setClinicalProcedureFee] = useState<number>(500);
  const [prescribedMed, setPrescribedMed] = useState<string>('');
  const [prescribedQuantity, setPrescribedQuantity] = useState<number>(1);
  const [sigInstructions, setSigInstructions] = useState<string>('');

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onloadend = () => {
          if (typeof reader.result === 'string') {
            setFormPictures(prev => [...prev, reader.result as string]);
          }
        };
        reader.readAsDataURL(file);
      });
    }
  };

  const handleQuickInsertPreset = (url: string) => {
    setFormPictures(prev => [...prev, url]);
    triggerToast("Quick diagnostic preview preset attached.");
  };

  const toggleAdmission = (type: string) => {
    if (selectedAdmissions.includes(type)) {
      setSelectedAdmissions(selectedAdmissions.filter(t => t !== type));
    } else {
      setSelectedAdmissions([...selectedAdmissions, type]);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !breed || !owner || !contact || !weight || selectedAdmissions.length === 0) return;
    
    onCreatePatient(name, species, breed, gender, owner, contact, Number(weight), selectedAdmissions, reason, formPictures);
    
    // Reset form
    setName(''); 
    setBreed(''); 
    setOwner(''); 
    setContact(''); 
    setWeight(''); 
    setReason(''); 
    setSelectedAdmissions(['Medical Checkup']);
    setFormPictures([]);
  };

  const startEditing = () => {
    setEditForm(selectedPatient);
    setIsEditing(true);
    setShowDeleteConfirm(false);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditForm(null);
    setShowDeleteConfirm(false);
  };

  const saveEdits = () => {
    if (editForm) {
      onUpdatePatient(editForm);
      setSelectedPatient(editForm); // Update view with edited metrics
      setIsEditing(false);
    }
  };

  const handleEditChange = (field: keyof PatientRecord, value: any) => {
    if (editForm) {
      setEditForm({ ...editForm, [field]: value });
    }
  };

  const toggleEditAdmission = (type: string) => {
    if (!editForm) return;
    const currentTypes = editForm.admissionTypes;
    if (currentTypes.includes(type)) {
      setEditForm({ ...editForm, admissionTypes: currentTypes.filter(t => t !== type) });
    } else {
      setEditForm({ ...editForm, admissionTypes: [...currentTypes, type] });
    }
  };

  const handleConfirmDelete = () => {
    if (selectedPatient) {
      onDeletePatient(selectedPatient.id);
      setSelectedPatient(null);
      setIsEditing(false);
      setShowDeleteConfirm(false);
    }
  };

  const calculatePrescriptionCost = () => {
    const med = inventory.find(i => i.itemCode === prescribedMed);
    return med ? med.sellingPrice * prescribedQuantity : 0;
  };

  const calculateTotalInvoice = () => {
    return clinicalProcedureFee + calculatePrescriptionCost();
  };

  const applyInvoiceToBalance = () => {
    if (!selectedPatient) return;
    const finalInvoiceCost = calculateTotalInvoice();
    const updatedRecord: PatientRecord = {
      ...selectedPatient,
      balance: selectedPatient.balance + finalInvoiceCost
    };
    onUpdatePatient(updatedRecord);
    setSelectedPatient(updatedRecord);
    triggerToast(`Added PHP ${finalInvoiceCost.toFixed(2)} to client invoice ledger.`);
    
    // Reset specific invoice selectors
    setPrescribedMed('');
    setPrescribedQuantity(1);
    setSigInstructions('');
  };

  return (
    <div className="space-y-6 relative">
      
      {/* --- SLIDE-OUT DETAILED PROFILE DRAWER --- */}
      {selectedPatient && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Backdrop click dismisser */}
          <div 
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" 
            onClick={() => {
              setSelectedPatient(null);
              setIsEditing(false);
              setShowDeleteConfirm(false);
            }} 
          />
          
          {/* Sliding Frame Panel */}
          <div className="relative w-full max-w-2xl bg-slate-50 h-full shadow-2xl flex flex-col border-l border-slate-200 overflow-hidden transform transition-transform duration-300 ease-in-out">
            {/* Drawer Header */}
            <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
              <div className="flex items-center gap-4">
                <div>
                  <h2 className="text-xl font-bold text-slate-800">
                    {isEditing ? `Editing ${selectedPatient.name}'s Record` : selectedPatient.name}
                  </h2>
                  <p className="text-sm text-slate-500">
                    {isEditing ? `ID: ${selectedPatient.id}` : `Owned by ${selectedPatient.ownerName}`}
                  </p>
                </div>
              </div>
              <button 
                onClick={() => {
                  setSelectedPatient(null);
                  setIsEditing(false);
                  setShowDeleteConfirm(false);
                }}
                className="p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 rounded-full transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Drawer Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-6">
              
              {isEditing && editForm ? (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
                  {/* Edit Status Section */}
                  <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                       <Activity className="w-4 h-4" /> Current Workflow Status
                    </h3>
                    <select 
                      className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none"
                      value={editForm.status}
                      onChange={e => handleEditChange('status', e.target.value)}
                    >
                      <option value="Waiting">Waiting</option>
                      <option value="In Treatment">In Treatment</option>
                      <option value="Confined">Confined</option>
                      <option value="Ready for Pickup">Ready for Pickup</option>
                      <option value="Discharged">Discharged</option>
                    </select>
                  </div>

                  {/* Edit Client Information */}
                  <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                      <User className="w-4 h-4" /> Client Information
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="col-span-2 md:col-span-1">
                        <label className="text-xs font-bold text-slate-700 block mb-1">Owner Name</label>
                        <input type="text" className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none" value={editForm.ownerName} onChange={e => handleEditChange('ownerName', e.target.value)} />
                      </div>
                      <div className="col-span-2 md:col-span-1">
                        <label className="text-xs font-bold text-slate-700 block mb-1">Contact Number</label>
                        <input type="text" className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none" value={editForm.ownerContact} onChange={e => handleEditChange('ownerContact', e.target.value)} />
                      </div>
                      <div className="col-span-2">
                        <label className="text-xs font-bold text-slate-700 block mb-1">Email Address</label>
                        <input type="email" className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none" value={editForm.ownerEmail || ''} onChange={e => handleEditChange('ownerEmail', e.target.value)} placeholder="No email provided" />
                      </div>
                      <div className="col-span-2">
                        <label className="text-xs font-bold text-slate-700 block mb-1">Home Address</label>
                        <input type="text" className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none" value={editForm.ownerAddress || ''} onChange={e => handleEditChange('ownerAddress', e.target.value)} placeholder="No address provided" />
                      </div>
                    </div>
                  </div>

                  {/* Edit Financial Information */}
                  <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                      <CreditCard className="w-4 h-4" /> Financial Record
                    </h3>
                    <div>
                      <label className="text-xs font-bold text-slate-700 block mb-1">Pending Balance (PHP)</label>
                      <input 
                        type="number" 
                        step="0.01"
                        className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 font-bold focus:ring-2 focus:ring-red-500 outline-none" 
                        value={editForm.balance} 
                        onChange={e => handleEditChange('balance', parseFloat(e.target.value) || 0)} 
                      />
                    </div>
                  </div>

                  {/* Edit Patient Information */}
                  <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                      <PawPrint className="w-4 h-4" /> Patient Metrics & Tags
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                       <div>
                        <label className="text-xs font-bold text-slate-700 block mb-1">Weight (kg)</label>
                        <input type="number" step="0.1" className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none" value={editForm.weight} onChange={e => handleEditChange('weight', parseFloat(e.target.value) || 0)} />
                      </div>
                      <div>
                        <label className="text-xs font-bold text-slate-700 block mb-1">Gender</label>
                        <select className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none" value={editForm.gender} onChange={e => handleEditChange('gender', e.target.value)}>
                          <option value="Male">Male</option>
                          <option value="Female">Female</option>
                          <option value="Unknown">Unknown</option>
                        </select>
                      </div>
                    </div>
                    
                    <div className="pt-3 border-t border-slate-100">
                      <label className="text-xs text-slate-500 block mb-2">Active Admission Tags:</label>
                      <div className="flex flex-wrap gap-2">
                        {admissionOptions.map(option => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => toggleEditAdmission(option)}
                            className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
                              editForm.admissionTypes.includes(option)
                                ? 'bg-teal-600 text-white border-teal-600 shadow-sm'
                                : 'bg-white text-slate-600 border-slate-200 hover:border-teal-300'
                            }`}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="pt-3 border-t border-slate-100">
                      <label className="text-xs font-bold text-slate-700 block mb-1">Chief Complaint / Remarks</label>
                      <textarea className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none resize-none h-24" value={editForm.reason} onChange={e => handleEditChange('reason', e.target.value)} />
                    </div>
                  </div>

                  {/* Danger Zone: Patient Deletion */}
                  <div className="bg-red-50 rounded-2xl p-5 border border-red-200 shadow-sm space-y-3">
                    <h3 className="text-sm font-bold text-red-800 flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-red-600" /> Danger Zone
                    </h3>
                    <p className="text-xs text-red-700 leading-relaxed">
                      Permanently deleting this clinical profile removes all historical admission records and pharmacy balance registers. This action cannot be undone.
                    </p>
                    
                    {!showDeleteConfirm ? (
                      <button 
                        type="button"
                        onClick={() => setShowDeleteConfirm(true)}
                        className="flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-all shadow-sm"
                      >
                        <Trash2 className="w-4 h-4" /> Delete Patient Record
                      </button>
                    ) : (
                      <div className="p-3 bg-white border border-red-200 rounded-xl space-y-3">
                        <p className="text-xs font-bold text-red-600">Are you absolutely sure you want to delete this profile?</p>
                        <div className="flex gap-2">
                          <button 
                            type="button"
                            onClick={() => setShowDeleteConfirm(false)}
                            className="bg-slate-100 text-slate-700 hover:bg-slate-200 px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
                          >
                            Cancel
                          </button>
                          <button 
                            type="button"
                            onClick={handleConfirmDelete}
                            className="bg-red-600 hover:bg-red-700 text-white px-4 py-1.5 rounded-lg text-xs font-black transition-all shadow-inner"
                          >
                            Yes, Confirm Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
                  {/* Top Row: Client & Patient Cards */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Client Details Card */}
                    <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
                      <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                        <User className="w-4 h-4" /> Client Profile
                      </h3>
                      <div>
                        <p className="text-lg font-bold text-slate-800">{selectedPatient.ownerName}</p>
                        <div className="mt-3 space-y-2">
                          <div className="flex items-center gap-3 text-sm text-slate-600">
                            <Phone className="w-4 h-4 text-slate-400" /> {selectedPatient.ownerContact}
                          </div>
                          <div className="flex items-center gap-3 text-sm text-slate-600">
                            <Mail className="w-4 h-4 text-slate-400" /> {selectedPatient.ownerEmail || 'No email provided'}
                          </div>
                          <div className="flex items-center gap-3 text-sm text-slate-600">
                            <MapPin className="w-4 h-4 text-slate-400" /> {selectedPatient.ownerAddress || 'No address provided'}
                          </div>
                        </div>
                      </div>
                      
                      {/* Financial Ledger Display */}
                      <div className={`p-4 rounded-xl border ${selectedPatient.balance > 0 ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-200'}`}>
                        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Pending Balance</p>
                        <p className={`text-xl font-black ${selectedPatient.balance > 0 ? 'text-red-600' : 'text-slate-800'}`}>
                          PHP {selectedPatient.balance.toFixed(2)}
                        </p>
                      </div>
                    </div>

                    {/* Patient Details Card */}
                    <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
                      <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                        <PawPrint className="w-4 h-4" /> Patient Metrics
                      </h3>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="text-xs text-slate-500 mb-1">Species / Breed</p>
                          <p className="text-sm font-bold text-slate-800">{selectedPatient.species}</p>
                          <p className="text-xs text-slate-600">{selectedPatient.breed}</p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500 mb-1">Gender</p>
                          <p className="text-sm font-bold text-slate-800">{selectedPatient.gender}</p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500 mb-1">Weight</p>
                          <p className="text-sm font-bold text-slate-800">{selectedPatient.weight} kg</p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500 mb-1">Current Status</p>
                          <span className={`inline-flex px-2 py-1 rounded-md text-xs font-bold border ${
                            selectedPatient.status === 'Ready for Pickup' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                            selectedPatient.status === 'Confined' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                            selectedPatient.status === 'In Treatment' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                            'bg-slate-100 text-slate-700 border-slate-200'
                          }`}>
                            {selectedPatient.status}
                          </span>
                        </div>
                      </div>

                      <div className="pt-3 border-t border-slate-100">
                        <p className="text-xs text-slate-500 mb-2">Admission Tags</p>
                        <div className="flex flex-wrap gap-2">
                          {selectedPatient.admissionTypes.map((type, idx) => (
                            <span key={idx} className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-md text-xs font-bold border border-slate-200">
                              {type}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Attached Clinical Pictures Preview inside Drawer */}
                  {selectedPatient.pictures && selectedPatient.pictures.length > 0 && (
                    <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
                      <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 mb-3">
                        <Sparkles className="w-4 h-4 text-teal-500" /> Attached Diagnostics & Images ({selectedPatient.pictures.length})
                      </h3>
                      <div className="grid grid-cols-3 gap-2">
                        {selectedPatient.pictures.map((pic, idx) => (
                          <div key={idx} className="aspect-square relative overflow-hidden rounded-xl border border-slate-200 group bg-slate-100">
                            <img src={pic} alt="Diagnostic" className="w-full h-full object-cover" />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Clinical Reason notes */}
                  <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 mb-3">
                      <Stethoscope className="w-4 h-4" /> Chief Complaint / Remarks
                    </h3>
                    <p className="text-sm text-slate-700 leading-relaxed bg-slate-50 p-4 rounded-xl border border-slate-100">
                      {selectedPatient.reason || 'No specific remarks provided during admission.'}
                    </p>
                  </div>

                  {/* --- INTEGRATED PRESCRIPTION & BILLING POS AREA --- */}
                  <div className="mt-6 border-t border-slate-200 pt-6 space-y-6">
                    
                    {/* Active Rx writer */}
                    <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                      <div className="flex items-center gap-2 mb-3">
                        <FileText className="w-4 h-4 text-teal-600" />
                        <h4 className="text-sm font-bold text-slate-800">Dynamic Medication Prescription (Rx)</h4>
                      </div>
                      
                      <div className="space-y-3">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                          <div className="md:col-span-2">
                            <label className="text-xs font-bold text-slate-600 block mb-1">Select Linked Inventory Item</label>
                            <select 
                              className="w-full p-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 outline-none font-medium"
                              value={prescribedMed}
                              onChange={(e) => setPrescribedMed(e.target.value)}
                            >
                              <option value="">-- Choose Meds from Catalog --</option>
                              {inventory.map(item => (
                                <option key={item.itemCode} value={item.itemCode} className="text-slate-900">
                                  {item.itemName} (PHP {item.sellingPrice.toFixed(2)} - Stock: {item.stock})
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="text-xs font-bold text-slate-600 block mb-1">Quantity</label>
                            <input 
                              type="number"
                              min="1"
                              className="w-full p-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 outline-none font-bold"
                              value={prescribedQuantity}
                              onChange={(e) => setPrescribedQuantity(parseInt(e.target.value) || 1)}
                            />
                          </div>
                        </div>

                        <div>
                          <label className="text-xs font-bold text-slate-600 block mb-1">Sig / Administration Instructions</label>
                          <textarea 
                            className="w-full p-2.5 bg-white border border-slate-200 rounded-lg text-xs font-mono text-slate-900 outline-none h-20 resize-none"
                            placeholder="e.g. Give orally 5 ml once a day as a daily maintenance routine after meals."
                            value={sigInstructions}
                            onChange={(e) => setSigInstructions(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Consolidated billing POS invoice card */}
                    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-inner space-y-4">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                        <div className="flex items-center gap-2">
                          <TrendingUp className="w-4 h-4 text-emerald-600" />
                          <h4 className="text-sm font-bold text-slate-800">Dynamic Invoicing Ledger</h4>
                        </div>
                        <span className="text-xs font-bold text-slate-400 uppercase">REF: {selectedPatient.id}</span>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="text-xs font-bold text-slate-600 block mb-1">Clinical Procedure Fee (PHP)</label>
                          <input 
                            type="number" 
                            className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold text-slate-900 outline-none"
                            value={clinicalProcedureFee}
                            onChange={(e) => setClinicalProcedureFee(parseFloat(e.target.value) || 0)}
                          />
                        </div>
                        <div>
                          <label className="text-xs font-bold text-slate-600 block mb-1">Pharmacy Med Cost (PHP)</label>
                          <div className="w-full p-2 bg-slate-100 border border-slate-200 rounded-lg text-sm font-bold text-slate-600">
                            {calculatePrescriptionCost().toFixed(2)}
                          </div>
                        </div>
                      </div>

                      <div className="pt-2 flex items-center justify-between bg-emerald-50/50 p-3 rounded-lg border border-emerald-100">
                        <div>
                          <span className="text-xs text-slate-500 font-bold uppercase tracking-wider block">Total Transaction Cost</span>
                          <span className="text-lg font-black text-emerald-700">PHP {calculateTotalInvoice().toFixed(2)}</span>
                        </div>
                        <button 
                          type="button"
                          onClick={applyInvoiceToBalance}
                          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg transition-all shadow-md shadow-emerald-600/20"
                        >
                          Add to Client Balance
                        </button>
                      </div>
                    </div>

                  </div>
                </div>
              )}
            </div>
            
            {/* Drawer Footer Actions */}
            <div className="p-4 border-t border-slate-200 bg-white flex gap-3">
              {isEditing ? (
                <>
                  <button onClick={cancelEditing} className="flex-1 bg-white border border-slate-300 text-slate-700 font-bold py-3 rounded-xl hover:bg-slate-50 transition-colors shadow-sm text-slate-900">
                    Cancel Edits
                  </button>
                  <button onClick={saveEdits} className="flex-1 bg-teal-600 text-white font-bold py-3 rounded-xl hover:bg-teal-700 transition-colors shadow-md shadow-teal-600/20">
                    Save Changes
                  </button>
                </>
              ) : (
                <>
                  <button onClick={startEditing} className="flex-1 bg-slate-900 hover:bg-slate-800 text-white font-bold py-3 rounded-xl transition-colors shadow-md text-slate-900 text-white">
                    Edit Clinical Details
                  </button>
                  {}
                  <button 
                    onClick={() => {
                      setShowFullReport(true);
                    }}
                    className="flex-1 bg-teal-600 text-white font-bold py-3 rounded-xl hover:bg-teal-700 transition-colors shadow-md shadow-teal-600/20 flex items-center justify-center gap-2"
                  >
                    <FileText className="w-5 h-5" />
                    Full View Report
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {/* --- END SLIDE-OUT DRAWER --- */}

      {}
      {/* --- CLINICAL DOSSIER FULL REPORT MODAL --- */}
      {showFullReport && selectedPatient && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-md flex justify-center p-4 md:p-10">
          <div className="relative w-full max-w-5xl bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col my-auto max-h-[90vh]">
            
            {/* Modal Header */}
            <div className="bg-slate-900 text-white px-8 py-5 flex items-center justify-between sticky top-0 z-10 border-b border-slate-800">
              <div className="flex items-center gap-3">
                <Activity className="w-6 h-6 text-teal-400" />
                <div>
                  <h2 className="text-xl font-bold tracking-wide">Patient Clinical Dossier</h2>
                  <p className="text-xs text-slate-400">Veterinary SOAP Report • Biñan Animal Practice System</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => window.print()}
                  className="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 border border-slate-700"
                >
                  <FileSpreadsheet className="w-4 h-4" /> Print / Export
                </button>
                <button 
                  onClick={() => setShowFullReport(false)}
                  className="bg-teal-500 hover:bg-teal-600 text-slate-950 font-bold p-2.5 rounded-full transition-all"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Dossier Report Body */}
            <div className="flex-1 overflow-y-auto p-8 space-y-8 bg-slate-50 text-slate-800">
              
              {/* Profile Card & Demographics */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                
                {/* Primary Patient Card */}
                <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm flex flex-col items-center text-center">
                  <div className="w-24 h-24 rounded-2xl bg-teal-50 border border-teal-200 flex items-center justify-center overflow-hidden mb-4 shadow-inner">
                    {selectedPatient.pictures && selectedPatient.pictures[0] ? (
                      <img src={selectedPatient.pictures[0]} alt={selectedPatient.name} className="w-full h-full object-cover" />
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

                {/* Owner & Legal Custody Card */}
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
                        <span className="text-[10px] text-slate-400 font-bold uppercase block">Primary Phone</span>
                        <p className="text-sm font-bold text-slate-900">{selectedPatient.ownerContact}</p>
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-400 font-bold uppercase block">Email Coordinates</span>
                        <p className="text-sm font-bold text-slate-900">{selectedPatient.ownerEmail || "N/A - Offline Registry Only"}</p>
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-400 font-bold uppercase block">Residence Coordinates</span>
                        <p className="text-xs font-medium text-slate-700">{selectedPatient.ownerAddress || "Biñan Animal Center Local Jurisdiction"}</p>
                      </div>
                    </div>
                  </div>

                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center justify-between mt-auto">
                    <div>
                      <span className="text-[10px] text-slate-400 font-bold uppercase block">Ledger Balance Summary</span>
                      <p className="text-lg font-black text-slate-800">PHP {selectedPatient.balance.toFixed(2)}</p>
                    </div>
                    <button 
                      onClick={() => {
                        const updated = { ...selectedPatient, balance: 0 };
                        onUpdatePatient(updated);
                        setSelectedPatient(updated);
                        triggerToast(`Ledger balance cleared.`);
                      }}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-4 py-2 rounded-lg transition-all"
                    >
                      Clear Account Balance
                    </button>
                  </div>
                </div>

              </div>

              {/* Patient Admission Gallery / Pictures */}
              <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-4">
                <h4 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3">
                  <Sparkles className="w-5 h-5 text-yellow-500" />
                  Clinical & Diagnostic Images Gallery
                </h4>
                {selectedPatient.pictures && selectedPatient.pictures.length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {selectedPatient.pictures.map((pic, idx) => (
                      <div key={idx} className="group relative rounded-xl border border-slate-200 overflow-hidden bg-slate-900 aspect-video flex items-center justify-center shadow-sm">
                        <img src={pic} alt={`Diagnostic #${idx}`} className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-200" />
                        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity p-2 flex items-end justify-between">
                          <span className="text-[9px] text-teal-400 font-bold font-mono">IMG-0{idx+1}</span>
                          <button 
                            onClick={() => window.open(pic, '_blank')}
                            className="bg-teal-500 hover:bg-teal-400 text-slate-900 font-bold px-2 py-0.5 rounded text-[10px]"
                          >
                            Enlarge
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400 text-center py-6">No clinical diagnostic photographs or scans uploaded to this patient profile yet.</p>
                )}
              </div>

              {/* Lab Results Metrics Panel */}
              <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-4">
                <h4 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3">
                  <TestTube className="w-5 h-5 text-teal-600" />
                  Dynamic Laboratory Panels & Bio-findings
                </h4>
                
                {selectedPatient.labResults && selectedPatient.labResults.length > 0 ? (
                  <div className="space-y-6">
                    {selectedPatient.labResults.map((result) => (
                      <div key={result.id} className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50/50">
                        <div className="bg-slate-200/60 px-4 py-2 flex justify-between items-center text-xs font-bold text-slate-700">
                          <span>{result.testName}</span>
                          <span>Report Date: {result.date}</span>
                        </div>
                        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <span className="text-[10px] text-slate-400 font-bold uppercase block mb-1">Diagnostic Interpretation</span>
                            <p className="text-sm text-slate-700 leading-relaxed font-medium bg-white p-3 rounded-xl border border-slate-100">
                              {result.findings}
                            </p>
                          </div>
                          <div>
                            <span className="text-[10px] text-slate-400 font-bold uppercase block mb-2">Panel Analyte Breakdown</span>
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              {Object.entries(result.metrics).map(([name, val]) => (
                                <div key={name} className="bg-white border border-slate-100 px-3 py-1.5 rounded-lg flex justify-between">
                                  <span className="font-semibold text-slate-500">{name}</span>
                                  <span className={`font-bold ${val.includes('High') ? 'text-red-600' : val.includes('Low') ? 'text-amber-600' : 'text-slate-800'}`}>
                                    {val}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-6 bg-slate-50/50 rounded-xl border border-slate-200 border-dashed">
                    <p className="text-sm text-slate-500">No laboratory panel files linked. Generate AI Hematology charts or import CSV values via the Portal.</p>
                  </div>
                )}
              </div>

              {/* Consultation History / Chief Complaint SOAP Notes */}
              <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-4">
                <h4 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3">
                  <Stethoscope className="w-5 h-5 text-purple-600" />
                  Clinical Encounter Timeline & Chief Complaint
                </h4>
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 font-medium text-sm text-slate-700 space-y-3">
                  <p className="leading-relaxed">
                    <span className="font-bold text-slate-800 block mb-1">Chief Complaint:</span>
                    {selectedPatient.reason}
                  </p>
                  <p className="text-xs text-slate-500 italic">Record created dynamically in accordance with practice guidelines.</p>
                </div>
              </div>

            </div>

            {/* Modal Footer */}
            <div className="p-6 bg-white border-t border-slate-200 flex justify-end">
              <button 
                onClick={() => setShowFullReport(false)}
                className="bg-slate-900 hover:bg-slate-800 text-white font-bold px-6 py-3 rounded-xl text-sm transition-all shadow-md"
              >
                Close Clinical Dossier
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Title block */}
      <div>
        <h2 className="text-2xl font-bold text-slate-800">Admission & Patient Records</h2>
        <p className="text-slate-500 font-medium font-medium">Unifies client cards, patient profiles, and workflow tagging in one screen.</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* --- LEFT COLUMN: ADMISSION FORM WITH FILE ATTACHMENT --- */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm h-fit">
          <h3 className="text-lg font-bold text-slate-800 mb-6 flex items-center gap-2 border-b border-slate-100 pb-4">
            <PlusCircle className="text-teal-600 w-5 h-5" />
            New Patient Admission
          </h3>
          
          <form onSubmit={handleSubmit} className="space-y-6">
            
            {/* Client Section */}
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                <User className="w-3.5 h-3.5" /> Client Info
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <label className="text-xs font-bold text-slate-700 block mb-1">Owner Name *</label>
                  <input type="text" className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none" placeholder="e.g. Juan Dela Cruz" value={owner} onChange={e => setOwner(e.target.value)} required />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs font-bold text-slate-700 block mb-1">Contact Number *</label>
                  <input type="text" className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none" placeholder="09XX-XXX-XXXX" value={contact} onChange={e => setContact(e.target.value)} required />
                </div>
              </div>
            </div>

            <div className="h-px bg-slate-100 w-full" />

            {/* Patient Section */}
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                <PawPrint className="w-3.5 h-3.5" /> Patient Details
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <label className="text-xs font-bold text-slate-700 block mb-1">Pet Name *</label>
                  <input type="text" className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none" placeholder="e.g. Dobby" value={name} onChange={e => setName(e.target.value)} required />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Species *</label>
                  <select className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none" value={species} onChange={e => setSpecies(e.target.value)}>
                    <option value="Canine">Canine</option>
                    <option value="Feline">Feline</option>
                    <option value="Avian">Avian</option>
                    <option value="Exotic">Exotic</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Gender *</label>
                  <select className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none" value={gender} onChange={e => setGender(e.target.value as any)}>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Unknown">Unknown</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs font-bold text-slate-700 block mb-1">Breed / Variety *</label>
                  <input type="text" className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none" placeholder="e.g. Pomeranian" value={breed} onChange={e => setBreed(e.target.value)} required />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs font-bold text-slate-700 block mb-1">Weight (kg) *</label>
                  <input type="number" step="0.1" className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none" placeholder="e.g. 4.2" value={weight} onChange={e => setWeight(e.target.value)} required />
                </div>
              </div>
            </div>

            <div className="h-px bg-slate-100 w-full" />

            {}
            {/* Clinical Photo Attachments Block */}
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-yellow-500" /> Clinical Files & Diagnostic Scans
              </h4>
              
              <div className="border-2 border-dashed border-slate-200 rounded-xl p-4 text-center hover:border-teal-300 transition-colors bg-slate-50">
                <input 
                  type="file" 
                  id="imageUpload" 
                  multiple 
                  accept="image/*" 
                  onChange={handleImageUpload} 
                  className="hidden" 
                />
                <label htmlFor="imageUpload" className="cursor-pointer block">
                  <Sparkles className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                  <span className="text-xs font-bold text-slate-700 block">Upload Real Clinical Photos</span>
                  <span className="text-[10px] text-slate-400 block mt-1">Select from computer or smartphone</span>
                </label>
              </div>

              {/* Preselected Preset Templates for convenient local testing */}
              <div>
                <span className="text-[10px] font-bold text-slate-400 uppercase block mb-2">Simulate Bio-scans / Quick Presets</span>
                <div className="grid grid-cols-2 gap-2">
                  <button 
                    type="button" 
                    onClick={() => handleQuickInsertPreset('https://images.unsplash.com/photo-1576091160550-2173dba999ef?auto=format&fit=crop&q=80&w=400')}
                    className="border border-slate-200 p-2 rounded-lg bg-white text-left hover:border-teal-400 hover:bg-teal-50/20 transition-all"
                  >
                    <span className="text-[10px] font-bold text-slate-700 block">Attach X-Ray Scan</span>
                  </button>
                  <button 
                    type="button" 
                    onClick={() => handleQuickInsertPreset('https://images.unsplash.com/photo-1559757175-5700dde675bc?auto=format&fit=crop&q=80&w=400')}
                    className="border border-slate-200 p-2 rounded-lg bg-white text-left hover:border-teal-400 hover:bg-teal-50/20 transition-all"
                  >
                    <span className="text-[10px] font-bold text-slate-700 block">Attach Lab Exam Panel</span>
                  </button>
                </div>
              </div>

              {/* Active Attached Form Preview Block */}
              {formPictures.length > 0 && (
                <div className="grid grid-cols-4 gap-2 border border-slate-200 p-2 rounded-xl bg-white max-h-24 overflow-y-auto">
                  {formPictures.map((pic, idx) => (
                    <div key={idx} className="relative aspect-square rounded-lg overflow-hidden border border-slate-200 bg-slate-50 group">
                      <img src={pic} alt="preview" className="w-full h-full object-cover" />
                      <button 
                        type="button"
                        onClick={() => setFormPictures(prev => prev.filter((_, i) => i !== idx))}
                        className="absolute inset-0 bg-red-600/80 text-white font-bold opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-xs"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="h-px bg-slate-100 w-full" />

            {/* Visit Section */}
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                <Activity className="w-3.5 h-3.5" /> Visit Purpose
              </h4>
              
              <div>
                <label className="text-xs font-bold text-slate-700 block mb-2">Admission Tags (Select multiple) *</label>
                <div className="flex flex-wrap gap-2">
                  {admissionOptions.map(option => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => toggleAdmission(option)}
                      className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
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
                <label className="text-xs font-bold text-slate-700 block mb-1">Chief Complaint / Notes</label>
                <textarea 
                  className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none resize-none h-20" 
                  placeholder="Reason for visit..."
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                />
              </div>
            </div>

            <button 
              type="submit" 
              className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-3 rounded-xl text-sm transition-colors mt-4 shadow-md text-white text-slate-900"
            >
              Admit Patient to Queue
            </button>
          </form>
        </div>

        {/* --- RIGHT COLUMN: ACTIVE DIRECTORY --- */}
        <div className="xl:col-span-2 bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col">
          <div className="p-6 border-b border-slate-200 bg-slate-50/50 flex justify-between items-center">
            <h3 className="text-lg font-bold text-slate-800">Active Patient Directory</h3>
            <span className="text-xs font-bold text-slate-500 bg-slate-200 px-3 py-1 rounded-full">
              {patients.length} Records
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-xs font-semibold uppercase border-b border-slate-200">
                  <th className="p-4">Patient Profile</th>
                  <th className="p-4">Tags</th>
                  <th className="p-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {patients.map((pat) => (
                  <tr 
                    key={pat.id} 
                    className="hover:bg-slate-50 transition-colors cursor-pointer group"
                    onClick={() => setSelectedPatient(pat)}
                  >
                    <td className="p-4">
                      {}
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl border border-slate-200 overflow-hidden bg-slate-50 flex items-center justify-center">
                          {pat.pictures && pat.pictures[0] ? (
                            <img src={pat.pictures[0]} alt={pat.name} className="w-full h-full object-cover" />
                          ) : (
                            <PawPrint className="w-5 h-5 text-slate-400" />
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-bold text-slate-800 group-hover:text-teal-600 transition-colors">{pat.name}</p>
                          <p className="text-xs text-slate-500">{pat.species} • {pat.breed}</p>
                          <p className="text-[10px] text-slate-400 uppercase mt-1">Owner: {pat.ownerName}</p>
                        </div>
                      </div>
                    </td>
                    <td className="p-4">
                      <div className="flex flex-wrap gap-1">
                        {pat.admissionTypes.map((type, i) => {
                          let colorClass = "bg-slate-100 text-slate-600 border-slate-200";
                          if (type === 'Grooming') colorClass = "bg-purple-50 text-purple-700 border-purple-200";
                          if (type === 'Medical Checkup') colorClass = "bg-blue-50 text-blue-700 border-blue-200";
                          if (type === 'Surgery') colorClass = "bg-red-50 text-red-700 border-red-200";
                          if (type === 'Confinement') colorClass = "bg-amber-50 text-amber-700 border-amber-200";
                          
                          return (
                            <span key={i} className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${colorClass}`}>
                              {type}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                    <td className="p-4">
                      <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-bold border ${
                        pat.status === 'Ready for Pickup' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                        pat.status === 'Confined' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                        pat.status === 'In Treatment' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                        'bg-slate-100 text-slate-700 border-slate-200'
                      }`}>
                        {pat.status}
                      </span>
                    </td>
                  </tr>
                ))}
                {patients.length === 0 && (
                  <tr>
                    <td colSpan={3} className="p-8 text-center text-slate-400">
                      <PawPrint className="w-8 h-8 mx-auto mb-2 opacity-20" />
                      No active patients in the queue.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

const InventoryControlView = ({ 
  inventory, 
  setInventory, 
  triggerToast
}: { 
  inventory: InventoryItem[]; 
  setInventory: React.Dispatch<React.SetStateAction<InventoryItem[]>>; 
  triggerToast: (msg: string) => void;
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  
  // Clean, dark-mode protected input form values
  const [itemName, setItemName] = useState('');
  const [category, setCategory] = useState<'Medicine' | 'Supplies' | 'Service' | 'Grooming'>('Medicine');
  const [stock, setStock] = useState<number | ''>('');
  const [buyingPrice, setBuyingPrice] = useState<number | ''>('');
  const [sellingPrice, setSellingPrice] = useState<number | ''>('');
  const [threshold, setThreshold] = useState<number | ''>('');

  // States for the Inventory Edit Slide-out Drawer
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<InventoryItem | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const filteredInventory = inventory.filter(item => 
    selectedCategory === 'All' ? true : item.category === selectedCategory
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!itemName || !buyingPrice || !sellingPrice) return;

    const isService = category === 'Service' || category === 'Grooming';
    const finalStock = isService ? 999 : Number(stock) || 0;
    const finalThreshold = isService ? 0 : Number(threshold) || 0;
    const prefix = isService ? 'SRV' : 'ITM';
    const nextCode = `${prefix}-00${140 + inventory.length + 1}`;

    const newItem: InventoryItem = {
      itemCode: nextCode,
      itemName,
      category,
      stock: finalStock,
      buyingPrice: Number(buyingPrice),
      sellingPrice: Number(sellingPrice),
      threshold: finalThreshold
    };

    setInventory([newItem, ...inventory]);
    triggerToast(`Added ${itemName} successfully to directory.`);

    // Reset Form
    setItemName('');
    setStock('');
    setBuyingPrice('');
    setSellingPrice('');
    setThreshold('');
  };

  const handleSaveEdits = () => {
    if (!editForm) return;
    setInventory(inventory.map(item => item.itemCode === editForm.itemCode ? editForm : item));
    setSelectedItem(editForm);
    setIsEditing(false);
    triggerToast(`Inventory item "${editForm.itemName}" updated.`);
  };

  const handleDeleteItem = () => {
    if (!selectedItem) return;
    setInventory(inventory.filter(item => item.itemCode !== selectedItem.itemCode));
    setSelectedItem(null);
    setIsEditing(false);
    setShowDeleteConfirm(false);
    triggerToast(`Inventory item has been permanently deleted.`);
  };

  return (
    <div className="space-y-6 relative">
      
      {/* --- SLIDE-OUT INVENTORY DETAILS & EDIT DRAWER --- */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Backdrop click dismisser */}
          <div 
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" 
            onClick={() => {
              setSelectedItem(null);
              setIsEditing(false);
              setShowDeleteConfirm(false);
            }} 
          />
          
          {/* Sliding Frame Panel */}
          <div className="relative w-full max-w-2xl bg-slate-50 h-full shadow-2xl flex flex-col border-l border-slate-200 overflow-hidden transform transition-transform duration-300 ease-in-out">
            {/* Drawer Header */}
            <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
              <div>
                <h2 className="text-xl font-bold text-slate-800">
                  {isEditing ? `Editing Catalog Item` : selectedItem.itemName}
                </h2>
                <p className="text-sm text-slate-500">
                  Item Code: {selectedItem.itemCode} | {selectedItem.category}
                </p>
              </div>
              <button 
                onClick={() => {
                  setSelectedItem(null);
                  setIsEditing(false);
                  setShowDeleteConfirm(false);
                }}
                className="p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 rounded-full transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Drawer Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {isEditing && editForm ? (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
                  
                  <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                      <Package className="w-4 h-4" /> Item Details
                    </h3>
                    <div>
                      <label className="text-xs font-bold text-slate-700 block mb-1">Item Name / Description</label>
                      <input 
                        type="text" 
                        className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 font-bold focus:ring-2 focus:ring-teal-500 outline-none" 
                        value={editForm.itemName} 
                        onChange={e => setEditForm({ ...editForm, itemName: e.target.value })} 
                      />
                    </div>
                    <div>
                      <label className="text-xs font-bold text-slate-700 block mb-1">Category</label>
                      <select 
                        className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                        value={editForm.category}
                        onChange={e => setEditForm({ ...editForm, category: e.target.value as any })}
                      >
                        <option value="Medicine">Medicine</option>
                        <option value="Supplies">Clinical Supplies</option>
                        <option value="Service">Medical Service / Procedure</option>
                        <option value="Grooming">Grooming Service</option>
                      </select>
                    </div>
                    {editForm.category !== 'Service' && editForm.category !== 'Grooming' && (
                      <div>
                        <label className="text-xs font-bold text-slate-700 block mb-1">Current Stock Level</label>
                        <input 
                          type="number" 
                          className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 font-bold focus:ring-2 focus:ring-teal-500 outline-none" 
                          value={editForm.stock} 
                          onChange={e => setEditForm({ ...editForm, stock: parseInt(e.target.value) || 0 })} 
                        />
                      </div>
                    )}
                  </div>

                  <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                      <TrendingUp className="w-4 h-4" /> Pricing & Thresholds
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs font-bold text-slate-700 block mb-1">Buying Price (PHP)</label>
                        <input 
                          type="number" 
                          step="0.01" 
                          className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 font-bold focus:ring-2 focus:ring-teal-500 outline-none" 
                          value={editForm.buyingPrice} 
                          onChange={e => setEditForm({ ...editForm, buyingPrice: parseFloat(e.target.value) || 0 })} 
                        />
                      </div>
                      <div>
                        <label className="text-xs font-bold text-slate-700 block mb-1">Selling Price (PHP)</label>
                        <input 
                          type="number" 
                          step="0.01" 
                          className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 font-bold focus:ring-2 focus:ring-teal-500 outline-none" 
                          value={editForm.sellingPrice} 
                          onChange={e => setEditForm({ ...editForm, sellingPrice: parseFloat(e.target.value) || 0 })} 
                        />
                      </div>
                      {editForm.category !== 'Service' && editForm.category !== 'Grooming' && (
                        <div className="col-span-2">
                          <label className="text-xs font-bold text-slate-700 block mb-1">Low-Stock Alert Threshold</label>
                          <input 
                            type="number" 
                            className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 font-bold focus:ring-2 focus:ring-teal-500 outline-none" 
                            value={editForm.threshold} 
                            onChange={e => setEditForm({ ...editForm, threshold: parseInt(e.target.value) || 0 })} 
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-red-50 rounded-2xl p-5 border border-red-200 shadow-sm space-y-3">
                    <h3 className="text-sm font-bold text-red-800 flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-red-600" /> Danger Zone
                    </h3>
                    <p className="text-xs text-red-700 leading-relaxed">
                      Permanently deleting this item removes it completely from the catalog. This action cannot be undone.
                    </p>
                    
                    {!showDeleteConfirm ? (
                      <button 
                        type="button"
                        onClick={() => setShowDeleteConfirm(true)}
                        className="flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-all shadow-sm"
                      >
                        <Trash2 className="w-4 h-4" /> Delete Catalog Item
                      </button>
                    ) : (
                      <div className="p-3 bg-white border border-red-200 rounded-xl space-y-3">
                        <p className="text-xs font-bold text-red-600">Are you absolutely sure you want to delete this item?</p>
                        <div className="flex gap-2">
                          <button 
                            type="button"
                            onClick={() => setShowDeleteConfirm(false)}
                            className="bg-slate-100 text-slate-700 hover:bg-slate-200 px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
                          >
                            Cancel
                          </button>
                          <button 
                            type="button"
                            onClick={handleDeleteItem}
                            className="bg-red-600 hover:bg-red-700 text-white px-4 py-1.5 rounded-lg text-xs font-black transition-all shadow-inner"
                          >
                            Yes, Confirm Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
                  <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                      <Package className="w-4 h-4" /> Item Summary
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="col-span-2">
                        <p className="text-xs text-slate-500 mb-1">Category</p>
                        <p className="text-sm font-bold text-slate-800">{selectedItem.category}</p>
                      </div>
                      {selectedItem.category !== 'Service' && selectedItem.category !== 'Grooming' ? (
                        <>
                          <div>
                            <p className="text-xs text-slate-500 mb-1">In Stock</p>
                            <p className={`text-lg font-black ${selectedItem.stock <= selectedItem.threshold ? 'text-red-600' : 'text-slate-800'}`}>
                              {selectedItem.stock} units
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-slate-500 mb-1">Alert Threshold</p>
                            <p className="text-lg font-bold text-slate-700">{selectedItem.threshold} units</p>
                          </div>
                        </>
                      ) : (
                        <div className="col-span-2">
                          <p className="text-xs text-slate-500 mb-1">Availability</p>
                          <span className="text-sm font-bold text-slate-400">∞ Service (Unlimited)</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                      <TrendingUp className="w-4 h-4" /> Pricing Matrix
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                        <p className="text-xs text-slate-500 mb-1">Cost Price</p>
                        <p className="text-lg font-bold text-slate-700">PHP {selectedItem.buyingPrice.toFixed(2)}</p>
                      </div>
                      <div className="bg-emerald-50 p-4 rounded-xl border border-emerald-100">
                        <p className="text-xs text-emerald-600 font-bold mb-1">Selling Price</p>
                        <p className="text-xl font-black text-emerald-700">PHP {selectedItem.sellingPrice.toFixed(2)}</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Drawer Footer Actions */}
            <div className="p-4 border-t border-slate-200 bg-white flex gap-3">
              {isEditing ? (
                <>
                  <button onClick={() => setIsEditing(false)} className="flex-1 bg-white border border-slate-300 text-slate-900 font-bold py-3 rounded-xl hover:bg-slate-50 transition-colors shadow-sm">
                    Cancel Edits
                  </button>
                  <button onClick={handleSaveEdits} className="flex-1 bg-teal-600 text-white font-bold py-3 rounded-xl hover:bg-teal-700 transition-colors shadow-md shadow-teal-600/20">
                    Save Changes
                  </button>
                </>
              ) : (
                <button onClick={() => { setEditForm(selectedItem); setIsEditing(true); }} className="w-full bg-slate-900 text-white font-bold py-3 rounded-xl hover:bg-slate-800 transition-colors shadow-md">
                  Edit Item Details
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div>
        <h2 className="text-2xl font-bold text-slate-800">Inventory & Service Control</h2>
        <p className="text-slate-500 font-medium">Consolidates legacy items, medicines, and surgical procedures into one cohesive catalog.</p>
      </div>

      {/* Category Toggle Filters */}
      <div className="flex flex-wrap gap-2">
        {['All', 'Medicine', 'Supplies', 'Service', 'Grooming'].map(cat => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`px-4 py-2 rounded-xl text-xs font-bold border transition-all ${
              selectedCategory === cat
                ? 'bg-slate-900 text-white border-slate-900 shadow-md'
                : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
            }`}
          >
            {cat}s
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* --- LEFT FORM: ADD ITEM / SERVICE --- */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm h-fit">
          <h3 className="text-lg font-bold text-slate-800 mb-6 flex items-center gap-2 border-b border-slate-100 pb-4">
            <PlusCircle className="text-teal-600 w-5 h-5" />
            New Item / Service
          </h3>
          
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">Name / Procedure Description *</label>
              <input 
                type="text" 
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 font-bold focus:ring-2 focus:ring-teal-500 outline-none" 
                placeholder="e.g. Ketoconazole 200mg" 
                value={itemName} 
                onChange={e => setItemName(e.target.value)} 
                required 
              />
            </div>

            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">Catalog Classification</label>
              <select 
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                value={category}
                onChange={e => setCategory(e.target.value as any)}
              >
                <option value="Medicine">Medicine</option>
                <option value="Supplies">Clinical Supplies</option>
                <option value="Service">Medical Service / Procedure</option>
                <option value="Grooming">Grooming Service</option>
              </select>
            </div>

            {category !== 'Service' && category !== 'Grooming' && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Initial Stock</label>
                  <input 
                    type="number" 
                    className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 font-bold focus:ring-2 focus:ring-teal-500 outline-none" 
                    placeholder="e.g. 50" 
                    value={stock} 
                    onChange={e => setStock(e.target.value ? Number(e.target.value) : '')} 
                  />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Low-Stock Alert</label>
                  <input 
                    type="number" 
                    className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 font-bold focus:ring-2 focus:ring-teal-500 outline-none" 
                    placeholder="e.g. 10" 
                    value={threshold} 
                    onChange={e => setThreshold(e.target.value ? Number(e.target.value) : '')} 
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 pt-2">
              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">Buying Price (PHP) *</label>
                <input 
                  type="number" 
                  step="0.01" 
                  className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 font-bold focus:ring-2 focus:ring-teal-500 outline-none" 
                  placeholder="0.00" 
                  value={buyingPrice} 
                  onChange={e => setBuyingPrice(e.target.value ? Number(e.target.value) : '')} 
                  required 
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">Selling Price (PHP) *</label>
                <input 
                  type="number" 
                  step="0.01" 
                  className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 font-bold focus:ring-2 focus:ring-teal-500 outline-none" 
                  placeholder="0.00" 
                  value={sellingPrice} 
                  onChange={e => setSellingPrice(e.target.value ? Number(e.target.value) : '')} 
                  required 
                />
              </div>
            </div>

            <button 
              type="submit" 
              className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-3 rounded-xl text-sm transition-colors mt-4 shadow-md text-slate-900"
            >
              Add to Catalog
            </button>
          </form>
        </div>

        {/* --- RIGHT: DYNAMIC DIRECTORY VIEW --- */}
        <div className="xl:col-span-2 bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col">
          <div className="p-6 border-b border-slate-200 bg-slate-50/50 flex justify-between items-center">
            <h3 className="text-lg font-bold text-slate-800">Unified Catalog List</h3>
            <span className="text-xs font-bold text-slate-500 bg-slate-200 px-3 py-1 rounded-full">
              {filteredInventory.length} Items Listed
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-xs font-semibold uppercase border-b border-slate-200">
                  <th className="p-4">Code</th>
                  <th className="p-4">Item description</th>
                  <th className="p-4 text-center">Stock level</th>
                  <th className="p-4 text-right">Cost Price</th>
                  <th className="p-4 text-right">Sale Price</th>
                  <th className="p-4 text-right">Margin %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredInventory.map((item) => {
                  const isService = item.category === 'Service' || item.category === 'Grooming';
                  const marginValue = item.sellingPrice - item.buyingPrice;
                  const marginPct = item.sellingPrice > 0 ? (marginValue / item.sellingPrice) * 100 : 0;

                  return (
                    <tr 
                      key={item.itemCode}
                      onClick={() => {
                        setSelectedItem(item);
                        setEditForm(item);
                        setIsEditing(false);
                        setShowDeleteConfirm(false);
                      }}
                      className="hover:bg-slate-50 transition-colors cursor-pointer group"
                    >
                      <td className="p-4 text-sm font-bold text-slate-800 group-hover:text-teal-600 transition-colors">{item.itemCode}</td>
                      <td className="p-4 text-sm font-bold text-slate-800">
                        <div>
                          {item.itemName}
                          <span className="text-[10px] text-slate-500 block uppercase font-bold mt-0.5 tracking-wider">{item.category}</span>
                        </div>
                      </td>
                      <td className="p-4 text-center">
                        {isService ? (
                          <span className="text-xs font-bold text-slate-400">∞ Service</span>
                        ) : (
                          <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-black ${
                            item.stock <= item.threshold ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-800'
                          }`}>
                            {item.stock} unit/s
                          </span>
                        )}
                      </td>
                      <td className="p-4 text-sm text-slate-800 text-right font-medium">
                        PHP {item.buyingPrice.toFixed(2)}
                      </td>
                      <td className="p-4 text-sm text-slate-900 text-right font-bold">
                        PHP {item.sellingPrice.toFixed(2)}
                      </td>
                      <td className="p-4 text-sm text-right font-bold text-emerald-600">
                        {isService ? 'N/A' : `${marginPct.toFixed(0)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

const AILaboratoryView = () => {
  const [inputText, setInputText] = useState("");
  const [analysisResult, setAnalysisResult] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const handleAnalyze = async () => {
    if (!inputText.trim()) return;
    setIsAnalyzing(true);
    setAnalysisResult("");
    
    const prompt = `You are a highly advanced veterinary clinical decision support AI. 
    Analyze the following raw laboratory results or clinical notes. 
    Provide: 
    1. A brief summary of abnormalities.
    2. A bulleted list of 3 potential differential diagnoses based on these findings.
    3. Recommended next steps or confirmatory tests.
    Format the response clearly using spacing and bullet points. Do not use bold markdown formatting, just plain text with clear spacing.
    
    Data to analyze:
    ${inputText}`;

    try {
      const result = await generateGeminiText(prompt);
      setAnalysisResult(result);
    } catch (error) {
      setAnalysisResult("An error occurred while communicating with the AI. Please try again.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <TestTube className="text-teal-600" />
          Laboratory & AI Diagnostics
        </h2>
        <p className="text-slate-500 font-medium">Bridges clinical tests and diagnostics directly with AI powered context analysis.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Input Section */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex flex-col">
          <label className="text-sm font-bold text-slate-800 mb-2">Machine Lab Output / Notes</label>
          <textarea 
            className="w-full flex-1 min-h-[300px] p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-teal-500 outline-none resize-none"
            placeholder="e.g. Hematology scan values: WBC 21.0 H, HGB 10.1 L, PLT 110 L. Patient shows poor appetite and fever."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
          />
          <button 
            onClick={handleAnalyze}
            disabled={isAnalyzing || !inputText.trim()}
            className="mt-4 w-full flex items-center justify-center gap-2 bg-gradient-to-r from-teal-500 to-emerald-500 text-white px-4 py-3 rounded-xl font-bold shadow-md hover:shadow-lg disabled:opacity-50 transition-all"
          >
            {isAnalyzing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5 text-yellow-300" />}
            {isAnalyzing ? "Processing..." : "✨ Get Clinical Summary"}
          </button>
        </div>

        {/* Output Insights Panel */}
        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm flex flex-col relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-teal-500/10 rounded-full blur-3xl pointer-events-none"></div>
          <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2 relative z-10">
            <Sparkles className="text-teal-400 w-5 h-5" />
            AI Diagnostics Intelligence
          </h3>
          <div className="flex-1 bg-slate-800/50 border border-slate-700 rounded-xl p-5 overflow-y-auto relative z-10">
            {analysisResult ? (
              <div className="text-slate-300 text-sm whitespace-pre-wrap leading-relaxed">
                {analysisResult}
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-3 py-16">
                <Sparkles className="w-10 h-10 opacity-20" />
                <p className="text-center text-sm">Awaiting clinical records for processing.<br/>Synthesized diagnostics will populate here.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const SystemSettingsView = ({ 
  inventory, 
  setInventory, 
  triggerToast 
}: { 
  inventory: InventoryItem[]; 
  setInventory: React.Dispatch<React.SetStateAction<InventoryItem[]>>; 
  triggerToast: (msg: string) => void; 
}) => {
  const [apiStatus, setApiStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [apiResponse, setApiResponse] = useState('');

  const handleTestConnection = async () => {
    setApiStatus('testing');
    setApiResponse('');
    try {
      // Sends a lightweight greeting to verify the API key channel is completely open
      const response = await generateGeminiText("Hello! This is Biñan Animal Clinic testing your connection. Please reply with a short, friendly one sentence greeting.");
      setApiResponse(response);
      setApiStatus('success');
      triggerToast("Gemini API connection verified successfully!");
    } catch (error) {
      setApiStatus('error');
      setApiResponse(error instanceof Error ? error.message : "Connection failed. Please verify your API key.");
      triggerToast("Gemini API connection failed.");
    }
  };

  const handleCSVImport = () => {
    const newItems: InventoryItem[] = [
      { itemCode: 'ITM-00201', itemName: 'Nexgard Chewables Medium', category: 'Medicine', stock: 15, buyingPrice: 0, sellingPrice: 650.00, threshold: 4 },
      { itemCode: 'ITM-00202', itemName: 'Baytril Otic drops 15ml', category: 'Medicine', stock: 8, buyingPrice: 0, sellingPrice: 920.00, threshold: 2 },
    ];
    setInventory([...inventory, ...newItems]);
    triggerToast("Batch imported Nexgard and Baytril from legacy Excel catalog.");
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-800">Clinic Settings & Import Portal</h2>
        <p className="text-slate-500 font-medium font-medium">Configure clinic variables, manage security rules, and migrate records from old software platforms.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* API KEY CONNECTION TESTER */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="text-teal-500 w-5 h-5 animate-pulse" />
              <h3 className="text-lg font-bold text-slate-800">Gemini AI Connection Tester</h3>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">
              Verify your free Google Gemini API key channel. Clicking the test button will trigger a real time handshake greeting with the model.
            </p>

            {apiStatus !== 'idle' && (
              <div className={`p-4 rounded-xl border text-sm leading-relaxed transition-all ${
                apiStatus === 'testing' ? 'bg-slate-50 border-slate-200 text-slate-500' :
                apiStatus === 'success' ? 'bg-emerald-50 border-emerald-200 text-slate-900 font-medium' :
                'bg-red-50 border-red-200 text-red-800 font-medium'
              }`}>
                {apiStatus === 'testing' && (
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-teal-500" />
                    <span>Contacting Google Gemini server endpoints...</span>
                  </div>
                )}
                {apiStatus === 'success' && (
                  <div>
                    <span className="text-[10px] uppercase font-bold tracking-wider text-emerald-600 block mb-1">Gemini Response:</span>
                    <span className="text-slate-900 font-bold">{apiResponse}</span>
                  </div>
                )}
                {apiStatus === 'error' && (
                  <div>
                    <span className="text-[10px] uppercase font-bold tracking-wider text-red-600 block mb-1">Error Details:</span>
                    <span>{apiResponse}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <button 
            type="button"
            onClick={handleTestConnection}
            disabled={apiStatus === 'testing'}
            className="w-full bg-teal-600 text-white font-bold py-3 rounded-xl hover:bg-teal-700 text-sm transition-all flex items-center justify-center gap-2 shadow-md shadow-teal-600/10 disabled:opacity-50"
          >
            <Sparkles className="w-4 h-4 text-yellow-300" />
            Test AI Handshake Response
          </button>
        </div>

        {/* Legacy Data Ingestion Block */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="text-emerald-600 w-5 h-5" />
              <h3 className="text-lg font-bold text-slate-800">Legacy Data Migration</h3>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">
              Quickly load existing product records. This simulates the legacy Excel parser present in your father's old application, mapping legacy CSV databases to clean state structures instantly.
            </p>
          </div>
          <button 
            onClick={handleCSVImport}
            className="w-full bg-slate-950 text-white font-bold py-3 rounded-xl hover:bg-slate-800 text-sm transition-all flex items-center justify-center gap-2 shadow-sm mt-4"
          >
            <Database className="w-4 h-4 text-teal-400" />
            Simulate Excel Database Migration
          </button>
        </div>

      </div>
    </div>
  );
};