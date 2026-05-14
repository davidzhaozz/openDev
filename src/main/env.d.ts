// Vite `?raw` imports — inline a file's contents as a string at build time.
declare module '*?raw' {
  const content: string;
  export default content;
}
