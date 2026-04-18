import { useEffect, useRef } from 'react';

// Discriminated union for IPC calls that can fail with a structured error.
// Using a local type (not imported from main) keeps the renderer/main boundary
// clean — consistent with how remote-shim.ts duplicates types rather than
// importing across the Node/browser boundary.
type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };

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
        openSound: () => Promise<string | null>;
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
      // Fix: marketplace auth — start/poll return typed ApiResult discriminated unions;
      // the rest return plain values (not wrapped). Keep these types local — do NOT
      // import from main; the renderer/main boundary must stay clean.
      marketplaceAuth: {
        start: () => Promise<ApiResult<{
          device_code: string;
          user_code: string;
          auth_url: string;
          expires_in: number;
        }>>;
        poll: (deviceCode: string) => Promise<ApiResult<
          | { status: "pending" }
          | { status: "complete"; token: string }
        >>;
        signedIn: () => Promise<boolean>;
        user: () => Promise<import('../../main/marketplace-auth-store').MarketplaceUser | null>;
        signOut: () => Promise<void>;
      };
      // Fix: expose marketplaceApi on Window.claude so Tasks 9-12 can call install,
      // rate, deleteRating, likeTheme, and report without (window as any) casts.
      // Shape mirrors preload.ts — all methods return ApiResult<T> so callers can
      // distinguish 403 install-gate errors from generic failures.
      marketplaceApi: {
        install(pluginId: string): Promise<ApiResult<void>>;
        rate(input: {
          plugin_id: string;
          stars: 1 | 2 | 3 | 4 | 5;
          review_text?: string;
        }): Promise<ApiResult<{ hidden: boolean }>>;
        deleteRating(pluginId: string): Promise<ApiResult<void>>;
        likeTheme(themeId: string): Promise<ApiResult<{ liked: boolean }>>;
        report(input: {
          rating_user_id: string;
          rating_plugin_id: string;
          reason?: string;
        }): Promise<ApiResult<void>>;
      };
      buddy: import('../../shared/types').BuddyApi;
      attention: import('../../shared/types').AttentionApi;
      // Multi-window detach / window directory APIs.
      // Shape mirrors preload.ts detach block; typed loosely here so the buddy
      // components can call them without importing from main across the boundary.
      detach: {
        getDirectory: () => Promise<import('../../shared/types').WindowDirectory>;
        onDirectoryUpdated: (cb: (dir: import('../../shared/types').WindowDirectory) => void) => () => void;
        requestTranscriptReplay: (sessionId: string) => void;
      };
      // App-level defaults (skipPermissions, model, projectFolder).
      defaults: {
        get: () => Promise<{ skipPermissions: boolean; model: string; projectFolder: string }>;
        set: (updates: Partial<{ skipPermissions: boolean; model: string; projectFolder: string }>) => Promise<any>;
      };
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
