import React from 'react';

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

interface Props {
  text: string;
}

/** Renders plain text with URLs auto-linked */
export default function LinkableText({ text }: Props) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    // Text before the URL
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    // The URL as a clickable link
    const url = match[0];
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-link hover:text-link-hover underline break-all"
      >
        {url}
      </a>,
    );
    lastIndex = match.index + url.length;
  }

  // Remaining text after last URL
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  // No URLs found — return plain text
  if (parts.length === 0) return <>{text}</>;

  return <>{parts}</>;
}
