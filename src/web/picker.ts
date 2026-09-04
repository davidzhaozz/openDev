// Remote file/folder picker.
//
// dialog.showOpenDialog opens a native panel on whichever machine the main
// process runs on — useless when that machine is across a network. This is the
// replacement: a small modal that walks the *server's* filesystem over the
// web:list-dir channel. Written against the DOM rather than React so it can be
// installed before the app mounts and used from anywhere.
import { invoke } from './rpc';

type Entry = { name: string; path: string; isDir: boolean };
type Listing = {
  path: string;
  parent: string | null;
  entries: Entry[];
  home: string;
  shortcuts: Array<{ label: string; path: string }>;
  error?: string;
};

export type PickOptions = {
  title: string;
  /** 'dir' hides files entirely; 'file' lets the user descend and pick a file. */
  mode: 'dir' | 'file';
  startAt?: string;
  confirmLabel?: string;
};

export function pickRemotePath(opts: PickOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let current = '';
    let selected: string | null = null;
    let done = false;

    const overlay = document.createElement('div');
    overlay.className = 'od-pick-overlay';
    overlay.innerHTML = `
      <div class="od-pick" role="dialog" aria-modal="true">
        <div class="od-pick-title"></div>
        <div class="od-pick-path"><input class="od-pick-input" spellcheck="false" /></div>
        <div class="od-pick-body">
          <div class="od-pick-side"></div>
          <div class="od-pick-list"></div>
        </div>
        <div class="od-pick-foot">
          <span class="od-pick-sel"></span>
          <span class="od-pick-actions">
            <button class="od-pick-cancel">Cancel</button>
            <button class="od-pick-ok primary"></button>
          </span>
        </div>
      </div>`;

    const q = <T extends Element>(sel: string) => overlay.querySelector(sel) as T;
    const titleEl = q<HTMLDivElement>('.od-pick-title');
    const input = q<HTMLInputElement>('.od-pick-input');
    const side = q<HTMLDivElement>('.od-pick-side');
    const list = q<HTMLDivElement>('.od-pick-list');
    const selLabel = q<HTMLSpanElement>('.od-pick-sel');
    const okBtn = q<HTMLButtonElement>('.od-pick-ok');

    titleEl.textContent = opts.title;
    okBtn.textContent = opts.confirmLabel || (opts.mode === 'dir' ? 'Open' : 'Choose');

    function finish(value: string | null): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
    }

    function select(path: string | null): void {
      selected = path;
      selLabel.textContent = path || '';
      okBtn.disabled = !path;
      for (const row of list.querySelectorAll('.od-pick-row')) {
        row.classList.toggle('sel', (row as HTMLElement).dataset.path === path);
      }
    }

    async function go(path: string): Promise<void> {
      list.innerHTML = '<div class="od-pick-empty">Loading…</div>';
      const listing = await invoke('web:list-dir', [path, opts.mode === 'file']) as Listing;
      current = listing.path;
      input.value = listing.path;
      // In directory mode the folder you're standing in is the default answer.
      select(opts.mode === 'dir' ? listing.path : null);

      side.innerHTML = '';
      for (const s of dedupe(listing.shortcuts)) {
        const b = document.createElement('button');
        b.className = 'od-pick-shortcut';
        b.textContent = s.label;
        b.title = s.path;
        b.onclick = () => void go(s.path);
        side.appendChild(b);
      }

      list.innerHTML = '';
      if (listing.parent) {
        const up = document.createElement('div');
        up.className = 'od-pick-row up';
        up.textContent = '↑  ..';
        up.onclick = () => void go(listing.parent!);
        list.appendChild(up);
      }
      if (listing.error) {
        const err = document.createElement('div');
        err.className = 'od-pick-empty';
        err.textContent = listing.error;
        list.appendChild(err);
      }
      for (const entry of listing.entries) {
        const row = document.createElement('div');
        row.className = `od-pick-row${entry.isDir ? '' : ' file'}`;
        row.dataset.path = entry.path;
        row.textContent = `${entry.isDir ? '📁' : '📄'}  ${entry.name}`;
        row.onclick = () => select(entry.path);
        row.ondblclick = () => { if (entry.isDir) void go(entry.path); else finish(entry.path); };
        list.appendChild(row);
      }
      if (!listing.entries.length && !listing.error) {
        const empty = document.createElement('div');
        empty.className = 'od-pick-empty';
        empty.textContent = opts.mode === 'dir' ? 'No sub-folders here.' : 'Empty folder.';
        list.appendChild(empty);
      }
    }

    input.onkeydown = (e) => { if (e.key === 'Enter') void go(input.value.trim() || current); };
    q<HTMLButtonElement>('.od-pick-cancel').onclick = () => finish(null);
    okBtn.onclick = () => finish(selected);
    overlay.onclick = (e) => { if (e.target === overlay) finish(null); };
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    void go(opts.startAt || '');
  });
}

function dedupe(shortcuts: Array<{ label: string; path: string }>): Array<{ label: string; path: string }> {
  const seen = new Set<string>();
  return shortcuts.filter((s) => (seen.has(s.path) ? false : (seen.add(s.path), true)));
}
