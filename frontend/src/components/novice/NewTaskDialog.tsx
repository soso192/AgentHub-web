import { useEffect, useRef, useState } from 'react';
import { Circle, Image as ImageIcon, Loader2, Paperclip, X } from 'lucide-react';
import { api } from '../../lib/api';
import { novicePreflight } from '../../lib/novicePrompt';
import { patchApi } from '../../lib/patch';
import type { ProjectEnv } from '../../lib/types';
import { firstChars } from '../../lib/utils';
import { useChatStore } from '../../store/chat';
import { useNodeStore, type LocalNodeRun } from '../../store/nodeRuns';
import { useProjectEnvs } from '../patches/hooks';
import { Button, Dialog, Input } from '../ui';
import { useToast } from '../ui/toast';

function newRunId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID().replace(/[^A-Za-z0-9-]/g, '');
  return `novice-${Date.now()}`;
}

function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

function maskDb(value?: string): string {
  if (!value) return '';
  return value
    .replace(/(password|passwd|pwd)\s*=\s*[^;&\s]+/gi, '$1=***')
    .replace(/&password=[^&\s]+/gi, '&password=***');
}

function buildPrompt(run: {
  id: string;
  problem_desc: string;
  trigger_url?: string;
  image_paths?: string[];
  turn_dir: string;
  stage_dir: string;
  env_snapshot: Record<string, unknown>;
}, template?: string): string {
  const env = run.env_snapshot;
  const s = (value: unknown) => (value == null ? '' : String(value));
  const variables: Record<string, string> = {
    product_name: s(env.product_name),
    product_version: s(env.product_version),
    project_name: s(env.project_name),
    problem_desc: run.problem_desc,
    trigger_url: run.trigger_url || '',
    code_directory: s(env.code_directory),
    package_path: s(env.package_path),
    local_jdk_path: s(env.local_jdk_path),
    local_skill_path: s(env.local_skill_path),
    db_connection: maskDb(s(env.db_connection)),
    debug_address: s(env.debug_address),
    record_url: s(env.record_url),
    turn_dir: run.turn_dir,
    stage_dir: run.stage_dir,
  };
  if (template && template.trim()) {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => variables[key] ?? '');
  }
  return `你是一名实施顾问，请分析并解决下面的产品问题。

【产品环境】
产品：${variables.product_name} ${variables.product_version}
项目：${variables.project_name}
客开代码目录（只读参考）：${variables.code_directory}
home/war 目录：${variables.package_path}
本地 JDK：${variables.local_jdk_path || '未登记'}
调试地址：${variables.debug_address || '未登记'}
数据库连接：${variables.db_connection || '未登记'}
录制页面：${variables.record_url || '未录制'}

【问题描述】
${run.problem_desc}

【触发入口】
${run.trigger_url || '（未填写）'}

【约束】
- 不要修改客开代码目录，除非用户明确要求。
- 分析过程与结论请写入工作目录：${run.turn_dir}
- 工作目录：${run.stage_dir}
- 需要执行 SQL 时，请给出可复制的 SQL 并说明预期结果。
- 涉及数据库密码时不要输出明文。

${run.image_paths?.length ? `【附件】请先用 Read 工具查看以下文件：\n${run.image_paths.map((path) => `- ${path}`).join('\n')}\n` : ''}
请给出问题根因、排查依据、修复方案和验证步骤。`;
}

export function NewTaskDialog({
  open,
  onClose,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  onStarted?: (sessionId: string) => void;
}) {
  const toast = useToast();
  const { envs, reload: reloadEnvs } = useProjectEnvs();
  const createSession = useChatStore((state) => state.createSession);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const registerExternal = useNodeStore((state) => state.registerExternal);
  const [envId, setEnvId] = useState('');
  const [problem, setProblem] = useState('');
  const [recordUrl, setRecordUrl] = useState('');
  const [recordPath, setRecordPath] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recState, setRecState] = useState('');
  const pollRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const env: ProjectEnv | undefined = envs.find((item) => String(item.id) === envId);

  // 弹窗常驻在页面里，首次挂载后不会再请求环境列表；每次打开都重新拉一次，
  // 否则刚在「产品环境」里新增的环境不会出现在下拉框里。
  useEffect(() => {
    if (!open) return;
    void reloadEnvs();
  }, [open, reloadEnvs]);

  useEffect(() => {
    if (!open) return;
    setEnvId((current) =>
      current && envs.some((item) => String(item.id) === current)
        ? current
        : String(envs[0]?.id || '')
    );
  }, [open, envs]);

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    if (open) return;
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setRecording(false);
    setRecState('');
  }, [open]);

  useEffect(() => {
    if (env?.record_url && !recordUrl) setRecordUrl(env.record_url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envId, env?.record_url]);

  const stopPolling = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startRecording = async () => {
    if (!/^https?:\/\//i.test(recordUrl.trim())) {
      toast.error('请填写 http/https 页面地址');
      return;
    }
    setRecording(true);
    setRecState('正在启动浏览器…');
    try {
      await api.recorder.open({ record_url: recordUrl.trim(), env_id: env?.id });
      const poll = async () => {
        try {
          const status = await api.recorder.status();
          const state = String(status.state || '');
          if (state === 'browser_open') setRecState('浏览器已打开，请在页面上点击「开始录制」');
          else if (state === 'recording') setRecState('录制中…在浏览器上点击「停止录制」');
          else if (state === 'finished') {
            setRecordPath(String(status.file || ''));
            setRecState('录制完成，已附加到任务');
            setRecording(false);
            stopPolling();
          } else if (state === 'idle') {
            setRecState('浏览器已关闭（未导出录制），可重新录制');
            setRecording(false);
            stopPolling();
          }
          if (status.error) setRecState(String(status.error));
        } catch {
          /* ignore */
        }
      };
      await poll();
      pollRef.current = window.setInterval(poll, 1500);
    } catch (error) {
      setRecording(false);
      setRecState('');
      toast.error(error instanceof Error ? error.message : '启动录制失败');
    }
  };

  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files).filter((file) => file.size <= 20 * 1024 * 1024);
    if (list.length) setImages((current) => [...current, ...list]);
  };

  const submit = async () => {
    if (!env) {
      toast.error('请选择产品环境');
      return;
    }
    if (!problem.trim() && !images.length) {
      toast.error('请填写问题描述或添加截图');
      return;
    }
    if (recordUrl.trim() && !/^https?:\/\//i.test(recordUrl.trim())) {
      toast.error('录制页面地址必须是 http/https');
      return;
    }
    setBusy(true);
    const runId = newRunId();
    try {
      const workspaceResult = await api.nodeRuns.workspace(runId);
      const workspace =
        (workspaceResult as unknown as { path?: string }).path ||
        (workspaceResult as unknown as { data?: { path?: string } }).data?.path ||
        '';
      if (!workspace) throw new Error('创建工作目录失败');

      const imagePaths: string[] = [];
      for (const file of images) {
        const form = new FormData();
        form.append('file', file, file.name || 'image');
        const result = await api.nodeProblemImage(runId, form, file.name);
        if (!result.success) throw new Error(result.error || '附件上传失败');
        if (result.path) imagePaths.push(result.path);
      }

      let jdk = env.local_jdk_path || '';
      if (!jdk && env.package_path) {
        try {
          const check = await api.envCheck(env.package_path);
          if (check.home_jdk?.ok && check.home_jdk.path) jdk = check.home_jdk.path;
        } catch {
          /* ignore */
        }
      }

      const turnDir = joinPath(workspace, 'step01');
      const pseudo = {
        id: runId,
        problem_desc: problem.trim() || `（已附带 ${imagePaths.length} 个附件，请查看）`,
        trigger_url: recordPath || '',
        image_paths: imagePaths,
        turn_dir: turnDir,
        stage_dir: joinPath(turnDir, 'work'),
        env_snapshot: {
          project_name: env.project_name,
          product_id: env.product_id,
          version_id: env.version_id,
          product_name: env.product_name,
          product_version: env.product_version,
          code_directory: env.code_directory,
          package_path: env.package_path,
          local_jdk_path: jdk,
          local_skill_path: env.local_skill_path,
          db_connection: env.db_connection,
          debug_address: env.debug_address,
          record_url: recordUrl.trim() || env.record_url,
        },
      };

      let template = '';
      try {
        const templates = await patchApi.resolveNodePrompts(
          String(env.product_name || ''),
          String(env.product_version || ''),
          'novice'
        );
        template = templates.phase1 || '';
      } catch {
        template = '';
      }
      const prompt =
        `${novicePreflight(pseudo.env_snapshot, turnDir)}\n\n${buildPrompt(pseudo, template)}`;

      const sessionId = await createSession({ cwd: workspace, assistant: 'claude' });
      // 会话名称取问题描述的前 10 个字；没有描述时退回带时间的默认名称。
      const name =
        firstChars(problem.trim(), 10) || `排查任务 ${new Date().toLocaleString('zh-CN')}`;
      await api.sessions.rename(sessionId, name).catch(() => {});

      // 登记为智能开发运行（本机清单 + problem_run），供左侧按项目分组、打开产物和统计使用。
      // 提示词仍由聊天页发送，registerExternal 只负责状态/结束监听。
      const now = new Date().toISOString();
      const run: LocalNodeRun = {
        id: runId,
        edition: 'novice',
        mode: 'investigate',
        problem_desc: pseudo.problem_desc,
        trigger_url: pseudo.trigger_url,
        env_id: env.id,
        env_snapshot: pseudo.env_snapshot,
        patch_output_path: workspace,
        out_dir: workspace,
        step_dir: turnDir,
        turn_dir: turnDir,
        stage_dir: pseudo.stage_dir,
        phase1_step: 1,
        stage: 1,
        phase: 'analyzing',
        retry_count: 0,
        artifacts: [],
        log_file_name: '',
        need_debug_log: true,
        need_diff_report: true,
        session_id: sessionId,
        image_paths: imagePaths,
        reported: false,
        created_at: now,
        updated_at: now,
      };
      await registerExternal(run);

      await sendMessage(prompt, sessionId);
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      onStarted?.(sessionId);
      toast.success('任务已开始，可直接在聊天中查看进展');
      setProblem('');
      setImages([]);
      setRecordPath('');
      setRecordUrl('');
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建任务失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="创建排查任务"
      description="选择产品环境，描述问题。任务会在聊天中启动 Claude 分析。"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            开始任务
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-[12px] font-medium text-ink-2">产品环境 <span className="text-danger">*</span></label>
          <select value={envId} onChange={(event) => setEnvId(event.target.value)} className="input">
            <option value="">
              {envs.length ? '选择产品环境' : '（请先到「产品环境」新增一个环境）'}
            </option>
            {envs.map((item) => (
              <option key={String(item.id)} value={String(item.id)}>
                {item.project_name} · {item.product_name} {item.product_version}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-[12px] font-medium text-ink-2">问题描述 <span className="text-danger">*</span></label>
          <div className="rounded-xl border border-line bg-surface-2 transition-colors focus-within:border-accent/50">
            {images.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
                {images.map((file, index) => (
                  <span
                    key={`${file.name}-${index}`}
                    className="inline-flex max-w-[220px] items-center gap-1.5 rounded-lg border border-line bg-surface-3 px-2 py-1 text-[11.5px] text-ink-2"
                  >
                    <ImageIcon size={12} className="shrink-0 text-accent" />
                    <span className="truncate">{file.name || '附件'}</span>
                    <button
                      type="button"
                      className="shrink-0 text-ink-3 hover:text-danger"
                      onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={problem}
              onChange={(event) => setProblem(event.target.value)}
              rows={5}
              className="block w-full resize-none bg-transparent px-3 pt-3 text-[13px] leading-6 text-ink outline-none placeholder:text-ink-3"
              onPaste={(event) => {
                const items = event.clipboardData?.items;
                if (!items) return;
                const files: File[] = [];
                for (let i = 0; i < items.length; i += 1) {
                  if (items[i].kind === 'file') {
                    const file = items[i].getAsFile();
                    if (file) files.push(file);
                  }
                }
                if (files.length) {
                  event.preventDefault();
                  addFiles(files);
                }
              }}
            />
            <div className="flex items-center gap-1.5 px-2 pb-2">
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = '';
                }}
              />
              <button
                type="button"
                className="btn-icon h-7 w-7"
                title="添加图片或文件"
                aria-label="添加图片或文件"
                onClick={() => fileRef.current?.click()}
              >
                <Paperclip size={15} />
              </button>
            </div>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-[12px] font-medium text-ink-2">录制页面地址（可选）</label>
          <div className="flex gap-2">
            <Input
              value={recordUrl}
              onChange={(event) => setRecordUrl(event.target.value)}
            />
            <Button
              className="shrink-0"
              variant={recording ? 'danger' : 'default'}
              icon={recording ? <Loader2 size={14} className="animate-spin" /> : <Circle size={12} fill="currentColor" />}
              disabled={recording}
              onClick={startRecording}
            >
              {recording ? '录制中' : '录制'}
            </Button>
          </div>
          {recState && <div className="mt-1 text-[11.5px] text-ink-3">{recState}</div>}
          {recordPath && (
            <div className="mt-1 truncate font-mono text-[10.5px] text-success" title={recordPath}>
              录制文件：{recordPath}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
