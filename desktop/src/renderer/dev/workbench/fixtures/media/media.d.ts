// Vite's ?inline gives a picture as a data: address (card #267 mockups: ChatImage only draws non-website pictures directly).
declare module '*.png?inline' {
  const src: string;
  export default src;
}
