// Column type catalogue, kept separate from ColumnTypeSelector so that file
// only exports its component — a module mixing components with other exports
// opts out of React Fast Refresh, forcing a full reload on every edit.

export const COLUMN_TYPES = [
  {
    id: "name",
    label: "Name",
    icon: "Aa",
    description: "Primary identifier, not sortable or filterable",
    sortable: false,
    filterable: false,
  },
  {
    id: "text",
    label: "Text",
    icon: "T",
    description: "Filterable by keyword",
    sortable: false,
    filterable: true,
  },
  {
    id: "number",
    label: "Number",
    icon: "#",
    description: "Sortable and filterable by range",
    sortable: true,
    filterable: true,
  },
  {
    id: "date",
    label: "Date",
    icon: "▦",
    description: "Sortable and filterable by range",
    sortable: true,
    filterable: true,
  },
  {
    id: "datetime",
    label: "Date & Time",
    icon: "⊙",
    description: "Sortable and filterable by range",
    sortable: true,
    filterable: true,
  },
  {
    id: "boolean",
    label: "Boolean",
    icon: "◑",
    description: "Filterable as yes/no",
    sortable: false,
    filterable: true,
  },
  {
    id: "status",
    label: "Status",
    icon: "●",
    description: "Filterable by option",
    sortable: false,
    filterable: true,
  },
];

// Falls back to COLUMN_TYPES[1] ('text'), the safe default for an unknown id.
export function getTypeConfig(typeId) {
  return COLUMN_TYPES.find((t) => t.id === typeId) || COLUMN_TYPES[1];
}
