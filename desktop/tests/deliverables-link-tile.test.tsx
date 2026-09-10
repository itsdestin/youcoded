// @vitest-environment jsdom
// Pins the SendUserLink tile in the Deliverables card (spec 2026-09-02,
// slice A): a link tile renders for a SendUserLink call, clicks open via
// shell.openExternal (never the artifact viewer — a URL has no artifact to
// preview), and a visually-distinct label/url is shown. The model never
// triggers navigation itself: only the user's click opens.
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ToolCallState } from '../src/shared/types';

vi.mock('../src/renderer/components/ArtifactThumbnail', () => ({
  ArtifactThumbnail: () => <div data-testid="thumb" />,
}));

import { DeliverablesCard, sentLinks, isSentLinksTool } from '../src/renderer/components/DeliverablesCard';
import { CLAUDE_CODE_LINK_TOOL } from '../src/shared/send-user-link';

function setViewport(narrow = false) {
  (window as any).matchMedia = (query: string) => ({
    matches: narrow, media: query, addEventListener: () => {}, removeEventListener: () => {},
  });
}
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const linkCall = (id: string, links: Array<{ url: string; label?: string }>, extra: Partial<ToolCallState> = {}): ToolCallState => ({
  toolUseId: id, toolName: 'SendUserLink', input: { links, status: 'normal' }, status: 'complete', ...extra,
});

beforeEach(() => setViewport(false));
afterEach(cleanup);

describe('sentLinks parsing', () => {
  it('parses {url, label?} objects and bare strings tolerantly', () => {
    expect(sentLinks({ links: [{ url: 'https://a.com', label: 'A' }, 'https://b.com', { url: '', label: 'x' }, { nonsense: true }] }))
      .toEqual([{ url: 'https://a.com', label: 'A' }, { url: 'https://b.com' }]);
  });
  it('returns [] for a non-array', () => {
    expect(sentLinks({ links: 'https://a.com' })).toEqual([]);
    expect(sentLinks({})).toEqual([]);
  });
  it('isSentLinksTool matches the native tool AND the Claude Code MCP tool', () => {
    expect(isSentLinksTool({ toolName: 'SendUserLink', toolUseId: 'x', input: {}, status: 'complete' })).toBe(true);
    expect(isSentLinksTool({ toolName: CLAUDE_CODE_LINK_TOOL, toolUseId: 'x', input: {}, status: 'complete' })).toBe(true);
    expect(isSentLinksTool({ toolName: 'SendUserFile', toolUseId: 'x', input: {}, status: 'complete' })).toBe(false);
    expect(isSentLinksTool(undefined)).toBe(false);
  });

  it('matches EXACTLY — another MCP server cannot squat the link tile', () => {
    // Any marketplace server could name a tool SendUserLink; a wildcard match
    // would let it draw official-looking, one-click-to-the-browser tiles.
    expect(isSentLinksTool({ toolName: 'mcp__somebody-else__SendUserLink', toolUseId: 'x', input: {}, status: 'complete' })).toBe(false);
    expect(isSentLinksTool({ toolName: 'mcp__youcoded__SendUserFile', toolUseId: 'x', input: {}, status: 'complete' })).toBe(false);
  });
});

describe('DeliverablesCard with SendUserLink', () => {
  it('renders one link tile per link, with the label and the URL', () => {
    render(<DeliverablesCard tools={[linkCall('t1', [{ url: 'https://example.com', label: 'The Site' }])]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables'));
    const tiles = screen.getAllByTestId('sent-link-tile');
    expect(tiles).toHaveLength(1);
    expect(screen.getByText('The Site')).toBeInTheDocument();
    expect(screen.getByText('https://example.com')).toBeInTheDocument();
  });

  it('with no label, shows the host over the path — never the same URL twice', () => {
    render(<DeliverablesCard tools={[linkCall('t1', [{ url: 'https://example.com/docs/page?x=1' }])]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables'));
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText('/docs/page?x=1')).toBeInTheDocument();
    expect(screen.queryByText('https://example.com/docs/page?x=1')).toBeNull();
  });

  it('with no label and no path, shows ONE clean line', () => {
    render(<DeliverablesCard tools={[linkCall('t1', [{ url: 'http://localhost:5173' }])]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables'));
    expect(screen.getByText('localhost:5173')).toBeInTheDocument();
    expect(screen.queryByText('http://localhost:5173')).toBeNull();
    // The full URL still rides the tooltip, so nothing is actually hidden.
    expect(screen.getByTestId('sent-link-tile')).toHaveAttribute('data-hint', 'Open http://localhost:5173');
  });

  it('a Claude Code MCP link call draws the same tile and opens the same way', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    (window as any).claude = { shell: { openExternal } };
    const mcpCall: ToolCallState = {
      toolUseId: 'm1', toolName: CLAUDE_CODE_LINK_TOOL,
      input: { links: [{ url: 'https://example.com', label: 'The Site' }] }, status: 'complete',
    };
    render(<DeliverablesCard tools={[mcpCall]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables'));
    expect(screen.getByText('The Site')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sent-link-tile'));
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('clicking a link tile calls shell.openExternal with the URL', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    (window as any).claude = { shell: { openExternal } };
    render(<DeliverablesCard tools={[linkCall('t1', [{ url: 'http://localhost:5173' }])]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables'));
    fireEvent.click(screen.getByTestId('sent-link-tile'));
    expect(openExternal).toHaveBeenCalledWith('http://localhost:5173');
  });

  it('a FAILED link tile does not open on click and shows Couldn’t send + the tool error', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    (window as any).claude = { shell: { openExternal } };
    const err = 'SendUserLink failed — nothing was sent:\n- not a url: Invalid URL';
    render(<DeliverablesCard tools={[linkCall('t1', [{ url: 'https://example.com' }], { status: 'failed', error: err })]} sessionId="s" />);
    // Failed call seeds the card open.
    expect(screen.getByText('Couldn’t send')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sent-link-tile'));
    expect(openExternal).not.toHaveBeenCalled();
    expect(screen.getByText(/Invalid URL/)).toBeInTheDocument();
  });

  it('keeps CALL order across kinds — a link sent first is drawn first', () => {
    const fileCall: ToolCallState = {
      toolUseId: 'f1', toolName: 'SendUserFile', input: { files: ['/p/a.md'] }, status: 'complete',
    };
    render(<DeliverablesCard tools={[linkCall('l1', [{ url: 'https://a.com' }]), fileCall]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables'));
    const kinds = Array.from(screen.getByTestId('deliverables-strip').querySelectorAll('[data-testid$="-tile"]'))
      .map((el) => el.getAttribute('data-testid'));
    expect(kinds).toEqual(['sent-link-tile', 'sent-file-tile']);
  });

  it('draws a tile per link even when the same URL is sent twice in one call', () => {
    // Two identical React keys silently drop one tile.
    render(<DeliverablesCard tools={[linkCall('t1', [{ url: 'https://a.com' }, { url: 'https://a.com' }])]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables'));
    expect(screen.getAllByTestId('sent-link-tile')).toHaveLength(2);
  });

  it('merges file and link calls into one card, one strip', () => {
    const fileCall: ToolCallState = {
      toolUseId: 't1', toolName: 'SendUserFile', input: { files: ['/p/a.md'] }, status: 'complete',
    };
    render(<DeliverablesCard tools={[fileCall, linkCall('t2', [{ url: 'https://a.com' }])]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables'));
    expect(screen.getAllByTestId('sent-file-tile')).toHaveLength(1);
    expect(screen.getAllByTestId('sent-link-tile')).toHaveLength(1);
  });

  it('a SendUserLink-only card still mounts CLOSED, and its header count is the link count', () => {
    render(<DeliverablesCard tools={[linkCall('t1', [{ url: 'https://a.com' }, { url: 'https://b.com' }])]} sessionId="s" />);
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
    fireEvent.click(screen.getByText('Deliverables'));
    expect(screen.getAllByTestId('sent-link-tile')).toHaveLength(2);
  });
});