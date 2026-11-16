import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const SPA_PATHS = [
  '/index.html',
  '/chat.html',
  '/patches.html',
  '/novice.html',
  '/login',
  '/login.html',
  '/help',
  '/node_run.html',
  '/adapt_run.html',
  '/workflow_run.html',
  '/server_replay.html',
];

/** 开发服务器：与 Rust 侧一致，把 SPA 路由重写到 index.html。 */
function spaFallback(): Plugin {
  return {
    name: 'cc-web-spa-fallback',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const [pathname, query] = (req.url || '/').split('?');
        // 开发辅助：写入一个假 token 后跳转，便于在实施版下预览登录后的外壳
        if (pathname === '/__set-token') {
          const params = new URLSearchParams(query || '');
          const token = params.get('t') || 'dev-token';
          const target = params.get('next') || '/';
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(
            `<script>localStorage.setItem('patch-search-access-token', ${JSON.stringify(
              token
            )});location.replace(${JSON.stringify(target)});</script>`
          );
          return;
        }
        if (SPA_PATHS.includes(pathname)) {
          req.url = `/index.html${query ? `?${query}` : ''}`;
        }
        next();
      });
    },
  };
}

// 构建产物固定文件名：Rust 侧用 include_str! 内嵌，不能出现 hash 文件名。
export default defineConfig({
  plugins: [react(), spaFallback()],
  build: {
    outDir: '../static/dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    target: 'es2019',
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'app.js',
        assetFileNames: (info) => {
          const name = info.name || '';
          if (name.endsWith('.css')) return 'app.css';
          return 'assets/[name][extname]';
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:3030',
        changeOrigin: true,
      },
    },
  },
});
