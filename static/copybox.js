/* ══════════════════════════════════════════════════════════════════
   给「只读内容框」统一挂一个复制图标（右上角）
   ──────────────────────────────────────────────────────────────────
   覆盖四类框（各页已有的类名，不新增约定）：
     .md-box               适配详情页的结论/摘要/改动文件/冲突详情/说明、智能开发详情页的问题描述与结论
     .session-pre          会话存档里的思考/工具入参/工具结果、适配详情页的非 markdown 分支
     .patch-code-block     补丁详情弹窗的分析结果
     .workflow-result-code 流程运行页的三处输出、智能开发详情页的相关日志

   全站**只有这一处**提供复制按钮：以前补丁详情弹窗和流程运行页各有一套手工按钮（文字按钮、
   位置也不一样），已一并撤掉换成这里的图标，保证四个页面长得一样。

   做法：扫描 + MutationObserver。这些框大多是**先渲染好空元素、之后才填内容**
   （innerHTML 赋值、弹窗现建现用），所以不能只在加载时扫一遍；观察新增节点、按需补挂，最省事也不会漏。

   位置：把框包进一层定位容器（.copybox-wrap），图标贴在**框自己**的右上角——
   不能把图标塞进框里：.md-box 是 overflow:auto，塞进去会随内容一起滚走。
   ══════════════════════════════════════════════════════════════════ */
(function () {
    const BOXES = '.md-box, .session-pre, .patch-code-block, .workflow-result-code';

    const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    const ICON_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

    // 与 patches.js 原来的 copyTextToClipboard 同款：https/localhost 用 clipboard API，
    // 局域网 http 下退回到 textarea + execCommand（非安全上下文没有 navigator.clipboard）
    function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
        return new Promise((resolve, reject) => {
            const area = document.createElement('textarea');
            area.value = text;
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            try { document.execCommand('copy') ? resolve() : reject(new Error('复制失败')); }
            catch (error) { reject(error); }
            finally { document.body.removeChild(area); }
        });
    }

    function decorate(box) {
        if (!box || box.dataset.copyBox === '1') return;
        if (box.closest('.file-viewer')) return;   // 文件查看浮层：右上角已经是关闭按钮，别挤在一起
        box.dataset.copyBox = '1';                 // 标记过就不再处理（observer 会反复扫到同一个框）

        // 包一层定位容器：图标才能稳定贴在框的右上角（框内部滚动时也不跟着走）
        const wrap = document.createElement('div');
        wrap.className = 'copybox-wrap';
        box.parentNode.insertBefore(wrap, box);
        wrap.appendChild(box);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'patch-copy-icon';
        btn.title = '复制';
        btn.setAttribute('aria-label', '复制');
        btn.innerHTML = ICON_COPY;
        let resetTimer = 0;
        btn.onclick = () => {
            // innerText 保留换行（md-box 里是 <p>/<br>）；图标是框的兄弟节点，不会被算进去
            const text = box.innerText || box.textContent || '';
            if (!text.trim()) return;
            copyText(text)
                .then(() => { btn.innerHTML = ICON_DONE; btn.classList.add('copied'); btn.title = '已复制'; })
                .catch(() => { btn.title = '复制失败'; });
            clearTimeout(resetTimer);
            resetTimer = setTimeout(() => {
                btn.innerHTML = ICON_COPY;
                btn.classList.remove('copied');
                btn.title = '复制';
            }, 1500);
        };
        wrap.appendChild(btn);
    }

    function scan(node) {
        if (!node || node.nodeType !== 1) return;
        if (node.matches && node.matches(BOXES)) decorate(node);
        if (node.querySelectorAll) node.querySelectorAll(BOXES).forEach(decorate);
    }

    scan(document.body);
    new MutationObserver(mutations => {
        mutations.forEach(record => record.addedNodes.forEach(scan));
    }).observe(document.body, {childList: true, subtree: true});
})();
