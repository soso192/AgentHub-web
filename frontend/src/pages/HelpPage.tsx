import { BookOpen, Github, MessageSquare, Wand2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AppShell, SidebarToggle } from '../components/layout/AppShell';
import { Button } from '../components/ui';

export function HelpPage() {
  const navigate = useNavigate();
  return (
    <AppShell
      nav={[
        {
          key: 'dev',
          label: '智能开发',
          icon: <Wand2 size={15} />,
          onClick: () => navigate('/'),
        },
      ]}
      showSessions={false}
      showFiles={false}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <SidebarToggle />
        <BookOpen size={16} className="text-accent" />
        <span className="text-[14px] font-semibold text-ink">帮助</span>
      </div>
      <div className="scroll-area flex-1 p-5">
        <div className="mx-auto max-w-3xl space-y-4">
          <div className="panel p-5">
            <h1 className="text-[18px] font-semibold text-ink">智能开发平台使用说明</h1>
            <p className="mt-2 text-[13px] leading-6 text-ink-2">
              智能开发平台是一个本地 Web 工作台，把 Claude Code、Pi Agent、Codex 等 AI 编程助手统一在一个界面里。
              左侧管理会话与文件，右侧进行对话或智能开发。
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => navigate('/chat.html')}>
                开始聊天
              </Button>
              <Button onClick={() => navigate('/')}>智能开发</Button>
              <Button
                icon={<Github size={14} />}
                onClick={() =>
                  window.open('https://github.com/soso192/AgentHub-web', '_blank')
                }
              >
                GitHub 仓库
              </Button>
            </div>
          </div>

          {[
            {
              title: '聊天与分屏',
              body: '新建会话时选择工作目录和助手。分屏模式下可以同时运行多个独立会话，同步模式会把一条消息发送到所有面板。消息发送后即时流式展示思考过程、工具调用和执行结果。',
            },
            {
              title: '智能开发',
              body: '在「智能开发」里创建排查任务：填写问题描述、项目环境和补丁输出目录，系统会启动 Claude 分析并产出结论、SQL、改动说明和补丁包。任务结束后可以继续追问、重试或归档。',
            },
            {
              title: '补丁中心',
              body: '开发版首页是补丁中心：检索、上传、下载补丁，管理项目环境、流程模板和提示词配置。所有数据来自你配置的 patch_search 服务。',
            },
            {
              title: '文件浏览',
              body: '聊天页左侧的文件面板会跟随当前会话的工作目录。点击文件可以预览文本、图片和 PDF，也可以在新标签页打开或在资源管理器中定位。',
            },
          ].map((item) => (
            <section key={item.title} className="panel p-5">
              <h2 className="text-[14px] font-semibold text-ink">{item.title}</h2>
              <p className="mt-1.5 text-[13px] leading-6 text-ink-2">{item.body}</p>
            </section>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
