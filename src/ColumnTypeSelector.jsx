import { useState } from "react";
import { COLUMN_TYPES, getTypeConfig } from "./columnTypes";

/**
 * Inline type picker for a single column.
 * Used inside the column mapping table.
 *
 * Props:
 *   value     – current type id string
 *   onChange  – (typeId) => void
 */
export default function ColumnTypeSelector({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const current = getTypeConfig(value);

  return (
    <div className="col-type-selector" data-open={open}>
      <button
        className="col-type-trigger"
        onClick={() => setOpen((o) => !o)}
        type="button"
        title="Set column type"
      >
        <span className="type-icon">{current.icon}</span>
        <span className="type-label">{current.label}</span>
        <span className="type-caret">›</span>
      </button>

      {open && (
        <>
          <div className="col-type-backdrop" onClick={() => setOpen(false)} />
          <div className="col-type-dropdown">
            {COLUMN_TYPES.map((t) => (
              <button
                key={t.id}
                className={`col-type-option ${value === t.id ? "active" : ""}`}
                onClick={() => {
                  onChange(t.id);
                  setOpen(false);
                }}
                type="button"
              >
                <span className="opt-icon">{t.icon}</span>
                <span className="opt-info">
                  <span className="opt-label">{t.label}</span>
                  <span className="opt-desc">{t.description}</span>
                </span>
                {value === t.id && <span className="opt-check">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}