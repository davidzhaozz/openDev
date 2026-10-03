import { useCallback, useEffect, useRef, useState } from 'react';

// In-app menu bar for the frameless chrome (Windows / Linux).
//
// macOS puts the application menu in the system menu bar, so it is always
// visible there. Windows draws it into the native window frame — and this app
// runs `frame: false` everywhere except macOS, so the frame, and with it every
// File / Edit / View / Window item, simply isn't rendered. This component puts
// the bar back.
//
// It deliberately does NOT redefine the menu: it asks main for the top-level
// labels and pops the real `Menu` submenus built in main/index.ts, so
// accelerators, enablement and click handlers have exactly one definition.

type TopLevelItem = { index: number; label: string; enabled: boolean };

export function MenuBar() {
  const [items, setItems] = useState<TopLevelItem[]>([]);
  // Which menu is currently popped, so the bar can highlight it and so a
  // second click on the same label reads as "close" rather than reopening.
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    window.opendev.menu.topLevel().then((r) => { if (!cancelled) setItems(r); });
    return () => { cancelled = true; };
  }, []);

  const openAt = useCallback(async (item: TopLevelItem, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setOpenIndex(item.index);
    // popup() resolves when the menu closes, which is the signal to drop the
    // highlight — there is no separate "menu closed" event to listen for.
    await window.opendev.menu.popup(item.index, r.left, r.bottom);
    setOpenIndex(null);
  }, []);

  // Hovering across the bar while a menu is open switches menus, the way a
  // native menu bar behaves.
  const onEnter = useCallback((item: TopLevelItem, el: HTMLElement) => {
    if (openIndex === null || openIndex === item.index) return;
    void openAt(item, el);
  }, [openIndex, openAt]);

  if (!items.length) return null;

  return (
    <div className="menubar" ref={barRef} role="menubar">
      {items.map((item) => (
        <button
          key={item.index}
          type="button"
          role="menuitem"
          className={`menubar-item${openIndex === item.index ? ' open' : ''}`}
          disabled={!item.enabled}
          aria-haspopup="menu"
          aria-expanded={openIndex === item.index}
          onClick={(e) => void openAt(item, e.currentTarget)}
          onMouseEnter={(e) => onEnter(item, e.currentTarget)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
