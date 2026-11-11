// ============================================================
//  chat_attachments.js - 聊天输入框附件（开发版 / 小白版共用）
//  依赖：app.js（sendMessage / currentSessionId / messageInput）、common.js 可选
//
//  行为：
//   - 📎 按钮选择图片/文件；输入框可直接 Ctrl+V 粘贴图片
//   - 点发送时先把附件存到当前会话的工作目录（后端 /api/chat/attachment），
//     再把绝对路径追加到消息末尾，AI 用 Read 工具查看
//   - 页面需提供：#chatAttachBtn、#chatFiles、#chatFileList
// ============================================================
(function () {
    'use strict';

    const state = { files: [], sending: false };

    function el(id) { return document.getElementById(id); }

    function notify(text) {
        if (typeof showAppNotice === 'function') {
            try { showAppNotice(text); return; } catch (e) { /* fall through */ }
        }
        console.warn('[附件]', text);
    }

    function render() {
        const box = el('chatFileList');
        if (!box) return;
        box.innerHTML = '';
        state.files.forEach((item, index) => {
            const chip = document.createElement('div');
            chip.className = 'nv-file-chip';
            const label = document.createElement('span');
            label.textContent = `${item.isImage ? '🖼️' : '📄'} ${item.file.name || '附件'}`;
            label.title = label.textContent;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '×';
            remove.title = '移除';
            remove.onclick = () => { state.files.splice(index, 1); render(); };
            chip.appendChild(label);
            chip.appendChild(remove);
            box.appendChild(chip);
        });
    }

    function addFiles(files) {
        Array.from(files || []).forEach(file => {
            if (!file) return;
            if (file.size > 20 * 1024 * 1024) { notify(`「${file.name || '附件'}」超过 20MB，已跳过`); return; }
            state.files.push({ file, isImage: /^image\//i.test(file.type || '') });
        });
        render();
    }

    function clearFiles() {
        state.files = [];
        render();
    }

    // 发送前上传附件，把路径追加到消息文本，再走 app.js 原来的 sendMessage
    function wrapSendMessage() {
        if (typeof window.sendMessage !== 'function' || window.sendMessage.__attachmentWrapped) return;
        const base = window.sendMessage;
        window.sendMessage = async function () {
            if (!state.files.length) return base.apply(this, arguments);
            if (state.sending) return;
            if (typeof currentSessionId === 'undefined' || !currentSessionId) {
                notify('请先选择一个会话，再发送附件');
                return;
            }
            state.sending = true;
            try {
                const paths = [];
                for (const item of state.files) {
                    const form = new FormData();
                    form.append('file', item.file, item.file.name || 'attachment');
                    const query = `session_id=${encodeURIComponent(currentSessionId)}&name=${encodeURIComponent(item.file.name || '')}`;
                    const response = await fetch(`/api/chat/attachment?${query}`, { method: 'POST', body: form });
                    const payload = await response.json().catch(() => ({}));
                    if (!response.ok || payload.success === false) throw new Error(payload.error || '附件保存失败');
                    if (payload.path) paths.push(payload.path);
                }
                if (paths.length) {
                    const input = el('messageInput');
                    const suffix = `\n\n【附件】用户发送了以下文件，请先用 Read 工具查看（图片可看图，其他文件读取内容）：\n`
                        + paths.map(path => `- ${path}`).join('\n');
                    input.value = String(input.value || '').replace(/\s+$/, '') + suffix;
                }
                clearFiles();
            } catch (error) {
                notify('附件发送失败：' + error.message);
                state.sending = false;
                return;
            }
            state.sending = false;
            return base.apply(this, arguments);
        };
        window.sendMessage.__attachmentWrapped = true;
    }

    function init() {
        const button = el('chatAttachBtn');
        const input = el('chatFiles');
        if (!button || !input) return;
        button.onclick = () => input.click();
        input.onchange = event => { addFiles(event.target.files); event.target.value = ''; };
        const box = el('messageInput');
        if (box) {
            box.addEventListener('paste', event => {
                const items = event.clipboardData && event.clipboardData.items;
                if (!items) return;
                const files = [];
                for (let i = 0; i < items.length; i += 1) {
                    const item = items[i];
                    if (item.kind === 'file' && /^image\//i.test(item.type || '')) {
                        const file = item.getAsFile();
                        if (file) files.push(file);
                    }
                }
                if (!files.length) return;
                event.preventDefault();
                addFiles(files);
            });
        }
        wrapSendMessage();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
