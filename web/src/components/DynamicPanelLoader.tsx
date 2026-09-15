'use client';

import React, { Suspense, useMemo, Component, ErrorInfo, ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PanelLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PanelLoadError';
  }
}

// ---------------------------------------------------------------------------
// SDK runtime (minimal — full version in app-sdk-runtime.ts)
// ---------------------------------------------------------------------------

function ensureSdkGlobal() {
  if (typeof window === 'undefined') return;
  if ((window as any).__JZ_SDK__) return;
  (window as any).__JZ_SDK__ = {
    react: React,
  };
}

// ---------------------------------------------------------------------------
// Skeleton fallback
// ---------------------------------------------------------------------------

function PanelSkeleton() {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <div className="animate-pulse flex flex-col gap-3 w-48">
        <div className="h-4 bg-gray-200 rounded w-3/4" />
        <div className="h-4 bg-gray-200 rounded w-full" />
        <div className="h-4 bg-gray-200 rounded w-5/6" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  panelName: string;
  children: ReactNode;
}
interface ErrorBoundaryState {
  error: Error | null;
}

class PanelErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[DynamicPanelLoader] ${this.props.panelName} error:`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-gray-500 p-6">
          <p className="font-medium text-red-500">应用面板加载失败</p>
          <p className="text-xs text-gray-400 max-w-xs text-center break-all">
            {this.state.error.message}
          </p>
          <button
            className="text-xs text-blue-500 hover:underline"
            onClick={() => this.setState({ error: null })}
          >
            重试
          </button>
          <details className="text-xs text-gray-400 max-w-xs">
            <summary className="cursor-pointer">详细信息</summary>
            <pre className="mt-1 whitespace-pre-wrap break-all">{this.state.error.stack}</pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Uninstalled tombstone
// ---------------------------------------------------------------------------

function UninstalledTombstone({ panelName }: { panelName: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-sm text-gray-400 p-6">
      <p className="font-medium">「{panelName}」应用已卸载</p>
      <p className="text-xs">该面板对应的扩展包已被移除，相关功能不再可用。</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ExtPanelProps {
  initialData?: unknown;
  onMessage?: (msg: unknown) => void;
  sdk?: unknown;
}

export interface DynamicPanelSpec {
  id: string;
  name: string;
  sourceAppId: string;
  entryComponent: string;
  version: string;
  keepAlive?: boolean;
  status?: string;
}

interface DynamicPanelLoaderProps {
  panel: DynamicPanelSpec;
  initialData?: unknown;
  onMessage?: (msg: unknown) => void;
}

const MAIN_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export function DynamicPanelLoader({ panel, initialData, onMessage }: DynamicPanelLoaderProps) {
  if (panel.status === 'uninstalled') {
    return <UninstalledTombstone panelName={panel.name} />;
  }

  const entryBasename = panel.entryComponent.split('/').pop() ?? panel.entryComponent;
  const url = `${MAIN_URL}/api/app-store/apps/${panel.sourceAppId}/assets/${panel.entryComponent}?v=${panel.version}`;

  const Comp = useMemo(
    () =>
      React.lazy(async (): Promise<{ default: React.ComponentType<ExtPanelProps> }> => {
        ensureSdkGlobal();
        // Dynamic ESM import with cache-busting via version query param
        const mod = await import(/* webpackIgnore: true */ url) as any;
        if (!mod.default) {
          throw new PanelLoadError(`应用面板 ${panel.sourceAppId}/${entryBasename} 缺少默认导出`);
        }
        return { default: mod.default };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [url],
  );

  return (
    <PanelErrorBoundary panelName={panel.name}>
      <Suspense fallback={<PanelSkeleton />}>
        <Comp initialData={initialData} onMessage={onMessage} sdk={(window as any).__JZ_SDK__} />
      </Suspense>
    </PanelErrorBoundary>
  );
}
