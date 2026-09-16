// WHY: side-effect stylesheet imports (`import './styles/globals.css'`) are
// resolved by Vite, not TypeScript. TypeScript 7 (tsgo) checks side-effect
// imports by default (noUncheckedSideEffectImports) and reports each one as
// "cannot find module". Declaring the extension keeps that check ON for every
// other import — a typo'd .ts path still fails — while accepting stylesheets.
declare module '*.css';
