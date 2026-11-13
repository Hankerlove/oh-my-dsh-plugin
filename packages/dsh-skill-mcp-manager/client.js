window.__ModuleLoader__.load({
  id: '@ultraslow/dsh-skill-mcp-manager',
  /**
   * Client half of the workspace-scoped Skill / MCP manager.
   *
   * One icon in the chat session header (`conversation.session.header.actions`)
   * opens a panel bound to that session's workspace. Everything is fetched from
   * the host route family under /skill-mcp; the browser never guesses a project
   * root, it only passes the session id.
   *
   * Skills are grouped by the rank table the host parses from the running DSH
   * source, so each group shows the directory DSH would actually scan.
   */
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'skill-mcp-manager';
    const API = '/skill-mcp';

    // #region i18n
    const ZH = {
      entry: 'Skill 与 MCP',
      title: 'Skill 与 MCP',
      close: '关闭',
      refresh: '刷新',
      loading: '加载中…',
      empty: '这个工作区还没有可管理的Skill。',
      skillsTab: 'Skill',
      mcpTab: 'MCP',
      visibleCount: (on, total) => `${on}/${total}`,
      visibleShort: '模型可见',
      hiddenNote: '取消勾选只让模型看不到它，节省context；你仍然可以用/名字手动调用。拖动复选框可连续切换。',
      enableAll: '全部激活',
      disableAll: '全部关闭',
      search: '筛选Skill名…',
      whenToUse: '何时使用',
      noWorkspace: '当前会话没有工作区路径。',
      expandAll: '全部展开',
      collapseAll: '全部收起',
      noMatch: '没有匹配的Skill。',
      groupEmpty: '这个目录下没有发现Skill。',
      rankSource: (short) => `优先级读取自DSH源码:${short}`,
      rankFallback: '无法读取 DSH 源码，已改用内置 rank 表',
      rankFallbackFor: (list) => `以下 rank 常量来自内置回退：${list.join('、')}`,
      patternDir: (pattern) => `由 preset 决定（${pattern}）`,
      presetDecided: '由 preset 决定',
      hostInjected: '由 DSH 宿主注入',
      observedDirs: (count) => `${count} 个目录`,
      mcpAdd: '新增 MCP',
      mcpScopeLabel: '作用域',
      mcpGlobalSection: '全局配置',
      mcpWorkspaceSection: '本工作区',
      mcpGlobalHint: '对全部工作区生效，写入profile的cordis.patch.yml',
      mcpReadOnly: '只读',
      mcpScopeGlobal: '全局',
      mcpScopeWorkspace: '工作区',
      mcpGlobalScopeNote: '作用域为全局：写入profile的cordis.patch.yml，对全部工作区生效，保存后由DSH热重载。',
      mcpWorkspaceScopeNote: '作用域为本工作区：只影响当前工作区的会话。',
      mcpRestartRequired: '已写入配置文件，但当前环境没有热重载，重启DSH后生效。',
      mcpApplyPending: '已写入配置文件，DSH尚未加载该服务器；稍后刷新或重启DSH。',
      mcpGlobalReadError: (message) => `无法读取profile的cordis.patch.yml：${message}`,
      mcpEdit: '编辑',
      mcpDelete: '删除',
      mcpSave: '保存',
      mcpCancel: '取消',
      mcpType: '类型',
      mcpCommandLabel: '命令',
      mcpUrlLabel: 'URL',
      mcpArgs: '参数 (args)',
      mcpEnv: '环境变量 (env)',
      mcpHeaders: 'Headers',
      mcpAddRow: '添加',
      mcpRemove: '删除此项',
      mcpEnabled: '启用',
      mcpTools: '工具',
      mcpTest: '测试连接',
      mcpTesting: '连接中…',
      mcpTestOk: '连接成功',
      mcpTestFailed: '连接失败',
      mcpTestTools: (count) => `${count} 个工具`,
      mcpTestElapsed: (ms) => `耗时 ${ms}ms`,
      mcpTestServer: (name, version) => `服务端 ${name}${version === undefined ? '' : ` v${version}`}`,
      mcpTestNoTools: '服务端未提供工具能力',
      mcpDisabled: '已停用',
      mcpProbing: '探测中…',
      mcpProbeFailed: '连接失败',
      mcpProbeToggle: '查看/收起工具名',
      mcpConfigured: '已配置',
      mcpMountNote: '工作区MCP只在该工作区的会话里挂载；全局MCP由DSH在profile层挂载，对所有工作区生效。',
      mcpUnavailable: '当前 DSH 运行时无法解析 @deepseek-ai/dsh-mcp-client，MCP 管理暂不可用。',
      invalid: '请检查字段后再保存。',
      status: { starting: '连接中', ready: '已连接', failed: '失败', disposed: '已卸载' },
      onlyUser: '仅用户可用',
    };
    const EN = {
      entry: 'Skills & MCP',
      title: 'Skills and MCP',
      close: 'Close',
      refresh: 'Refresh',
      loading: 'Loading…',
      empty: 'No manageable skills in this workspace yet.',
      skillsTab: 'Skills',
      mcpTab: 'MCP',
      visibleCount: (on, total) => `${on}/${total}`,
      visibleShort: 'visible to the model',
      hiddenNote: 'Unchecking only hides a skill from the model to save context; /name still works. Drag the checkbox to toggle a run of skills.',
      enableAll: 'Enable all',
      disableAll: 'Disable all',
      search: 'Filter skill names…',
      whenToUse: 'When to use',
      noWorkspace: 'This session has no workspace path.',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      noMatch: 'No matching skills.',
      groupEmpty: 'No skills found in this directory.',
      rankSource: (short) => `Priorities read from the DSH source: ${short}`,
      rankFallback: 'Could not read the DSH source; using the built-in rank table',
      rankFallbackFor: (list) => `These rank constants came from the built-in fallback: ${list.join(', ')}`,
      patternDir: (pattern) => `decided by the preset (${pattern})`,
      presetDecided: 'decided by the preset',
      hostInjected: 'injected by the DSH host',
      observedDirs: (count) => `${count} directories`,
      mcpAdd: 'Add MCP',
      mcpScopeLabel: 'Scope',
      mcpGlobalSection: 'Global',
      mcpWorkspaceSection: 'This workspace',
      mcpGlobalHint: 'Applies to every workspace; written to the profile cordis.patch.yml',
      mcpReadOnly: 'read-only',
      mcpScopeGlobal: 'global',
      mcpScopeWorkspace: 'workspace',
      mcpGlobalScopeNote: 'Scope: global — written to the profile cordis.patch.yml, applies to every workspace, hot-reloaded by DSH.',
      mcpWorkspaceScopeNote: 'Scope: this workspace — affects sessions of the current workspace only.',
      mcpRestartRequired: 'Written to the config file, but this environment has no hot reload; restart DSH to apply.',
      mcpApplyPending: 'Written to the config file, but DSH has not loaded the server yet; refresh or restart DSH.',
      mcpGlobalReadError: (message) => `Cannot read the profile cordis.patch.yml: ${message}`,
      mcpEdit: 'Edit',
      mcpDelete: 'Delete',
      mcpSave: 'Save',
      mcpCancel: 'Cancel',
      mcpType: 'Type',
      mcpCommandLabel: 'Command',
      mcpUrlLabel: 'URL',
      mcpArgs: 'Arguments',
      mcpEnv: 'Environment',
      mcpHeaders: 'Headers',
      mcpAddRow: 'Add',
      mcpRemove: 'Remove this row',
      mcpEnabled: 'Enabled',
      mcpTools: 'Tools',
      mcpTest: 'Test connection',
      mcpTesting: 'Connecting…',
      mcpTestOk: 'Connected',
      mcpTestFailed: 'Connection failed',
      mcpTestTools: (count) => `${count} tools`,
      mcpTestElapsed: (ms) => `${ms}ms`,
      mcpTestServer: (name, version) => `server ${name}${version === undefined ? '' : ` v${version}`}`,
      mcpTestNoTools: 'The server exposes no tools capability',
      mcpDisabled: 'disabled',
      mcpProbing: 'probing…',
      mcpProbeFailed: 'failed',
      mcpProbeToggle: 'Show/hide tool names',
      mcpConfigured: 'configured',
      mcpMountNote: 'Workspace rows mount inside that workspace only; global rows mount in the profile layer and apply to every workspace.',
      mcpUnavailable: 'This DSH runtime cannot resolve @deepseek-ai/dsh-mcp-client, so MCP management is unavailable.',
      invalid: 'Please fix the fields before saving.',
      status: { starting: 'connecting', ready: 'connected', failed: 'failed', disposed: 'disposed' },
      onlyUser: 'user only',
    };
    // #endregion

    // #region styles
    // Every colour is a DSH alias token, so the panel follows the active theme
    // (light/dark) instead of shipping its own palette.
    const CSS = `
.smm-entry { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 0; padding: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.smm-entry:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.smm-entry.is-hero { width: auto; gap: 5px; padding: 0 6px; height: 24px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); }
.smm-entry.is-hero:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.smm-entry-label { font-size: 12px; white-space: nowrap; }
/* The hero options group is normally pushed to the far right; keep our entry
   right beside the preset chip instead, like the workspace/mode chips. */
[class*="_heroOptions"]:has(.smm-entry.is-hero) { margin-left: 6px; }
.smm-backdrop { position: fixed; inset: 0; pointer-events: auto; z-index: 2147483000; background: var(--dsw-alias-bg-mask-1); display: flex; align-items: center; justify-content: center; padding: 24px; }
.smm-panel { width: min(880px, 100%); max-height: min(80vh, 780px); display: flex; flex-direction: column; background: var(--dsw-static-neutral-bluish-00); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; box-shadow: 0 24px 64px rgba(0,0,0,.35); overflow: hidden; font-size: 13px; }
body[data-ds-dark-theme] .smm-panel { background: var(--dsw-static-neutral-bluish-850); }
body[data-ds-dark-theme] .smm-row:hover, body[data-ds-dark-theme] .smm-mcp-row:hover, body[data-ds-dark-theme] .smm-group-head:hover { background: var(--dsw-static-neutral-bluish-800); }
.smm-head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 18px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.smm-head-main { flex: 1 1 auto; min-width: 0; }
.smm-title { font-size: 15px; font-weight: 600; margin: 0 0 2px; color: var(--dsw-alias-label-primary); }
.smm-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smm-x { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 18px; line-height: 1; padding: 4px 6px; border-radius: 6px; }
.smm-x:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.smm-tabs { display: flex; gap: 4px; padding: 8px 14px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.smm-tab { border: 0; background: transparent; padding: 6px 10px 8px; cursor: pointer; color: var(--dsw-alias-label-secondary); border-bottom: 2px solid transparent; font-size: 13px; }
.smm-tab.is-on { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }
.smm-body { flex: 1 1 auto; overflow: auto; padding: 12px 14px 16px; }
.smm-toolbar { display: flex; align-items: center; gap: 8px; padding: 4px 2px 10px; flex-wrap: wrap; }
.smm-count { flex: 1 1 auto; color: var(--dsw-alias-label-secondary); font-size: 12px; min-width: 140px; display: inline-flex; align-items: baseline; gap: 6px; }
.smm-count b { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.smm-count-hint { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; }
.smm-search { width: 200px; padding: 5px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; outline: none; }
.smm-search:focus { border-color: var(--dsw-alias-brand-primary); }
.smm-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
.smm-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.smm-btn:disabled { opacity: .5; cursor: default; }
.smm-btn.is-primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
.smm-btn.is-primary:hover { background: var(--dsw-alias-button-primary-hover); }
.smm-btn.is-danger { color: var(--dsw-alias-label-error); }
.smm-btn.is-danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.smm-group { margin: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.smm-group:last-of-type { border-bottom: 0; }
.smm-group-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 6px; border-radius: 8px; min-width: 0; }
.smm-group-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
.smm-group-toggle { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 4px 0; text-align: left; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.smm-group-actions { flex: none; display: flex; align-items: center; gap: 2px; }
.smm-mini { border: 0; background: transparent; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; font-family: inherit; padding: 2px 6px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.smm-mini:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.smm-mini:disabled { opacity: .38; cursor: default; }
.smm-caret { width: 12px; flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; transition: transform .12s ease; }
.smm-caret.is-open { transform: rotate(90deg); }
.smm-rank { flex: none; width: 40px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.smm-group-title { flex: none; font-weight: 600; font-size: 12.5px; }
.smm-group-dir { flex: 1 1 auto; min-width: 0; text-align: left; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smm-group-dir.is-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.smm-group-count { flex: none; margin-left: auto; padding-left: 10px; min-width: 44px; text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.smm-group-count b { font-weight: 600; color: var(--dsw-alias-label-secondary); }
.smm-group-body { padding: 0 4px 4px 24px; }
.smm-row { display: flex; align-items: flex-start; gap: 10px; padding: 6px 8px; border-radius: 8px; }
.smm-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.smm-row.is-range { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent); }
.smm-row.is-range .smm-check { cursor: grabbing; }
.smm-skills.is-dragging { user-select: none; -webkit-user-select: none; cursor: grabbing; }
.smm-skills.is-dragging .smm-row { cursor: grabbing; }
.smm-row.is-off .smm-name, .smm-row.is-off .smm-desc { opacity: .5; }
.smm-check { margin: 0; width: 15px; height: 15px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; flex: none; }
.smm-row > .smm-check { margin-top: 2px; }
.smm-main { flex: 1 1 auto; min-width: 0; }
.smm-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.smm-name { font-weight: 600; font-size: 13px; color: var(--dsw-alias-label-primary); }
.smm-tag { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.smm-tag.is-muted { color: var(--dsw-alias-label-tertiary); }
.smm-tag.is-bad { color: var(--dsw-alias-label-error); background: var(--dsw-alias-interactive-bg-hover-danger); }
.smm-tag-btn { border: 0; cursor: pointer; font-family: inherit; }
.smm-tag-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.smm-tag-caret { margin-left: 3px; opacity: .7; }
.smm-tool-panel { margin-top: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); padding: 8px 10px; }
.smm-tool-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-bottom: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.smm-tool-list { display: grid; gap: 0; max-height: 200px; overflow: auto; }
.smm-tool-row { display: flex; align-items: baseline; gap: 10px; padding: 4px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); min-width: 0; }
.smm-tool-row:last-child { border-bottom: 0; }
.smm-tool-name { flex: none; max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.smm-tool-desc { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.smm-tool-empty { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.smm-desc { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.smm-note { margin: 10px 2px 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.smm-warn { margin: 8px 2px; padding: 8px 10px; border-radius: 8px; font-size: 12px; background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.smm-err { margin: 8px 2px; color: var(--dsw-alias-label-error); font-size: 12px; }
.smm-footer { margin-top: 14px; padding: 10px 10px 8px; border-top: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); display: grid; gap: 5px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.smm-footer div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smm-footer .is-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.smm-footer .is-warn { color: var(--dsw-alias-state-warn-label); white-space: normal; }
.smm-section-wrap { margin-top: 2px; }
.smm-section { display: flex; align-items: baseline; gap: 8px; padding: 12px 6px 2px; border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 8px; }
.smm-section-wrap:first-of-type .smm-section { border-top: 0; margin-top: 0; padding-top: 4px; }
.smm-section-title { flex: none; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.smm-section-hint { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.smm-section-count { flex: none; margin-left: auto; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.smm-mcp-row { display: flex; align-items: flex-start; gap: 10px; padding: 9px 8px; border-radius: 8px; }
.smm-mcp-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.smm-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; background: var(--dsw-alias-label-dimmed); flex: none; }
.smm-dot.is-ready { background: var(--dsw-alias-state-success-primary); }
.smm-dot.is-starting { background: var(--dsw-alias-label-tertiary); }
.smm-dot.is-failed { background: var(--dsw-alias-state-error-primary); }
.smm-cmd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smm-row-actions { display: flex; gap: 6px; margin-top: 4px; }
.smm-form { display: grid; gap: 12px; }
.smm-server-name { font-weight: 600; }
.smm-form-wrap { margin: 6px 0 16px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.smm-field-row { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 10px; align-items: center; }
.smm-field-block { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 10px; align-items: start; }
.smm-field-block > .smm-label { line-height: 29px; }
.smm-inline-controls { display: flex; align-items: center; gap: 10px; min-width: 0; }
.smm-inline-controls > .smm-select { flex: 0 0 168px; }
.smm-inline-controls > .smm-input { flex: 1 1 auto; min-width: 0; }
.smm-inline-label { flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.smm-hint { margin: -4px 0 0 102px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.smm-scope-fixed { font-size: 12px; color: var(--dsw-alias-label-primary); }
.smm-segment { display: inline-flex; justify-self: start; align-items: center; gap: 2px; padding: 2px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover); }
.smm-segment-item { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 12px; line-height: 17px; padding: 3px 14px; border-radius: 6px; cursor: pointer; }
.smm-segment-item:hover { color: var(--dsw-alias-label-primary); }
.smm-segment-item.is-on { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, .12); }
body[data-ds-dark-theme] .smm-segment { background: var(--dsw-static-neutral-bluish-875); }
body[data-ds-dark-theme] .smm-segment-item.is-on { background: var(--dsw-static-neutral-bluish-800); box-shadow: 0 1px 2px rgba(0, 0, 0, .4); }
.smm-list > .smm-add:first-child { margin-top: 8px; }
.smm-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.smm-list { display: grid; gap: 6px; }
.smm-list-row { display: flex; align-items: center; gap: 6px; }
.smm-list-row .smm-input { flex: 1 1 0; min-width: 0; }
.smm-list-row .smm-key { flex: 0 0 38%; }
.smm-remove { flex: none; width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; font-size: 14px; line-height: 1; }
.smm-remove:hover { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-label-error); }
.smm-add { justify-self: start; border: 0; background: transparent; color: var(--dsw-alias-link); cursor: pointer; padding: 2px 0 2px 9px; font-size: 12px; }
.smm-add:hover { text-decoration: underline; }
.smm-input, .smm-select, .smm-textarea { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; font-family: inherit; outline: none; }
.smm-input:focus, .smm-select:focus, .smm-textarea:focus { border-color: var(--dsw-alias-brand-primary); }
.smm-textarea { min-height: 56px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.smm-form-actions { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.smm-actions-gap { flex: 1 1 auto; }
.smm-test-btn { margin-right: auto; }
.smm-probe { display: grid; gap: 5px; padding: 8px 10px; border-radius: 8px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2); }
.smm-probe.is-ok { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-label-primary); }
.smm-probe.is-bad { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); }
.smm-probe-line { font-weight: 600; }
.smm-probe-dim { color: var(--dsw-alias-label-secondary); font-weight: 400; }
.smm-probe-err { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-error); word-break: break-word; }
`;

    /** Append the panel/entry stylesheet once per page; returns the node (if created). */
    function ensureStyles() {
      if (typeof document === 'undefined') return undefined;
      const id = `${NS}-css`;
      const existing = document.getElementById(id);
      if (existing !== null) return undefined;
      const node = document.createElement('style');
      node.id = id;
      node.textContent = CSS;
      document.head.appendChild(node);
      return node;
    }
    // #endregion

    // #region host api
    async function call(path, init) {
      const response = await fetch(API + path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...init,
      });
      const text = await response.text();
      let body = null;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      if (body?.ok === false) throw new Error(body.error ?? 'request failed');
      return body;
    }

    const post = (path, payload) =>
      call(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    // #endregion

    // #region editors
    const blankRow = () => ({ key: '', value: '' });

    const blankServer = () => ({
      id: '',
      serverName: '',
      transport: 'stdio',
      enabled: true,
      command: '',
      url: '',
      args: [],
      env: [],
      headers: [],
    });

    const pairList = (record) => Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));

    function fromServer(server) {
      return {
        id: server.id,
        serverName: server.serverName,
        transport: server.transport,
        enabled: server.enabled !== false,
        command: server.command ?? '',
        url: server.url ?? '',
        args: Array.isArray(server.args) ? [...server.args] : [],
        env: pairList(server.env),
        headers: pairList(server.headers),
      };
    }

    const pairsToRecord = (pairs) => {
      const record = {};
      for (const pair of pairs) {
        const key = String(pair.key ?? '').trim();
        if (key === '') continue;
        record[key] = String(pair.value ?? '');
      }
      return record;
    };

    function toServer(form) {
      const base = {
        serverName: form.serverName.trim(),
        transport: form.transport,
        enabled: form.enabled !== false,
      };
      if (form.id !== '') base.id = form.id;
      if (form.transport === 'stdio') {
        const args = form.args.map((arg) => String(arg ?? '').trim()).filter((arg) => arg !== '');
        const env = pairsToRecord(form.env);
        return { ...base, command: form.command.trim(), args, ...(Object.keys(env).length === 0 ? {} : { env }) };
      }
      const headers = pairsToRecord(form.headers);
      return { ...base, url: form.url.trim(), ...(Object.keys(headers).length === 0 ? {} : { headers }) };
    }

    function validate(form) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(form.serverName.trim())) return false;
      if (form.transport === 'stdio') return form.command.trim() !== '';
      return /^https?:\/\//i.test(form.url.trim());
    }
    // #endregion

    // #region components
    function Toggle(props) {
      return h('input', {
        type: 'checkbox',
        className: 'smm-check',
        checked: props.checked,
        disabled: props.disabled === true,
        onChange: (event) => props.onChange(event.target.checked),
        'aria-label': props.label ?? '',
      });
    }

    /** One tool per row: mono name + one-line description; scrolls when long. */
    function ToolList({ tools, t }) {
      if (tools.length === 0) return h('div', { className: 'smm-tool-empty' }, t('mcpTestNoTools'));
      return h(
        'div',
        { className: 'smm-tool-list' },
        tools.map((tool) =>
          h(
            'div',
            { className: 'smm-tool-row', key: tool.name },
            h('code', { className: 'smm-tool-name', title: tool.name }, tool.name),
            tool.description === undefined || tool.description === '' ? null : h('span', { className: 'smm-tool-desc', title: tool.description }, tool.description),
          ),
        ),
      );
    }

    /**
     * Checkbox that never toggles itself: the row owns the gesture so a click and
     * a drag across rows share one code path and one batched write.
     */
    function SkillCheckbox({ checked, disabled, label, onToggle }) {
      return h('input', {
        type: 'checkbox',
        className: 'smm-check',
        checked,
        disabled,
        readOnly: true,
        'aria-label': label,
        onClick: (event) => event.preventDefault(),
        onKeyDown: (event) => {
          if (event.key !== ' ' && event.key !== 'Enter') return;
          event.preventDefault();
          onToggle(!checked);
        },
      });
    }

    function SkillRow({ row, t, onToggle, disabled, index, inRange, onPointerDown }) {
      return h(
        'div',
        {
          className: `smm-row${row.enabled ? '' : ' is-off'}${inRange ? ' is-range' : ''}`,
          'data-skill-index': index,
          onPointerDown: (event) => onPointerDown(event, index),
        },
        h(SkillCheckbox, {
          checked: inRange ? !row.enabled : row.enabled,
          disabled,
          label: row.name,
          onToggle: (checked) => onToggle(row, checked),
        }),
        h(
          'div',
          { className: 'smm-main' },
          h(
            'div',
            { className: 'smm-line' },
            h('span', { className: 'smm-name' }, row.name),
            row.modelInvocable ? null : h('span', { className: 'smm-tag' }, t('onlyUser')),
          ),
          row.description === '' ? null : h('div', { className: 'smm-desc', title: row.whenToUse ?? '' }, row.description),
        ),
      );
    }

    function groupDirectory(group, t) {
      if (typeof group.directory === 'string' && group.directory !== '') {
        if (group.kind === 'observed' && Array.isArray(group.observed) && group.observed.length > 1) {
          return `${group.directory} (+${t('observedDirs')(group.observed.length - 1)})`;
        }
        return group.directory;
      }
      if (group.pattern === 'path' || group.pattern === 'this.customSkillDirs') return t('presetDecided');
      if (group.pattern === 'this.bundledSkillDir') return t('hostInjected');
      if (typeof group.pattern === 'string' && group.pattern !== '') return t('patternDir')(group.pattern);
      return '';
    }

    /** One grouped footer: usage note, where the rank table came from, and any per-row fallback. */
    /** `…/node_modules/@scope/pkg/lib/index.js` — enough to identify the file, full path stays in the tooltip. */
    function shortSourcePath(full) {
      if (typeof full !== 'string' || full === '') return '';
      const normalized = full.replaceAll('\\', '/');
      const marker = normalized.lastIndexOf('node_modules/');
      if (marker >= 0) return normalized.slice(marker + 'node_modules/'.length);
      const parts = normalized.split('/');
      return parts.slice(-3).join('/');
    }

    function RankFooter({ rank, t }) {
      const source = rank?.source;
      const lines = [h('div', { key: 'note' }, t('hiddenNote'))];
      if (source?.mode === 'source') {
        lines.push(h('div', { key: 'src', className: 'is-mono' }, t('rankSource')(shortSourcePath(source.sourcePath))));
        const fallbackFor = Array.isArray(source.fallbackFor) ? source.fallbackFor : [];
        if (fallbackFor.length > 0) lines.push(h('div', { key: 'fb', className: 'is-warn' }, t('rankFallbackFor')(fallbackFor)));
      } else if (source !== null && source !== undefined) {
        lines.push(
          h('div', { key: 'fb', className: 'is-warn' }, `${t('rankFallback')}${source.reason === null || source.reason === undefined ? '' : ` — ${source.reason}`}`),
        );
        if (source.sourcePath) {
          lines.push(h('div', { key: 'src', className: 'is-mono' }, shortSourcePath(source.sourcePath)));
        }
      }
      return h('div', { className: 'smm-footer' }, lines);
    }

    function SkillTab({ view, t, busy, onToggle, onToggleMany }) {
      const [query, setQuery] = useState('');
      const [expanded, setExpanded] = useState(() => new Set());
      const [dragRange, setDragRange] = useState(null);
      const dragRef = useRef(null);
      const flatRowsRef = useRef([]);
      const toggleManyRef = useRef(onToggleMany);
      toggleManyRef.current = onToggleMany;
      const skills = view.skills ?? [];
      const groups = Array.isArray(view.rank?.groups) ? view.rank.groups : [];
      const enabledCount = skills.filter((row) => row.enabled).length;
      const bySource = useMemo(() => {
        const map = new Map();
        for (const row of skills) {
          const list = map.get(row.source) ?? [];
          list.push(row);
          map.set(row.source, list);
        }
        return map;
      }, [skills]);
      const filtered = useMemo(() => {
        if (query === '') return null;
        const needle = query.toLowerCase();
        const map = new Map();
        for (const [source, rows] of bySource) {
          const hit = rows.filter((row) => row.name.toLowerCase().includes(needle));
          if (hit.length > 0) map.set(source, hit);
        }
        return map;
      }, [bySource, query]);
      const visibleGroups = query === '' ? groups : groups.filter((group) => (filtered?.get(group.source) ?? []).length > 0);
      const toggleGroup = (source) => {
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(source)) next.delete(source);
          else next.add(source);
          return next;
        });
      };
      const allExpanded = visibleGroups.length > 0 && visibleGroups.every((group) => expanded.has(group.source));
      const setAll = (open) => {
        setExpanded(() => new Set(open ? visibleGroups.map((group) => group.source) : []));
      };

      const rowsOf = (group) => (query === '' ? bySource.get(group.source) ?? [] : filtered?.get(group.source) ?? []);
      const isOpen = (group) => query !== '' || expanded.has(group.source);
      /** Rendered rows in screen order: drag selection spans groups, exactly like clicking each box. */
      const flatRows = useMemo(() => {
        const list = [];
        for (const group of visibleGroups) {
          if (!isOpen(group)) continue;
          for (const row of rowsOf(group)) list.push(row);
        }
        return list;
      }, [visibleGroups, query, expanded, bySource, filtered]);
      flatRowsRef.current = flatRows;
      const indexByKey = useMemo(() => {
        const map = new Map();
        flatRows.forEach((row, index) => map.set(`${row.provider}:${row.name}`, index));
        return map;
      }, [flatRows]);
      const range =
        dragRange === null
          ? null
          : [Math.min(dragRange.anchor, dragRange.end), Math.max(dragRange.anchor, dragRange.end)];

      /**
       * A drag toggles every row it touched (`enabled` flips per row), so the
       * release is one request no matter how many boxes were swept.
       */
      useEffect(() => {
        const finish = () => {
          const drag = dragRef.current;
          dragRef.current = null;
          setDragRange(null);
          if (drag === null) return;
          const lo = Math.min(drag.anchor, drag.end);
          const hi = Math.max(drag.anchor, drag.end);
          if (lo === hi && !drag.fromCheckbox) return;
          const changes = flatRowsRef.current
            .slice(lo, hi + 1)
            .map((row) => ({ name: row.name, enabled: !row.enabled }));
          if (changes.length > 0) toggleManyRef.current(changes);
        };
        const cancel = () => {
          dragRef.current = null;
          setDragRange(null);
        };
        /** Index under the pointer — a fast sweep skips rows, the range still fills them in. */
        const track = (event) => {
          if (dragRef.current === null) return;
          if ((event.buttons & 1) === 0) return;
          const element = document.elementFromPoint(event.clientX, event.clientY);
          const row = element?.closest?.('[data-skill-index]');
          if (row === null || row === undefined) return;
          const index = Number(row.getAttribute('data-skill-index'));
          if (!Number.isInteger(index) || index < 0) return;
          const drag = dragRef.current;
          if (drag.end === index) return;
          drag.end = index;
          setDragRange({ anchor: drag.anchor, end: index });
        };
        document.addEventListener('pointermove', track);
        document.addEventListener('pointerup', finish);
        document.addEventListener('pointercancel', cancel);
        return () => {
          document.removeEventListener('pointermove', track);
          document.removeEventListener('pointerup', finish);
          document.removeEventListener('pointercancel', cancel);
        };
      }, []);

      const beginDrag = (event, index) => {
        if (busy || index < 0 || event.button !== 0) return;
        event.preventDefault();
        const fromCheckbox = event.target?.classList?.contains('smm-check') === true;
        dragRef.current = { anchor: index, end: index, fromCheckbox };
        setDragRange({ anchor: index, end: index });
      };
      const setGroupSkills = (source, enabled) => {
        const changes = (bySource.get(source) ?? [])
          .filter((row) => Boolean(row.enabled) !== enabled)
          .map((row) => ({ name: row.name, enabled }));
        if (changes.length > 0) onToggleMany(changes);
      };

      return h(
        'div',
        { className: `smm-skills${dragRange === null ? '' : ' is-dragging'}` },
        h(
          'div',
          { className: 'smm-toolbar' },
          h(
            'span',
            { className: 'smm-count' },
            h('b', null, t('visibleCount')(enabledCount, skills.length)),
            h('span', { className: 'smm-count-hint' }, t('visibleShort')),
          ),
          h('input', {
            className: 'smm-search',
            value: query,
            placeholder: t('search'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'button',
            { className: 'smm-btn', disabled: visibleGroups.length === 0, onClick: () => setAll(!allExpanded) },
            allExpanded ? t('collapseAll') : t('expandAll'),
          ),
        ),
        skills.length === 0
          ? h('div', { className: 'smm-note' }, t('empty'))
          : visibleGroups.length === 0
            ? h('div', { className: 'smm-note' }, t('noMatch'))
            : visibleGroups.map((group) => {
                const rows = rowsOf(group);
                const all = bySource.get(group.source) ?? [];
                const open = isOpen(group);
                const directory = groupDirectory(group, t);
                const pathLike = typeof group.directory === 'string' && group.directory !== '';
                const total = all.length;
                const enabledInGroup = all.filter((row) => row.enabled).length;
                return h(
                  'div',
                  { className: 'smm-group', key: `${group.rank}:${group.source}` },
                  h(
                    'div',
                    { className: 'smm-group-head' },
                    h(
                      'button',
                      {
                        className: 'smm-group-toggle',
                        onClick: () => toggleGroup(group.source),
                        'aria-expanded': open,
                        title: [group.label, pathLike ? group.directory : (group.pattern ?? '')].filter((part) => typeof part === 'string' && part !== '').join(' · '),
                      },
                      h('span', { className: `smm-caret${open ? ' is-open' : ''}` }, '▶'),
                      h('span', { className: 'smm-rank' }, `#${group.rank}`),
                      h('span', { className: `smm-group-dir${pathLike ? ' is-path' : ''}` }, directory === '' ? group.label : directory),
                    ),
                    total === 0
                      ? null
                      : h(
                          'span',
                          { className: 'smm-group-actions' },
                          h(
                            'button',
                            {
                              className: 'smm-mini',
                              disabled: busy || enabledInGroup === total,
                              onClick: () => setGroupSkills(group.source, true),
                            },
                            t('enableAll'),
                          ),
                          h(
                            'button',
                            {
                              className: 'smm-mini',
                              disabled: busy || enabledInGroup === 0,
                              onClick: () => setGroupSkills(group.source, false),
                            },
                            t('disableAll'),
                          ),
                        ),
                    h(
                      'span',
                      { className: 'smm-group-count' },
                      h('b', null, `${rows.filter((row) => row.enabled).length}`),
                      `/${total}`,
                    ),
                  ),
                  open
                    ? h(
                        'div',
                        { className: 'smm-group-body' },
                        rows.length === 0 ? h('div', { className: 'smm-note' }, t('groupEmpty')) : null,
                        rows.map((row) => {
                          const key = `${row.provider}:${row.name}`;
                          const index = indexByKey.get(key) ?? -1;
                          return h(SkillRow, {
                            key,
                            row,
                            t,
                            disabled: busy,
                            onToggle,
                            index,
                            inRange: range !== null && index >= range[0] && index <= range[1],
                            onPointerDown: beginDrag,
                          });
                        }),
                      )
                    : null,
                );
              }),
        h(RankFooter, { rank: view.rank, t }),
      );
    }

    function ServerEditor({ initial, scope, allowScope, sessionId, t, onCancel, onSubmit, busy }) {
      const [form, setForm] = useState(initial ?? blankServer());
      const [scopeChoice, setScopeChoice] = useState(scope === 'global' ? 'global' : 'workspace');
      const [error, setError] = useState('');
      const [testing, setTesting] = useState(false);
      const [probe, setProbe] = useState(null);
      const edited = (next) => {
        setProbe(null);
        return next;
      };
      const patch = (key, value) => setForm((current) => edited({ ...current, [key]: value }));
      const patchArg = (index, value) =>
        setForm((current) => edited({ ...current, args: current.args.map((arg, at) => (at === index ? value : arg)) }));
      const patchPair = (listKey, index, key, value) =>
        setForm((current) =>
          edited({
            ...current,
            [listKey]: current[listKey].map((pair, at) => (at === index ? { ...pair, [key]: value } : pair)),
          }),
        );
      const addArgRow = () => setForm((current) => edited({ ...current, args: [...current.args, ''] }));
      const addPairRow = (listKey) => setForm((current) => edited({ ...current, [listKey]: [...current[listKey], blankRow()] }));
      const removeArg = (index) =>
        setForm((current) => ({ ...current, args: current.args.filter((_, at) => at !== index) }));
      const removePair = (listKey, index) =>
        setForm((current) => ({ ...current, [listKey]: current[listKey].filter((_, at) => at !== index) }));
      const submit = () => {
        if (!validate(form)) {
          setError(t('invalid'));
          return;
        }
        setError('');
        onSubmit(toServer(form), scopeChoice);
      };
      const runTest = () => {
        if (!validate(form)) {
          setError(t('invalid'));
          return;
        }
        setError('');
        setProbe(null);
        setTesting(true);
        post('/mcp', { session: sessionId, action: 'test', server: toServer(form) })
          .then((body) => setProbe({ ok: true, result: body.result }))
          .catch((cause) => setProbe({ ok: false, error: String(cause?.message ?? cause) }))
          .finally(() => setTesting(false));
      };
      const row = (label, node) =>
        h('div', { className: 'smm-field-row' }, h('span', { className: 'smm-label' }, label), node);
      const block = (label, children) =>
        h('div', { className: 'smm-field-block' }, h('span', { className: 'smm-label' }, label), h('div', { className: 'smm-list' }, children));
      const removeButton = (onClick) =>
        h('button', { type: 'button', className: 'smm-remove', onClick, title: t('mcpRemove'), 'aria-label': t('mcpRemove') }, '×');
      const addButton = (label, onClick) => h('button', { type: 'button', className: 'smm-add', onClick }, `+ ${label}`);
      const argsSection = block(
        t('mcpArgs'),
        [
          ...form.args.map((arg, index) =>
            h(
              'div',
              { className: 'smm-list-row', key: `arg-${index}` },
              h('input', {
                className: 'smm-input',
                value: arg,
                placeholder: 'arg',
                onChange: (event) => patchArg(index, event.target.value),
              }),
              removeButton(() => removeArg(index)),
            ),
          ),
          addButton(t('mcpAddRow'), addArgRow),
        ],
      );
      const envSection = block(
        t('mcpEnv'),
        [
          ...form.env.map((pair, index) =>
            h(
              'div',
              { className: 'smm-list-row', key: `env-${index}` },
              h('input', {
                className: 'smm-input smm-key',
                value: pair.key,
                placeholder: 'KEY',
                onChange: (event) => patchPair('env', index, 'key', event.target.value),
              }),
              h('input', {
                className: 'smm-input',
                value: pair.value,
                placeholder: 'value',
                onChange: (event) => patchPair('env', index, 'value', event.target.value),
              }),
              removeButton(() => removePair('env', index)),
            ),
          ),
          addButton(t('mcpAddRow'), () => addPairRow('env')),
        ],
      );
      const headerSection = block(
        t('mcpHeaders'),
        [
          ...form.headers.map((pair, index) =>
            h(
              'div',
              { className: 'smm-list-row', key: `header-${index}` },
              h('input', {
                className: 'smm-input smm-key',
                value: pair.key,
                placeholder: 'KEY',
                onChange: (event) => patchPair('headers', index, 'key', event.target.value),
              }),
              h('input', {
                className: 'smm-input',
                value: pair.value,
                placeholder: 'value',
                onChange: (event) => patchPair('headers', index, 'value', event.target.value),
              }),
              removeButton(() => removePair('headers', index)),
            ),
          ),
          addButton(t('mcpAddRow'), () => addPairRow('headers')),
        ],
      );
      const scopeNote = scopeChoice === 'global' ? t('mcpGlobalScopeNote') : t('mcpWorkspaceScopeNote');
      return h(
        'div',
        { className: 'smm-form' },
        row(
          t('mcpScopeLabel'),
          allowScope === true
            ? h(
                'div',
                { className: 'smm-segment', role: 'radiogroup', 'aria-label': t('mcpScopeLabel') },
                ...[
                  ['workspace', t('mcpScopeWorkspace')],
                  ['global', t('mcpScopeGlobal')],
                ].map(([value, label]) =>
                  h(
                    'button',
                    {
                      key: value,
                      type: 'button',
                      role: 'radio',
                      'aria-checked': scopeChoice === value,
                      className: `smm-segment-item${scopeChoice === value ? ' is-on' : ''}`,
                      onClick: () => setScopeChoice(value),
                    },
                    label,
                  ),
                ),
              )
            : h('span', { className: 'smm-scope-fixed' }, scopeChoice === 'global' ? t('mcpScopeGlobal') : t('mcpScopeWorkspace')),
        ),
        h('div', { className: 'smm-hint' }, scopeNote),
        h('input', {
          className: 'smm-input smm-server-name',
          value: form.serverName,
          placeholder: 'serverName',
          'aria-label': 'serverName',
          onChange: (event) => patch('serverName', event.target.value),
        }),
        row(
          t('mcpType'),
          h(
            'div',
            { className: 'smm-inline-controls' },
            h(
              'select',
              {
                className: 'smm-select',
                value: form.transport,
                onChange: (event) => patch('transport', event.target.value),
              },
              h('option', { value: 'stdio' }, 'stdio'),
              h('option', { value: 'streamable-http' }, 'streamable-http'),
            ),
            h('span', { className: 'smm-inline-label' }, form.transport === 'stdio' ? t('mcpCommandLabel') : t('mcpUrlLabel')),
            form.transport === 'stdio'
              ? h('input', {
                  className: 'smm-input',
                  value: form.command,
                  placeholder: 'npx',
                  onChange: (event) => patch('command', event.target.value),
                })
              : h('input', {
                  className: 'smm-input',
                  value: form.url,
                  placeholder: 'https://example.com/mcp',
                  onChange: (event) => patch('url', event.target.value),
                }),
          ),
        ),
        form.transport === 'stdio' ? argsSection : headerSection,
        form.transport === 'stdio' ? envSection : null,
        row(t('mcpEnabled'), h(Toggle, { checked: form.enabled, label: t('mcpEnabled'), onChange: (checked) => patch('enabled', checked) })),
        probe === null
          ? null
          : probe.ok === true
            ? h(
                'div',
                { className: 'smm-probe is-ok' },
                h(
                  'div',
                  { className: 'smm-probe-line' },
                  `✅ ${t('mcpTestOk')}`,
                  h('span', { className: 'smm-probe-dim' }, ` · ${t('mcpTestTools')(probe.result.tools.length)} · ${t('mcpTestElapsed')(probe.result.elapsedMs)}`),
                  probe.result.server?.name === undefined
                    ? null
                    : h('span', { className: 'smm-probe-dim' }, ` · ${t('mcpTestServer')(probe.result.server.name, probe.result.server.version)}`),
                ),
                h(ToolList, { tools: probe.result.tools, t }),
              )
            : h(
                'div',
                { className: 'smm-probe is-bad' },
                h('div', { className: 'smm-probe-line' }, `❌ ${t('mcpTestFailed')}`),
                h('div', { className: 'smm-probe-err' }, probe.error),
              ),
        error === '' ? null : h('div', { className: 'smm-err' }, error),
        h(
          'div',
          { className: 'smm-form-actions' },
          h('button', { className: 'smm-btn smm-test-btn', onClick: runTest, disabled: busy || testing }, testing ? t('mcpTesting') : t('mcpTest')),
          h('div', { className: 'smm-actions-gap' }),
          h('button', { className: 'smm-btn', onClick: onCancel, disabled: busy }, t('mcpCancel')),
          h('button', { className: 'smm-btn is-primary', onClick: submit, disabled: busy }, t('mcpSave')),
        ),
      );
    }

    function McpTab({ view, sessionId, t, busy, onSaveServer, onToggleServer, onDeleteServer, onReload }) {
      const [editing, setEditing] = useState(null);
      const [probes, setProbes] = useState({});
      const [expandedTools, setExpandedTools] = useState(() => new Set());
      const [probeNonce, setProbeNonce] = useState(0);
      const available = view.mcp?.available !== false;
      const workspaceRows = (view.mcp?.servers ?? []).map((row) => ({ ...row, scope: 'workspace', editable: true }));
      const globalRows = Array.isArray(view.mcp?.global) ? view.mcp.global : [];
      const globalError = view.mcp?.globalError ?? null;
      const rows = [...globalRows, ...workspaceRows];
      const keyOf = (row) => row.key ?? `${row.scope}:${row.id ?? row.serverName}`;
      const serverOf = (row) => (row.scope === 'global' ? row.server : row);
      const selectorOf = (row) => ({ id: row.id ?? null, serverName: row.serverName ?? null });

      // One probe per enabled server, two at a time. The result owns the row's
      // tool count and dot, so the list never shows a stale live-mount count.
      const probeSignature = JSON.stringify(rows.map((row) => [keyOf(row), row.enabled !== false, serverOf(row)]));
      useEffect(() => {
        if (available === false) return undefined;
        let cancelled = false;
        const targets = rows
          .filter((row) => row.enabled !== false)
          .map((row) => ({ key: keyOf(row), server: serverOf(row) }))
          .filter((target) => target.server !== null && target.server !== undefined);
        if (targets.length === 0) return undefined;
        setProbes((current) => {
          const next = {};
          for (const key of Object.keys(current)) if (targets.some((target) => target.key === key)) next[key] = current[key];
          return next;
        });
        const queue = [...targets];
        const worker = async () => {
          while (!cancelled && queue.length > 0) {
            const target = queue.shift();
            setProbes((current) => ({ ...current, [target.key]: { state: 'testing' } }));
            try {
              const body = await post('/mcp', { session: sessionId, action: 'test', server: target.server });
              if (!cancelled) setProbes((current) => ({ ...current, [target.key]: { state: 'ok', ...body.result } }));
            } catch (cause) {
              if (!cancelled) {
                setProbes((current) => ({ ...current, [target.key]: { state: 'failed', error: String(cause?.message ?? cause) } }));
              }
            }
          }
        };
        void Promise.all([worker(), worker()]);
        return () => {
          cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [probeSignature, probeNonce, sessionId, available]);

      const toggleTools = (key) =>
        setExpandedTools((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });

      const probeBadge = (row, key) => {
        const probe = probes[key];
        if (row.enabled === false) return h('span', { className: 'smm-tag' }, t('mcpDisabled'));
        if (probe === undefined || probe.state === 'testing') return h('span', { className: 'smm-tag is-muted' }, t('mcpProbing'));
        if (probe.state === 'failed') {
          return h('span', { className: 'smm-tag is-bad', title: probe.error }, t('mcpProbeFailed'));
        }
        const count = probe.tools?.length ?? 0;
        return h(
          'button',
          {
            type: 'button',
            className: 'smm-tag smm-tag-btn',
            title: t('mcpProbeToggle'),
            onClick: () => toggleTools(key),
          },
          t('mcpTestTools')(count),
          h('span', { className: 'smm-tag-caret' }, expandedTools.has(key) ? '▾' : '▸'),
        );
      };

      const renderRow = (row) => {
        const key = keyOf(row);
        const probe = probes[key];
        const server = serverOf(row);
        const editable = row.editable === true;
        const detail =
          server === null || server === undefined
            ? ''
            : server.transport === 'stdio'
              ? `${server.command ?? ''} ${(server.args ?? []).join(' ')}`.trim()
              : server.url ?? '';
        const toolList =
          expandedTools.has(key) && probe?.state === 'ok'
            ? h(
                'div',
                { className: 'smm-tool-panel' },
                h(
                  'div',
                  { className: 'smm-tool-meta' },
                  t('mcpTestTools')(probe.tools.length),
                  probe.server?.name === undefined ? null : ` · ${t('mcpTestServer')(probe.server.name, probe.server.version)}`,
                  probe.elapsedMs === undefined ? null : ` · ${t('mcpTestElapsed')(probe.elapsedMs)}`,
                ),
                h(ToolList, { tools: probe.tools, t }),
              )
            : null;
        return h(
          'div',
          { className: 'smm-mcp-row', key },
          h('span', {
            className: `smm-dot${probe?.state === 'ok' ? ' is-ready' : probe?.state === 'failed' ? ' is-failed' : probe?.state === 'testing' ? ' is-starting' : ''}`,
            title: t('status')[probe?.state] ?? '',
          }),
          h(
            'div',
            { className: 'smm-main' },
            h(
              'div',
              { className: 'smm-line' },
              h('span', { className: 'smm-name' }, row.serverName ?? row.id ?? ''),
              h('span', { className: 'smm-tag' }, row.transport),
              h('span', { className: 'smm-tag' }, row.scope === 'global' ? t('mcpScopeGlobal') : t('mcpScopeWorkspace')),
              editable ? null : h('span', { className: 'smm-tag is-muted' }, t('mcpReadOnly')),
              probeBadge(row, key),
            ),
            detail === '' ? null : h('div', { className: 'smm-cmd', title: detail }, detail),
            probe?.state === 'failed' ? h('div', { className: 'smm-probe-err' }, probe.error) : null,
            editable
              ? h(
                  'div',
                  { className: 'smm-row-actions' },
                  h(
                    'button',
                    {
                      className: 'smm-btn',
                      disabled: busy,
                      onClick: () =>
                        setEditing({
                          form: fromServer(server ?? blankServer()),
                          scope: row.scope,
                          previous: selectorOf(row),
                          allowScope: false,
                        }),
                    },
                    t('mcpEdit'),
                  ),
                  h(
                    'button',
                    {
                      className: 'smm-btn is-danger',
                      disabled: busy,
                      onClick: () => onDeleteServer(row.scope, selectorOf(row)),
                    },
                    t('mcpDelete'),
                  ),
                )
              : null,
            toolList,
          ),
          editable
            ? h(Toggle, {
                checked: row.enabled !== false,
                label: row.serverName,
                disabled: busy,
                onChange: (checked) => onToggleServer(row.scope, selectorOf(row), checked),
              })
            : null,
        );
      };

      const section = (key, title, hint, list) => {
        if (list.length === 0) return null;
        return h(
          'div',
          { className: 'smm-section-wrap', key },
          h(
            'div',
            { className: 'smm-section' },
            h('span', { className: 'smm-section-title' }, title),
            hint === '' ? null : h('span', { className: 'smm-section-hint', title: hint }, hint),
            h('span', { className: 'smm-section-count' }, String(list.length)),
          ),
          list.map(renderRow),
        );
      };

      const path = view.workspace?.path ?? '';
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'smm-toolbar' },
          h(
            'span',
            { className: 'smm-count' },
            h('b', null, String(rows.length)),
            h('span', { className: 'smm-count-hint' }, t('mcpConfigured')),
          ),
          h(
            'button',
            {
              className: 'smm-btn is-primary',
              disabled: busy || !available,
              onClick: () => setEditing({ form: blankServer(), scope: 'workspace', previous: undefined, allowScope: true }),
            },
            t('mcpAdd'),
          ),
          h(
            'button',
            {
              className: 'smm-btn',
              disabled: busy,
              onClick: () => {
                setProbeNonce((value) => value + 1);
                onReload();
              },
            },
            t('refresh'),
          ),
        ),
        h('div', { className: 'smm-note' }, t('mcpMountNote')),
        available ? null : h('div', { className: 'smm-warn' }, t('mcpUnavailable')),
        globalError === null ? null : h('div', { className: 'smm-err' }, t('mcpGlobalReadError')(globalError)),
        editing === null
          ? null
          : h('div', { className: 'smm-form-wrap' }, h(ServerEditor, {
              initial: editing.form,
              scope: editing.scope,
              allowScope: editing.allowScope === true,
              sessionId,
              t,
              busy,
              onCancel: () => setEditing(null),
              onSubmit: (server, chosenScope) => {
                void Promise.resolve(onSaveServer(chosenScope, server, editing.previous)).then((okay) => {
                  if (okay !== false) setEditing(null);
                });
              },
            })),
        section('global', t('mcpGlobalSection'), t('mcpGlobalHint'), globalRows),
        section('workspace', t('mcpWorkspaceSection'), path, workspaceRows),
      );
    }

    function ManagerPanel({ sessionId, workspacePath, t, onClose }) {
      const [view, setView] = useState(null);
      const [tab, setTab] = useState('skills');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState(false);
      const closeRef = useRefEffect(onClose);

      const load = useCallback(() => {
        setBusy(true);
        return call(`/view?session=${encodeURIComponent(sessionId ?? '')}`)
          .then((body) => {
            setView(body);
            setError('');
          })
          .catch((cause) => setError(String(cause?.message ?? cause)))
          .finally(() => setBusy(false));
      }, [sessionId]);

      useEffect(() => {
        load();
      }, [load]);

      // Escape closes the panel; capture so the host composer never sees it.
      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          closeRef.current();
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
      }, [closeRef]);

      /** One write for a rank group or a drag sweep; the host applies all changes atomically. */
      const toggleSkills = (changes) => {
        if (!Array.isArray(changes) || changes.length === 0) return;
        setBusy(true);
        post('/skills', { session: sessionId, changes })
          .then(() => load())
          .catch((cause) => setError(String(cause?.message ?? cause)))
          .finally(() => setBusy(false));
      };

      const toggleSkill = (row, enabled) => toggleSkills([{ name: row.name, enabled }]);

      /** Notice line for outcomes that leave the panel useful (hot reload / pending apply). */
      const outcome = (body) => {
        if (body?.restartRequired === true) setNotice(t('mcpRestartRequired'));
        else if (body?.applied === false) setNotice(t('mcpApplyPending'));
        else setNotice('');
      };

      const mcpPost = (action, payload) => post('/mcp', { session: sessionId, action, ...payload });

      const saveServer = (scope, server, previous) => {
        setBusy(true);
        setNotice('');
        return mcpPost('save', { scope, server, previous })
          .then((body) => {
            outcome(body);
            return load().then(() => true);
          })
          .catch((cause) => {
            setError(String(cause?.message ?? cause));
            return false;
          })
          .finally(() => setBusy(false));
      };

      const toggleServer = (scope, selector, enabled) => {
        setBusy(true);
        setNotice('');
        return mcpPost('toggle', { scope, ...selector, enabled })
          .then((body) => {
            outcome(body);
            return load();
          })
          .catch((cause) => {
            setError(String(cause?.message ?? cause));
            return undefined;
          })
          .finally(() => setBusy(false));
      };

      const deleteServer = (scope, selector) => {
        setBusy(true);
        setNotice('');
        return mcpPost('delete', { scope, ...selector })
          .then((body) => {
            outcome(body);
            return load();
          })
          .catch((cause) => {
            setError(String(cause?.message ?? cause));
            return undefined;
          })
          .finally(() => setBusy(false));
      };

      const path = view?.workspace?.path ?? workspacePath ?? '';
      return h(
        'div',
        {
          className: 'smm-backdrop',
          role: 'dialog',
          'aria-modal': 'true',
          onClick: (event) => event.target === event.currentTarget && onClose(),
        },
        h(
          'div',
          { className: 'smm-panel', onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'smm-head' },
            h(
              'div',
              { className: 'smm-head-main' },
              h('h2', { className: 'smm-title' }, t('title')),
              h('div', { className: 'smm-path', title: path }, path),
            ),
            h('button', { className: 'smm-x', onClick: onClose, title: t('close'), 'aria-label': t('close') }, '×'),
          ),
          h(
            'div',
            { className: 'smm-tabs' },
            h(
              'button',
              { className: `smm-tab${tab === 'skills' ? ' is-on' : ''}`, onClick: () => setTab('skills') },
              `${t('skillsTab')} ${view === null ? '' : (view.skills ?? []).length}`,
            ),
            h(
              'button',
              { className: `smm-tab${tab === 'mcp' ? ' is-on' : ''}`, onClick: () => setTab('mcp') },
              `${t('mcpTab')} ${view === null ? '' : (view.mcp?.servers ?? []).length + (view.mcp?.global ?? []).length}`,
            ),
          ),
          h(
            'div',
            { className: 'smm-body' },
            view === null ? h('div', { className: 'smm-note' }, t('loading')) : null,
            error === '' ? null : h('div', { className: 'smm-err' }, error),
            notice === '' ? null : h('div', { className: 'smm-warn' }, notice),
            view !== null && path === '' ? h('div', { className: 'smm-warn' }, t('noWorkspace')) : null,
            view !== null && tab === 'skills' ? h(SkillTab, { view, t, busy, onToggle: toggleSkill, onToggleMany: toggleSkills }) : null,
            view !== null && tab === 'mcp'
              ? h(McpTab, {
                  view,
                  sessionId,
                  t,
                  busy,
                  onSaveServer: saveServer,
                  onToggleServer: toggleServer,
                  onDeleteServer: deleteServer,
                  onReload: load,
                })
              : null,
          ),
        ),
      );
    }

    /** Keep an always-fresh callback reference for the Escape listener. */
    function useRefEffect(fn) {
      const ref = useRef(fn);
      useEffect(() => {
        ref.current = fn;
      }, [fn]);
      return ref;
    }

    function EntryIcon(props) {
      const [open, setOpen] = useState(false);
      const t = props.t ?? ((key) => key);
      const label = t('entry');
      const labeled = props.withLabel === true;
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            className: `smm-entry${labeled ? ' is-hero' : ''}`,
            title: label,
            'aria-label': label,
            onClick: () => setOpen(true),
          },
          h(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
            h('path', {
              d: 'M8 1.6l1.4 1.1 1.7-.4.7 1.6 1.6.7-.3 1.8L14.4 8l-1.1 1.4.3 1.8-1.6.7-.7 1.6-1.7-.4L8 14.4l-1.4-1.1-1.7.4-.7-1.6-1.6-.7.3-1.8L1.6 8l1.1-1.4-.3-1.8 1.6-.7.7-1.6 1.7.4L8 1.6z',
              stroke: 'currentColor',
              strokeWidth: 1.2,
              strokeLinejoin: 'round',
            }),
            h('circle', { cx: 8, cy: 8, r: 2.1, stroke: 'currentColor', strokeWidth: 1.2 }),
          ),
          labeled ? h('span', { className: 'smm-entry-label' }, label) : null,
        ),
        open
          ? ReactDOM.createPortal(
              h(ManagerPanel, {
                sessionId: props.sessionId,
                workspacePath: props.workspacePath,
                t,
                onClose: () => setOpen(false),
              }),
              document.body,
            )
          : null,
      );
    }
    // #endregion

    return {
      name: NS,
      inject: ['slots', 'locale', 'sessions', 'workspaces'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'skill-mcp-manager: dictionaries');
        ctx.effect(() => {
          const node = ensureStyles();
          return () => node?.remove();
        }, 'skill-mcp-manager: styles');
        const t = ctx.locale.bind(NS);

        /** session -> owning workspace path, taken from the host's own client services. */
        const workspacePathOf = (sessionId) => {
          try {
            const workspace = ctx.workspaces.list
              .getSnapshot()
              .items.find((candidate) => candidate.sessionIds.includes(sessionId));
            if (workspace !== undefined) return workspace.path;
          } catch {
            /* service not ready */
          }
          try {
            return ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
          } catch {
            return undefined;
          }
        };

        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: `${NS}:entry`,
              order: 40,
              locale: NS,
              inject: (sessionId) => ({
                sessionId,
                workspacePath: workspacePathOf(sessionId),
                t,
              }),
            },
            EntryIcon,
          ),
        );

        // A blank Session hides the header chrome, so the hero composer row gets
        // its own labelled entry: it is the only moment to choose what the first
        // turn may see.
        ctx.slots.inject('conversation.hero.options', () =>
          ctx.slots.register(
            {
              name: 'conversation.hero.options',
              id: `${NS}:hero-entry`,
              order: 40,
              locale: NS,
              inject: (sessionId) => ({
                sessionId,
                workspacePath: workspacePathOf(sessionId),
                t,
                withLabel: true,
              }),
            },
            EntryIcon,
          ),
        );
      },
    };
  },
});
