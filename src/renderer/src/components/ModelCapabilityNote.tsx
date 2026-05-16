// Honest-expectations warning for local AI users. Triggered when the
// selected Ollama / OpenAI-compatible model has fewer than ~13B params,
// because below that mark agentic flows reliably spiral. We keep the
// language tight and concrete so it isn't blown past — the goal is for
// the first multi-step failure to land with "ah right, the warning said
// this would happen" rather than confusion.

export type ModelTier = 'small' | 'medium' | 'large' | 'unknown';

// Parse "<name>:<n>b", "<name>-<n>b", "<name>:<n.n>b", "8b", etc. Tag-style
// labels like ":mini" / ":medium" map to small / medium. Anything else
// returns 'unknown' so we don't false-positive on hosted model names.
export function modelTier(id: string): { tier: ModelTier; params?: number } {
  if (!id) return { tier: 'unknown' };
  const m = id.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (m) {
    const params = parseFloat(m[1]);
    if (params < 13) return { tier: 'small', params };
    if (params < 30) return { tier: 'medium', params };
    return { tier: 'large', params };
  }
  if (/(?:^|[-:_])medium\b/i.test(id)) return { tier: 'medium' };
  if (/(?:^|[-:_])(?:mini|tiny|small|nano)\b/i.test(id)) return { tier: 'small' };
  return { tier: 'unknown' };
}

export function ModelCapabilityNote({ model, variant = 'block' }: { model: string; variant?: 'block' | 'compact' }) {
  const t = modelTier(model);
  if (t.tier !== 'small') return null;
  if (variant === 'compact') {
    return (
      <div className="model-cap-note compact" title="Click for the full caveats">
        ⚠ {model}{t.params ? ` (${t.params}B)` : ''} — fine for single-file edits; multi-step refactors will spiral. Try a 14B+ model.
      </div>
    );
  }
  return (
    <div className="model-cap-note">
      <div className="model-cap-head">⚠ Honest expectations for {model}{t.params ? ` (~${t.params}B params)` : ''}</div>
      <ul>
        <li><b>Single-file edits and grep-based investigation:</b> usually fine.</li>
        <li><b>Multi-step debug loops or 5+ coordinated edits:</b> will spiral. Switch to a 14B+ model — try <code>qwen2.5-coder:14b</code>.</li>
        <li><b>Tool-argument hallucination</b> (wrong paths, made-up symbols) happens occasionally — review proposed changes before applying.</li>
      </ul>
    </div>
  );
}
