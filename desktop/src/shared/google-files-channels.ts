import type { GoogleAccount, GoogleAuthState, GoogleDriveFile, GoogleEdit, GoogleFilesStatus, GoogleProposal, GoogleReadResult } from './google-files-types';

/** Deliberately excludes attach, OAuth, approval and cloud-write methods from model access. */
export interface GoogleFilesToolAccess {
  accounts(): Promise<GoogleAccount[]>;
  attached(sessionId: string): Promise<GoogleDriveFile[]>;
  read(sessionId: string, accountId: string, fileId: string): Promise<GoogleReadResult>;
  propose(sessionId: string, accountId: string, fileId: string, edits: GoogleEdit[], summary: string, mode?: 'original' | 'copy'): Promise<GoogleProposal>;
  proposeCreate(sessionId: string, accountId: string, kind: 'Doc' | 'Sheet' | 'Slides', name: string, content: string): Promise<GoogleProposal>;
  proposals(sessionId: string): Promise<GoogleProposal[]>;
}

/** One wire contract for the desktop test build. Phone authorization needs a platform-specific callback. */
export interface GoogleFilesChannelTypes {
  'googleFiles:status': { request: void; response: GoogleFilesStatus };
  'googleFiles:auth-start': { request: { accountId?: string }; response: { flowId: string } };
  'googleFiles:auth-state': { request: { flowId: string }; response: GoogleAuthState };
  'googleFiles:auth-cancel': { request: { flowId: string }; response: void };
  'googleFiles:files': { request: { accountId: string }; response: GoogleDriveFile[] };
  'googleFiles:attach': { request: { sessionId: string; accountId: string; fileIds: string[] }; response: GoogleDriveFile[] };
  'googleFiles:attached': { request: { sessionId: string }; response: GoogleDriveFile[] };
  'googleFiles:detach': { request: { sessionId: string; accountId: string; fileId: string }; response: void };
  'googleFiles:disconnect': { request: { accountId: string }; response: void };
  'googleFiles:read': { request: { sessionId: string; accountId: string; fileId: string }; response: GoogleReadResult };
  'googleFiles:proposals': { request: { sessionId: string }; response: GoogleProposal[] };
  'googleFiles:approve': { request: { sessionId: string; proposalId: string; mode?: 'original' | 'copy' }; response: GoogleDriveFile };
  'googleFiles:reject': { request: { sessionId: string; proposalId: string }; response: void };
}

export interface GoogleFilesBridge {
  status(): Promise<GoogleFilesStatus>;
  beginAuth(accountId?: string): Promise<{ flowId: string }>;
  authState(flowId: string): Promise<GoogleAuthState>;
  cancelAuth(flowId: string): Promise<void>;
  files(accountId: string): Promise<GoogleDriveFile[]>;
  attach(sessionId: string, accountId: string, fileIds: string[]): Promise<GoogleDriveFile[]>;
  attached(sessionId: string): Promise<GoogleDriveFile[]>;
  detach(sessionId: string, accountId: string, fileId: string): Promise<void>;
  disconnect(accountId: string): Promise<void>;
  read(sessionId: string, accountId: string, fileId: string): Promise<GoogleReadResult>;
  proposals(sessionId: string): Promise<GoogleProposal[]>;
  approve(sessionId: string, proposalId: string, mode?: 'original' | 'copy'): Promise<GoogleDriveFile>;
  reject(sessionId: string, proposalId: string): Promise<void>;
}
