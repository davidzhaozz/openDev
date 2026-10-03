import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureSource } from '../../../shared/types';
import { useStore } from '../state/store';
import { isMacPlatform } from '../platformUi';

// Screen recorder — bottom-bar record button, source picker, and the
// MediaRecorder that ties them together.
//
// Video comes from a desktopCapturer source id (the main process owns that
// API since Electron 17); the voice-over comes from a normal microphone
// getUserMedia. Both land in one MediaRecorder, whose chunks go straight to
// a file main already has open — nothing accumulates in renderer memory, so
// length is bounded by disk rather than by RAM.

type Prefs = {
  mic: boolean;
  micDeviceId?: string;
  systemAudio: boolean;
  mimeType?: string;
};

const PREFS_KEY = 'opendev.recorder.prefs';

const DEFAULT_PREFS: Prefs = { mic: true, systemAudio: false };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch { return DEFAULT_PREFS; }
}

function savePrefs(p: Prefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

// Ordered best-first. WebM/VP9 is the default because it always works in a
// Chromium MediaRecorder; MP4 is offered only when the platform actually has
// an H.264 encoder behind it, since Windows users usually want that one.
const VIDEO_FORMATS: Array<{ mimeType: string; ext: string; label: string }> = [
  { mimeType: 'video/webm;codecs=vp9,opus', ext: 'webm', label: 'WebM · VP9 (best quality)' },
  { mimeType: 'video/webm;codecs=vp8,opus', ext: 'webm', label: 'WebM · VP8' },
  { mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4', label: 'MP4 · H.264 (most compatible)' },
  { mimeType: 'video/webm', ext: 'webm', label: 'WebM' }
];

function supportedFormats() {
  const seen = new Set<string>();
  return VIDEO_FORMATS.filter((f) => {
    if (seen.has(f.mimeType)) return false;
    seen.add(f.mimeType);
    try { return MediaRecorder.isTypeSupported(f.mimeType); } catch { return false; }
  });
}

function fmtDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Everything a live take needs torn down, in one bag. */
type Live = {
  id: string;
  path: string;
  recorder: MediaRecorder;
  tracks: MediaStreamTrack[];
  audioCtx?: AudioContext;
  analyser?: AnalyserNode;
  startedAt: number;
  /** Serializes chunk writes — `dataavailable` is fired, not awaited. */
  writes: Promise<void>;
  bytes: number;
};

export function ScreenRecorder() {
  const showToast = useStore((s) => s.showToast);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [level, setLevel] = useState(0);
  const live = useRef<Live | null>(null);
  const [recording, setRecording] = useState(false);

  // Ticks the timer/size readout and samples the mic meter. One rAF-free
  // interval is plenty — this is a status chip, not a VU meter.
  useEffect(() => {
    if (!recording) return;
    const buf = new Uint8Array(512);
    const t = setInterval(() => {
      const l = live.current;
      if (!l) return;
      setElapsed(Date.now() - l.startedAt);
      setBytes(l.bytes);
      if (l.analyser) {
        l.analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(1, peak / 90));
      }
    }, 250);
    return () => clearInterval(t);
  }, [recording]);

  const teardown = useCallback((l: Live) => {
    for (const t of l.tracks) { try { t.stop(); } catch {} }
    if (l.audioCtx) { l.audioCtx.close().catch(() => {}); }
  }, []);

  /** Stop the recorder and wait for its final `dataavailable` to be written. */
  const drain = useCallback(async (l: Live): Promise<void> => {
    if (l.recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        l.recorder.addEventListener('stop', () => resolve(), { once: true });
        try { l.recorder.stop(); } catch { resolve(); }
      });
    }
    await l.writes.catch(() => {});
  }, []);

  const stop = useCallback(async (discard: boolean) => {
    const l = live.current;
    if (!l) return;
    live.current = null;
    setRecording(false);
    const durationMs = Date.now() - l.startedAt;
    await drain(l);
    teardown(l);
    try {
      if (discard) {
        await window.opendev.recorder.cancel(l.id);
        showToast('Recording discarded', 2500);
        return;
      }
      const r = await window.opendev.recorder.finish(l.id, durationMs);
      if (!r) { showToast('Recording finished, but the file handle was already gone', 4000); return; }
      showToast(`Saved ${fmtDuration(r.durationMs)} · ${fmtBytes(r.bytes)} → ${r.path}`, 8000);
      // Pop the folder so the file is one drag away from Slack/Jira.
      window.opendev.fs.reveal(r.path).catch(() => {});
    } catch (e: any) {
      showToast(`Saving recording failed: ${e?.message || e}`, 6000);
    }
  }, [drain, teardown, showToast]);

  const start = useCallback(async (source: CaptureSource, prefs: Prefs) => {
    const formats = supportedFormats();
    const format = formats.find((f) => f.mimeType === prefs.mimeType) || formats[0];
    if (!format) { showToast('This build has no MediaRecorder video codec available', 5000); return; }

    const tracks: MediaStreamTrack[] = [];
    let audioCtx: AudioContext | undefined;
    let analyser: AnalyserNode | undefined;
    let handle: { id: string; path: string } | undefined;

    try {
      // System audio only exists as a loopback device on Windows. Chromium
      // wants it requested in the same call as the video track.
      const wantSystemAudio = prefs.systemAudio && !isMacPlatform();
      const desktopConstraints: any = {
        audio: wantSystemAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
            maxFrameRate: 30,
            maxWidth: 3840,
            maxHeight: 2160
          }
        }
      };
      let desktop: MediaStream;
      try {
        desktop = await navigator.mediaDevices.getUserMedia(desktopConstraints);
      } catch (err) {
        if (!wantSystemAudio) throw err;
        // Loopback refused (common when no audio endpoint is shareable) —
        // the picture matters more than the system sound, so keep going.
        desktopConstraints.audio = false;
        desktop = await navigator.mediaDevices.getUserMedia(desktopConstraints);
        showToast('System audio was unavailable — recording video and mic only', 5000);
      }
      tracks.push(...desktop.getTracks());

      let micStream: MediaStream | undefined;
      if (prefs.mic) {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: prefs.micDeviceId ? { exact: prefs.micDeviceId } : undefined,
            // Cancel echo only when the speakers are also being captured;
            // otherwise it can duck a quiet narration for no reason.
            echoCancellation: wantSystemAudio,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });
        tracks.push(...micStream.getTracks());
      }

      // Build the final track list. Two audio sources have to be summed
      // through WebAudio — MediaRecorder records only the first audio track.
      const videoTrack = desktop.getVideoTracks()[0];
      if (!videoTrack) throw new Error('The selected source produced no video track');
      const desktopAudio = desktop.getAudioTracks();
      const micAudio = micStream ? micStream.getAudioTracks() : [];
      let audioTracks: MediaStreamTrack[] = [];

      if (micAudio.length > 0) {
        // Always route the mic through an AudioContext, mixing or not: the
        // analyser tap is what drives the live level meter, which is the
        // only way to notice a muted mic before the take is over.
        audioCtx = new AudioContext();
        const dest = audioCtx.createMediaStreamDestination();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        const micNode = audioCtx.createMediaStreamSource(new MediaStream(micAudio));
        micNode.connect(analyser);
        micNode.connect(dest);
        if (desktopAudio.length > 0) {
          const sysNode = audioCtx.createMediaStreamSource(new MediaStream(desktopAudio));
          // Duck the system a little so narration stays on top of it.
          const gain = audioCtx.createGain();
          gain.gain.value = 0.7;
          sysNode.connect(gain).connect(dest);
        }
        audioTracks = dest.stream.getAudioTracks();
      } else {
        audioTracks = desktopAudio;
      }

      const stream = new MediaStream([videoTrack, ...audioTracks]);
      handle = await window.opendev.recorder.start({ ext: format.ext, withMic: prefs.mic });

      const recorder = new MediaRecorder(stream, {
        mimeType: format.mimeType,
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 128_000
      });

      const l: Live = {
        id: handle.id,
        path: handle.path,
        recorder,
        tracks,
        audioCtx,
        analyser,
        startedAt: Date.now(),
        writes: Promise.resolve(),
        bytes: 0
      };

      recorder.ondataavailable = (e) => {
        if (!e.data || e.data.size === 0) return;
        const blob = e.data;
        // Chain rather than fire-and-forget: `arrayBuffer()` is async, so two
        // chunks could otherwise reach main out of order and corrupt the file.
        l.writes = l.writes.then(async () => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          l.bytes = await window.opendev.recorder.chunk(l.id, bytes);
        });
        l.writes.catch((err) => showToast(`Recording write failed: ${err?.message || err}`, 6000));
      };
      recorder.onerror = (e: any) => {
        showToast(`Recorder error: ${e?.error?.message || 'unknown'}`, 6000);
        stop(false);
      };
      // Closing the captured window ends the track; finish the take rather
      // than keep writing a frozen frame.
      videoTrack.addEventListener('ended', () => {
        if (live.current?.id === l.id) {
          showToast('Capture source closed — saving recording', 4000);
          stop(false);
        }
      });

      // One second per chunk: small enough that a crash loses almost
      // nothing, large enough that IPC overhead stays invisible.
      recorder.start(1000);
      live.current = l;
      setElapsed(0);
      setBytes(0);
      setLevel(0);
      setRecording(true);
    } catch (e: any) {
      for (const t of tracks) { try { t.stop(); } catch {} }
      if (audioCtx) audioCtx.close().catch(() => {});
      if (handle) window.opendev.recorder.cancel(handle.id).catch(() => {});
      const msg = e?.name === 'NotAllowedError'
        ? 'Permission denied — check screen recording / microphone access in system privacy settings.'
        : e?.message || String(e);
      showToast(`Could not start recording: ${msg}`, 7000);
    }
  }, [showToast, stop]);

  // A quit mid-take still closes the file main-side, but stopping the
  // recorder here flushes the last chunk first.
  useEffect(() => {
    const onUnload = () => {
      const l = live.current;
      if (l && l.recorder.state !== 'inactive') { try { l.recorder.stop(); } catch {} }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  if (recording) {
    return (
      <div className="rec-chip" title={live.current?.path || 'Recording'}>
        <span className="rec-dot" />
        <span className="rec-time">{fmtDuration(elapsed)}</span>
        <MicMeter level={level} active={!!live.current?.analyser} />
        <span className="rec-size">{fmtBytes(bytes)}</span>
        <button className="rec-stop" onClick={() => stop(false)} title="Stop and save">■</button>
        <button className="rec-discard" onClick={() => stop(true)} title="Stop and discard">✕</button>
      </div>
    );
  }

  return (
    <>
      <button
        className="rec-btn"
        onClick={() => setPickerOpen(true)}
        title="Record the screen with microphone narration"
      >⏺</button>
      {pickerOpen && (
        <RecorderPicker
          onClose={() => setPickerOpen(false)}
          onStart={(source, prefs) => { setPickerOpen(false); start(source, prefs); }}
        />
      )}
    </>
  );
}

/** Five-segment mic level readout. Greys out when nothing is being mixed in. */
function MicMeter({ level, active }: { level: number; active: boolean }) {
  if (!active) return <span className="rec-mic-off" title="No microphone in this recording">🔇</span>;
  const lit = Math.round(level * 5);
  return (
    <span className="rec-meter" title={`Mic level ${Math.round(level * 100)}%`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={`rec-meter-seg ${i < lit ? 'lit' : ''} ${i >= 4 ? 'hot' : ''}`} />
      ))}
    </span>
  );
}

function RecorderPicker({
  onClose, onStart
}: {
  onClose: () => void;
  onStart: (source: CaptureSource, prefs: Prefs) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micError, setMicError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const formats = supportedFormats();
  const macOs = isMacPlatform();

  useEffect(() => {
    let alive = true;
    window.opendev.recorder.sources()
      .then((list) => {
        if (!alive) return;
        // Screens first — that's what most recordings want.
        const sorted = [...list].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'screen' ? -1 : 1));
        setSources(sorted);
        setSelected(sorted[0]?.id);
      })
      .catch((e) => { if (alive) setError(e?.message || String(e)); });
    return () => { alive = false; };
  }, []);

  // Device labels stay blank until the page has been granted microphone
  // access once, so ask here — at the moment the user is choosing a mic —
  // rather than surprising them with an OS prompt after they hit Start.
  useEffect(() => {
    let alive = true;
    if (!prefs.mic) { setMics([]); setMicError(null); return; }
    (async () => {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const t of probe.getTracks()) t.stop();
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!alive) return;
        setMics(devices.filter((d) => d.kind === 'audioinput'));
        setMicError(null);
      } catch (e: any) {
        if (!alive) return;
        setMics([]);
        setMicError(e?.name === 'NotAllowedError'
          ? 'Microphone access denied — allow it in system privacy settings, or record without narration.'
          : e?.message || String(e));
      }
    })();
    return () => { alive = false; };
  }, [prefs.mic]);

  const update = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(next);
  };

  const source = sources?.find((s) => s.id === selected);
  const canStart = !!source;

  return (
    <div className="modal-overlay" ref={overlayRef} onMouseDown={(e) => { if (e.target === overlayRef.current) onClose(); }}>
      <div className="modal rec-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Record screen</span>
          <span className="grow" />
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        <div className="rec-sources">
          {error && <div className="rec-empty">Couldn't list capture sources: {error}</div>}
          {!error && !sources && <div className="rec-empty">Looking for screens and windows…</div>}
          {!error && sources?.length === 0 && (
            <div className="rec-empty">
              No capture sources available.{macOs ? ' macOS needs OpenDev IDE enabled under Privacy & Security › Screen Recording.' : ''}
            </div>
          )}
          {sources?.map((s) => (
            <button
              key={s.id}
              className={`rec-source ${selected === s.id ? 'selected' : ''}`}
              onClick={() => setSelected(s.id)}
              title={s.name}
            >
              <img src={s.thumbnail} alt="" />
              <span className="rec-source-name">
                <span className="rec-source-kind">{s.kind === 'screen' ? 'Screen' : 'Window'}</span>
                {s.name}
              </span>
            </button>
          ))}
        </div>

        <div className="rec-options">
          <label className="rec-opt">
            <input type="checkbox" checked={prefs.mic} onChange={(e) => update({ mic: e.target.checked })} />
            Record microphone
          </label>
          <select
            className="rec-mic-select"
            disabled={!prefs.mic || mics.length === 0}
            value={prefs.micDeviceId || ''}
            onChange={(e) => update({ micDeviceId: e.target.value || undefined })}
            title="Microphone"
          >
            <option value="">System default microphone</option>
            {mics.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>
            ))}
          </select>

          <label className={`rec-opt ${macOs ? 'disabled' : ''}`} title={macOs ? 'macOS has no loopback device to capture system audio from.' : 'Also capture what your speakers are playing'}>
            <input
              type="checkbox"
              disabled={macOs}
              checked={prefs.systemAudio && !macOs}
              onChange={(e) => update({ systemAudio: e.target.checked })}
            />
            Include system audio{macOs ? ' (not available on macOS)' : ''}
          </label>

          <label className="rec-opt rec-format">
            Format
            <select
              value={prefs.mimeType || formats[0]?.mimeType || ''}
              onChange={(e) => update({ mimeType: e.target.value })}
            >
              {formats.map((f) => <option key={f.mimeType} value={f.mimeType}>{f.label}</option>)}
            </select>
          </label>

          {micError && <div className="rec-warn">{micError}</div>}
        </div>

        <div className="rec-foot">
          <span className="rec-hint">Saved to your Videos folder · 30 fps · stop from the status bar</span>
          <span className="grow" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!canStart} onClick={() => source && onStart(source, prefs)}>
            Start recording
          </button>
        </div>
      </div>
    </div>
  );
}
