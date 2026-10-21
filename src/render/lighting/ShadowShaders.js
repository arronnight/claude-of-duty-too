import * as THREE from 'three';

/**
 * Global GLSL surgery for the shadow pipeline.
 *
 * three's stock `getShadow()` is a fixed-radius hardware-PCF tap set: it cannot
 * express contact hardening, and `lights_fragment_begin` treats every
 * directional light as an independent key light, which makes a cascaded sun
 * impossible. Rewriting those two ShaderChunks is the only way to change shadow
 * sampling for *every* material in the scene without owning the material
 * library — a per-material `onBeforeCompile` patch would require every other
 * agent to register their materials with us.
 *
 * Everything is baked to literals at install time (cascade count, tap
 * positions, depth range) so the generated code has no dynamic array indexing
 * and no extra uniforms to plumb through three's light state.
 */

/** All cascade shadow cameras share this ortho depth span so the shader can turn
 *  a normalised depth delta back into metres with a compile-time constant. */
export const CSM_DEPTH_RANGE = 300;
export const CSM_SHADOW_NEAR = 0.5;

const GOLDEN_ANGLE = 2.399963229728653;

let _originals = null;
let _installed = null;

function vogelDisk(count) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt((i + 0.5) / count);
    const a = i * GOLDEN_ANGLE + 0.61;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

const f = (n) => (Math.abs(n) < 1e-6 ? '0.0' : n.toFixed(6));

/** Emit `count` explicit taps instead of a const-array loop: no array indexing,
 *  no reliance on driver support for global const arrays, and it unrolls free. */
function emitTaps(pts, line) {
  return pts.map((p) => '\t\t' + line(`vec2( ${f(p[0])}, ${f(p[1])} )`)).join('\n');
}

function buildShadowPars({ pcss, filterTaps, searchTaps }) {
  const filter = vogelDisk(filterTaps);
  const search = vogelDisk(searchTaps);
  const invFilter = f(1 / filterTaps);

  const blockerSearch = emitTaps(
    search,
    (v) => `sd = textureLod( shadowMap, uv + rot * ${v} * search, 0.0 ).r; if ( SHADOW_CLOSER( sd, zr ) ) { bSum += sd; bCount += 1.0; }`
  );
  const filterTapsSrc = emitTaps(
    filter,
    (v) => `sum += SHADOW_LIT( textureLod( shadowMap, uv + rot * ${v} * radius, 0.0 ).r, zr );`
  );

  return /* glsl */ `
#if NUM_SPOT_LIGHT_COORDS > 0
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif

#if NUM_SPOT_LIGHT_MAPS > 0
	uniform sampler2D spotLightMap[ NUM_SPOT_LIGHT_MAPS ];
#endif

#ifdef USE_SHADOWMAP

	#if NUM_DIR_LIGHT_SHADOWS > 0

		uniform sampler2D directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];

		struct DirectionalLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};

		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];

	#endif

	#if NUM_SPOT_LIGHT_SHADOWS > 0

		uniform sampler2D spotShadowMap[ NUM_SPOT_LIGHT_SHADOWS ];

		struct SpotLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};

		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];

	#endif

	#if NUM_POINT_LIGHT_SHADOWS > 0

		uniform samplerCube pointShadowMap[ NUM_POINT_LIGHT_SHADOWS ];
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];

		struct PointLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};

		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];

	#endif

	#ifdef USE_REVERSED_DEPTH_BUFFER
		#define SHADOW_LIT( d, z ) step( d, z )
		#define SHADOW_CLOSER( d, z ) ( d > z )
		#define SHADOW_APPLY_BIAS( z, b ) ( z - b )
	#else
		#define SHADOW_LIT( d, z ) step( z, d )
		#define SHADOW_CLOSER( d, z ) ( d < z )
		#define SHADOW_APPLY_BIAS( z, b ) ( z + b )
	#endif

	float shadowHash( vec2 p ) {

		return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );

	}

	mat2 shadowRotation() {

		float phi = shadowHash( gl_FragCoord.xy ) * PI2;
		float c = cos( phi );
		float s = sin( phi );
		return mat2( c, s, -s, c );

	}

	float shadowFilter( sampler2D shadowMap, vec2 uv, float zr, float radius, mat2 rot ) {

		float sum = 0.0;
${filterTapsSrc}
		return sum * ${invFilter};

	}

	/**
	 * Cascade shadow lookup. All cascades share an orthographic depth span of
	 * ${f(CSM_DEPTH_RANGE)} m, so a normalised depth delta times shadowRadius
	 * (which the CPU pre-multiplies by tan(sunAngularRadius) * depthSpan /
	 * cascadeExtent) is directly the penumbra width in UV — contact hardening
	 * with no extra uniforms.
	 */
	float getShadowCSM( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {

		vec3 proj = shadowCoord.xyz / shadowCoord.w;
		if ( proj.z <= 0.0 || proj.z >= 1.0 ) return 1.0;

		vec2 uv = proj.xy;
		float texel = 1.0 / shadowMapSize.x;
		float zr = SHADOW_APPLY_BIAS( proj.z, shadowBias );
		mat2 rot = shadowRotation();

		#if ${pcss ? 1 : 0}

			float search = clamp( shadowRadius * 0.09, texel * 2.0, texel * 22.0 );
			float bSum = 0.0;
			float bCount = 0.0;
			float sd;
${blockerSearch}
			if ( bCount < 0.5 ) return 1.0;

			float penumbra = abs( zr - bSum / bCount ) * shadowRadius;
			float radius = clamp( penumbra, texel * 0.7, texel * 26.0 );

		#else

			float radius = texel * 1.4;

		#endif

		return mix( 1.0, shadowFilter( shadowMap, uv, zr, radius, rot ), shadowIntensity );

	}

	float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {

		vec3 proj = shadowCoord.xyz / shadowCoord.w;
		if ( proj.z >= 1.0 || proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 ) return 1.0;

		float texel = 1.0 / shadowMapSize.x;
		float zr = SHADOW_APPLY_BIAS( proj.z, shadowBias );
		float radius = max( shadowRadius, 0.5 ) * texel;

		return mix( 1.0, shadowFilter( shadowMap, proj.xy, zr, radius, shadowRotation() ), shadowIntensity );

	}

	#if NUM_POINT_LIGHT_SHADOWS > 0

	float getPointShadow( samplerCube shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {

		vec3 lightToPosition = shadowCoord.xyz;
		vec3 absVec = abs( lightToPosition );
		float viewSpaceZ = max( max( absVec.x, absVec.y ), absVec.z );

		if ( viewSpaceZ > shadowCameraFar || viewSpaceZ < shadowCameraNear ) return 1.0;

		vec3 dir = normalize( lightToPosition );

		#ifdef USE_REVERSED_DEPTH_BUFFER
			float dp = ( shadowCameraNear * ( shadowCameraFar - viewSpaceZ ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
		#else
			float dp = ( shadowCameraFar * ( viewSpaceZ - shadowCameraNear ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
		#endif
		dp = SHADOW_APPLY_BIAS( dp, shadowBias );

		vec3 up = abs( dir.y ) > 0.9 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 0.0, 1.0, 0.0 );
		vec3 tangent = normalize( cross( up, dir ) );
		vec3 bitangent = cross( dir, tangent );

		mat2 rot = shadowRotation();
		float offset = shadowRadius / shadowMapSize.x;
		float sum = 0.0;

${emitTaps(
  vogelDisk(6),
  (v) => `{ vec2 o = rot * ${v} * offset; sum += SHADOW_LIT( texture( shadowMap, dir + tangent * o.x + bitangent * o.y ).r, dp ); }`
)}

		return mix( 1.0, sum * ${f(1 / 6)}, shadowIntensity );

	}

	#endif

#endif
`;
}

const DIR_HEAD = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
const RECT_HEAD = '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )';

function buildDirectionalBlock(cascades, blend) {
  return /* glsl */ `#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif

	#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS >= ${cascades} )
		#define CSM_ACTIVE
	#endif

	#ifdef CSM_ACTIVE

		float csmShadow = 0.0;
		float csmCover = 0.0;

		#pragma unroll_loop_start
		for ( int i = 0; i < ${cascades}; i ++ ) {
			if ( csmCover < 0.998 ) {
				vec4 csmCoord = vDirectionalShadowCoord[ i ];
				vec3 csmProj = csmCoord.xyz / csmCoord.w;
				vec2 csmEdge = abs( csmProj.xy * 2.0 - 1.0 );
				float csmFit = ( csmProj.z > 0.0 && csmProj.z < 1.0 ) ? ( 1.0 - smoothstep( ${f(1 - blend)}, 1.0, max( csmEdge.x, csmEdge.y ) ) ) : 0.0;
				float csmW = min( csmFit, 1.0 - csmCover );
				if ( csmW > 0.0 ) {
					directionalLightShadow = directionalLightShadows[ i ];
					csmShadow += csmW * getShadowCSM( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, csmCoord );
					csmCover += csmW;
				}
			}
		}
		#pragma unroll_loop_end

		csmShadow += 1.0 - csmCover;

		directionalLight = directionalLights[ 0 ];
		getDirectionalLightInfo( directionalLight, directLight );
		directLight.color *= ( directLight.visible && receiveShadow ) ? csmShadow : 1.0;
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	#endif

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {

		#if !defined( CSM_ACTIVE ) || ( UNROLLED_LOOP_INDEX >= ${cascades} )

		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );

		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif

		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

		#endif

	}
	#pragma unroll_loop_end

	#ifdef CSM_ACTIVE
		#undef CSM_ACTIVE
	#endif

#endif

`;
}

/**
 * Rewrites the two lighting chunks. Idempotent and reversible; returns whether
 * the cascade injection actually took (if three's chunk layout ever changes the
 * caller falls back to a single uncascaded shadow so we never hard-fail).
 */
export function installLightingShaders({ cascades = 3, pcss = true, filterTaps = 16, searchTaps = 8 } = {}) {
  if (!_originals) {
    _originals = {
      shadowmap_pars_fragment: THREE.ShaderChunk.shadowmap_pars_fragment,
      lights_fragment_begin: THREE.ShaderChunk.lights_fragment_begin,
    };
  }

  const key = `${cascades}|${pcss}|${filterTaps}|${searchTaps}`;
  if (_installed === key) return { ok: true, cascades };

  THREE.ShaderChunk.shadowmap_pars_fragment = buildShadowPars({ pcss, filterTaps, searchTaps });

  const src = _originals.lights_fragment_begin;
  const a = src.indexOf(DIR_HEAD);
  const b = src.indexOf(RECT_HEAD);
  if (a < 0 || b < 0 || b < a) {
    THREE.ShaderChunk.lights_fragment_begin = src;
    _installed = null;
    return { ok: false, cascades: 1 };
  }

  THREE.ShaderChunk.lights_fragment_begin =
    src.slice(0, a) + buildDirectionalBlock(cascades, 0.14) + src.slice(b);
  _installed = key;
  return { ok: true, cascades };
}

export function uninstallLightingShaders() {
  if (!_originals) return;
  THREE.ShaderChunk.shadowmap_pars_fragment = _originals.shadowmap_pars_fragment;
  THREE.ShaderChunk.lights_fragment_begin = _originals.lights_fragment_begin;
  _installed = null;
}
