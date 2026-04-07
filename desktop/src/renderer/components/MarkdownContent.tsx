import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

// Stable plugin arrays — avoids re-creating on every render
const remarkPluginsStable = [remarkGfm];
const rehypePluginsStable = [rehypeHighlight];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="absolute top-2 right-2 px-2 py-1 text-xs rounded-sm bg-inset text-fg-2 hover:bg-edge transition-colors opacity-0 group-hover:opacity-100"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

// Stable component overrides — defined at module scope so ReactMarkdown
// receives the same object reference on every render, preventing unnecessary
// reconciliation of the entire markdown tree.
const mdComponents = {
  h1({ children, ...props }: any) {
    return <h1 className="text-xl font-bold mt-6 mb-3 pb-1.5 text-fg border-b border-edge" {...props}>{children}</h1>;
  },
  h2({ children, ...props }: any) {
    return <h2 className="text-lg font-bold mt-6 mb-3 pb-1 text-fg border-b border-edge" {...props}>{children}</h2>;
  },
  h3({ children, ...props }: any) {
    return <h3 className="text-base font-bold mt-5 mb-2 text-fg" {...props}>{children}</h3>;
  },
  h4({ children, ...props }: any) {
    return <h4 className="text-sm font-bold mt-4 mb-1.5 text-fg" {...props}>{children}</h4>;
  },
  p({ children, ...props }: any) {
    return <p className="mb-3 last:mb-0 leading-relaxed" {...props}>{children}</p>;
  },
  ol({ children, ...props }: any) {
    return <ol className="list-decimal pl-6 mb-3 space-y-1.5" {...props}>{children}</ol>;
  },
  ul({ children, ...props }: any) {
    return <ul className="list-disc pl-6 mb-3 space-y-1.5" {...props}>{children}</ul>;
  },
  li({ children, ...props }: any) {
    return <li className="leading-relaxed" {...props}>{children}</li>;
  },
  hr({ ...props }: any) {
    return <hr className="border-edge my-5" {...props} />;
  },
  blockquote({ children, ...props }: any) {
    return (
      <blockquote className="border-l-2 border-edge pl-3 my-3 text-fg-dim italic" {...props}>
        {children}
      </blockquote>
    );
  },
  strong({ children, ...props }: any) {
    return <strong className="font-bold text-fg" {...props}>{children}</strong>;
  },
  em({ children, ...props }: any) {
    return <em className="italic text-fg-2" {...props}>{children}</em>;
  },
  pre({ children, ...props }: any) {
    let codeText = '';
    React.Children.forEach(children, (child) => {
      if (React.isValidElement(child) && child.props) {
        const c = child as React.ReactElement<{ children?: React.ReactNode }>;
        if (typeof c.props.children === 'string') {
          codeText = c.props.children;
        }
      }
    });
    return (
      <div className="relative group my-3">
        <pre className="rounded-md bg-canvas border border-edge p-3 overflow-x-auto text-sm" {...props}>
          {children}
        </pre>
        {codeText && <CopyButton text={codeText} />}
      </div>
    );
  },
  code({ className, children, ...props }: any) {
    const isInline = !className;
    if (isInline) {
      return (
        <code className="text-sm text-code" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  a({ href, children, ...props }: any) {
    const isSafeHref = href && /^(https?:|mailto:)/.test(href);
    if (!isSafeHref) {
      return <span className="text-link">{children}</span>;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-link hover:text-link-hover underline"
        {...props}
      >
        {children}
      </a>
    );
  },
  table({ children, ...props }: any) {
    return (
      <div className="overflow-x-auto my-3">
        <table className="border-collapse border border-edge text-sm w-full" {...props}>
          {children}
        </table>
      </div>
    );
  },
  th({ children, ...props }: any) {
    return (
      <th className="border border-edge px-3 py-2 bg-panel text-left font-bold text-fg" {...props}>
        {children}
      </th>
    );
  },
  td({ children, ...props }: any) {
    return (
      <td className="border border-edge px-3 py-2" {...props}>
        {children}
      </td>
    );
  },
};

interface Props {
  content: string;
}

export default React.memo(function MarkdownContent({ content }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPluginsStable}
      rehypePlugins={rehypePluginsStable}
      components={mdComponents}
    >
      {content}
    </ReactMarkdown>
  );
});
