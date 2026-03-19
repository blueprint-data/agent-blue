import type { ReactElement } from "react";

export function MappingEditor({
  label,
  idValue,
  tenantValue,
  onIdChange,
  onTenantChange,
  onSave
}: {
  label: string;
  idValue: string;
  tenantValue: string;
  onIdChange: (value: string) => void;
  onTenantChange: (value: string) => void;
  onSave: () => void;
}): ReactElement {
  return (
    <div className="filters-row">
      <input placeholder={`${label} ID`} value={idValue} onChange={(event) => onIdChange(event.target.value)} />
      <input placeholder="Tenant ID" value={tenantValue} onChange={(event) => onTenantChange(event.target.value)} />
      <button className="secondary-button" onClick={onSave}>
        Save {label.toLowerCase()}
      </button>
    </div>
  );
}

export function MappingTable({
  title,
  items,
  onDelete
}: {
  title: string;
  items: Array<{ id: string; tenantId: string; meta?: string }>;
  onDelete: (id: string) => void;
}): ReactElement {
  return (
    <div className="stack">
      <div className="subsection-title">{title}</div>
      {items.length === 0 ? (
        <div className="empty-state">No mappings yet.</div>
      ) : (
        items.map((item) => (
          <div key={item.id} className="list-row">
            <div>
              <strong>{item.id}</strong>
              <div className="muted">
                {item.tenantId}
                {item.meta ? ` · ${item.meta}` : ""}
              </div>
            </div>
            <button className="danger-button small" onClick={() => onDelete(item.id)}>
              Delete
            </button>
          </div>
        ))
      )}
    </div>
  );
}
