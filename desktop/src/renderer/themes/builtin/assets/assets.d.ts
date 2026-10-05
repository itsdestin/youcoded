// Vite turns an imported picture into its bundled URL; TypeScript needs to be told so.
// The YouCoded themes' wallpapers (and the terminal's pre-blurred copies) live here.
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.webp' {
  const src: string;
  export default src;
}
// The glass buddy drawings, read as text and handed to the mascot as data: URLs.
declare module '*.svg?raw' {
  const src: string;
  export default src;
}
