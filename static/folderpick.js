/* ══════════════════════════════════════════════════════════════════
   本机路径输入框的「📁 选择目录」按钮（patches.html 与 index.html 共用）
   ──────────────────────────────────────────────────────────────────
   浏览器出于安全不把绝对路径给网页，所以选择器由 cc-web 后端弹系统原生
   「选择文件夹」对话框（GET /api/pick-folder，见 files.rs 的 pick_folder），
   选中后把绝对路径填回输入框；手动输入完全不受影响。

   用法：在 label 里、路径输入框后面放一个按钮，点击取**同一个 label** 里的 input/textarea 回填：
     <label>客开工程目录<input ...>
       <button type="button" class="patch-folder-pick" data-folder-pick>📁</button>
     </label>
   输入框不在 label 里时（label 用 for 关联），把输入框 id 写进 data-folder-pick：
     <button type="button" class="patch-folder-pick" data-folder-pick="cwdInput">📁</button>
   ══════════════════════════════════════════════════════════════════ */
(function () {
    document.addEventListener('click', async event => {
        const btn = event.target.closest('button[data-folder-pick]');
        if (!btn || btn.disabled) return;
        const target = btn.dataset.folderPick
            ? document.getElementById(btn.dataset.folderPick)
            : btn.closest('label')?.querySelector('input, textarea');
        const input = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') ? target : null;
        if (!input) return;

        btn.disabled = true;   // 对话框会一直开着，期间不允许再点（后端也有 409 守卫）
        try {
            const current = String(input.value || '').trim();
            const response = await fetch(`/api/pick-folder?start=${encodeURIComponent(current)}`);
            const payload = await response.json().catch(() => ({}));
            // 取消（path:null）、409（已有窗口）、失败：都不动输入框
            if (payload && payload.success && payload.path) input.value = payload.path;
        } catch (error) {
            /* 网络失败就算了，用户可以手输 */
        } finally {
            btn.disabled = false;
        }
    });
})();
