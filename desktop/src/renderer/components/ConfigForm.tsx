/**
 * Phase 3c: Settings form for marketplace entries that declare a configSchema.
 *
 * Renders fields based on the schema (string, boolean, number, select) and
 * debounces writes to ~/.claude/youcoded-config/<id>.json via IPC. Only
 * shown when the entry is installed AND has a configSchema — Anthropic
 * plugins using their own native config.json are left alone.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { ConfigSchema, ConfigField } from '../../shared/types';

const claude = () => (window as any).claude;

interface ConfigFormProps {
  id: string;
  schema: ConfigSchema;
}

export default function ConfigForm({ id, schema }: ConfigFormProps) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load existing config on mount
  useEffect(() => {
    setLoading(true);
    const api = claude().marketplace;
    if (api?.getConfig) {
      api.getConfig(id)
        .then((config: Record<string, unknown>) => {
          // Apply defaults for fields that aren't set yet
          const merged: Record<string, unknown> = {};
          for (const field of schema.fields) {
            merged[field.name] = config[field.name] ?? field.default ?? getFieldDefault(field);
          }
          setValues(merged);
        })
        .catch(() => {
          // Initialize with defaults
          const defaults: Record<string, unknown> = {};
          for (const field of schema.fields) {
            defaults[field.name] = field.default ?? getFieldDefault(field);
          }
          setValues(defaults);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [id, schema]);

  // Debounced save — 500ms after last change
  const save = useCallback((newValues: Record<string, unknown>) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSaveError(null);
    debounceRef.current = setTimeout(() => {
      const api = claude().marketplace;
      if (api?.setConfig) {
        api.setConfig(id, newValues).catch((err: any) => {
          setSaveError(err?.message || 'Failed to save config');
        });
      }
    }, 500);
  }, [id]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleChange = (fieldName: string, value: unknown) => {
    const next = { ...values, [fieldName]: value };
    setValues(next);
    save(next);
  };

  if (loading) {
    return (
      <div className="py-2">
        <p className="text-[10px] text-fg-faint">Loading config...</p>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-edge-dim pt-3">
      <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">Settings</h4>
      <div className="space-y-3">
        {schema.fields.map(field => (
          <FieldRenderer
            key={field.name}
            field={field}
            value={values[field.name]}
            onChange={(v) => handleChange(field.name, v)}
          />
        ))}
      </div>
      {saveError && (
        <p className="text-[10px] text-red-400 mt-2">{saveError}</p>
      )}
    </div>
  );
}

// ── Field renderer ──────────────────────────────────────────────────────────

function FieldRenderer({
  field,
  value,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  switch (field.type) {
    case 'boolean':
      return (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="w-3.5 h-3.5 rounded border-edge accent-accent"
          />
          <div>
            <span className="text-xs text-fg">{field.label}</span>
            {field.required && <span className="text-red-400 text-[8px] ml-0.5">*</span>}
            {field.description && (
              <p className="text-[10px] text-fg-faint leading-snug">{field.description}</p>
            )}
          </div>
        </label>
      );

    case 'number':
      return (
        <div>
          <label className="text-xs text-fg-muted block mb-1">
            {field.label}
            {field.required && <span className="text-red-400 text-[8px] ml-0.5">*</span>}
          </label>
          {field.description && (
            <p className="text-[10px] text-fg-faint mb-1">{field.description}</p>
          )}
          <input
            type="number"
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => {
              const v = e.target.value;
              onChange(v === '' ? undefined : Number(v));
            }}
            className="w-full px-2 py-1 text-xs bg-well border border-edge-dim rounded-md text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent"
          />
        </div>
      );

    case 'select':
      return (
        <div>
          <label className="text-xs text-fg-muted block mb-1">
            {field.label}
            {field.required && <span className="text-red-400 text-[8px] ml-0.5">*</span>}
          </label>
          {field.description && (
            <p className="text-[10px] text-fg-faint mb-1">{field.description}</p>
          )}
          <select
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-2 py-1 text-xs bg-well border border-edge-dim rounded-md text-fg focus:outline-none focus:border-accent"
          >
            <option value="">Select...</option>
            {(field.options || []).map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      );

    case 'string':
    default:
      return (
        <div>
          <label className="text-xs text-fg-muted block mb-1">
            {field.label}
            {field.required && <span className="text-red-400 text-[8px] ml-0.5">*</span>}
          </label>
          {field.description && (
            <p className="text-[10px] text-fg-faint mb-1">{field.description}</p>
          )}
          <input
            type="text"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-2 py-1 text-xs bg-well border border-edge-dim rounded-md text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent"
          />
        </div>
      );
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Return a sensible default value for a field type when none is specified. */
function getFieldDefault(field: ConfigField): unknown {
  switch (field.type) {
    case 'boolean': return false;
    case 'number': return 0;
    case 'select': return '';
    case 'string':
    default: return '';
  }
}
