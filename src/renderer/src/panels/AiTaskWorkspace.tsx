import { useEffect, useRef } from 'react';
import { useStore } from '../state/store';
import { Resizer } from '../components/Resizer';

function composePrompt(goal: string, priorities: string[]): string {
  const lines: string[] = [];
  lines.push('# TASK');
  lines.push(goal.trim());
  lines.push('');
  if (priorities.some(p => p.trim())) {
    lines.push('# TOP PRIORITIES — ACCEPTANCE CRITERIA');
    lines.push('Treat these as test cases. The work is only complete when every one passes.');
    lines.push('');
    priorities.filter(p => p.trim()).forEach((p, i) => {
      lines.push(`${i + 1}. ${p.trim()}`);
    });
    lines.push('');
    lines.push('# WHEN DONE');
    lines.push('Output a section titled `VERIFICATION` with one bullet per criterion in the form:');
    lines.push('  - [PASS] / [FAIL] / [SKIP] <criterion> — one-line evidence (file path / line / behavior)');
    lines.push('If any criterion is [FAIL], make the additional change before reporting again.');
  }
  return lines.join('\n');
}

type Verdict = 'pass' | 'fail' | 'skip' | 'pending';
function extractVerification(text: string, priorities: string[]): Verdict[] {
  const verdicts: Verdict[] = priorities.map(() => 'pending');
  // Look for a `VERIFICATION` section near the end of the text.
  const idx = text.search(/##?\s*VERIFICATION/i);
  if (idx < 0) return verdicts;
  const tail = text.slice(idx);
  const lines = tail.split('\n');
  let lineIdx = 0;
  for (const line of lines) {
    const m = line.match(/\[(PASS|FAIL|SKIP)\]/i);
    if (!m) continue;
    if (lineIdx >= verdicts.length) break;
    const v = m[1].toLowerCase() as Verdict;
    verdicts[lineIdx] = v;
    lineIdx++;
  }
  return verdicts;
}

export function AiTaskWorkspace() {
  const goal = useStore(s => s.aiTaskGoal);
  const setGoal = useStore(s => s.setAiTaskGoal);
  const priorities = useStore(s => s.aiTaskPriorities);
  const setPriorities = useStore(s => s.setAiTaskPriorities);
  const output = useStore(s => s.aiTaskOutput);
  const setOutput = useStore(s => s.setAiTaskOutput);
  const running = useStore(s => s.aiTaskRunning);
  const setRunning = useStore(s => s.setAiTaskRunning);
  const streamId = useStore(s => s.aiTaskStreamId);
  const setStreamId = useStore(s => s.setAiTaskStreamId);
  const layout = useStore(s => s.layout);
  const setLayout = useStore(s => s.setLayout);
  const showToast = useStore(s => s.showToast);

  const outputRef = useRef<HTMLPreElement | null>(null);

  // Stream listener
  useEffect(() => {
    const off = window.opendev.ai.onStream(({ streamId: sid, chunk, done }) => {
      if (!sid || sid !== streamId) return;
      if (chunk) setOutput(o => o + chunk);
      if (done) setRunning(false);
    });
    return off;
  }, [streamId, setOutput, setRunning]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  const submit = async () => {
    if (!goal.trim()) { showToast('Enter a goal first.', 2500); return; }
    setRunning(true);
    setOutput('');
    const prompt = composePrompt(goal, priorities);
    const r = await window.opendev.ai.send({
      text: prompt,
      transport: 'claude-cli'
    });
    setStreamId(r.streamId);
  };

  const stop = () => {
    if (streamId) window.opendev.ai.cancel(streamId);
    setRunning(false);
  };

  const addPriority = () => setPriorities([...priorities, '']);
  const updatePriority = (i: number, v: string) => {
    const next = priorities.slice();
    next[i] = v;
    setPriorities(next);
  };
  const removePriority = (i: number) => setPriorities(priorities.filter((_, j) => j !== i));

  const verdicts = extractVerification(output, priorities);

  return (
    <div className="ai-task">
      <div className="ai-task-top">
        <div className="ai-task-section">
          <div className="ai-task-label">Goal</div>
          <textarea
            className="ai-task-goal"
            value={goal}
            placeholder="What should the AI do? Be specific."
            onChange={(e) => setGoal(e.target.value)}
            disabled={running}
          />
        </div>
        <div className="ai-task-section">
          <div className="ai-task-label-row">
            <span className="ai-task-label">Top priorities · acceptance criteria</span>
            <button onClick={addPriority} disabled={running}>+ Add</button>
          </div>
          <div className="ai-task-priorities">
            {priorities.map((p, i) => {
              const v = verdicts[i];
              return (
                <div key={i} className="ai-task-priority">
                  <span className={`ai-task-verdict ${v}`} title={v}>
                    {v === 'pass' ? '✓' : v === 'fail' ? '✗' : v === 'skip' ? '–' : `${i + 1}`}
                  </span>
                  <input
                    value={p}
                    placeholder={`Criterion ${i + 1} — e.g. "GET /healthz returns 200"`}
                    onChange={(e) => updatePriority(i, e.target.value)}
                    disabled={running}
                  />
                  <button className="icon" onClick={() => removePriority(i)} disabled={running}>✕</button>
                </div>
              );
            })}
            {priorities.length === 0 && (
              <div className="ai-task-hint">
                Add measurable criteria the AI must satisfy. The IDE will inject them into the prompt and ask the AI
                to verify each one in a <code>VERIFICATION</code> block when it finishes.
              </div>
            )}
          </div>
        </div>
        <div className="ai-task-actions">
          <span className="ai-task-status">
            {running ? 'Running…'
              : verdicts.length === 0 ? 'idle'
              : verdicts.every(v => v === 'pass') ? '✓ all criteria pass'
              : verdicts.some(v => v === 'fail') ? '✗ one or more criteria failed'
              : 'partial verification'}
          </span>
          <span className="grow" />
          {running
            ? <button onClick={stop}>Stop</button>
            : <button className="primary" onClick={submit} disabled={!goal.trim()}>Run with Claude Code</button>}
        </div>
      </div>

      <Resizer orientation="horizontal" value={layout.bottomH} min={120} max={800}
        onChange={(v) => setLayout({ bottomH: v })} invert />

      <div className="ai-task-output" style={{ height: layout.bottomH, flex: `0 0 ${layout.bottomH}px` }}>
        <div className="ai-task-output-head">Output</div>
        <pre ref={outputRef} className="ai-task-output-body">{output || (running ? '' : '(no output yet)')}</pre>
      </div>
    </div>
  );
}
