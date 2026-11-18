import { create } from 'zustand';

/**
 * 智能分析（workflow）本地步骤的会话与产物目录映射。
 *
 * ChatPanel 只认识「智能开发」的 node run，工作流步骤没有登记成 node run，
 * 所以这里单独记一份 sessionId -> 产物目录，聊天页才能显示「打开产物所在位置」。
 * 映射持久化到 localStorage，页面刷新/重新打开会话后按钮仍然可用。
 */
export interface WorkflowSessionArtifact {
  dir: string;
  runId: string;
  step: number;
}

interface WorkflowSessionState {
  artifacts: Record<string, WorkflowSessionArtifact>;
  setArtifact: (sessionId: string, value: WorkflowSessionArtifact) => void;
  clearArtifact: (sessionId: string) => void;
}

const STORAGE_KEY = 'cc-web-workflow-session-artifacts';

function readArtifacts(): Record<string, WorkflowSessionArtifact> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const result: Record<string, WorkflowSessionArtifact> = {};
    for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const item = value as Partial<WorkflowSessionArtifact> | null;
      if (!item || typeof item.dir !== 'string' || !item.dir) continue;
      result[sessionId] = {
        dir: item.dir,
        runId: String(item.runId || ''),
        step: Number(item.step || 0),
      };
    }
    return result;
  } catch {
    return {};
  }
}

function writeArtifacts(artifacts: Record<string, WorkflowSessionArtifact>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(artifacts));
  } catch {
    /* localStorage 不可用时只保留内存映射 */
  }
}

export const useWorkflowSessionStore = create<WorkflowSessionState>((set, get) => ({
  artifacts: readArtifacts(),

  setArtifact: (sessionId, value) => {
    if (!sessionId || !value.dir) return;
    const artifacts = { ...get().artifacts, [sessionId]: value };
    writeArtifacts(artifacts);
    set({ artifacts });
  },

  clearArtifact: (sessionId) => {
    if (!get().artifacts[sessionId]) return;
    const artifacts = { ...get().artifacts };
    delete artifacts[sessionId];
    writeArtifacts(artifacts);
    set({ artifacts });
  },
}));
