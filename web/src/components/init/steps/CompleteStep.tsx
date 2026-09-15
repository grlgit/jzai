'use client';

export default function CompleteStep({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="bg-white rounded-2xl shadow-xl border border-gray-200 p-10 text-center max-w-md w-full">
      <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-50 flex items-center justify-center">
        <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h2 className="text-xl font-bold text-gray-900 mb-2">初始化完成</h2>
      <p className="text-sm text-gray-500 mb-6">
        系统已就绪，请使用管理员账号登录
      </p>
      <div className="bg-gray-50 rounded-lg px-4 py-3 mb-6 text-left">
        <p className="text-xs text-gray-500 mb-1">登录账号</p>
        <p className="text-sm font-mono text-gray-800">admin@company.com</p>
      </div>
      <button
        onClick={onLogin}
        className="w-full py-3 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-sm transition-all"
      >
        立即登录
      </button>
    </div>
  );
}
