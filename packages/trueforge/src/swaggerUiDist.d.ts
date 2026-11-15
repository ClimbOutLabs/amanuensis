// swagger-ui-dist ships no types; this is the one helper the API docs page reads.
declare module 'swagger-ui-dist/absolute-path.js' {
  const getAbsoluteFSPath: () => string;
  export default getAbsoluteFSPath;
}
