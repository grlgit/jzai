'use client';

import { useState, useEffect, useCallback } from 'react';
import { getMainUrl } from '@/lib/env';
import WelcomeStep from './steps/WelcomeStep';
import RegistrationStep from './steps/RegistrationStep';
import AdminPasswordStep from './steps/AdminPasswordStep';
import CompleteStep from './steps/CompleteStep';

const MAIN_URL = getMainUrl();

type Phase = 'pending' | 'registered' | 'complete';

interface InitWizardProps {
  onComplete: () => void;
}

const STEPS = [
  { key: 'welcome', label: '系统检查' },
  { key: 'register', label: '企业注册' },
  { key: 'password', label: '管理员密码' },
  { key: 'done', label: '完成' },
] as const;

export default function InitWizard({ onComplete }: InitWizardProps) {
  const [phase, setPhase] = useState<Phase | 'loading'>('loading');
  const [currentStep, setCurrentStep] = useState(0);

  const fetchPhase = useCallback(async () => {
    try {
      const res = await fetch(`${MAIN_URL}/api/setup/status`);
      const data = await res.json();
      const p = data.phase as Phase;
      setPhase(p);
      if (p === 'complete') {
        onComplete();
      } else if (p === 'registered') {
        setCurrentStep(2); // Jump to password step
      } else {
        setCurrentStep(0); // Start from welcome
      }
    } catch {
      // Backend unreachable — show welcome anyway
      setPhase('pending');
      setCurrentStep(0);
    }
  }, [onComplete]);

  useEffect(() => { fetchPhase(); }, [fetchPhase]);

  const handleRegistrationComplete = () => {
    setPhase('registered');
    setCurrentStep(2);
  };

  const handlePasswordComplete = () => {
    setPhase('complete');
    setCurrentStep(3);
  };

  if (phase === 'loading') {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-400 animate-pulse">Loading...</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-indigo-50 via-white to-emerald-50">
      {/* Step indicator */}
      <div className="flex items-center justify-center pt-8 pb-4">
        <div className="flex items-center gap-1">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex items-center">
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                i === currentStep ? 'bg-indigo-600 text-white shadow-sm' :
                i < currentStep ? 'bg-indigo-100 text-indigo-700' :
                'bg-gray-100 text-gray-400'
              }`}>
                <span className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold border border-current/20">
                  {i < currentStep ? '✓' : i + 1}
                </span>
                {s.label}
              </div>
              {i < STEPS.length - 1 && (
                <div className={`w-6 h-px mx-1 ${i < currentStep ? 'bg-indigo-300' : 'bg-gray-200'}`} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Step content */}
      <div className="flex-1 flex items-center justify-center px-4 pb-8">
        {currentStep === 0 && (
          <WelcomeStep onNext={() => setCurrentStep(1)} />
        )}
        {currentStep === 1 && (
          <RegistrationStep onComplete={handleRegistrationComplete} />
        )}
        {currentStep === 2 && (
          <AdminPasswordStep onComplete={handlePasswordComplete} />
        )}
        {currentStep === 3 && (
          <CompleteStep onLogin={onComplete} />
        )}
      </div>
    </div>
  );
}
