import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  ExternalLink,
  Globe2,
  GripHorizontal,
  Loader2,
  Maximize2,
  Minimize2,
  RotateCw,
  Square,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  getShell,
  hasEmbeddedBrowser,
  normalizeBrowserUrl,
  type EmbeddedBrowserState,
} from '../../lib/shell';
import { useBrowserStore } from '../../store/browser';

const EMPTY_STATE: EmbeddedBrowserState = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  devToolsOpen: false,
  error: '',
};

const RECT_KEY = 'cc-web-embedded-browser-rect';
const MIN_WIDTH = 480;
const MIN_HEIGHT = 320;
const EDGE = 8;

interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type ResizeMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

function clampRect(rect: PanelRect): PanelRect {
  const viewportWidth = Math.max(320, window.innerWidth);
  const viewportHeight = Math.max(240, window.innerHeight);
  const maxWidth = Math.max(240, viewportWidth - 16);
  const maxHeight = Math.max(180, viewportHeight - 16);
  const width = Math.min(Math.max(rect.width, Math.min(MIN_WIDTH, maxWidth)), maxWidth);
  const height = Math.min(Math.max(rect.height, Math.min(MIN_HEIGHT, maxHeight)), maxHeight);
  const x = Math.min(Math.max(rect.x, EDGE), Math.max(EDGE, viewportWidth - width - EDGE));
  const y = Math.min(Math.max(rect.y, EDGE), Math.max(EDGE, viewportHeight - height - EDGE));
  return { x, y, width, height };
}

function defaultRect(): PanelRect {
  const width = Math.min(960, Math.max(MIN_WIDTH, window.innerWidth - 48));
  const height = Math.min(680, Math.max(MIN_HEIGHT, window.innerHeight - 48));
  return clampRect({
    width,
    height,
    x: window.innerWidth - width - 24,
    y: window.innerHeight - height - 24,
  });
}

function loadRect(): PanelRect {
  try {
    const raw = localStorage.getItem(RECT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PanelRect>;
      if (
        [parsed.x, parsed.y, parsed.width, parsed.height].every(
          (value) => typeof value === 'number' && Number.isFinite(value)
        )
      ) {
        return clampRect(parsed as PanelRect);
      }
    }
  } catch {
    /* 忽略损坏的本地记录 */
  }
  return defaultRect();
}

function dragRect(base: PanelRect, mode: ResizeMode, dx: number, dy: number): PanelRect {
  if (mode === 'move') {
    return clampRect({ ...base, x: base.x + dx, y: base.y + dy });
  }

  let { x, y, width, height } = base;
  if (mode.includes('e')) width = base.width + dx;
  if (mode.includes('s')) height = base.height + dy;
  if (mode.includes('w')) {
    width = base.width - dx;
    x = base.x + dx;
  }
  if (mode.includes('n')) {
    height = base.height - dy;
    y = base.y + dy;
  }

  // 先保证最小尺寸，并让反向拖动时固定住另一条边。
  if (width < MIN_WIDTH) {
    if (mode.includes('w')) x += width - MIN_WIDTH;
    width = MIN_WIDTH;
  }
  if (height < MIN_HEIGHT) {
    if (mode.includes('n')) y += height - MIN_HEIGHT;
    height = MIN_HEIGHT;
  }

  if (x < EDGE) {
    width += x - EDGE;
    x = EDGE;
  }
  if (y < EDGE) {
    height += y - EDGE;
    y = EDGE;
  }
  width = Math.min(width, window.innerWidth - x - EDGE);
  height = Math.min(height, window.innerHeight - y - EDGE);

  return {
    x,
    y,
    width: Math.max(MIN_WIDTH, width),
    height: Math.max(MIN_HEIGHT, height),
  };
}

function fullscreenRect(): PanelRect {
  return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
}

/** 顶栏右侧的「内置浏览器」入口。只在 Electron 桌面壳里显示。 */
export function EmbeddedBrowserButton({ className }: { className?: string }) {
  const open = useBrowserStore((state) => state.open);
  const openBrowser = useBrowserStore((state) => state.openBrowser);
  const closeBrowser = useBrowserStore((state) => state.closeBrowser);
  if (!hasEmbeddedBrowser()) return null;
  return (
    <button
      type="button"
      onClick={() => (open ? closeBrowser() : openBrowser())}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-2 transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent',
        open && 'border-accent/50 bg-accent-soft text-accent',
        className
      )}
      aria-label="内置浏览器"
      title="内置浏览器"
    >
      <Globe2 size={15} />
    </button>
  );
}

/** 全局内置浏览器宿主，负责在任意页面弹出浮动窗口。 */
export function EmbeddedBrowserHost() {
  const open = useBrowserStore((state) => state.open);
  const closeBrowser = useBrowserStore((state) => state.closeBrowser);
  if (!open) return null;
  return <EmbeddedBrowser onClose={closeBrowser} />;
}

function EmbeddedBrowser({ onClose }: { onClose: () => void }) {
  const bridge = getShell()?.embeddedBrowser;
  const requestedUrl = useBrowserStore((state) => state.requestedUrl);
  const setLastUrl = useBrowserStore((state) => state.setLastUrl);

  const [state, setState] = useState<EmbeddedBrowserState>(EMPTY_STATE);
  const [address, setAddress] = useState(requestedUrl || '');
  const [panel, setPanel] = useState<PanelRect>(loadRect);
  const [interacting, setInteracting] = useState(false);
  const [maximized, setMaximized] = useState(false);

  const restoreRectRef = useRef<PanelRect | null>(null);
  const editingRef = useRef(false);
  const interactingRef = useRef(false);
  const interactionRef = useRef<{
    mode: ResizeMode;
    startX: number;
    startY: number;
    rect: PanelRect;
  } | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const sendBounds = () => {
    const element = viewportRef.current;
    if (!element || !bridge) return Promise.resolve();
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return Promise.resolve();
    return bridge.setBounds({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  };

  // 订阅主进程状态，并在挂载时打开视图。
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;

    bridge.subscribe({
      onState: (next) => {
        if (cancelled) return;
        setState(next);
        if (!editingRef.current) {
          setAddress(next.url === 'about:blank' ? '' : next.url);
        }
        setLastUrl(next.url);
      },
      onClose,
      onFocus: () => {
        addressRef.current?.focus();
        addressRef.current?.select();
      },
    });

    void bridge
      .getState()
      .then((result) => {
        if (cancelled || !result?.ok || !result.state) return;
        setState(result.state);
        if (!editingRef.current) {
          setAddress(result.state.url === 'about:blank' ? '' : result.state.url);
        }
      })
      .catch(() => {});

    void bridge
      .open(requestedUrl)
      .then((result) => {
        if (!cancelled && !result.ok && result.message) {
          setState((current) => ({ ...current, error: result.message || '' }));
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      bridge.unsubscribe();
      void bridge.close();
    };
  }, [bridge, requestedUrl, onClose, setLastUrl]);

  // 占位区域尺寸变化（窗口缩放、出错条出现、拖动缩放）时同步原生视图。
  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !bridge) return;

    let frame = 0;
    const schedule = () => {
      if (interactingRef.current) return;
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        void sendBounds();
      });
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener('resize', schedule);
    schedule();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [bridge]);

  // 只移动位置（尺寸没变）时 ResizeObserver 不会触发，这里补一次。
  useEffect(() => {
    if (interactingRef.current) return;
    const frame = requestAnimationFrame(() => {
      void sendBounds();
    });
    return () => cancelAnimationFrame(frame);
  }, [panel]);

  // 记住位置和大小，下次打开恢复。
  useEffect(() => {
    if (maximized) return;
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(RECT_KEY, JSON.stringify(panel));
      } catch {
        /* 忽略 */
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [panel, maximized]);

  // 窗口变小时把浮窗收回可视区域。
  useEffect(() => {
    const onResize = () =>
      setPanel((current) => (maximized ? fullscreenRect() : clampRect(current)));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [maximized]);

  // 拖动/缩放期间：原生视图隐藏，鼠标事件完全交给 React，避免被 WebContentsView 抢走。
  useEffect(() => {
    if (!interacting) return;

    const onMove = (event: PointerEvent) => {
      const current = interactionRef.current;
      if (!current) return;
      setPanel(
        dragRect(current.rect, current.mode, event.clientX - current.startX, event.clientY - current.startY)
      );
    };

    const finish = () => {
      interactionRef.current = null;
      interactingRef.current = false;
      setInteracting(false);
      requestAnimationFrame(() => {
        void sendBounds().then(() => bridge?.setVisible(true));
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }, [interacting, bridge]);

  const startInteraction = (mode: ResizeMode, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    interactionRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      rect: panel,
    };
    interactingRef.current = true;
    setInteracting(true);
    void bridge?.setVisible(false);
  };

  const toggleMaximize = () => {
    if (interactingRef.current) return;
    if (maximized) {
      const restore = restoreRectRef.current;
      restoreRectRef.current = null;
      setMaximized(false);
      setPanel(restore ? clampRect(restore) : defaultRect());
      return;
    }
    restoreRectRef.current = panel;
    try {
      localStorage.setItem(RECT_KEY, JSON.stringify(panel));
    } catch {
      /* 忽略 */
    }
    setMaximized(true);
    setPanel(fullscreenRect());
  };

  const navigate = () => {
    const target = normalizeBrowserUrl(address);
    if (!target) {
      setState((current) => ({ ...current, error: '请输入 http / https 地址' }));
      return;
    }
    setState((current) => ({ ...current, error: '' }));
    void bridge?.navigate(target);
    addressRef.current?.blur();
  };

  if (!bridge) return null;

  return (
    <div
      className={cn(
        'fixed flex flex-col bg-surface-1',
        maximized ? 'rounded-none border-0' : 'rounded-xl border border-line shadow-2xl'
      )}
      style={{
        left: panel.x,
        top: panel.y,
        width: panel.width,
        height: panel.height,
        zIndex: 100,
      }}
    >
      <div
        className={cn(
          'flex touch-none select-none items-center gap-1 border-b border-line bg-surface-2 px-2 py-1.5',
          maximized ? 'rounded-none' : 'rounded-t-xl'
        )}
        onPointerDown={(event) => {
          if (maximized) return;
          const target = event.target as HTMLElement;
          if (target.closest('button, input, a, [data-no-drag]')) return;
          startInteraction('move', event);
        }}
      >
        {!maximized && (
          <span className="flex cursor-move items-center text-ink-3" title="拖动">
            <GripHorizontal size={15} />
          </span>
        )}
        <button
          type="button"
          onClick={() => void bridge.back()}
          disabled={!state.canGoBack}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 disabled:cursor-default disabled:opacity-35"
          aria-label="后退"
          title="后退"
        >
          <ArrowLeft size={15} />
        </button>
        <button
          type="button"
          onClick={() => void bridge.forward()}
          disabled={!state.canGoForward}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 disabled:cursor-default disabled:opacity-35"
          aria-label="前进"
          title="前进"
        >
          <ArrowRight size={15} />
        </button>
        {state.loading ? (
          <button
            type="button"
            onClick={() => void bridge.stop()}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3"
            aria-label="停止加载"
            title="停止加载"
          >
            <Square size={12} />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void bridge.reload()}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3"
            aria-label="刷新"
            title="刷新"
          >
            <RotateCw size={15} />
          </button>
        )}

        <div className="relative min-w-0 flex-1">
          {state.loading && (
            <Loader2
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 animate-spin text-ink-3"
            />
          )}
          <input
            ref={addressRef}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              editingRef.current = true;
              event.currentTarget.select();
            }}
            onBlur={() => {
              editingRef.current = false;
              setAddress(state.url === 'about:blank' ? '' : state.url);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') navigate();
            }}
            placeholder="输入网址，例如 http://10.1.2.3:8080"
            spellCheck={false}
            title={state.title || state.url}
            className={cn(
              'h-8 w-full rounded-lg border border-line bg-surface-1 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent',
              state.loading ? 'pl-8 pr-2.5' : 'px-2.5'
            )}
          />
        </div>

        <button
          type="button"
          onClick={() => void bridge.toggleDevTools()}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3',
            state.devToolsOpen && 'bg-accent-soft text-accent'
          )}
          aria-label="开发者工具"
          title="开发者工具（F12）"
        >
          <Bug size={15} />
        </button>
        <button
          type="button"
          onClick={toggleMaximize}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3"
          aria-label={maximized ? '退出全屏' : '全屏'}
          title={maximized ? '退出全屏' : '全屏'}
        >
          {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button
          type="button"
          onClick={() => {
            if (/^https?:/i.test(state.url)) void bridge.openExternal(state.url);
          }}
          disabled={!/^https?:/i.test(state.url)}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 disabled:cursor-default disabled:opacity-35"
          aria-label="在系统浏览器打开"
          title="在系统浏览器打开"
        >
          <ExternalLink size={15} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-danger-soft hover:text-danger"
          aria-label="关闭内置浏览器"
          title="关闭"
        >
          <X size={16} />
        </button>
      </div>

      {state.error && (
        <div className="border-b border-danger/30 bg-danger-soft px-3 py-1.5 text-[11px] text-danger">
          <span className="line-clamp-2">{state.error}</span>
        </div>
      )}

      <div className="relative min-h-0 flex-1 p-2">
        {/* WebContentsView 覆盖这个区域；拖动/缩放时先隐藏，显示这里的占位。 */}
        <div
          ref={viewportRef}
          className={cn(
            'relative h-full w-full overflow-hidden rounded-md',
            interacting
              ? 'flex items-center justify-center border border-dashed border-accent/50 bg-surface-2 text-[11.5px] text-ink-3'
              : 'bg-white'
          )}
        >
          {interacting && <span>松开鼠标完成调整</span>}
        </div>
      </div>

      {/* 四边/四角缩放热区。原生视图内缩 8px，所以这些热区不会被盖住。 */}
      {!maximized && (
        <>
          <div
            className="absolute left-2 right-2 top-0 z-20 h-1.5 cursor-ns-resize touch-none"
            onPointerDown={(event) => startInteraction('n', event)}
            data-no-drag
          />
          <div
            className="absolute bottom-0 left-2 right-2 z-20 h-1.5 cursor-ns-resize touch-none"
            onPointerDown={(event) => startInteraction('s', event)}
            data-no-drag
          />
          <div
            className="absolute bottom-2 left-0 top-2 z-20 w-1.5 cursor-ew-resize touch-none"
            onPointerDown={(event) => startInteraction('w', event)}
            data-no-drag
          />
          <div
            className="absolute bottom-2 right-0 top-2 z-20 w-1.5 cursor-ew-resize touch-none"
            onPointerDown={(event) => startInteraction('e', event)}
            data-no-drag
          />
          <div
            className="absolute left-0 top-0 z-20 h-2.5 w-2.5 cursor-nwse-resize touch-none"
            onPointerDown={(event) => startInteraction('nw', event)}
            data-no-drag
          />
          <div
            className="absolute right-0 top-0 z-20 h-2.5 w-2.5 cursor-nesw-resize touch-none"
            onPointerDown={(event) => startInteraction('ne', event)}
            data-no-drag
          />
          <div
            className="absolute bottom-0 left-0 z-20 h-2.5 w-2.5 cursor-nesw-resize touch-none"
            onPointerDown={(event) => startInteraction('sw', event)}
            data-no-drag
          />
          <div
            className="absolute bottom-0 right-0 z-20 h-2.5 w-2.5 cursor-nwse-resize touch-none"
            onPointerDown={(event) => startInteraction('se', event)}
            data-no-drag
          />
        </>
      )}
    </div>
  );
}
