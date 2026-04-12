import React, { useState, useEffect, useRef, useCallback } from 'react';

interface SavedFolder {
  path: string;
  nickname: string;
  addedAt: number;
  exists: boolean;
}

interface Props {
  /** Currently selected folder path */
  value: string;
  /** Called when user selects a folder */
  onChange: (path: string) => void;
  /** Auto-select the first saved folder when value is empty (default: true) */
  autoSelect?: boolean;
}

export default function FolderSwitcher({ value, onChange, autoSelect = true }: Props) {
  const [folders, setFolders] = useState<SavedFolder[]>([]);
  const [open, setOpen] = useState(false);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editNickname, setEditNickname] = useState('');
  const editRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await (window as any).claude.folders.list();
      setFolders(list);
      // Auto-select the first folder (home) when no value is set
      if (autoSelect && !value && list.length > 0) {
        onChange(list[0].path);
      }
    } catch {}
  }, [value, onChange]);

  useEffect(() => { load(); }, [load]);

  // Close panel on outside click/tap
  useEffect(() => {
    if (!open) return;
    const handler = (e: Event) => {
      if (wrapperRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      setEditingPath(null);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [open]);

  // Focus nickname input when editing starts
  useEffect(() => {
    if (editingPath && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingPath]);

  const handleBrowseAndAdd = useCallback(async () => {
    try {
      const folder = await (window as any).claude.dialog.openFolder();
      if (!folder) return;
      await (window as any).claude.folders.add(folder);
      await load();
      onChange(folder);
    } catch {}
  }, [onChange, load]);

  const handleSelect = useCallback((path: string) => {
    onChange(path);
    setOpen(false);
    setEditingPath(null);
  }, [onChange]);

  const handleRemove = useCallback(async (e: React.MouseEvent, folderPath: string) => {
    e.stopPropagation();
    await (window as any).claude.folders.remove(folderPath);
    await load();
    // If we just removed the selected folder, clear selection
    if (value === folderPath) onChange('');
  }, [value, onChange, load]);

  const handleStartRename = useCallback((e: React.MouseEvent, folder: SavedFolder) => {
    e.stopPropagation();
    setEditingPath(folder.path);
    setEditNickname(folder.nickname);
  }, []);

  const handleFinishRename = useCallback(async () => {
    if (!editingPath || !editNickname.trim()) {
      setEditingPath(null);
      return;
    }
    await (window as any).claude.folders.rename(editingPath, editNickname.trim());
    await load();
    setEditingPath(null);
  }, [editingPath, editNickname, load]);

  // Find nickname for current value
  const currentFolder = folders.find(f => f.path === value);
  const displayLabel = currentFolder
    ? currentFolder.nickname
    : value
      ? value.replace(/\\/g, '/').split('/').pop() || value
      : 'Select folder...';

  return (
    <div ref={wrapperRef} className="relative">
      {/* Trigger button — shows current selection */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left px-2.5 py-1.5 bg-inset border border-edge rounded-md text-xs text-fg-2 hover:border-edge transition-colors truncate flex items-center gap-1.5"
      >
        <svg className="w-3 h-3 shrink-0 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <span className="flex-1 truncate">{displayLabel}</span>
        <svg className={`w-3 h-3 shrink-0 text-fg-faint transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Full path hint below trigger */}
      {value && (
        <div className="mt-0.5 px-1 text-[10px] text-fg-faint truncate" title={value}>
          {value}
        </div>
      )}

      {/* Dropdown panel — uses .layer-surface for theme-driven background,
          border, shadow, and glassmorphism (blur when [data-panels-blur]). */}
      {open && (
        <div
          className="layer-surface absolute top-full mt-1 left-1/2 w-72 overflow-hidden"
          style={{ transform: 'translateX(-50%)', zIndex: 50, animation: 'dropdown-in 120ms cubic-bezier(0.16, 1, 0.3, 1) both' }}
        >
          {/* Saved folders list */}
          {folders.length > 0 && (
            <div className="max-h-48 overflow-y-auto py-1">
              {folders.map((f) => {
                const isSelected = f.path === value;
                const isEditing = editingPath === f.path;

                return (
                  <div
                    key={f.path}
                    onClick={() => !isEditing && handleSelect(f.path)}
                    className={`group/folder flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-accent/10 text-fg'
                        : f.exists
                          ? 'text-fg-2 hover:bg-inset hover:text-fg'
                          : 'text-fg-faint hover:bg-inset'
                    }`}
                  >
                    {/* Folder icon */}
                    <svg className={`w-3 h-3 shrink-0 ${f.exists ? 'text-fg-muted' : 'text-[#DD4444]/60'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>

                    {/* Nickname (editable) or display */}
                    <div className="flex-1 min-w-0">
                      {isEditing ? (
                        <input
                          ref={editRef}
                          value={editNickname}
                          onChange={(e) => setEditNickname(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleFinishRename();
                            if (e.key === 'Escape') setEditingPath(null);
                          }}
                          onBlur={handleFinishRename}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full bg-inset border border-edge rounded-sm px-1 py-0.5 text-xs text-fg outline-none focus:border-accent"
                        />
                      ) : (
                        <>
                          <div className="text-xs truncate">{f.nickname}</div>
                          <div className="text-[10px] text-fg-faint truncate" title={f.path}>
                            {f.path}
                          </div>
                        </>
                      )}
                    </div>

                    {/* Stale warning */}
                    {!f.exists && !isEditing && (
                      <span className="text-[9px] text-[#DD4444]/80 shrink-0" title="Directory not found">
                        missing
                      </span>
                    )}

                    {/* Action buttons — visible on hover */}
                    {!isEditing && (
                      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover/folder:opacity-100 transition-opacity">
                        {/* Rename */}
                        <button
                          onClick={(e) => handleStartRename(e, f)}
                          className="w-5 h-5 flex items-center justify-center rounded-sm text-fg-faint hover:text-fg hover:bg-inset transition-colors"
                          title="Rename"
                        >
                          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </button>
                        {/* Remove */}
                        <button
                          onClick={(e) => handleRemove(e, f.path)}
                          className="w-5 h-5 flex items-center justify-center rounded-sm text-fg-faint hover:text-[#DD4444] hover:bg-inset transition-colors"
                          title="Remove from list"
                        >
                          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    )}

                    {/* Selected check */}
                    {isSelected && !isEditing && (
                      <svg className="w-3 h-3 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Add new folder button */}
          <div className="border-t border-edge">
            <button
              onClick={handleBrowseAndAdd}
              className="w-full px-2.5 py-2 text-xs text-fg-dim hover:bg-inset hover:text-fg transition-colors flex items-center justify-center gap-1.5"
            >
              <span className="text-sm leading-none">+</span>
              <span>Browse for folder</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
