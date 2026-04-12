import React from 'react';
import type { SystemMarker as SystemMarkerData } from '../state/chat-types';

// Thin horizontal divider used for /clear and /compact markers. Permanent —
// user sees "these messages end here" when scrolling back. Deliberately quiet
// styling so it doesn't compete with actual conversation content.

interface Props {
  marker: SystemMarkerData;
}

export default function SystemMarker({ marker }: Props) {
  const time = new Date(marker.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <div className="flex items-center gap-3 px-6 py-2 text-fg-muted">
      <div className="flex-1 h-px bg-edge-dim" />
      <span className="text-[11px] uppercase tracking-wider whitespace-nowrap">
        {marker.label}
        <span className="ml-2 text-fg-faint normal-case tracking-normal">· {time}</span>
      </span>
      <div className="flex-1 h-px bg-edge-dim" />
    </div>
  );
}
