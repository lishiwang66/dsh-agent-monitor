/**
 * Agent 监视器 —— client 半（浏览器侧 bundle，零构建）。
 *
 * 四处注册：
 *   1. `main`（keyed，key = PANEL_ID）—— 整页版，由侧边栏图标进入
 *   2. `sidebar.panellist`（list，id = PANEL_ID）—— 侧边栏图标（宿主按 id 选同名主面板）
 *   3. `sidebar.right.pane.tab` + `.title`（keyed，key = KIND）—— 右侧栏常驻 tab
 *   4. `ctx.sidebarRightTabs.register` —— tab 类型定义 + 右侧栏「+」菜单入口（guide）
 * 数据：自建 HTTP 路由 + SSE（`ctx.remote.$on` 的频道是硬编码白名单，收不到这些事件）。
 * 只读：所有控件只影响面板自身（搜索/过滤/暂停/清屏/导出/改价表），不触碰运行时。
 *
 * 视觉：现代仪表盘（渐变统计卡 + 分段标签 + 可折叠分组列表 + 右侧详情栏 + 底部操作条 + 时间轴）。
 * 布局用容器查询自适应：窄（右侧栏）单列堆叠，宽（整页）自动变三栏 —— 左导航 / 内容 / 详情。
 * 调色板取自主题层里真实存在的 `--dsw-static-*` 与 `--dsw-alias-*`，每个 token 都带 fallback。
 */

window.__ModuleLoader__.load({
  id: 'dsh-agent-monitor',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React;

    //#region 身份
    const NS = 'agent-monitor';
    const PANEL_ID = 'agent-monitor';
    const KIND = 'agent-monitor';
    const CSS_ID = 'dsh-agent-monitor/client.css';
    const API = '/agent-monitor/api';
    //#endregion

    //#region 插件自有样式
    const CSS = [
      // ── 调色板（真实存在的 token + fallback）
      '.am_root{',
      '--am-green:var(--dsw-static-green-500,#22c55e);',
      '--am-green-l:var(--dsw-static-green-400,#4ed17e);',
      '--am-amber:var(--dsw-static-amber-500,#f59e0b);',
      '--am-amber-l:var(--dsw-static-amber-400,#f7ad31);',
      '--am-blue:var(--dsw-static-blue-500,#3b82f6);',
      '--am-blue-l:var(--dsw-static-blue-400,#60a5fa);',
      '--am-cyan:var(--dsw-static-deepseek-400,#7aaaff);',
      '--am-violet:var(--dsw-static-deepseek-300,#b7c8fe);',
      '--am-brand:var(--dsw-alias-brand-primary,#4176e6);',
      '--am-red:var(--dsw-alias-state-error-primary,#ef4444);',
      '--am-ink:var(--dsw-alias-label-primary,currentColor);',
      '--am-dim:var(--dsw-alias-label-secondary,#8b8f96);',
      '--am-dimmer:var(--dsw-alias-label-tertiary,#9aa0a8);',
      '--am-rule:var(--dsw-alias-border-l1,rgb(127 127 127 / 26%));',
      '--am-rule2:var(--dsw-alias-border-l2,rgb(127 127 127 / 42%));',
      '--am-bg:var(--dsw-alias-bg-base,transparent);',
      '--am-panel:var(--dsw-alias-bg-layer-1,rgb(127 127 127 / 6%));',
      '--am-panel2:var(--dsw-alias-bg-layer-2,rgb(127 127 127 / 10%));',
      '--am-code:var(--dsw-alias-markdown-code-block,rgb(127 127 127 / 12%));',
      '--am-hover:var(--dsw-alias-interactive-bg-hover,rgb(127 127 127 / 14%));',
      '--am-r-lg:var(--dsw-radius-lg,14px);',
      '--am-r-md:var(--dsw-radius-md,10px);',
      '--am-r-sm:var(--dsw-radius-sm,8px);',
      'box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;',
      'color:var(--am-ink);background:var(--am-bg);',
      'font-family:var(--ds-font-family-code,"SF Mono","JetBrains Mono",Consolas,monospace);',
      'font-size:12px;line-height:17px;-webkit-font-smoothing:antialiased}',
      '.am_root *{box-sizing:border-box}',
      '.am_num{font-variant-numeric:tabular-nums}',

      // ── 顶栏
      '.am_head{flex:none;padding:10px 12px 8px;border-bottom:1px solid var(--am-rule)}',
      '.am_headRow{display:flex;align-items:flex-start;gap:10px}',
      '.am_headText{min-width:0;flex:1}',
      '.am_h1{margin:0;font-size:16px;line-height:21px;font-weight:600;letter-spacing:.01em;display:flex;align-items:center;gap:7px}',
      '.am_h1mark{color:var(--am-brand)}',
      '.am_sub{margin:2px 0 0;color:var(--am-dimmer);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.am_search{display:flex;align-items:center;gap:6px;min-width:150px;max-width:250px;flex:1;',
      'padding:5px 9px;border-radius:999px;border:1px solid var(--am-rule);background:var(--am-panel);color:var(--am-dimmer)}',
      '.am_search input{flex:1;min-width:0;border:0;background:transparent;color:var(--am-ink);font:inherit;outline:none}',
      '.am_search input::placeholder{color:var(--am-dimmer)}',
      '.am_kbd{flex:none;border:1px solid var(--am-rule);border-radius:4px;padding:0 4px;font-size:10px;color:var(--am-dimmer)}',
      '.am_iconBtns{display:flex;align-items:center;gap:5px;flex:none}',
      '.am_ib{width:26px;height:26px;display:grid;place-items:center;border-radius:999px;border:1px solid var(--am-rule);',
      'background:var(--am-panel);color:var(--am-dim);cursor:pointer;font:inherit;padding:0}',
      '.am_ib:hover{color:var(--am-ink);background:var(--am-hover)}',
      '.am_ib_on{color:var(--am-amber);border-color:color-mix(in srgb,var(--am-amber) 50%,transparent)}',
      '.am_meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:7px}',
      '.am_tag{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;border:1px solid var(--am-rule);',
      'background:var(--am-panel);color:var(--am-dim);white-space:nowrap;max-width:22ch;overflow:hidden;text-overflow:ellipsis}',
      '.am_tag_ok{color:var(--am-green);border-color:color-mix(in srgb,var(--am-green) 40%,transparent);background:color-mix(in srgb,var(--am-green) 10%,transparent)}',
      '.am_tag_warn{color:var(--am-amber);border-color:color-mix(in srgb,var(--am-amber) 40%,transparent);background:color-mix(in srgb,var(--am-amber) 10%,transparent)}',
      '.am_tag_bad{color:var(--am-red);border-color:color-mix(in srgb,var(--am-red) 40%,transparent);background:color-mix(in srgb,var(--am-red) 10%,transparent)}',
      '.am_tag_brand{color:var(--am-brand);border-color:color-mix(in srgb,var(--am-brand) 40%,transparent);background:color-mix(in srgb,var(--am-brand) 10%,transparent)}',
      '.am_dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary,var(--am-dim))}',
      '.am_dot_run{background:var(--am-green);box-shadow:0 0 0 3px color-mix(in srgb,var(--am-green) 18%,transparent)}',
      '.am_dot_err{background:var(--am-red)}',
      '.am_dot_warn{background:var(--am-amber)}',

      // ── 滚动体 + 容器查询
      '.am_body{flex:1;min-height:0;overflow:auto;padding:9px 12px 12px;container-type:inline-size;container-name:am}',
      '.am_root ::-webkit-scrollbar{width:8px;height:8px}',
      '.am_root ::-webkit-scrollbar-thumb{background:var(--am-rule2);border-radius:4px}',
      '.am_shell{display:grid;gap:9px;align-items:start}',

      // ── 左导航（窄栏变横向分段条）
      '.am_nav{display:flex;gap:3px;overflow-x:auto;padding-bottom:2px}',
      '.am_navItem{display:flex;align-items:center;gap:7px;padding:5px 10px;border-radius:var(--am-r-sm);border:1px solid transparent;',
      'background:transparent;color:var(--am-dim);cursor:pointer;font:inherit;white-space:nowrap;flex:none;text-align:left}',
      '.am_navItem:hover{background:var(--am-hover);color:var(--am-ink)}',
      '.am_navItem_on{background:var(--am-panel2);border-color:var(--am-rule);color:var(--am-ink);font-weight:600}',
      '.am_navIcon{width:14px;height:14px;flex:none;opacity:.9}',
      '.am_navCount{margin-left:auto;color:var(--am-dimmer);font-size:11px}',
      '.am_navSpacer{flex:1}',

      '.am_main,.am_side{min-width:0;display:flex;flex-direction:column;gap:9px}',

      // ── 卡片
      '.am_card{border:1px solid var(--am-rule);border-radius:var(--am-r-lg);background:var(--am-panel);overflow:hidden}',
      '.am_cardHead{display:flex;align-items:center;gap:7px;padding:8px 11px;border-bottom:1px solid var(--am-rule)}',
      '.am_cardTitle{margin:0;font-size:12px;font-weight:600;letter-spacing:.02em}',
      '.am_cardBody{padding:10px 11px}',
      '.am_cardBodyTight{padding:6px 0 7px}',
      '.am_spacer{flex:1;min-width:0}',
      '.am_label{color:var(--am-dimmer)}',
      '.am_hint{color:var(--am-dimmer);margin:0 0 7px}',
      '.am_empty{padding:14px 12px;color:var(--am-dim);white-space:pre-wrap}',
      '.am_row2{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;min-width:0}',
      '.am_ellip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',

      // ── 渐变统计卡（参考「今日新增 / 未读库存」那排）
      '.am_heroGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}',
      '.am_hero{position:relative;border-radius:var(--am-r-lg);padding:11px 12px 12px;overflow:hidden;',
      'border:1px solid color-mix(in srgb,var(--tone) 34%,transparent);',
      'background:linear-gradient(135deg,color-mix(in srgb,var(--tone) 24%,transparent) 0%,color-mix(in srgb,var(--tone) 6%,transparent) 62%,transparent 100%)}',
      '.am_heroGlow{position:absolute;right:-26px;top:-30px;width:96px;height:96px;border-radius:50%;',
      'background:radial-gradient(circle,color-mix(in srgb,var(--tone) 34%,transparent) 0%,transparent 70%);pointer-events:none}',
      '.am_heroLabel{position:relative;color:var(--am-dim);font-size:11px;display:flex;align-items:center;gap:5px}',
      '.am_heroValue{position:relative;margin-top:5px;font-size:22px;line-height:26px;font-weight:650;letter-spacing:-.02em;color:var(--tone)}',
      '.am_heroUnit{font-size:11px;font-weight:400;color:var(--am-dim);margin-left:3px;letter-spacing:0}',
      '.am_heroSub{position:relative;margin-top:5px;color:var(--am-dim);font-size:11px;display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
      '.am_heroSub b{color:var(--tone);font-weight:600}',
      '.am_heroMeter{position:relative;margin-top:7px;height:3px;border-radius:2px;background:color-mix(in srgb,var(--tone) 18%,transparent);overflow:hidden}',
      '.am_heroMeterFill{height:100%;border-radius:2px;background:var(--tone)}',

      // ── 建议卡（参考「AI 助手建议」）
      '.am_tip{display:flex;gap:9px;padding:10px 11px;border-radius:var(--am-r-lg);',
      'border:1px solid color-mix(in srgb,var(--am-blue) 28%,transparent);',
      'background:linear-gradient(135deg,color-mix(in srgb,var(--am-blue) 12%,transparent),transparent 80%)}',
      '.am_tipGlyph{flex:none;width:22px;height:22px;border-radius:7px;display:grid;place-items:center;',
      'background:color-mix(in srgb,var(--am-blue) 22%,transparent);color:var(--am-blue-l)}',
      '.am_tipTitle{font-weight:600;margin-bottom:3px}',
      '.am_tipList{margin:0;padding:0;list-style:none;color:var(--am-dim)}',
      '.am_tipList li{margin:2px 0;display:flex;gap:6px}',
      '.am_tipList li::before{content:"•";color:var(--am-blue-l);flex:none}',
      '.am_tipAction{margin-top:8px}',

      // ── 分段控件（参考「全部笔记 / 我负责的 / 我参与的」）
      '.am_seg{display:inline-flex;gap:2px;padding:2px;border-radius:999px;border:1px solid var(--am-rule);background:var(--am-panel);overflow-x:auto}',
      '.am_segItem{border:0;background:transparent;color:var(--am-dim);font:inherit;cursor:pointer;white-space:nowrap;',
      'padding:3px 11px;border-radius:999px}',
      '.am_segItem:hover{color:var(--am-ink)}',
      '.am_segItem_on{background:var(--am-panel2);color:var(--am-ink);font-weight:600;box-shadow:0 1px 2px rgb(0 0 0 / 12%)}',
      '.am_segCount{color:var(--am-dimmer);font-weight:400;margin-left:4px}',
      '.am_segItem_on .am_segCount{color:var(--am-dim)}',

      // ── 分组列表（参考「今日新增 3 / 长期积压 4」）
      '.am_group{border:1px solid var(--am-rule);border-radius:var(--am-r-md);background:var(--am-panel);overflow:hidden;margin-bottom:6px}',
      '.am_groupHead{display:flex;align-items:center;gap:7px;padding:6px 10px;cursor:pointer;color:var(--am-dim)}',
      '.am_groupHead:hover{background:var(--am-hover);color:var(--am-ink)}',
      '.am_groupCaret{color:var(--am-dimmer);flex:none;transition:transform .12s}',
      '.am_groupDot{width:7px;height:7px;border-radius:50%;flex:none}',
      '.am_groupTitle{font-weight:600;color:var(--am-ink)}',
      '.am_groupCount{color:var(--am-dim)}',
      '.am_groupMeta{color:var(--am-dimmer);white-space:nowrap;display:inline-flex;gap:8px;align-items:baseline;font-variant-numeric:tabular-nums}',
      '.am_groupBody{border-top:1px solid var(--am-rule);padding:3px 0 4px}',

      // ── 活动行
      '.am_row{display:grid;grid-template-columns:6.5ch 10ch minmax(0,1fr) auto;gap:7px;align-items:baseline;',
      'padding:3px 10px;border-left:2px solid transparent;cursor:default}',
      '.am_row+.am_row{border-top:1px solid color-mix(in srgb,var(--am-rule) 55%,transparent)}',
      '.am_row:hover{background:var(--am-hover)}',
      '.am_row_click{cursor:pointer}',
      '.am_row_open{background:var(--am-hover);border-left-color:var(--am-brand)}',
      '.am_row_err{border-left-color:color-mix(in srgb,var(--am-red) 60%,transparent)}',
      '.am_row_run{border-left-color:color-mix(in srgb,var(--am-amber) 60%,transparent)}',
      '.am_t{color:var(--am-dimmer)}',
      '.am_kind{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}',
      '.am_text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.am_sideMeta{color:var(--am-dimmer);white-space:nowrap;display:inline-flex;gap:8px;align-items:baseline;font-variant-numeric:tabular-nums}',
      '.am_green{color:var(--am-green)}',
      '.am_red{color:var(--am-red)}',
      '.am_amber{color:var(--am-amber)}',
      '.am_blue{color:var(--am-blue-l)}',
      '.am_cyan{color:var(--am-cyan)}',
      '.am_violet{color:var(--am-violet)}',
      '.am_dimc{color:var(--am-dim)}',
      '.am_dimmer{color:var(--am-dimmer)}',
      '.am_add{color:var(--am-green)}',
      '.am_del{color:var(--am-red)}',
      '.am_detail{border-top:1px dashed var(--am-rule);margin:2px 10px 6px 22px;padding-top:6px}',
      '.am_blockLabel{display:flex;align-items:center;gap:6px;color:var(--am-dimmer);margin:6px 0 3px}',
      '.am_pre{margin:0;padding:7px 9px;border-radius:var(--am-r-sm);background:var(--am-code);border:1px solid var(--am-rule);',
      'white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto}',
      '.am_copy{border:0;background:transparent;color:var(--am-dimmer);cursor:pointer;font:inherit;padding:0 3px}',
      '.am_copy:hover{color:var(--am-ink)}',

      // ── 实时行
      '.am_live{display:flex;align-items:center;gap:8px;padding:7px 11px;border-radius:var(--am-r-lg);',
      'border:1px solid color-mix(in srgb,var(--am-green) 32%,transparent);',
      'background:linear-gradient(135deg,color-mix(in srgb,var(--am-green) 12%,transparent),transparent 85%)}',
      '.am_caret{color:var(--am-green);flex:none}',
      '.am_livePhase{color:var(--am-green);font-weight:600}',

      // ── 键值行（参考右侧详情栏）
      '.am_kv{display:grid;grid-template-columns:minmax(7ch,auto) minmax(0,1fr);gap:4px 10px;align-items:baseline}',
      '.am_kvK{color:var(--am-dimmer);display:flex;align-items:center;gap:5px}',
      '.am_kvV{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}',
      '.am_kvRow{display:contents}',
      '.am_chips{display:flex;flex-wrap:wrap;gap:5px}',

      // ── 时间轴（参考「阅读时间轴」）
      '.am_tl{display:flex;align-items:flex-end;gap:2px;height:56px;padding:0 2px}',
      '.am_tlCol{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:3px;height:100%}',
      '.am_tlBar{width:100%;border-radius:3px 3px 0 0;min-height:2px;background:color-mix(in srgb,var(--am-blue) 55%,transparent)}',
      '.am_tlBarToday{background:var(--am-blue)}',
      '.am_tlTicks{display:flex;gap:2px;padding:3px 2px 0;border-top:1px solid var(--am-rule)}',
      '.am_tlTick{flex:1;min-width:0;text-align:center;color:var(--am-dimmer);font-size:10px;overflow:hidden}',
      '.am_tlTickToday{color:var(--am-blue);font-weight:600}',

      // ── 表格
      '.am_table{width:100%;border-collapse:collapse}',
      '.am_table th{color:var(--am-dimmer);font-weight:500;text-align:left;padding:3px 6px;border-bottom:1px solid var(--am-rule2);white-space:nowrap}',
      '.am_table td{padding:3px 6px;border-bottom:1px solid var(--am-rule);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.am_table tr:hover td{background:var(--am-hover)}',
      '.am_tdNum{text-align:right;font-variant-numeric:tabular-nums}',
      '.am_cellPath{max-width:24ch}',
      '.am_mini{display:inline-block;letter-spacing:-1px}',
      '.am_meter{display:inline-block;letter-spacing:-1px;white-space:nowrap;overflow:hidden}',
      '.am_meterTrack{color:var(--am-rule2)}',
      '.am_stack{display:block;white-space:nowrap;overflow:hidden;letter-spacing:-1px}',
      '.am_legend{display:flex;flex-wrap:wrap;gap:2px 10px;margin-top:6px}',
      '.am_legendItem{display:inline-flex;align-items:center;gap:5px;color:var(--am-dim)}',
      '.am_swatch{width:8px;height:8px;border-radius:2px;flex:none}',

      // ── 会话列表
      '.am_srow{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:7px;align-items:baseline;',
      'padding:5px 10px;cursor:pointer;border-left:2px solid transparent}',
      '.am_srow+.am_srow{border-top:1px solid color-mix(in srgb,var(--am-rule) 55%,transparent)}',
      '.am_srow:hover{background:var(--am-hover)}',
      '.am_srow_on{background:var(--am-hover);border-left-color:var(--am-brand)}',
      '.am_sub{color:var(--am-violet)}',

      // ── 表单
      '.am_field{display:grid;grid-template-columns:minmax(11ch,auto) minmax(0,1fr);gap:10px;align-items:center;margin-bottom:6px}',
      '.am_field>label{color:var(--am-dim)}',
      '.am_input{width:100%;background:var(--am-bg);color:var(--am-ink);border:1px solid var(--am-rule2);',
      'border-radius:var(--am-r-sm);padding:2px 7px;font:inherit;font-variant-numeric:tabular-nums}',
      '.am_priceGrid{display:grid;grid-template-columns:auto repeat(3,minmax(0,1fr));gap:5px 7px;align-items:center}',
      '.am_btn{border:1px solid var(--am-rule);background:var(--am-panel);color:var(--am-dim);border-radius:999px;',
      'padding:3px 11px;font:inherit;cursor:pointer;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;gap:5px}',
      '.am_btn:hover{color:var(--am-ink);background:var(--am-hover)}',
      '.am_btn_on{color:var(--am-amber);border-color:color-mix(in srgb,var(--am-amber) 45%,transparent);background:color-mix(in srgb,var(--am-amber) 10%,transparent)}',
      '.am_btnPrimary{border-color:transparent;background:color-mix(in srgb,var(--am-green) 88%,transparent);color:#fff;font-weight:600}',
      '.am_btnPrimary:hover{background:var(--am-green);color:#fff}',
      '.am_note{color:var(--am-amber)}',

      // ── 底部操作条（参考底部那排按钮 + 绿色主按钮）
      '.am_foot{flex:none;display:flex;align-items:center;gap:7px;padding:8px 12px;border-top:1px solid var(--am-rule);',
      'background:var(--am-panel);flex-wrap:wrap}',
      '.am_footStatus{color:var(--am-dimmer);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}',
      '.am_footSep{color:var(--am-rule2);margin:0 2px}',
      '.am_toast{color:var(--am-green)}',

      // ── 侧边栏图标
      '.am_sidebtn{width:100%;display:flex;align-items:center;gap:6px;padding:4px 6px;border:0;background:transparent;',
      'border-radius:6px;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font:inherit}',
      '.am_sidebtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(127 127 127 / 14%));color:var(--dsw-alias-label-primary,currentColor)}',
      '.am_icon{width:16px;height:16px;display:block}',

      // ── 宽容器：左导航 + 内容 + 右侧详情（就是参考图的三栏）
      '@container am (min-width:620px){',
      '.am_shell{grid-template-columns:124px minmax(0,1fr)}',
      '.am_nav{flex-direction:column;overflow:visible;align-items:stretch;gap:2px}',
      '.am_navItem{width:100%}',
      '.am_navSpacer{flex:1}',
      '.am_main{grid-column:2;grid-row:1}',
      '.am_side{grid-column:2;grid-row:2}',
      '}',
      '@container am (min-width:980px){',
      '.am_shell{grid-template-columns:124px minmax(0,1fr) 264px}',
      '.am_side{grid-column:3;grid-row:1}',
      '}',
    ].join('');
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-agent-monitor';
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }
    //#endregion

    //#region 展示辅助（bundle 不能 require 相对模块，这是客户端侧的最小副本）
    const fmtTokens = (value) => {
      const n = Number.isFinite(value) ? value : 0;
      if (n < 1000) return String(Math.round(n));
      if (n < 10000) return `${(n / 1000).toFixed(2)}k`;
      if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
      return `${(n / 1e6).toFixed(2)}M`;
    };
    const fmtMoney = (value, currency) => {
      const n = Number.isFinite(value) ? value : 0;
      const abs = Math.abs(n);
      const digits = abs > 0 && abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
      return `${currency === 'USD' ? '$' : '¥'}${n.toFixed(digits)}`;
    };
    const fmtDuration = (ms) => {
      const n = Number.isFinite(ms) && ms >= 0 ? ms : 0;
      if (n < 1000) return `${Math.round(n)}ms`;
      if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
      const m = Math.floor(n / 60000);
      const s = Math.round((n % 60000) / 1000);
      if (m < 60) return `${m}m${String(s).padStart(2, '0')}s`;
      return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
    };
    const fmtClock = (t) => {
      const d = new Date(Number.isFinite(t) ? t : Date.now());
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    const fmtAgo = (t) => {
      if (!Number.isFinite(t) || t <= 0) return '—';
      const delta = Date.now() - t;
      if (delta < 5000) return '刚刚';
      if (delta < 60000) return `${Math.round(delta / 1000)}s 前`;
      if (delta < 3600000) return `${Math.round(delta / 60000)}m 前`;
      if (delta < 86400000) return `${Math.round(delta / 3600000)}h 前`;
      return `${Math.round(delta / 86400000)}d 前`;
    };
    const fmtPct = (ratio, digits = 0) => (Number.isFinite(ratio) ? `${(ratio * 100).toFixed(digits)}%` : '—');
    const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    const shortId = (id) => {
      const m = /([0-9a-f]{8})-[0-9a-f]{4}/i.exec(String(id ?? ''));
      return m ? m[1] : String(id ?? '').slice(0, 10);
    };
    const TONE = {
      green: 'var(--am-green)',
      amber: 'var(--am-amber)',
      red: 'var(--am-red)',
      blue: 'var(--am-blue-l)',
      cyan: 'var(--am-cyan)',
      violet: 'var(--am-violet)',
      brand: 'var(--am-brand)',
      dim: 'var(--am-dimmer)',
    };
    const toneClass = (tone) => `am_${tone}`;
    const ratioTone = (ratio, warn = 0.8, danger = 0.95) => (ratio >= danger ? 'red' : ratio >= warn ? 'amber' : 'green');
    //#endregion

    //#region 客户端 store
    const cap = (frames, limit) => (frames.length > limit ? frames.slice(frames.length - limit) : frames);

    const store = {
      state: {
        transport: 'connecting',
        error: null,
        stats: null,
        frames: [],
        clearedBefore: 0,
        paused: false,
        pending: 0,
        expanded: {},
        section: 'board',
        groupByTurn: true,
        collapsedTurns: {},
        visibleLimit: 400,
        sessionFilter: null,
        kindFilter: 'all',
        query: '',
        toast: null,
        savedAt: 0,
        savedError: null,
      },
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      getSnapshot() {
        return this.state;
      },
      update(patch) {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener();
      },
      mergeFrames(incoming) {
        const floor = this.state.clearedBefore;
        const map = new Map(this.state.frames.map((frame) => [frame.id, frame]));
        for (const frame of incoming) {
          if (!frame || typeof frame.id !== 'number' || frame.id <= floor) continue;
          map.set(frame.id, frame);
        }
        const limit = this.state.stats?.config?.bufferSize ?? 500;
        this.update({ frames: cap([...map.values()].sort((a, b) => a.id - b.id), Math.max(50, limit)) });
      },
      patchFrames(patches) {
        const map = new Map(this.state.frames.map((frame) => [frame.id, frame]));
        let changed = false;
        for (const item of patches) {
          const current = map.get(item.id);
          if (current) {
            map.set(item.id, { ...current, ...item.patch });
            changed = true;
          }
        }
        if (changed) this.update({ frames: [...map.values()].sort((a, b) => a.id - b.id) });
      },
    };
    //#endregion

    //#region 与 host 通信
    let source = null;
    let pollTimer = null;
    let disposed = false;
    let started = false;

    const fetchJson = async (path, options) => {
      const response = await fetch(API + path, { credentials: 'same-origin', ...options });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 120)}`);
      }
      if (!response.ok) throw new Error(parsed?.error ?? `${response.status}`);
      return parsed;
    };

    const applyMessage = (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'snapshot' && message.snapshot) {
        store.mergeFrames(message.snapshot.activity ?? []);
        store.update({ stats: message.snapshot });
        return;
      }
      if (message.type === 'stats' && message.stats) {
        store.update({ stats: message.stats });
        return;
      }
      if (message.type === 'frames' && Array.isArray(message.frames)) {
        if (store.state.paused) store.update({ pending: store.state.pending + message.frames.length });
        else store.mergeFrames(message.frames);
        return;
      }
      if (message.type === 'patch' && Array.isArray(message.patches)) {
        if (store.state.paused) store.update({ pending: store.state.pending + message.patches.length });
        else store.patchFrames(message.patches);
      }
    };

    const stopTransport = () => {
      if (source) {
        try {
          source.close();
        } catch {
          /* 忽略 */
        }
        source = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const pollOnce = async () => {
      try {
        const result = await fetchJson('/snapshot');
        applyMessage({ type: 'snapshot', snapshot: result.value });
        store.update({ transport: 'poll', error: null });
      } catch (error) {
        store.update({ transport: 'offline', error: String(error?.message ?? error) });
      }
    };

    const startPolling = () => {
      if (pollTimer) return;
      pollOnce();
      pollTimer = setInterval(pollOnce, 1500);
      pollTimer.unref?.();
    };

    const start = async () => {
      if (disposed || started) return;
      started = true;
      store.update({ transport: 'connecting', error: null });
      try {
        await fetchJson('/health');
      } catch (error) {
        stopTransport();
        store.update({
          transport: 'offline',
          error: `host 半不可达（${String(error?.message ?? error)}）。若当前界面运行在 Electron 壳里，自建 HTTP 路由可能不通——请用浏览器打开 http://127.0.0.1:19387 。`,
        });
        return;
      }
      try {
        const result = await fetchJson('/snapshot');
        applyMessage({ type: 'snapshot', snapshot: result.value });
      } catch {
        /* 快照失败不致命，SSE 还会送来 */
      }
      if (typeof EventSource !== 'undefined') {
        try {
          source = new EventSource(API + '/stream');
          source.onopen = () => store.update({ transport: 'sse', error: null });
          source.onmessage = (event) => {
            try {
              applyMessage(JSON.parse(event.data));
            } catch {
              /* 忽略坏帧 */
            }
          };
          source.onerror = () => {
            if (disposed) return;
            store.update({ transport: 'poll' });
            try {
              source?.close();
            } catch {
              /* 忽略 */
            }
            source = null;
            startPolling();
          };
        } catch {
          startPolling();
        }
      } else {
        startPolling();
      }
    };

    const saveConfig = async (config, prices) => {
      try {
        const result = await fetchJson('/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ config, prices }),
        });
        store.update({ savedAt: Date.now(), savedError: null });
        applyMessage({ type: 'stats', stats: { ...(store.state.stats ?? {}), config: result.value.config, prices: result.value.prices } });
      } catch (error) {
        store.update({ savedError: String(error?.message ?? error) });
      }
    };

    const refreshWallet = async () => {
      try {
        await fetchJson('/wallet/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const result = await fetchJson('/snapshot');
        applyMessage({ type: 'snapshot', snapshot: result.value });
      } catch (error) {
        store.update({ savedError: String(error?.message ?? error) });
      }
    };
    //#endregion

    //#region 通用件
    const copyText = (text) => {
      try {
        navigator.clipboard?.writeText(String(text ?? ''));
        store.update({ toast: '已复制到剪贴板' });
        setTimeout(() => store.update({ toast: null }), 1200);
      } catch {
        /* 忽略 */
      }
    };

    const CopyButton = ({ text, label }) =>
      h('button', { className: 'am_copy', title: '复制', onClick: () => copyText(text) }, label ?? '⧉');

    /** 卡片：标题行 + 内容。 */
    function Card({ title, icon, right, rightTone, children, tight }) {
      return h(
        'section',
        { className: 'am_card' },
        title || right
          ? h(
              'header',
              { className: 'am_cardHead' },
              icon ? h('span', { className: 'am_dimc' }, icon) : null,
              title ? h('h3', { className: 'am_cardTitle' }, title) : null,
              h('span', { className: 'am_spacer' }),
              right === undefined || right === null ? null : h('span', { className: rightTone ? toneClass(rightTone) : 'am_dimmer' }, right),
            )
          : null,
        h('div', { className: `am_cardBody${tight ? ' am_cardBodyTight' : ''}` }, children),
      );
    }

    /** 渐变统计卡（参考「今日新增 / 未读库存」那排）。 */
    function Hero({ label, value, unit, sub, meter, tone }) {
      return h(
        'div',
        { className: 'am_hero', style: { '--tone': TONE[tone] ?? TONE.blue } },
        h('div', { className: 'am_heroGlow' }),
        h('div', { className: 'am_heroLabel' }, label),
        h('div', { className: 'am_heroValue am_num' }, value, unit ? h('span', { className: 'am_heroUnit' }, unit) : null),
        sub ? h('div', { className: 'am_heroSub' }, sub) : null,
        meter !== undefined && meter !== null
          ? h('div', { className: 'am_heroMeter' }, h('div', { className: 'am_heroMeterFill', style: { width: `${Math.round(clamp01(meter) * 100)}%` } }))
          : null,
      );
    }

    /** 分段控件（参考「全部笔记 / 我负责的 / 我参与的」）。 */
    function Segmented({ items, value, onChange }) {
      return h(
        'div',
        { className: 'am_seg', role: 'tablist' },
        ...items.map((item) =>
          h(
            'button',
            {
              key: item.key,
              role: 'tab',
              'aria-selected': value === item.key,
              className: `am_segItem${value === item.key ? ' am_segItem_on' : ''}`,
              onClick: () => onChange(item.key),
            },
            item.label,
            item.count === undefined || item.count === null ? null : h('span', { className: 'am_segCount am_num' }, item.count),
          ),
        ),
      );
    }

    /** 键值行。 */
    const KV = ({ k, v, tone, title }) =>
      h(
        'div',
        { className: 'am_kvRow' },
        h('span', { className: 'am_kvK' }, k),
        h('span', { className: `am_kvV ${tone ? toneClass(tone) : ''}`, title: title ?? String(v ?? '') }, v),
      );

    /** 标签组。 */
    const Chips = ({ items }) =>
      h(
        'div',
        { className: 'am_chips' },
        ...items.filter(Boolean).map((item, index) =>
          h('span', { className: `am_tag${item.tone ? ` am_tag_${item.tone}` : ''}`, key: `${item.text}-${index}` }, item.text),
        ),
      );

    /** 块字符仪表条。 */
    function Meter({ ratio, width = 18, tone = 'green', showTrack = true }) {
      const clamped = clamp01(ratio);
      const filled = Math.round(clamped * width);
      return h(
        'span',
        { className: 'am_meter am_num' },
        h('span', { style: { color: TONE[tone] } }, '█'.repeat(filled)),
        showTrack ? h('span', { className: 'am_meterTrack' }, '░'.repeat(Math.max(0, width - filled))) : null,
      );
    }
    //#endregion

    //#region 统计区
    const cacheSaving = (session, prices) => {
      const tokens = session?.tokens?.session ?? {};
      const entry = prices?.[session?.model] ?? prices?.['deepseek-flash'];
      if (!entry?.offPeak) return null;
      const saved = ((tokens.cacheRead ?? 0) / 1e6) * Math.max(0, (Number(entry.offPeak.cacheMiss) || 0) - (Number(entry.offPeak.cacheRead) || 0));
      return saved > 0 ? saved : null;
    };

    function HeroRow({ stats, session }) {
      const config = stats.config ?? {};
      const today = stats.today ?? { cost: 0, tokens: {}, requests: 0, sessions: 0 };
      const tokens = session?.tokens?.session ?? {};
      const budget = config.todayBudget ?? 0;
      const todayRatio = budget > 0 ? today.cost / budget : 0;
      const contextWindow = session?.contextWindow ?? 0;
      const surface = session?.surfaceTokens ?? 0;
      const pressure = contextWindow > 0 ? surface / contextWindow : 0;
      const warn = config.contextWarn ?? 0.8;
      const hitBase = (tokens.cacheRead ?? 0) + (tokens.uncachedInput ?? 0);
      const cacheHit = hitBase > 0 ? (tokens.cacheRead ?? 0) / hitBase : 0;
      const saved = cacheSaving(session, stats.prices ?? {});
      const live = session?.live;
      const liveElapsed = live ? (live.endedAt || Date.now()) - (live.startedAt || Date.now()) : 0;
      const liveTokens = live?.usage?.output ?? live?.usage?.total ?? 0;
      const liveTps = live && liveElapsed > 400 && liveTokens > 0 ? (liveTokens / liveElapsed) * 1000 : 0;
      const avgTps = session?.stats?.decodeMs > 0 ? (session.stats.decodeTokens / session.stats.decodeMs) * 1000 : 0;
      const tps = liveTps > 0 ? liveTps : avgTps;

      return h(
        'div',
        { className: 'am_heroGrid' },
        h(Hero, {
          label: '本次会话花费',
          value: fmtMoney(session?.cost?.session ?? 0),
          sub: [
            h('span', { key: 'tok', className: 'am_num' }, `${fmtTokens(tokens.total ?? 0)} tok`),
            h('span', { key: 'req', className: 'am_num' }, `${session?.requests ?? 0} 请求`),
          ],
          tone: 'blue',
        }),
        h(Hero, {
          label: '今日花费 · 全机器',
          value: fmtMoney(today.cost),
          sub: [
            h('b', { key: 'pct' }, fmtPct(todayRatio)),
            h('span', { key: 'bud' }, `预算 ${fmtMoney(budget)}`),
            h('span', { key: 'left', className: 'am_num' }, `剩 ${fmtMoney(Math.max(0, budget - today.cost))}`),
          ],
          meter: todayRatio,
          tone: ratioTone(todayRatio, 0.8, 1) === 'green' ? 'green' : ratioTone(todayRatio, 0.8, 1),
        }),
        h(Hero, {
          label: '本次会话 tokens',
          value: fmtTokens(tokens.total ?? 0),
          unit: 'tok',
          sub: [
            h('b', { key: 'hit' }, `命中 ${fmtPct(cacheHit)}`),
            saved ? h('span', { key: 'saved', className: 'am_num' }, `已省 ${fmtMoney(saved)}`) : null,
            h('span', { key: 'out', className: 'am_num' }, `出 ${fmtTokens(tokens.output ?? 0)}`),
          ],
          meter: cacheHit,
          tone: 'cyan',
        }),
        h(Hero, {
          label: '上下文占用',
          value: fmtPct(pressure),
          sub: [
            h('b', { key: 'used', className: 'am_num' }, `${fmtTokens(surface)}/${contextWindow > 0 ? fmtTokens(contextWindow) : '?'}`),
            h('span', { key: 'left', className: 'am_num' }, `剩 ${contextWindow > 0 ? fmtTokens(Math.max(0, contextWindow - surface)) : '—'}`),
          ],
          meter: pressure,
          tone: ratioTone(pressure, warn, 0.95),
        }),
        h(Hero, {
          label: '生成速率',
          value: tps > 0 ? tps.toFixed(0) : '—',
          unit: tps > 0 ? 'tok/s' : null,
          sub: [
            h('span', { key: 'src' }, liveTps > 0 ? '实时' : avgTps > 0 ? '会话均值' : '等待数据'),
            session?.stats?.ttftSteps > 0
              ? h('span', { key: 'ttft', className: 'am_num' }, `首字 ${fmtDuration(session.stats.ttftMs / session.stats.ttftSteps)}`)
              : null,
          ],
          tone: 'violet',
        }),
      );
    }

    /** 建议卡（参考「AI 助手建议」）。 */
    function TipCard({ stats, session, onAction }) {
      const config = stats.config ?? {};
      const tokens = session?.tokens?.session ?? {};
      const budget = config.todayBudget ?? 0;
      const today = stats.today ?? { cost: 0 };
      const contextWindow = session?.contextWindow ?? 0;
      const surface = session?.surfaceTokens ?? 0;
      const pressure = contextWindow > 0 ? surface / contextWindow : 0;
      const warn = config.contextWarn ?? 0.8;
      const saved = cacheSaving(session, stats.prices ?? {});
      const bullets = [];
      // 顺序即优先级（只显示前 4 条）：告警 → 报错 → 上下文 → 省钱 → 预算
      if (stats.alerts?.length > 0) {
        for (const alert of stats.alerts.slice(0, 2)) bullets.push(alert.text);
      }
      if ((session?.errors ?? 0) > 0) bullets.push(`本会话有 ${session.errors} 次报错，可切到「错误」分段逐条看`);
      if (contextWindow > 0) {
        const left = Math.max(0, contextWindow - surface);
        bullets.push(`上下文剩余 ${fmtTokens(left)}，约占窗口 ${fmtPct(1 - pressure)}`);
      }
      if (saved) bullets.push(`缓存命中让本次会话省下 ${fmtMoney(saved)}（命中率 ${fmtPct((tokens.cacheRead ?? 0) / Math.max(1, (tokens.cacheRead ?? 0) + (tokens.uncachedInput ?? 0)))}）`);
      if (budget > 0) bullets.push(`今日已用预算 ${fmtPct(today.cost / budget)}（${fmtMoney(today.cost)} / ${fmtMoney(budget)}）`);
      if ((session?.retries ?? 0) > 0) bullets.push(`本会话有 ${session.retries} 次重试（每次重试都是一次额外计费请求）`);
      if (bullets.length === 0) bullets.push('一切正常，暂无需要处理的异常');

      const action = (session?.errors ?? 0) > 0
        ? { label: '查看错误行', run: () => onAction('errors') }
        : { label: '调整阈值与单价', run: () => onAction('settings') };

      return h(
        'div',
        { className: 'am_tip' },
        h('div', { className: 'am_tipGlyph' }, '✦'),
        h(
          'div',
          { style: { minWidth: 0 } },
          h('div', { className: 'am_tipTitle' }, '助手建议'),
          h('ul', { className: 'am_tipList' }, ...bullets.slice(0, 5).map((text, index) => h('li', { key: index }, h('span', null, text)))),
          h('div', { className: 'am_tipAction' }, h('button', { className: 'am_btn', onClick: action.run }, action.label)),
        ),
      );
    }

    function LiveLine({ session }) {
      const live = session?.live;
      if (!live) return null;
      const elapsed = (live.endedAt || Date.now()) - (live.startedAt || Date.now());
      const phase =
        live.phase === 'thinking' ? '思考中'
          : live.phase === 'writing' ? '生成中'
            : live.phase === 'tool-call' ? `正在调用 ${live.tool || '工具'}`
              : live.phase === 'finishing' ? '收尾中'
                : live.phase === 'committed' ? '已提交'
                  : live.phase === 'abandoned' ? '本次尝试已放弃' : '进行中';
      const tokens = live.usage?.output ?? live.usage?.total ?? 0;
      const tps = elapsed > 400 && tokens > 0 ? ((tokens / elapsed) * 1000).toFixed(1) : null;
      return h(
        'div',
        { className: 'am_live' },
        h('span', { className: 'am_caret' }, '▌'),
        h('span', { className: 'am_livePhase' }, phase),
        live.reasoningChars > 0 ? h('span', { className: 'am_num am_dimc' }, `思考 ${live.reasoningChars} 字`) : null,
        live.textChars > 0 ? h('span', { className: 'am_num am_dimc' }, `正文 ${live.textChars} 字`) : null,
        h('span', { className: 'am_dimmer am_num' }, fmtDuration(elapsed)),
        tps ? h('span', { className: 'am_tag am_tag_brand am_num' }, `${tps} tok/s`) : null,
        h('span', { className: 'am_spacer' }),
        live.turn ? h('span', { className: 'am_dimmer' }, `turn ${live.turn}/step ${live.step}`) : null,
      );
    }

    /** 时间轴（参考「阅读时间轴」）。 */
    function Timeline({ trend }) {
      const max = Math.max(0.000001, ...trend.map((item) => item.cost));
      const todayIndex = trend.length - 1;
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'am_tl' },
          ...trend.map((item, index) =>
            h(
              'div',
              { className: 'am_tlCol', key: item.day, title: `${item.day}  ${fmtMoney(item.cost)}  ${fmtTokens(item.tokens)} tok  ${item.requests} 次请求` },
              h('div', {
                className: `am_tlBar${index === todayIndex ? ' am_tlBarToday' : ''}`,
                style: { height: `${Math.max(4, Math.round((item.cost / max) * 42))}px` },
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'am_tlTicks' },
          ...trend.map((item, index) =>
            h('div', { className: `am_tlTick${index === todayIndex ? ' am_tlTickToday' : ''}`, key: item.day }, index === todayIndex ? '今天' : item.day.slice(5)),
          ),
        ),
      );
    }
    //#endregion

    //#region 活动流
    const KIND_TONE = {
      tool: 'cyan', reply: 'violet', user: 'blue', request: 'dim', turn: 'violet', step: 'dim',
      subagent: 'amber', workflow: 'amber', goal: 'green', retry: 'amber', error: 'red', note: 'dim',
    };
    const KIND_GROUPS = [
      { key: 'all', label: '全部' },
      { key: 'tool', label: '工具' },
      { key: 'reply', label: '回复' },
      { key: 'errors', label: '错误' },
      { key: 'other', label: '其他' },
    ];
    const frameBucket = (frame) => {
      if (frame.status === 'error' || frame.ok === false || frame.kind === 'error' || frame.kind === 'retry') return 'errors';
      if (frame.kind === 'tool') return 'tool';
      if (frame.kind === 'reply' || frame.kind === 'user') return 'reply';
      return 'other';
    };
    const frameMatches = (frame, query) => {
      if (!query) return true;
      const haystack = `${frame.tool ?? ''} ${frame.kind ?? ''} ${frame.title ?? ''} ${frame.detail ?? ''} ${frame.args ?? ''} ${frame.result ?? ''} ${frame.error ?? ''}`.toLowerCase();
      return haystack.includes(query);
    };
    const statusOf = (frame) => {
      if (frame.status === 'running') return { tone: 'amber', mark: '…' };
      if (frame.status === 'error' || frame.ok === false) return { tone: 'red', mark: '✗' };
      if (frame.status === 'ok') return { tone: 'green', mark: '✓' };
      return { tone: 'dim', mark: '·' };
    };

    function ActivityFrame({ frame, expanded, onToggle, maxDuration }) {
      const status = statusOf(frame);
      const expandable = Boolean(frame.args || frame.result || frame.reasoning || frame.text || frame.error);
      const label = frame.tool || frame.kind;
      const detail =
        frame.title && frame.title !== label && frame.title !== frame.detail
          ? `${frame.title}${frame.detail ? ` · ${frame.detail}` : ''}`
          : frame.detail || frame.title || '';
      const tokens = frame.tokens;
      const durationRatio = maxDuration > 0 && frame.durationMs ? frame.durationMs / maxDuration : 0;
      const rowTone = frame.status === 'error' || frame.ok === false ? ' am_row_err' : frame.status === 'running' ? ' am_row_run' : '';
      return h(
        'div',
        null,
        h(
          'div',
          {
            className: `am_row${expandable ? ' am_row_click' : ''}${expanded ? ' am_row_open' : ''}${rowTone}`,
            onClick: expandable ? () => onToggle(frame.id) : undefined,
            title: expandable ? `${detail}\n（点击展开/收起）` : detail,
          },
          h('span', { className: 'am_t am_num' }, fmtClock(frame.t)),
          h('span', { className: `am_kind ${status.tone === 'dim' ? 'am_dimc' : toneClass(status.tone)}` }, `${status.mark} ${label}`),
          h('span', { className: 'am_text' }, detail, frame.model ? h('span', { className: 'am_dimmer' }, `  ${frame.model}`) : null),
          h(
            'span',
            { className: 'am_sideMeta' },
            durationRatio > 0 ? h(Meter, { ratio: durationRatio, width: 5, tone: durationRatio > 0.8 ? 'amber' : 'dim', showTrack: false }) : null,
            frame.durationMs !== undefined ? h('span', null, fmtDuration(frame.durationMs)) : null,
            tokens && tokens.total ? h('span', { className: 'am_blue' }, fmtTokens(tokens.total)) : null,
            frame.cost ? h('span', { className: 'am_green' }, fmtMoney(frame.cost)) : null,
            frame.turn ? h('span', { className: 'am_dimmer' }, `T${frame.turn}`) : null,
          ),
        ),
        expanded
          ? h(
              'div',
              { className: 'am_detail' },
              frame.error ? h('div', { className: 'am_red' }, `✗ ${frame.error}`) : null,
              frame.args ? h('div', null, h('div', { className: 'am_blockLabel' }, '▸ 参数', h(CopyButton, { text: frame.args })), h('pre', { className: 'am_pre' }, frame.args)) : null,
              frame.result ? h('div', null, h('div', { className: 'am_blockLabel' }, '▸ 输出', h(CopyButton, { text: frame.result })), h('pre', { className: 'am_pre' }, frame.result)) : null,
              frame.reasoning
                ? h('div', null, h('div', { className: 'am_blockLabel' }, `▸ 思考（前 ${frame.reasoning.length} 字${frame.reasoningChars > frame.reasoning.length ? ` / 共 ${frame.reasoningChars}` : ''}）`, h(CopyButton, { text: frame.reasoning })), h('pre', { className: 'am_pre' }, frame.reasoning))
                : null,
              frame.text ? h('div', null, h('div', { className: 'am_blockLabel' }, '▸ 正文', h(CopyButton, { text: frame.text })), h('pre', { className: 'am_pre' }, frame.text)) : null,
            )
          : null,
      );
    }

    /** 分组（参考「今日新增 3」这种可折叠分组）。 */
    function Group({ dotTone, title, count, meta, collapsed, onToggle, children }) {
      return h(
        'div',
        { className: 'am_group' },
        h(
          'div',
          { className: 'am_groupHead', onClick: onToggle },
          h('span', { className: 'am_groupCaret' }, collapsed ? '▸' : '▾'),
          h('span', { className: 'am_groupDot', style: { background: TONE[dotTone] ?? TONE.dim } }),
          h('span', { className: 'am_groupTitle' }, title),
          h('span', { className: 'am_groupCount am_num' }, count),
          h('span', { className: 'am_spacer' }),
          h('span', { className: 'am_groupMeta' }, ...(meta ?? [])),
        ),
        collapsed ? null : h('div', { className: 'am_groupBody' }, children),
      );
    }
    //#endregion

    //#region 内容区
    function FlowSection({ state, frames, groups, maxDuration, toggle, toggleGroup }) {
      if (frames.length === 0) {
        return h('div', { className: 'am_empty' }, '这个范围里暂时没有活动。');
      }
      if (!groups) {
        return h(
          'div',
          { className: 'am_group' },
          h('div', { className: 'am_groupBody' }, ...frames.map((frame) => h(ActivityFrame, { key: frame.id, frame, expanded: Boolean(state.expanded[frame.id]), onToggle: toggle, maxDuration }))),
        );
      }
      return h(
        'div',
        null,
        ...groups.map((group) => {
          const cost = group.frames.reduce((sum, frame) => sum + (frame.cost || 0), 0);
          const tokens = group.frames.reduce((sum, frame) => sum + (frame.tokens?.total || 0), 0);
          const errors = group.frames.filter((frame) => frame.status === 'error' || frame.ok === false).length;
          const first = group.frames[0]?.t ?? Date.now();
          const last = group.frames[group.frames.length - 1]?.t ?? first;
          const meta = [];
          if (group.frames.length > 1) meta.push(h('span', { key: 'd' }, fmtDuration(last - first)));
          if (tokens > 0) meta.push(h('span', { key: 't', className: 'am_blue' }, `${fmtTokens(tokens)} tok`));
          if (cost > 0) meta.push(h('span', { key: 'c', className: 'am_green' }, fmtMoney(cost)));
          if (errors > 0) meta.push(h('span', { key: 'e', className: 'am_red' }, `${errors} 错`));
          meta.push(h('span', { key: 'at', className: 'am_dimmer' }, fmtAgo(last)));
          return h(
            Group,
            {
              key: `${group.turn}-${group.frames[0].id}`,
              dotTone: errors > 0 ? 'red' : group.turn === '—' ? 'dim' : 'violet',
              title: group.turn === '—' ? '无轮次' : `turn ${group.turn}`,
              count: group.frames.length,
              meta,
              collapsed: Boolean(state.collapsedTurns[group.turn]),
              onToggle: () => toggleGroup(group.turn),
            },
            ...group.frames.map((frame) => h(ActivityFrame, { key: frame.id, frame, expanded: Boolean(state.expanded[frame.id]), onToggle: toggle, maxDuration })),
          );
        }),
      );
    }

    function FilesSection({ session }) {
      const files = session?.files ?? [];
      if (files.length === 0) return h('div', { className: 'am_empty' }, '这个会话还没有文件访问记录。');
      const maxChange = Math.max(1, ...files.map((file) => (file.plus ?? 0) + (file.minus ?? 0)));
      return h(
        Card,
        { title: '文件访问', icon: '▤', right: `${files.length} 个`, rightTone: 'dim', tight: true },
        h(
          'table',
          { className: 'am_table' },
          h('thead', null, h('tr', null, ...['文件', '读', '写', '改', '±行', '规模', '最后'].map((label, index) => h('th', { key: label, className: index >= 1 && index <= 3 ? 'am_tdNum' : '' }, label)))),
          h(
            'tbody',
            null,
            files.map((file) =>
              h(
                'tr',
                { key: file.path, title: file.path },
                h('td', { className: 'am_cellPath' }, file.rel || file.path),
                h('td', { className: 'am_tdNum am_num' }, file.reads ?? 0),
                h('td', { className: 'am_tdNum am_num' }, file.writes ?? 0),
                h('td', { className: 'am_tdNum am_num' }, file.edits ?? 0),
                h('td', { className: 'am_tdNum am_num' }, h('span', { className: 'am_add' }, `+${file.plus ?? 0}`), ' ', h('span', { className: 'am_del' }, `−${file.minus ?? 0}`)),
                h('td', null, h(Meter, { ratio: ((file.plus ?? 0) + (file.minus ?? 0)) / maxChange, width: 6, tone: (file.edits ?? 0) > 0 ? 'amber' : 'dim', showTrack: false })),
                h('td', { className: 'am_dimmer am_num' }, fmtAgo(file.lastT)),
              ),
            ),
          ),
        ),
      );
    }

    function SessionsSection({ stats, state, onFilter }) {
      const sessions = stats?.sessions ?? [];
      if (sessions.length === 0) return h('div', { className: 'am_empty' }, '还没有任何会话数据。');
      const maxCost = Math.max(0.000001, ...sessions.map((session) => session.cost.today));
      const totalToday = sessions.reduce((sum, session) => sum + session.cost.today, 0);
      return h(
        Card,
        { title: '会话', icon: '❐', right: `${sessions.length} 个 · 今日 ${fmtMoney(totalToday)}`, rightTone: 'green', tight: true },
        h(
          'div',
          { className: `am_srow${state.sessionFilter === null ? ' am_srow_on' : ''}`, onClick: () => onFilter(null) },
          h('span', { className: state.sessionFilter === null ? 'am_green' : 'am_dimmer' }, state.sessionFilter === null ? '●' : '○'),
          h('span', { className: 'am_dimmer' }, '↺'),
          h('span', { className: 'am_ellip' }, '跟随当前会话 / 运行中优先'),
          h('span', { className: 'am_sideMeta' }, `${sessions.filter((item) => item.running).length} 运行中`),
        ),
        ...sessions.map((session) =>
          h(
            'div',
            {
              key: session.id,
              className: `am_srow${state.sessionFilter === session.id ? ' am_srow_on' : ''}`,
              onClick: () => onFilter(session.id),
              title: `${session.cwd || session.id}\n${session.title || ''}`,
            },
            h('span', { className: session.running ? 'am_dot am_dot_run' : 'am_dot' }),
            h('span', { className: session.isSubagent ? 'am_sub' : 'am_dimmer' }, session.isSubagent ? '└' : '│'),
            h(
              'span',
              { className: 'am_ellip' },
              h('span', { className: 'am_num' }, session.shortId),
              h('span', { className: 'am_dimmer' }, `  ${session.workspace}`),
              session.isSubagent && session.parentSession ? h('span', { className: 'am_sub' }, `  ←${shortId(session.parentSession)}`) : null,
            ),
            h(
              'span',
              { className: 'am_sideMeta' },
              h(Meter, { ratio: session.cost.today / maxCost, width: 4, tone: 'green', showTrack: false }),
              h('span', { className: 'am_green' }, fmtMoney(session.cost.today)),
              h('span', { className: 'am_dimmer' }, fmtTokens(session.tokens.session.total)),
              h('span', { className: 'am_dimmer' }, `${session.toolCalls}↯`),
              session.errors > 0 ? h('span', { className: 'am_red' }, `${session.errors}✗`) : null,
            ),
          ),
        ),
      );
    }

    function SettingsSection({ stats }) {
      const config = stats?.config ?? {};
      const prices = stats?.prices ?? {};
      const [draft, setDraft] = useState(() => ({ config: { ...config }, prices: JSON.parse(JSON.stringify(prices)) }));
      const [dirty, setDirty] = useState(false);
      const setCfg = (key, value) => {
        setDraft((prev) => ({ ...prev, config: { ...prev.config, [key]: value } }));
        setDirty(true);
      };
      const setPrice = (model, band, rate, value) => {
        setDraft((prev) => {
          const next = JSON.parse(JSON.stringify(prev.prices));
          next[model][band][rate] = Number(value);
          return { ...prev, prices: next };
        });
        setDirty(true);
      };
      const numberField = (label, key, step) =>
        h(
          'div',
          { className: 'am_field', key },
          h('label', null, label),
          h('input', { className: 'am_input am_num', type: 'number', step: step ?? 1, value: draft.config[key] ?? '', onChange: (event) => setCfg(key, Number(event.target.value)) }),
        );
      const toggleField = (label, key) =>
        h(
          'div',
          { className: 'am_field', key },
          h('label', null, label),
          h('button', { className: `am_btn ${draft.config[key] ? 'am_btn_on' : ''}`, onClick: () => setCfg(key, !draft.config[key]) }, draft.config[key] ? '开' : '关'),
        );
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
        h(
          Card,
          { title: '阈值与开关', icon: '⚙', right: '保存后立即生效' },
          h('p', { className: 'am_hint' }, '按你选的「不额外落盘」，这些值只活在内存里，Host 重启后回到默认。'),
          numberField('活动流保留条数', 'bufferSize', 50),
          numberField('今日预算（元）', 'todayBudget', 1),
          numberField('上下文告警线（0-1）', 'contextWarn', 0.05),
          numberField('卡住判定（分钟）', 'stuckMs', 1),
          numberField('连续报错次数', 'errorStreak', 1),
          numberField('趋势天数', 'historyDays', 1),
          numberField('思考预览字数', 'reasoningPreview', 50),
          toggleField('按峰谷计价', 'peakAware'),
          toggleField('自动脱敏', 'redact'),
        ),
        ...Object.entries(draft.prices).map(([model, entry]) =>
          h(
            Card,
            { key: model, title: model, icon: '¥', right: entry.currency ?? 'CNY', rightTone: 'green' },
            h(
              'div',
              { className: 'am_priceGrid' },
              h('span', { className: 'am_label' }, ''),
              h('span', { className: 'am_label' }, '缓存命中'),
              h('span', { className: 'am_label' }, '未命中'),
              h('span', { className: 'am_label' }, '输出'),
              ...['offPeak', 'peak'].flatMap((band) => [
                h('span', { className: band === 'peak' ? 'am_amber' : 'am_dimc', key: `${band}-label` }, band === 'offPeak' ? '空闲' : '高峰'),
                ...['cacheRead', 'cacheMiss', 'output'].map((rate) =>
                  h('input', {
                    key: `${band}-${rate}`,
                    className: 'am_input am_num',
                    type: 'number',
                    step: 0.01,
                    value: entry[band]?.[rate] ?? 0,
                    onChange: (event) => setPrice(model, band, rate, event.target.value),
                  }),
                ),
              ]),
            ),
          ),
        ),
        h(
          'div',
          { className: 'am_row2' },
          h(
            'button',
            {
              className: `am_btn ${dirty ? 'am_btn_on' : 'am_btnPrimary'}`,
              onClick: () => {
                saveConfig(draft.config, draft.prices);
                setDirty(false);
              },
            },
            dirty ? '保存修改 *' : '保存',
          ),
          store.state.savedAt ? h('span', { className: 'am_dimmer' }, `已保存 ${fmtClock(store.state.savedAt)}`) : null,
          store.state.savedError ? h('span', { className: 'am_red' }, store.state.savedError) : null,
        ),
      );
    }

    /** 右侧详情栏（参考「智能详情」）。 */
    function DetailPanel({ stats, session }) {
      const wallet = stats?.wallet ?? {};
      const stats2 = session?.stats ?? null;
      const files = session?.files ?? [];
      const walletText =
        wallet.status === 'ready'
          ? (wallet.wallets ?? []).map((item) => `${item.currency === 'USD' ? '$' : '¥'}${item.balance}`).join(' + ') || '—'
          : wallet.status === 'signed-out' ? '未登录'
            : wallet.status === 'unavailable' ? '服务不可用'
              : wallet.status === 'failed' ? '查询失败'
                : wallet.status === 'error' ? '查询出错' : '读取中…';
      const cards = [];

      cards.push(
        h(
          Card,
          { key: 'info', title: '会话详情', icon: '⌗', tight: false },
          h(
            'div',
            { className: 'am_kv' },
            h(KV, { k: '会话', v: session ? session.shortId : '—' }),
            h(KV, { k: '工作区', v: session?.workspace ?? '—', title: session?.cwd }),
            h(KV, { k: '模型', v: session ? `${session.provider}/${session.model}` : '—' }),
            h(KV, { k: '推理档位', v: session?.reasoningEffort || '—' }),
            h(KV, { k: '轮次 / 步骤', v: session ? `${session.turns} / ${session.steps}` : '—' }),
            h(KV, { k: '模型请求', v: session?.requests ?? 0 }),
            h(KV, { k: '工具调用', v: session?.toolCalls ?? 0 }),
            h(KV, { k: '报错 / 重试', v: `${session?.errors ?? 0} / ${session?.retries ?? 0}`, tone: (session?.errors ?? 0) > 0 ? 'red' : undefined }),
            h(KV, { k: '运行状态', v: session?.running ? '运行中' : '空闲', tone: session?.running ? 'green' : undefined }),
            h(KV, { k: '最后活动', v: fmtAgo(session?.lastEventAt) }),
            h(KV, { k: '创建时间', v: session?.createdAt ? fmtClock(session.createdAt) : '—' }),
          ),
          session?.goal?.objective
            ? h('div', { className: 'am_blockLabel', style: { marginTop: '8px' } }, '目标', h('span', { className: 'am_dimc am_ellip' }, session.goal.objective))
            : null,
          session?.todos
            ? h(
                'div',
                { className: 'am_blockLabel', style: { marginTop: '8px' } },
                '待办 ',
                h('span', { className: 'am_num am_green' }, `${session.todos.completed}/${session.todos.total}`),
                h(Meter, { ratio: session.todos.total > 0 ? session.todos.completed / session.todos.total : 0, width: 12, tone: 'green' }),
              )
            : null,
        ),
      );

      cards.push(
        h(
          Card,
          { key: 'speed', title: '速度与耗时', icon: '⚡' },
          h(
            'div',
            { className: 'am_kv' },
            h(KV, { k: '首字延迟', v: stats2?.ttftSteps > 0 ? fmtDuration(stats2.ttftMs / stats2.ttftSteps) : '—' }),
            h(KV, { k: '模型耗时', v: stats2?.llmMs ? fmtDuration(stats2.llmMs) : '—' }),
            h(KV, { k: '工具耗时', v: stats2?.toolMs ? fmtDuration(stats2.toolMs) : '—' }),
            h(KV, { k: '解码', v: stats2?.decodeMs ? `${fmtDuration(stats2.decodeMs)} / ${fmtTokens(stats2.decodeTokens ?? 0)}` : '—' }),
            h(KV, { k: '上下文', v: session?.contextWindow > 0 ? `${fmtTokens(session.surfaceTokens)}/${fmtTokens(session.contextWindow)}` : '—' }),
          ),
        ),
      );

      const chips = [];
      if (session?.model) chips.push({ text: session.model, tone: 'brand' });
      if (session?.reasoningEffort) chips.push({ text: session.reasoningEffort });
      if (session?.agentPreset) chips.push({ text: session.agentPreset });
      if (session?.isSubagent) chips.push({ text: '子代理', tone: 'warn' });
      if (session?.workspace) chips.push({ text: session.workspace });
      if (session?.turns) chips.push({ text: `${session.turns} 轮` });
      if (session?.toolCalls) chips.push({ text: `${session.toolCalls} 次工具` });
      cards.push(h(Card, { key: 'chips', title: '标签', icon: '⌗' }, h(Chips, { items: chips })));

      cards.push(
        h(
          Card,
          { key: 'wallet', title: '钱包余额', icon: '¥', right: h('button', { className: 'am_copy', title: '立即刷新', onClick: refreshWallet }, '⟳') },
          h(
            'div',
            { className: 'am_row2' },
            h('span', { className: 'am_heroValue am_num', style: { '--tone': TONE.green, fontSize: '18px' } }, walletText),
          ),
          (wallet.bonusWallets ?? []).length > 0
            ? h('div', { className: 'am_row2' }, h('span', { className: 'am_label' }, '赠送余额'), h('span', { className: 'am_num am_green' }, (wallet.bonusWallets ?? []).map((item) => `${item.currency === 'USD' ? '$' : '¥'}${item.balance}`).join(' + ')))
            : null,
          h('div', { className: 'am_row2' }, h('span', { className: 'am_label' }, '刷新'), h('span', { className: 'am_num am_dimc' }, wallet.at ? `${fmtClock(wallet.at)} · 每 60s 自动` : '等待中')),
          wallet.error ? h('div', { className: 'am_red' }, String(wallet.error).slice(0, 80)) : null,
        ),
      );

      if (files.length > 0) {
        cards.push(
          h(
            Card,
            { key: 'files', title: '最近文件', icon: '▤', right: `${files.length}` },
            ...files.slice(0, 6).map((file) =>
              h(
                'div',
                { className: 'am_row2', key: file.path, title: file.path, style: { marginBottom: '4px' } },
                h('span', { className: 'am_ellip am_dimc', style: { minWidth: 0, flex: 1 } }, file.rel || file.path),
                h('span', { className: 'am_num' }, h('span', { className: 'am_add' }, `+${file.plus ?? 0}`), ' ', h('span', { className: 'am_del' }, `−${file.minus ?? 0}`)),
              ),
            ),
          ),
        );
      }

      cards.push(
        h(
          Card,
          { key: 'trend', title: `最近 ${stats?.config?.historyDays ?? 14} 天花费`, icon: '◷' },
          h(Timeline, { trend: stats?.trend ?? [] }),
          h(
            'div',
            { className: 'am_row2', style: { marginTop: '6px' } },
            h('span', { className: 'am_label' }, '峰值'),
            h('span', { className: 'am_num am_amber' }, fmtMoney(Math.max(0, ...(stats?.trend ?? []).map((item) => item.cost)))),
            h('span', { className: 'am_label' }, '今日'),
            h('span', { className: 'am_num am_blue' }, fmtMoney(stats?.today?.cost ?? 0)),
          ),
        ),
      );

      return h('div', { className: 'am_side' }, ...cards);
    }
    //#endregion

    //#region 主面板
    function useStore() {
      return useSyncExternalStore(
        useCallback((listener) => store.subscribe(listener), []),
        useCallback(() => store.getSnapshot(), []),
      );
    }

    const onTogglePause = () => {
      const state = store.state;
      if (state.paused) {
        store.update({ paused: false, pending: 0 });
        pollOnce();
      } else {
        store.update({ paused: true });
      }
    };

    const NAV = [
      { key: 'board', label: '仪表盘', icon: '▦' },
      { key: 'flow', label: '活动流', icon: '≡' },
      { key: 'files', label: '文件', icon: '▤' },
      { key: 'sessions', label: '会话', icon: '❐' },
      { key: 'settings', label: '设置', icon: '⚙' },
    ];

    function Panel({ t, runtime }) {
      const state = useStore();
      const stats = state.stats;
      const config = stats?.config ?? {};
      const sessions = stats?.sessions ?? [];
      const current = useMemo(
        () => (state.sessionFilter ? sessions.find((item) => item.id === state.sessionFilter) : sessions.find((item) => item.running) ?? sessions[0]) ?? null,
        [state.sessionFilter, sessions],
      );

      useEffect(() => {
        start();
      }, []);

      const scoped = useMemo(() => {
        const list = state.frames.filter((frame) => frame.hidden !== true);
        return state.sessionFilter
          ? list.filter((frame) => frame.sid === state.sessionFilter)
          : current
            ? list.filter((frame) => frame.sid === current.id || frame.parentSid === current.id)
            : [];
      }, [state.frames, state.sessionFilter, current]);

      const counts = useMemo(() => {
        const base = { all: scoped.length, tool: 0, reply: 0, errors: 0, other: 0 };
        for (const frame of scoped) base[frameBucket(frame)] += 1;
        return base;
      }, [scoped]);

      const query = state.query.trim().toLowerCase();
      const frames = useMemo(() => {
        const filtered = scoped.filter((frame) => (state.kindFilter === 'all' || frameBucket(frame) === state.kindFilter) && frameMatches(frame, query));
        return filtered.slice(-state.visibleLimit);
      }, [scoped, state.kindFilter, query, state.visibleLimit]);

      const maxDuration = useMemo(() => Math.max(0, ...frames.map((frame) => frame.durationMs || 0)), [frames]);

      const groups = useMemo(() => {
        if (!state.groupByTurn) return null;
        const out = [];
        for (const frame of frames) {
          const key = frame.turn > 0 ? String(frame.turn) : '—';
          const last = out[out.length - 1];
          if (last && last.turn === key) last.frames.push(frame);
          else out.push({ turn: key, frames: [frame] });
        }
        return out;
      }, [frames, state.groupByTurn]);

      const toggle = useCallback((id) => {
        store.update({ expanded: { ...store.state.expanded, [id]: !store.state.expanded[id] } });
      }, []);
      const toggleGroup = useCallback((turn) => {
        store.update({ collapsedTurns: { ...store.state.collapsedTurns, [turn]: !store.state.collapsedTurns[turn] } });
      }, []);

      const transport =
        state.transport === 'sse' ? { text: '实时', cls: 'am_tag_ok', dot: 'am_dot_run' }
          : state.transport === 'poll' ? { text: '轮询', cls: 'am_tag_warn', dot: 'am_dot_warn' }
            : state.transport === 'offline' ? { text: '离线', cls: 'am_tag_bad', dot: 'am_dot_err' }
              : { text: '连接中', cls: 'am_tag_warn', dot: 'am_dot_warn' };

      const navCounts = { flow: counts.all, files: current?.files?.length ?? 0, sessions: sessions.length };

      const renderContent = () => {
        if (state.transport === 'offline') {
          return h('div', { className: 'am_empty' }, h('div', { className: 'am_red' }, '✗ 监视器的 host 半不可达'), h('div', null, state.error ?? ''));
        }
        if (!stats) return h('div', { className: 'am_empty' }, '正在读取数据…');
        if (state.section === 'files') return h(FilesSection, { session: current });
        if (state.section === 'sessions') return h(SessionsSection, { stats, state, onFilter: (id) => store.update({ sessionFilter: id }) });
        if (state.section === 'settings') return h(SettingsSection, { stats });
        return h(FlowSection, { state, frames, groups, maxDuration, toggle, toggleGroup });
      };

      const showFlow = state.section === 'board' || state.section === 'flow';

      return h(
        'div',
        { className: 'am_root', 'data-agent-monitor': state.section },
        // 顶栏（参考图：标题 + 副标题 + 搜索 + 圆形图标按钮）
        h(
          'header',
          { className: 'am_head' },
          h(
            'div',
            { className: 'am_headRow' },
            h(
              'div',
              { className: 'am_headText' },
              h('h1', { className: 'am_h1' }, h('span', { className: 'am_h1mark' }, '✦'), t('title')),
              h('p', { className: 'am_sub' }, '实时活动 · token 与花费 · 上下文压力 · 只读'),
            ),
            h(
              'label',
              { className: 'am_search' },
              h('span', null, '⌕'),
              h('input', {
                type: 'search',
                placeholder: '搜索活动…',
                value: state.query,
                onChange: (event) => store.update({ query: event.target.value }),
              }),
              state.query ? h('button', { className: 'am_copy', title: '清空搜索', onClick: () => store.update({ query: '' }) }, '✕') : null,
            ),
            h(
              'div',
              { className: 'am_iconBtns' },
              h('button', { className: 'am_ib', title: '立即刷新', onClick: () => pollOnce() }, '⟳'),
              h('button', { className: `am_ib${state.paused ? ' am_ib_on' : ''}`, title: '暂停/继续接收', onClick: onTogglePause }, state.paused ? '▶' : '⏸'),
              h('button', { className: 'am_ib', title: '清空当前视图', onClick: () => store.update({ frames: [], clearedBefore: stats?.seq ?? 0, pending: 0 }) }, '⌫'),
              h('button', { className: `am_ib${state.groupByTurn ? ' am_ib_on' : ''}`, title: '按 turn 分组', onClick: () => store.update({ groupByTurn: !state.groupByTurn }) }, '⊞'),
              runtime?.closeTab ? h('button', { className: 'am_ib', title: '关闭右侧栏 tab', onClick: () => runtime.closeTab() }, '✕') : null,
            ),
          ),
          h(
            'div',
            { className: 'am_meta' },
            h('span', { className: `am_tag ${transport.cls}` }, h('span', { className: `am_dot ${transport.dot}` }), transport.text),
            state.paused ? h('span', { className: 'am_tag am_tag_warn' }, `已暂停 +${state.pending}`) : null,
            current ? h('span', { className: 'am_tag' }, `session ${current.shortId}`) : null,
            current ? h('span', { className: 'am_tag' }, current.workspace) : null,
            current?.model ? h('span', { className: 'am_tag am_tag_brand' }, `${current.provider}/${current.model}`) : null,
            current?.reasoningEffort ? h('span', { className: 'am_tag' }, current.reasoningEffort) : null,
            current ? h('span', { className: 'am_tag' }, `turn ${current.turns} / step ${current.steps}`) : null,
            current?.running ? h('span', { className: 'am_tag am_tag_ok' }, '运行中') : null,
          ),
        ),

        // 主体：容器查询决定单列 / 三栏
        h(
          'div',
          { className: 'am_body' },
          h(
            'div',
            { className: 'am_shell' },
            // 左导航（窄栏变横向分段条）
            h(
              'nav',
              { className: 'am_nav' },
              ...NAV.map((item) =>
                h(
                  'button',
                  { key: item.key, className: `am_navItem${state.section === item.key ? ' am_navItem_on' : ''}`, onClick: () => store.update({ section: item.key }) },
                  h('span', { className: 'am_navIcon' }, item.icon),
                  h('span', null, item.label),
                  navCounts[item.key] ? h('span', { className: 'am_navCount am_num' }, navCounts[item.key]) : null,
                ),
              ),
            ),
            // 中间内容
            h(
              'div',
              { className: 'am_main' },
              stats?.backfill?.state === 'scanning'
                ? h(Card, { title: '回填历史', icon: '↻', right: `${stats.backfill.scanned}/${stats.backfill.total}` }, h(Meter, { ratio: stats.backfill.total > 0 ? stats.backfill.scanned / stats.backfill.total : 0, width: 40, tone: 'blue' }))
                : null,
              state.section === 'board' && stats ? h(HeroRow, { stats, session: current }) : null,
              state.section === 'board' && stats ? h(TipCard, { stats, session: current, onAction: (action) => store.update(action === 'errors' ? { section: 'flow', kindFilter: 'errors' } : { section: 'settings' }) }) : null,
              showFlow && stats ? h(LiveLine, { session: current }) : null,
              showFlow && stats
                ? h(
                    'div',
                    { className: 'am_row2', style: { justifyContent: 'space-between' } },
                    h(Segmented, {
                      items: KIND_GROUPS.map((group) => ({ key: group.key, label: group.label, count: counts[group.key] })),
                      value: state.kindFilter,
                      onChange: (key) => store.update({ kindFilter: key }),
                    }),
                    h('span', { className: 'am_label am_num' }, `${frames.length} 条${query ? ` · 匹配「${state.query}」` : ''}`),
                  )
                : null,
              renderContent(),
            ),
            // 右侧详情（窄栏时排到内容下面）
            state.section === 'board' && stats ? h(DetailPanel, { stats, session: current }) : null,
          ),
        ),

        // 底部操作条（次要 + 主按钮）
        h(
          'footer',
          { className: 'am_foot' },
          state.toast
            ? h('span', { className: 'am_toast' }, `✓ ${state.toast}`)
            : h(
                'span',
                { className: 'am_footStatus' },
                'Ctrl+` 呼出/收起',
                h('span', { className: 'am_footSep' }, '│'),
                '只读',
                h('span', { className: 'am_footSep' }, '│'),
                `${sessions.length} 会话`,
                h('span', { className: 'am_footSep' }, '│'),
                `今日 ${fmtMoney(stats?.today?.cost ?? 0)}`,
                h('span', { className: 'am_footSep' }, '│'),
                `${fmtTokens(stats?.today?.tokens?.total ?? 0)} tok`,
                h('span', { className: 'am_footSep' }, '│'),
                `缓冲 ${state.frames.length}/${config.bufferSize ?? 500}`,
              ),
          h('a', { className: 'am_btn', href: `${API}/export?what=activity&format=csv`, download: '' }, '活动 CSV'),
          h('a', { className: 'am_btn', href: `${API}/export?what=daily&format=csv`, download: '' }, '每日 CSV'),
          h('a', { className: 'am_btn', href: `${API}/export?what=sessions&format=csv`, download: '' }, '会话 CSV'),
          h('a', { className: 'am_btn', href: `${API}/export?what=models&format=csv`, download: '' }, '模型 CSV'),
          h('a', { className: 'am_btn am_btnPrimary', href: `${API}/export?format=json`, download: '' }, '✓ 完整 JSON'),
        ),
      );
    }
    //#endregion

    //#region 图标
    function MonitorIcon({ size }) {
      const s = typeof size === 'number' ? size : 16;
      return h(
        'svg',
        { className: 'am_icon', width: s, height: s, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, 'aria-hidden': true },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }),
        h('path', { d: 'M4.5 6.5h7' }),
        h('path', { d: 'M4.5 9.5h4' }),
      );
    }

    function SidebarEntry(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const runtime = props.runtime;
      return h(
        'button',
        { type: 'button', className: 'am_sidebtn', 'aria-label': t('title'), onClick: () => runtime?.selectFullPage?.() },
        h(MonitorIcon, { size: typeof props.size === 'number' ? props.size : 16 }),
      );
    }
    //#endregion

    //#region 插件体
    const inject = ['slots', 'layout', 'locale', 'sidebarRightTabs', 'sidebarRight'];

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh: {
              title: 'Agent 监视器',
              tabTitle: '监视器',
              guideTitle: 'Agent 监视器',
              guideDescription: '实时仪表盘：活动流、token 与花费、上下文占用、子代理与钱包余额（只读）',
              shortcut: '呼出/收起 Agent 监视器',
              needSession: '先打开一个会话，监视器才有可监测的对象',
            },
            en: {
              title: 'Agent Monitor',
              tabTitle: 'Monitor',
              guideTitle: 'Agent Monitor',
              guideDescription: 'Live dashboard: activity, tokens, cost, context pressure, subagents and wallet (read-only)',
              shortcut: 'Toggle the Agent Monitor',
              needSession: 'Open a session first — the monitor needs something to observe',
            },
          }),
        'agent-monitor: dictionaries',
      );
      const t = ctx.locale.bind(NS);

      const runtime = {
        selectFullPage: () => {
          try {
            ctx.layout.selectPanel(PANEL_ID);
          } catch {
            /* 忽略 */
          }
        },
        closeTab: () => {
          try {
            const tabs = ctx.sidebarRight?.openTabs?.getSnapshot?.() ?? [];
            const mine = tabs.find((tab) => tab && tab.kind === KIND);
            if (mine) ctx.sidebarRight.close(mine.id);
            else ctx.layout.selectPanel(null);
          } catch {
            /* 忽略 */
          }
        },
        openTab: () => {
          const controller = ctx.sidebarRight;
          if (!controller) return { ok: false, reason: 'no-controller' };
          try {
            const tabs = controller.openTabs?.getSnapshot?.() ?? [];
            const mine = tabs.find((tab) => tab && tab.kind === KIND);
            if (mine) {
              controller.focus?.(mine.id);
              if (controller.isExpanded?.() === false) controller.toggleExpanded?.();
              return { ok: true, action: 'focused' };
            }
            const target = controller.commandTarget?.();
            if (target !== undefined && typeof controller.openTabFromTarget === 'function') controller.openTabFromTarget(KIND, target);
            else controller.openTab(KIND);
            if (controller.isExpanded?.() === false) controller.toggleExpanded?.();
            return { ok: true, action: 'opened' };
          } catch (error) {
            return { ok: false, reason: String(error?.message ?? error) };
          }
        },
        toggleTab: () => {
          const controller = ctx.sidebarRight;
          try {
            const tabs = controller?.openTabs?.getSnapshot?.() ?? [];
            const mine = tabs.find((tab) => tab && tab.kind === KIND);
            if (mine) {
              controller.close(mine.id);
              return { ok: true, action: 'closed' };
            }
          } catch {
            /* 落到打开分支 */
          }
          const result = runtime.openTab();
          if (!result.ok) runtime.selectFullPage();
          return result;
        },
      };

      // 传输的生命周期跟随插件本身，而不是某一个挂载点
      ctx.effect(
        () => () => {
          disposed = true;
          started = false;
          stopTransport();
        },
        'agent-monitor: transport teardown',
      );

      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t, runtime }) }, Panel));

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 60, locale: NS, label: () => t('title'), inject: () => ({ t, runtime }) }, SidebarEntry),
      );

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: KIND,
            kind: KIND,
            title: () => t('tabTitle'),
            guide: [{ id: 'agent-monitor', order: 60, title: () => t('guideTitle'), description: () => t('guideDescription') }],
          }),
        'agent-monitor: right tab type',
      );

      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: KIND, locale: NS, inject: () => ({ t, runtime }) }, Panel),
      );

      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: KIND, locale: NS }, ({ t: translate }) =>
          h('span', { className: 'am_dimc' }, typeof translate === 'function' ? translate('tabTitle') : '监视器'),
        ),
      );

      ctx.inject(['shortcuts'], (scope) => {
        scope.effect(
          () =>
            scope.shortcuts.register({
              id: 'agent-monitor.toggle',
              label: () => t('shortcut'),
              aliases: ['agent monitor', 'monitor', '监视器'],
              defaults: {
                'desktop:macos': { code: 'Backquote', modifiers: ['primary'] },
                'desktop:windows': { code: 'Backquote', modifiers: ['primary'] },
                'desktop:linux': { code: 'Backquote', modifiers: ['primary'] },
                'web:macos': { code: 'Backquote', modifiers: ['primary'] },
                'web:windows': { code: 'Backquote', modifiers: ['primary'] },
              },
              regions: ['page', 'editable', 'terminal'],
              modals: [],
              resolve: ({ target }) => {
                if (target === undefined) return { status: 'blocked', reason: t('needSession') };
                return { status: 'handled', run: () => runtime.toggleTab() };
              },
            }),
          'agent-monitor: shortcut',
        );
      });
    }
    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
