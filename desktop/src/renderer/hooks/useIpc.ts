import { useEffect, useRef } from 'react';

// Type declaration for the preload API
declare global {
  interface Window {
    claude: {
      session: {
        create: (opts: { name: string; cwd: string; skipPermissions: boolean; cols?: number; rows?: number }) => Promise<any>;
        destroy: (sessionId: string) => Promise<boolean>;
        list: () => Promise<any[]>;
        sendInput: (sessionId: string, text: string) => void;
        resize: (sessionId: string, cols: number, rows: number) => void;
        signalReady: (sessionId: string) => void;
        respondToPermission: (requestId: string, decision: object) => Promise<boolean>;
        browse: () => Promise<any[]>;
        loadHistory: (sessionId: string, projectSlug: string, count?: number, all?: boolean) => Promise<any>;
      };
      skills: {
        list: () => Promise<import('../../shared/types').SkillEntry[]>;
        listMarketplace: (filters?: import('../../shared/types').SkillFilters) => Promise<import('../../shared/types').SkillEntry[]>;
        getDetail: (id: string) => Promise<import('../../shared/types').SkillDetailView>;
        search: (query: string) => Promise<import('../../shared/types').SkillEntry[]>;
        install: (id: string) => Promise<void>;
        uninstall: (id: string) => Promise<void>;
        getFavorites: () => Promise<string[]>;
        setFavorite: (id: string, favorited: boolean) => Promise<void>;
        getChips: () => Promise<import('../../shared/types').ChipConfig[]>;
        setChips: (chips: import('../../shared/types').ChipConfig[]) => Promise<void>;
        getOverride: (id: string) => Promise<import('../../shared/types').MetadataOverride | null>;
        setOverride: (id: string, override: import('../../shared/types').MetadataOverride) => Promise<void>;
        createPrompt: (skill: any) => Promise<import('../../shared/types').SkillEntry>;
        deletePrompt: (id: string) => Promise<void>;
        publish: (id: string) => Promise<{ prUrl: string }>;
        getShareLink: (id: string) => Promise<string>;
        importFromLink: (encoded: string) => Promise<import('../../shared/types').SkillEntry>;
        getCuratedDefaults: () => Promise<string[]>;
      };
      on: {
        sessionCreated: (cb: (info: any) => void) => (...args: any[]) => void;
        sessionDestroyed: (cb: (id: string) => void) => (...args: any[]) => void;
        ptyOutput: (cb: (sessionId: string, data: string) => void) => (...args: any[]) => void;
        hookEvent: (cb: (event: any) => void) => (...args: any[]) => void;
        statusData: (cb: (data: any) => void) => (...args: any[]) => void;
        sessionRenamed: (cb: (sessionId: string, name: string) => void) => (...args: any[]) => void;
        uiAction: (cb: (action: any) => void) => () => void;
        transcriptEvent: (cb: (event: any) => void) => () => void;
      };
      dialog: {
        openFile: () => Promise<string[]>;
        openFolder: () => Promise<string | null>;
        readTranscriptMeta: (path: string) => Promise<{ model: string; contextPercent: number } | null>;
        saveClipboardImage: () => Promise<string | null>;
      };
      shell: {
        openChangelog: () => Promise<void>;
        openExternal: (url: string) => Promise<void>;
      };
      remote: {
        getConfig: () => Promise<any>;
        setPassword: (pw: string) => Promise<void>;
        setConfig: (config: any) => Promise<void>;
        detectTailscale: () => Promise<any>;
        getClientCount: () => Promise<number>;
        getClientList: () => Promise<any[]>;
        disconnectClient: (id: string) => Promise<void>;
        broadcastAction: (action: any) => void;
      };
      off: (channel: string, handler: (...args: any[]) => void) => void;
      removeAllListeners: (channel: string) => void;
      getGitHubAuth: () => Promise<{ username: string } | null>;
      getHomePath: () => Promise<string>;
      getFavorites: () => Promise<any>;
      setFavorites: (favorites: any) => Promise<void>;
    };
  }
}

export function usePtyOutput(
  sessionId: string | null,
  onData: (data: string) => void,
) {
  const cbRef = useRef(onData);
  cbRef.current = onData;

  useEffect(() => {
    if (!sessionId) return;

    // Use per-session channel if available (avoids N+1 callback amplification)
    const claude = window.claude as any;
    if (claude?.on?.ptyOutputForSession) {
      return claude.on.ptyOutputForSession(sessionId, (data: string) => cbRef.current(data));
    }

    // Fallback: global channel with client-side filter
    const handler = window.claude.on.ptyOutput((sid, data) => {
      if (sid === sessionId) {
        cbRef.current(data);
      }
    });

    return () => {
      window.claude.off('pty:output', handler);
    };
  }, [sessionId]);
}
