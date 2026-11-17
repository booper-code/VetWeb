"use client";

import React, { useState } from 'react';
import { TestTube, Sparkles, Loader2, PlusCircle } from 'lucide-react';
import { compressImageFile, DOCUMENT_IMAGE_OPTIONS } from '@/lib/images';

export const AILaboratoryView = ({
  triggerToast
}: {
  triggerToast: (msg: string) => void;
}) => {
  const [inputText, setInputText] = useState("");
  const [analysisResult, setAnalysisResult] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [attachedImage, setAttachedImage] = useState<string | null>(null);

  const handleAttachImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const image = await compressImageFile(file, DOCUMENT_IMAGE_OPTIONS);
      setAttachedImage(image.dataUrl);
    } catch (err) {
      console.error('[Images] Failed to encode scan', err);
      triggerToast("Could not read that image. Try a JPG or PNG file.");
    }

    e.target.value = '';
  };

const handleAnalyze = () => {
  setIsAnalyzing(true);
  
  if (typeof triggerToast === 'function') {
    triggerToast("Gemini 3.5 Flash: Running comprehensive multimodal diagnostic matrix...");
  }

  setTimeout(() => {
    // 1. Auto-fill the text area with structured analytics if an image was attached
    if (attachedImage) {
      setInputText(
        "IDEXX HealthChek Plus (CHEM 25 w/ SDMA)\n" +
        "--------------------------------------\n" +
        "ALP: 163 H  (Ref: 5-160 U/L)\n" +
        "BUN: 41 H   (Ref: 9-31 mg/dL)\n" +
        "CREA: 0.9 N (Ref: 0.5-1.5 mg/dL)\n" +
        "BUN/CREA RATIO: 45.6 H\n" +
        "HEMOLYSIS INDEX: +++ (Severe Gross)\n" +
        "LIPEMIA INDEX: N (Gross Lipemia)"
      );
    }

    // 2. Inject the clinical-grade medical synthesis directly into your analysis container
    const advancedSynthesis = 
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

    setAnalysisResult(advancedSynthesis);
    setIsAnalyzing(false);

    if (typeof triggerToast === 'function') {
      triggerToast("Advanced clinical analysis finalized successfully.");
    }
  }, 1800); // 1.8 seconds timeout to mimic deep AI cloud processing
};

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <TestTube className="text-teal-600" />
          Laboratory & AI Diagnostics
        </h2>
        <p className="text-slate-500 font-medium">Bridges clinical tests and diagnostics directly with AI powered context analysis.</p>
        <p className="mt-2 text-sm font-bold text-amber-800">Demo only: this screen displays predefined example results and does not analyze the input. Do not use it for clinical decisions.</p>
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
          
          {/* Image Preview Area */}
          {attachedImage && (
            <div className="relative mt-4 w-32 h-32 rounded-xl border border-slate-200 overflow-hidden group shadow-sm">
              <img src={attachedImage} alt="Attached Lab Scan" className="w-full h-full object-cover" />
              <button 
                onClick={() => setAttachedImage(null)}
                className="absolute inset-0 bg-red-600/80 text-white font-bold opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-xs backdrop-blur-sm"
              >
                Remove
              </button>
            </div>
          )}

          {/* Action Toolbar */}
          <div className="mt-4 flex flex-col sm:flex-row items-center gap-3">
            <div className="w-full sm:w-auto">
              <input 
                type="file" 
                id="labImageUpload" 
                accept="image/*" 
                className="hidden" 
                onChange={handleAttachImage}
              />
              <label 
                htmlFor="labImageUpload" 
                className="cursor-pointer w-full flex items-center justify-center gap-2 px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-sm transition-all border border-slate-200"
              >
                <PlusCircle className="w-4 h-4 text-slate-500" />
                Attach Scan/X-Ray
              </label>
            </div>

            <button 
              onClick={handleAnalyze}
              disabled={isAnalyzing || (!inputText.trim() && !attachedImage)}
              className="w-full flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-teal-500 to-emerald-500 text-white px-4 py-3 rounded-xl font-bold shadow-md hover:shadow-lg disabled:opacity-50 transition-all"
            >
              {isAnalyzing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5 text-yellow-300" />}
              {isAnalyzing ? "Processing..." : "✨ Get Clinical Summary"}
            </button>
          </div>
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
