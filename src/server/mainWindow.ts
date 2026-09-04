// Stands in for src/main/index.ts in the web bundle. Only browser.ts imports
// from there (`getMainWindow`, for capturePage screenshots); pulling in the
// real module would drag the whole Electron app lifecycle along with it.
export function getMainWindow(): null {
  return null;
}
