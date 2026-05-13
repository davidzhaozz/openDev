import { useState, memo } from 'react';

type Props = { data: unknown; defaultDepth?: number };

export function JsonTree({ data, defaultDepth = 2 }: Props) {
  return (
    <div className="json-tree">
      <JsonNode k={null} v={data} depth={0} defaultDepth={defaultDepth} />
    </div>
  );
}

const JsonNode = memo(function JsonNode({
  k, v, depth, defaultDepth
}: { k: string | number | null; v: unknown; depth: number; defaultDepth: number }) {
  const [open, setOpen] = useState(depth < defaultDepth);

  const indent: React.CSSProperties = { paddingLeft: depth * 14 };

  if (v === null || v === undefined) {
    return <div className="json-row" style={indent}><Key k={k} />{' '}<span className="json-null">null</span></div>;
  }
  if (typeof v === 'string') {
    return <div className="json-row" style={indent}><Key k={k} />{' '}<span className="json-str">{JSON.stringify(v)}</span></div>;
  }
  if (typeof v === 'number' || typeof v === 'bigint') {
    return <div className="json-row" style={indent}><Key k={k} />{' '}<span className="json-num">{String(v)}</span></div>;
  }
  if (typeof v === 'boolean') {
    return <div className="json-row" style={indent}><Key k={k} />{' '}<span className="json-bool">{String(v)}</span></div>;
  }

  const isArr = Array.isArray(v);
  const entries = isArr
    ? (v as unknown[]).map((val, i) => [i, val] as const)
    : Object.entries(v as Record<string, unknown>);
  const len = entries.length;

  return (
    <div>
      <div className="json-row json-row-collapsible" style={indent} onClick={() => setOpen(o => !o)}>
        <span className="json-toggle">{open ? '−' : '+'}</span>
        <Key k={k} />
        {!open && (
          <span className="json-summary">
            {' '}{isArr ? `[…] (${len})` : `{…} (${len})`}
          </span>
        )}
        {open && <span className="json-bracket">{isArr ? '[' : '{'}</span>}
      </div>
      {open && (
        <>
          {entries.map(([ek, ev]) => (
            <JsonNode key={String(ek)} k={ek as string | number} v={ev} depth={depth + 1} defaultDepth={defaultDepth} />
          ))}
          <div className="json-row" style={{ paddingLeft: depth * 14 + 14 }}>
            <span className="json-bracket">{isArr ? ']' : '}'}</span>
          </div>
        </>
      )}
    </div>
  );
});

function Key({ k }: { k: string | number | null }) {
  if (k === null) return null;
  if (typeof k === 'number') return <span className="json-idx">{k}</span>;
  return <span className="json-key">{JSON.stringify(k)}<span className="json-colon">:</span></span>;
}
