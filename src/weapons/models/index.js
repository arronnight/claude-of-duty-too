import { buildM4 } from './M4.js';
import { buildMP5 } from './MP5.js';
import { buildDeagle } from './Deagle.js';

/**
 * Model registry. Every weapon in `WeaponDefs` names one of these; the ones
 * that share a platform reuse a builder with different parameters rather than
 * duplicating 400 lines of geometry.
 */
const BUILDERS = {
  m4: (r) => buildM4(r, {}),
  // The AK is the same carbine chassis with wood furniture, a different
  // magazine curl and iron sights — close enough to share the builder.
  ak74: (r) => buildM4(r, { variant: 'ak', furniture: 'wood', magBend: 0.42, ironSights: true }),
  dmr: (r) => buildM4(r, { variant: 'dmr', barrelExtra: 0.10, magBend: 0.10, scope: true }),
  m870: (r) => buildM4(r, { variant: 'shotgun', pump: true, magBend: 0, noMag: true }),
  mp5: buildMP5,
  deagle: buildDeagle,
};

export function buildWeaponModel(id, resolve) {
  const b = BUILDERS[id];
  if (!b) return null;
  return b(resolve);
}
