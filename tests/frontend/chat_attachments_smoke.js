// 聊天附件（两版共用 chat_attachments.js）冒烟测试：
// node tests/frontend/chat_attachments_smoke.js
// 验证：选择文件 → 发送时上传并追加路径到消息 → 走原来的 sendMessage
const fs = require('fs');
const path = require('path');

function makeEl(id) {
    const node = {
        id, value: '', textContent: '', _html: '', style: {}, children: [],
        onclick: null, onchange: null,
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        appendChild(child) { node.children.push(child); },
        addEventListener() {},
    };
    Object.defineProperty(node, 'innerHTML', {
        get() { return node._html; },
        set(value) { node._html = String(value); if (!value) node.children = []; },
    });
    return node;
}

const els = new Map();
for (const id of ['chatAttachBtn', 'chatFiles', 'chatFileList', 'messageInput']) els.set(id, makeEl(id));

global.document = {
    readyState: 'complete',
    getElementById(id) { return els.get(id) || null; },
    createElement(tag) { return makeEl('created-' + tag); },
    addEventListener() {},
};
global.window = global;
global.currentSessionId = 'sid-1';
global.showAppNotice = text => { global.__notice = text; };

// 原始 sendMessage（模拟 app.js）：读取 messageInput 的值并记录
const sent = [];
global.sendMessage = async function () { sent.push(String(els.get('messageInput').value || '').trim()); };

const uploads = [];
global.FormData = class {
    constructor() { this.entries = []; }
    append(key, value, filename) { this.entries.push([key, value, filename]); }
};
global.fetch = async url => {
    uploads.push(String(url));
    return { ok: true, status: 200, json: async () => ({ success: true, path: 'C:/temp/sid/.cc-web-attachments/a.png' }) };
};

const src = fs.readFileSync(path.join(__dirname, '../../static', 'chat_attachments.js'), 'utf8');
eval(src);

(async () => {
    let fails = 0;
    const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : ' | ' + extra)); if (!cond) fails++; };

    // 选择一张图片 + 一个文本文件
    const fileInput = els.get('chatFiles');
    fileInput.onchange({ target: { files: [
        { name: 'shot.png', size: 1024, type: 'image/png' },
        { name: 'server.log', size: 2048, type: 'text/plain' },
    ], value: '' } });
    check('附件 chip 已渲染', els.get('chatFileList').children.length === 2, String(els.get('chatFileList').children.length));

    els.get('messageInput').value = '帮忙看看这个报错';
    await global.sendMessage();
    await new Promise(r => setTimeout(r, 50));

    check('发送时上传了 2 个附件', uploads.length === 2, JSON.stringify(uploads));
    check('上传带 session_id', uploads.every(url => url.includes('session_id=sid-1')), JSON.stringify(uploads));
    check('消息里追加了附件路径', sent.length === 1 && sent[0].includes('【附件】') && sent[0].includes('a.png'), JSON.stringify(sent[0]));
    check('原消息文字保留', sent[0].includes('帮忙看看这个报错'), JSON.stringify(sent[0]));
    check('发送后附件 chip 清空', els.get('chatFileList').children.length === 0, String(els.get('chatFileList').children.length));

    console.log(fails ? ('共 ' + fails + ' 项 FAIL') : '全部 PASS');
})();
