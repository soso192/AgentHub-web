/* eslint-disable */
/**
 * 注入到目标页面的悬浮录制按钮
 * ---------------------------------------------------------------------------
 * 只负责「显示按钮 + 把点击意图写进 sessionStorage」，真正的抓包在工具端（CDP）。
 * 不依赖任何框架、不用 <style> 标签（兼容严格 CSP），不改动页面原有 DOM 结构。
 *
 * 通信约定：
 *   sessionStorage.__REC_TOOL_STATE__  'on' | 'off'     工具 -> 页面（显示状态）
 *   sessionStorage.__REC_TOOL_REQ__    {"seq":时间戳,"on":true}   页面 -> 工具（点击事件）
 */
(function () {
    'use strict';

    if (window.__REC_TOOL_OVERLAY__) return;
    window.__REC_TOOL_OVERLAY__ = true;

    // 只在最外层窗口显示，iframe 里不重复出现
    try {
        if (window.top !== window) return;
    } catch (e) {
        return;
    }

    var KEY_STATE = '__REC_TOOL_STATE__';
    var KEY_REQ = '__REC_TOOL_REQ__';

    var on = false;
    try { on = (sessionStorage.getItem(KEY_STATE) === 'on'); } catch (e) { /* ignore */ }

    var startedAt = 0;
    var timer = null;
    var host = null;
    var pill = null;
    var dot = null;
    var label = null;

    function store(k, v) {
        try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ }
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    function labelText() {
        if (!on) return '开始录制';
        if (!startedAt) return '录制中';
        var s = Math.floor((Date.now() - startedAt) / 1000);
        return '录制中 ' + pad(Math.floor(s / 60)) + ':' + pad(s % 60);
    }

    function render() {
        if (!pill) return;
        pill.style.background = on ? '#c4314b' : '#1f2430';
        pill.style.boxShadow = on
            ? '0 6px 20px rgba(196,49,75,.45)'
            : '0 4px 14px rgba(0,0,0,.25)';
        dot.style.background = on ? '#fff' : '#3ddc84';
        dot.style.opacity = on ? '1' : '.95';
        label.textContent = labelText();

        if (on && !timer) {
            timer = setInterval(function () { label.textContent = labelText(); }, 1000);
        } else if (!on && timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    function setState(v) {
        var next = (v === 'on' || v === 'true' || v === true);
        if (next && !on) {
            startedAt = Date.now();
        }
        if (!next) startedAt = 0;
        on = next;
        store(KEY_STATE, on ? 'on' : 'off');
        render();
    }

    function toggle() {
        var next = !on;
        if (next) startedAt = Date.now();
        else startedAt = 0;
        on = next;
        store(KEY_STATE, on ? 'on' : 'off');
        // 用时间戳当序号，保证工具端能识别为「新的点击」
        store(KEY_REQ, JSON.stringify({ seq: Date.now(), on: on }));
        render();
    }

    function build() {
        if (!document.body) {
            setTimeout(build, 100);
            return;
        }
        try {
            host = document.createElement('div');
            host.setAttribute('data-rec-tool', '1');
            host.style.cssText =
                'position:fixed;right:18px;bottom:18px;z-index:2147483647;' +
                'margin:0;padding:0;border:0;background:transparent;pointer-events:none;';

            var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

            pill = document.createElement('button');
            pill.type = 'button';
            pill.style.cssText =
                'pointer-events:auto;display:flex;align-items:center;gap:8px;' +
                'height:38px;padding:0 16px;border:0;border-radius:19px;cursor:pointer;' +
                'font:600 13px/1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
                'color:#fff;letter-spacing:.3px;user-select:none;' +
                'transition:background .15s,box-shadow .15s;' +
                'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;';

            dot = document.createElement('span');
            dot.style.cssText =
                'width:8px;height:8px;border-radius:50%;background:#3ddc84;flex:0 0 auto;';

            label = document.createElement('span');
            label.style.cssText = 'white-space:nowrap;';
            label.textContent = '开始录制';

            pill.appendChild(dot);
            pill.appendChild(label);
            pill.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                toggle();
            });
            pill.addEventListener('mouseenter', function () {
                pill.style.filter = 'brightness(1.08)';
            });
            pill.addEventListener('mouseleave', function () {
                pill.style.filter = 'none';
            });

            root.appendChild(pill);
            document.documentElement.appendChild(host);
            render();
        } catch (e) {
            // 页面结构异常时静默失败，不影响业务
        }
    }

    window.__recToolSet = function (v) { setState(v); };
    window.__recToolToggle = function () { toggle(); };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', build);
    } else {
        build();
    }
})();
