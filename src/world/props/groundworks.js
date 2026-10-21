/**
 * Adapter, not an implementation.
 *
 * `Props.js` resolves its optional modules through an `import.meta.glob` over
 * two fixed paths, and the one it looks for is `groundworks.js`. The road and
 * kerb work is written in `ground.js`, which is the file this agent owns. Two
 * lines of re-export are cheaper and far safer than either editing `Props.js`
 * — six other agents are in that file this wave — or renaming a file whose
 * ownership is recorded elsewhere.
 */
export { groundworks } from './ground.js';
