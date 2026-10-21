// WHY: Vite emits these modules as worker assets for desktop and the shared web
// build. A constructor import avoids import.meta in the CommonJS type-check target.
declare module '*?worker' {
  const WorkerConstructor: { new(options?: WorkerOptions): Worker };
  export default WorkerConstructor;
}
