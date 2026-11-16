import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AlertTriangle, Zap } from 'lucide-react';
import { ToastProvider } from './components/ui/toast';
import { hasAuthSession } from './lib/api';
import { useAppStore } from './store/app';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
import { HelpPage } from './pages/HelpPage';
import { PatchCenterPage } from './pages/PatchCenterPage';
import { NoviceShell } from './pages/NoviceShell';
import { NodeRunPage } from './pages/NodeRunPage';
import { AdaptRunPage } from './pages/AdaptRunPage';
import { WorkflowRunPage } from './pages/WorkflowRunPage';
import { ServerReplayPage } from './pages/ServerReplayPage';

function LoadingScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <div className="flex h-12 w-12 animate-pulse items-center justify-center rounded-2xl bg-gradient-to-br from-[var(--accent)] to-[#a78bfa] text-white shadow-[0_10px_30px_rgba(124,140,255,.35)]">
        <Zap size={24} />
      </div>
      <div className="text-[12.5px] text-ink-3">正在启动 CC-Web…</div>
    </div>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <AlertTriangle size={30} className="text-danger" />
      <div className="text-[15px] font-semibold text-ink">无法连接 CC-Web 后端</div>
      <div className="max-w-md text-[12.5px] leading-6 text-ink-3">{message}</div>
      <button
        type="button"
        className="btn btn-primary mt-2"
        onClick={() => window.location.reload()}
      >
        重试
      </button>
    </div>
  );
}

function AuthGuard({ children }: { children: ReactNode }) {
  const edition = useAppStore((state) => state.edition);
  const location = useLocation();
  if (edition !== 'novice') return <>{children}</>;
  if (!hasAuthSession()) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  const { ready, error, edition, init } = useAppStore();

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready) return <LoadingScreen />;
  if (error) return <ErrorScreen message={error} />;

  const home = edition === 'novice' ? <NoviceShell /> : <PatchCenterPage />;

  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/login.html" element={<LoginPage />} />
        <Route path="/" element={home} />
        <Route path="/patches.html" element={home} />
        <Route
          path="/chat.html"
          element={edition === 'novice' ? <NoviceShell initialView="chat" /> : <ChatPage />}
        />
        <Route
          path="/index.html"
          element={edition === 'novice' ? <NoviceShell initialView="chat" /> : <ChatPage />}
        />
        <Route
          path="/node_run.html"
          element={
            <AuthGuard>
              <NodeRunPage />
            </AuthGuard>
          }
        />
        <Route
          path="/adapt_run.html"
          element={
            <AuthGuard>
              <AdaptRunPage />
            </AuthGuard>
          }
        />
        <Route
          path="/workflow_run.html"
          element={
            <AuthGuard>
              <WorkflowRunPage />
            </AuthGuard>
          }
        />
        <Route
          path="/server_replay.html"
          element={
            <AuthGuard>
              <ServerReplayPage />
            </AuthGuard>
          }
        />
        <Route path="/help" element={<HelpPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ToastProvider>
  );
}
