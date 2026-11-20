"use client";

import { useState } from 'react';
import { TestTube, Sparkles } from 'lucide-react';

export const AILaboratoryView = ({
  triggerToast
}: {
  triggerToast: (msg: string) => void;
}) => {
  const [showExample, setShowExample] = useState(false);
  const revealExample = () => {
    setShowExample(true);
    triggerToast('Fictional example shown. No analysis was performed.');
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-content-heading flex items-center gap-2">
          <TestTube className="text-brand-text" />
          Laboratory & AI Demo
        </h2>
        <p className="mt-2 text-sm font-bold text-warning-text">Fictional example only. No AI provider is called, and no patient data is collected or analyzed on this screen.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-panel p-6 rounded-2xl border border-outline-soft shadow-sm space-y-4">
          <h3 className="font-bold text-content-heading">Fictional sample</h3>
          <p className="text-sm text-content-secondary">Sample DEMO-LAB-01 · No specimen or report attached.</p>
          <button type="button" onClick={revealExample} className="vc-btn">
            Show fictional example
          </button>
        </div>

        {/* Output Insights Panel */}
        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-sm flex flex-col relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-teal-500/10 rounded-full blur-3xl pointer-events-none"></div>
          <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2 relative z-10">
            <Sparkles className="text-teal-400 w-5 h-5" />
            Fictional example output
          </h3>
          <div className="flex-1 bg-slate-800/50 border border-slate-700 rounded-xl p-5 overflow-y-auto relative z-10">
            {showExample ? (
              <p className="text-slate-300 text-sm leading-relaxed">
                DEMO-LAB-01 · Example report status: no results available. This is predefined output, not a clinical finding.
              </p>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-content-hint space-y-3 py-16">
                <Sparkles className="w-10 h-10 opacity-20" />
                <p className="text-center text-sm">Select “Show fictional example” to preview the output.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
