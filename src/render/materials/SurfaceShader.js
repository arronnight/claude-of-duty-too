/**
 * Shader-level surface techniques shared by every material in the library.
 *
 * All of it is delivered through `onBeforeCompile` string surgery on three's
 * `meshphysical` shader rather than a hand-written ShaderMaterial, so materials
 * keep working with shadows, fog, IBL, clearcoat, sheen and transmission for
 * free. Each technique is individually toggleable per material key and the
 * generated GLSL is keyed by `customProgramCacheKey()`, so two keys that ask
 * for the same feature set share one compiled program (the ≤60 program budget
 * is spent on techniques, not on the 30 material names).
 *
 * Techniques: triplanar projection, reoriented-normal-mapping detail blending,
 * low-frequency macro variation, parallax occlusion mapping with a distance
 * ramped step count, a global wetness/puddle model and distance based
 * roughness/normal LOD to kill specular aliasing at range.
 */

const ANCHOR = {
  common: '#include <common>',
  projectVertex: '#include <project_vertex>',
  defaultNormal: '#include <defaultnormal_vertex>',
  map: '#include <map_fragment>',
  roughness: '#include <roughnessmap_fragment>',
  metalness: '#include <metalnessmap_fragment>',
  normalMaps: '#include <normal_fragment_maps>',
  physical: '#include <lights_physical_fragment>',
  lightsPars: '#include <lights_physical_pars_fragment>',
  aomap: '#include <aomap_fragment>',
};

/** Hash/value-noise + projection helpers. Injected once after `common`. */
const HELPERS = /* glsl */ `
varying vec3 vCodWorldPos;
varying vec3 vCodWorldNormal;

float codHash12( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

float codHash13( vec3 p3 ) {
	p3 = fract( p3 * 0.1031 );
	p3 += dot( p3, p3.zyx + 31.32 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

float codNoise2( vec2 p ) {
	vec2 i = floor( p ), f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( codHash12( i ), codHash12( i + vec2( 1.0, 0.0 ) ), u.x ),
	            mix( codHash12( i + vec2( 0.0, 1.0 ) ), codHash12( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}

float codNoise3( vec3 p ) {
	vec3 i = floor( p ), f = fract( p );
	vec3 u = f * f * ( 3.0 - 2.0 * f );
	float a = mix( mix( codHash13( i ), codHash13( i + vec3( 1.0, 0.0, 0.0 ) ), u.x ),
	               mix( codHash13( i + vec3( 0.0, 1.0, 0.0 ) ), codHash13( i + vec3( 1.0, 1.0, 0.0 ) ), u.x ), u.y );
	float b = mix( mix( codHash13( i + vec3( 0.0, 0.0, 1.0 ) ), codHash13( i + vec3( 1.0, 0.0, 1.0 ) ), u.x ),
	               mix( codHash13( i + vec3( 0.0, 1.0, 1.0 ) ), codHash13( i + vec3( 1.0, 1.0, 1.0 ) ), u.x ), u.y );
	return mix( a, b, u.z );
}

float codFbm2( vec2 p ) {
	float v = 0.0, a = 0.5;
	for ( int i = 0; i < 3; i ++ ) { v += a * codNoise2( p ); p = p * 2.07 + 17.3; a *= 0.5; }
	return v / 0.875;
}

float codFbm3( vec3 p ) {
	float v = 0.0, a = 0.5;
	for ( int i = 0; i < 2; i ++ ) { v += a * codNoise3( p ); p = p * 2.13 + 11.7; a *= 0.5; }
	return v / 0.75;
}

mat3 codTangentFrame( vec3 eye, vec3 n, vec2 uv ) {
	vec3 q0 = dFdx( eye ), q1 = dFdy( eye );
	vec2 st0 = dFdx( uv ), st1 = dFdy( uv );
	vec3 q1perp = cross( q1, n ), q0perp = cross( n, q0 );
	vec3 T = q1perp * st0.x + q0perp * st1.x;
	vec3 B = q1perp * st0.y + q0perp * st1.y;
	float det = max( dot( T, T ), dot( B, B ) );
	float s = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
	return mat3( T * s, B * s, n );
}

// Reoriented normal mapping (Barre-Brisebois/Hill): keeps the detail normal
// anchored to the base surface instead of averaging the two away.
vec3 codRNM( vec3 base, vec3 detail ) {
	vec3 t = base + vec3( 0.0, 0.0, 1.0 );
	vec3 u = detail * vec3( -1.0, -1.0, 1.0 );
	return normalize( t * ( dot( t, u ) / max( t.z, 1e-4 ) ) - u );
}

vec3 codTriWeights( vec3 n ) {
	vec3 w = abs( n );
	w = w * w; w = w * w;
	return w / max( w.x + w.y + w.z, 1e-4 );
}

vec4 codTriTex( sampler2D t, vec3 p, vec3 w ) {
	return texture2D( t, p.zy ) * w.x + texture2D( t, p.xz ) * w.y + texture2D( t, p.xy ) * w.z;
}

// Whiteout blend of three tangent-space samples into a world-space normal.
vec3 codTriNormal( sampler2D t, vec3 p, vec3 wn, vec3 w, float scale ) {
	vec3 nx = texture2D( t, p.zy ).xyz * 2.0 - 1.0;
	vec3 ny = texture2D( t, p.xz ).xyz * 2.0 - 1.0;
	vec3 nz = texture2D( t, p.xy ).xyz * 2.0 - 1.0;
	nx.xy *= scale; ny.xy *= scale; nz.xy *= scale;
	nx = vec3( nx.xy + wn.zy, abs( nx.z ) * wn.x );
	ny = vec3( ny.xy + wn.xz, abs( ny.z ) * wn.y );
	nz = vec3( nz.xy + wn.xy, abs( nz.z ) * wn.z );
	return normalize( nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z );
}

const mat2 COD_DETAIL_ROT = mat2( 0.8253, 0.5646, -0.5646, 0.8253 );
`;

const POM_FN = (maxSteps, ch) => /* glsl */ `
#define COD_POM_MAX ${maxSteps}
vec2 codParallax( sampler2D hmap, vec2 uv, vec3 vts, float depth, int steps, out float hitHeight ) {
	vec2 ddx = dFdx( uv ), ddy = dFdy( uv );
	if ( steps < 1 || depth <= 0.0 ) { hitHeight = textureGrad( hmap, uv, ddx, ddy ).${ch}; return uv; }
	float layer = 1.0 / float( steps );
	// Clamping |z| keeps the ray from shooting off to infinity at grazing angles.
	vec2 delta = ( vts.xy / max( abs( vts.z ), 0.35 ) ) * depth * layer;
	float cur = 0.0;
	vec2 cuv = uv;
	float d = 1.0 - textureGrad( hmap, cuv, ddx, ddy ).${ch};
	for ( int i = 0; i < COD_POM_MAX; i ++ ) {
		if ( i >= steps || cur >= d ) break;
		cuv -= delta;
		d = 1.0 - textureGrad( hmap, cuv, ddx, ddy ).${ch};
		cur += layer;
	}
	vec2 prev = cuv + delta;
	float after = d - cur;
	float before = ( 1.0 - textureGrad( hmap, prev, ddx, ddy ).${ch} ) - cur + layer;
	vec2 hit = mix( cuv, prev, clamp( after / max( after - before, 1e-4 ), 0.0, 1.0 ) );
	hitHeight = textureGrad( hmap, hit, ddx, ddy ).${ch};
	return hit;
}
`;

const VERTEX_WORLD = /* glsl */ `
	vec4 codWorld4 = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		codWorld4 = batchingMatrix * codWorld4;
	#endif
	#ifdef USE_INSTANCING
		codWorld4 = instanceMatrix * codWorld4;
	#endif
	vCodWorldPos = ( modelMatrix * codWorld4 ).xyz;
`;

const VERTEX_NORMAL = /* glsl */ `
	vec3 codObjN = objectNormal;
	#ifdef USE_BATCHING
		codObjN = mat3( batchingMatrix ) * codObjN;
	#endif
	#ifdef USE_INSTANCING
		codObjN = mat3( instanceMatrix ) * codObjN;
	#endif
	vCodWorldNormal = normalize( mat3( modelMatrix ) * codObjN );
`;

/**
 * Normalised feature description. Everything that changes the generated GLSL
 * must appear here, because `signature()` is the program cache key.
 */
export function makeFeatures(o = {}) {
  return {
    hasMap: !!o.hasMap,
    hasNormal: !!o.hasNormal,
    orm: !!o.orm,
    hasRough: !!o.orm || !!o.hasRough,
    hasMetal: !!o.orm || !!o.hasMetal,
    hasAO: !!o.orm || !!o.hasAO,
    hasHeight: !!o.hasHeight,
    heightChannel: o.heightChannel === 'a' ? 'a' : 'r',
    triplanar: !!o.triplanar,
    detail: !!o.detail,
    pom: !!o.pom,
    procedural: !!o.procedural,
    translucent: !!o.translucent,
    pomMax: o.pomMax | 0,
    uvSource: o.uvSource || 'none',
  };
}

export function signature(f) {
  return (
    'cod1|' +
    (f.hasMap ? 'M' : '') + (f.hasNormal ? 'N' : '') + (f.orm ? 'O' : '') +
    (f.hasRough ? 'R' : '') + (f.hasMetal ? 'X' : '') + (f.hasAO ? 'A' : '') +
    (f.hasHeight ? 'H' + f.heightChannel : '') +
    '|' + (f.triplanar ? 'T' : '') + (f.detail ? 'D' : '') +
    (f.pom ? 'P' + f.pomMax : '') +
    (f.procedural ? 'C' : '') + (f.translucent ? 'L' : '') +
    '|' + f.uvSource
  );
}

const UV_VARYING = {
  map: 'vMapUv',
  normalMap: 'vNormalMapUv',
  roughnessMap: 'vRoughnessMapUv',
  metalnessMap: 'vMetalnessMapUv',
  aoMap: 'vAoMapUv',
  none: 'vec2( 0.0 )',
};

function fragmentPars(f) {
  let s = HELPERS;
  s += '\nuniform float codWetness;\nuniform float codTime;\nuniform float codVertexAO;\n';
  s += 'uniform vec4 codSurface;\nuniform vec4 codSurface2;\nuniform vec4 codRange;\n';
  if (f.triplanar) s += 'uniform float codTriScale;\n';
  if (f.pom) s += 'uniform float codPomSteps;\n';
  if (f.hasHeight) s += 'uniform sampler2D codHeightMap;\n';
  if (f.translucent) s += 'uniform vec3 codTranslucency;\n';
  if (f.procedural) s += 'uniform vec2 codProc;\n';
  if (f.pom) s += POM_FN(Math.max(1, f.pomMax), f.heightChannel);
  return s;
}

/** The surface pass: resolves UVs (POM), samples albedo, applies variation. */
function fragmentSurface(f) {
  const uv = UV_VARYING[f.uvSource] || UV_VARYING.none;
  let s = '\n\t// ---- COD surface ----\n';
  s += `\tfloat codFaceDir = 1.0;
	#ifdef DOUBLE_SIDED
		codFaceDir = gl_FrontFacing ? 1.0 : -1.0;
	#endif
	#ifdef FLAT_SHADED
		vec3 codVN = normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) );
	#else
		vec3 codVN = normalize( vNormal ) * codFaceDir;
	#endif
	vec3 codWN = normalize( vCodWorldNormal ) * codFaceDir;
	vec3 codWP = vCodWorldPos;
	float codViewDist = length( vViewPosition );
	float codFar = smoothstep( codRange.x, codRange.y, codViewDist );
	vec2 codUv = ${uv};
	float codRoughLod = 0.0;
	float codHeight = 0.5;
	float codPuddle = 0.0;
	vec2 codRipple = vec2( 0.0 );
	mat3 codTbn = codTangentFrame( - vViewPosition, codVN, codUv );
`;

  if (f.triplanar) {
    s += '\tvec3 codTriP = codWP * codTriScale;\n\tvec3 codTriW = codTriWeights( codWN );\n';
  }

  if (f.pom && f.hasHeight) {
    s += `\tfloat codSteps = codPomSteps * ( 1.0 - smoothstep( codRange.z, codRange.w, codViewDist ) );\n`;
    if (f.triplanar) {
      // Ground-plane parallax only: the XZ projection dominates on terrain and
      // rubble, and a per-axis march would triple the tap count for no gain.
      s += `\tvec3 codVW = normalize( cameraPosition - codWP );
	vec3 codVts = vec3( codVW.x, codVW.z, max( codVW.y, 0.08 ) );
	float codPomW = codTriW.y;
	vec2 codPomUv = codParallax( codHeightMap, codTriP.xz, codVts, codSurface2.x * codPomW, int( codSteps * codPomW ), codHeight );
	codTriP.xz = codPomUv;
`;
    } else {
      s += `\tvec3 codVts = normalize( normalize( vViewPosition ) * codTbn );
	codUv = codParallax( codHeightMap, codUv, codVts, codSurface2.x * ( 1.0 - codFar * 0.6 ), int( codSteps ), codHeight );
`;
    }
  } else if (f.hasHeight) {
    s += f.triplanar
      ? `\tcodHeight = codTriTex( codHeightMap, codTriP, codTriW ).${f.heightChannel};\n`
      : `\tcodHeight = texture2D( codHeightMap, codUv ).${f.heightChannel};\n`;
  }

  const tap = (map) => (f.triplanar ? `codTriTex( ${map}, codTriP, codTriW )` : `texture2D( ${map}, codUv )`);

  s += '\tvec4 codAlbedo = vec4( 1.0 );\n';
  if (f.hasMap) s += `\tcodAlbedo = ${tap('map')};\n`;

  // One fetch for a packed occlusion/roughness/metalness texture instead of
  // three — worth 6 taps on a triplanar surface.
  s += '\tfloat codAoTex = 1.0;\n\tfloat codRoughTex = 1.0;\n\tfloat codMetalTex = 1.0;\n';
  if (f.orm) {
    s += `\tvec4 codOrm = ${tap('roughnessMap')};
	codAoTex = codOrm.r; codRoughTex = codOrm.g; codMetalTex = codOrm.b;
`;
  } else {
    if (f.hasRough) s += `\tcodRoughTex = ${tap('roughnessMap')}.g;\n`;
    if (f.hasMetal) s += `\tcodMetalTex = ${tap('metalnessMap')}.b;\n`;
    if (f.hasAO) s += `\tcodAoTex = ${tap('aoMap')}.r;\n`;
  }

  // Macro variation, grime and wetness are gated on uniforms rather than
  // compiled out: the branch is coherent across the whole draw call, and it
  // keeps every key on the same program.
  s += `\tfloat codMacro = 0.5;
	if ( codSurface.w > 0.0 ) {
		codMacro = codFbm3( codWP * codSurface.z );
		codMacro = mix( codMacro, codNoise3( codWP * codSurface.z * 0.27 ), 0.45 );
		codAlbedo.rgb *= mix( 1.0 - codSurface.w, 1.0 + codSurface.w * 0.75, codMacro );
	}
`;

  if (f.procedural) {
    // No texture set available: synthesise structure so nothing reads as a
    // flat default-grey plane.
    s += `\tfloat codProcH = codNoise3( codWP * codProc.x );
	float codProcF = codNoise3( codWP * codProc.x * 4.7 ) * ( 1.0 - codFar );
	codAlbedo.rgb *= mix( 0.80, 1.16, codProcH ) * mix( 0.9, 1.1, codProcF );
	codHeight = codProcH;
`;
  } else if (!f.hasHeight) {
    s += '\tcodHeight = codFbm2( codWP.xz * 1.7 );\n';
  }

  // Rain and traffic wash the top of a wall and leave the bottom filthy;
  // horizontal ledges collect pale dust instead.
  s += `\tfloat codGrime = 0.0;
	if ( codSurface2.w > 0.0 ) {
		float codStreak = codFbm2( vec2( ( codWP.x + codWP.z ) * 1.15, codWP.y * 0.13 ) );
		codGrime = clamp( codSurface2.w * ( 1.0 - abs( codWN.y ) ) * ( 1.0 - smoothstep( 0.0, 2.6, codWP.y ) ) * ( 0.15 + 1.05 * codStreak ), 0.0, 1.0 );
		float codDust = clamp( codSurface2.w * smoothstep( 0.35, 0.95, codWN.y ) * ( 0.3 + 0.9 * codMacro ), 0.0, 1.0 );
		codAlbedo.rgb = mix( codAlbedo.rgb, codAlbedo.rgb * vec3( 0.52, 0.49, 0.45 ), codGrime * 0.75 );
		codAlbedo.rgb = mix( codAlbedo.rgb, mix( codAlbedo.rgb, vec3( 0.40, 0.37, 0.33 ), 0.5 ), codDust * 0.5 );
	}
`;

  if (f.hasHeight || f.procedural) {
    s += '\tcodAlbedo.rgb *= mix( 1.0, 0.45 + 0.55 * codHeight, 0.55 );\n';
  }

  s += `\tfloat codWetAmt = 0.0;
	if ( codWetness > 0.0 ) {
		codWetAmt = codWetness * codSurface2.y;
		// Water pools by terrain shape, not by grain: the pooling field is
		// metres-scale, the texture height only feathers the edge.
		float codPoolH = codFbm2( codWP.xz * 0.55 ) * 0.78 + codHeight * 0.22;
		float codUpFace = smoothstep( 0.45, 0.82, codWN.y );
		float codLevel = codWetness * codSurface2.z * codUpFace * ( 0.1 + 0.95 * codFbm2( codWP.xz * 0.19 + 31.7 ) );
		codPuddle = smoothstep( codLevel, codLevel - 0.09, codPoolH );
		// Water in the pores raises the effective albedo exponent.
		codAlbedo.rgb = pow( max( codAlbedo.rgb, vec3( 1e-4 ) ), vec3( 1.0 + 0.7 * codWetAmt ) );
		codAlbedo.rgb *= mix( 1.0, 0.55, codPuddle );
		float codRt = codTime * 1.6;
		codRipple = vec2(
			sin( dot( codWP.xz, vec2( 9.7, 5.3 ) ) + codRt ) + 0.6 * sin( dot( codWP.xz, vec2( -4.1, 11.3 ) ) - codRt * 1.37 ),
			sin( dot( codWP.xz, vec2( -6.1, 8.9 ) ) + codRt * 0.9 ) + 0.6 * sin( dot( codWP.xz, vec2( 12.7, 3.1 ) ) + codRt * 1.11 )
		) * 0.03 * codPuddle * codWetness;
	}
`;

  s += f.hasMap ? '\tdiffuseColor *= codAlbedo;\n' : '\tdiffuseColor.rgb *= codAlbedo.rgb;\n';
  return s;
}

function fragmentRoughness(f) {
  let s = '\tfloat roughnessFactor = roughness * codRoughTex;\n';
  // Distance roughness floor. By 200 m the roughness map has mipped to its own
  // mean and the normal map to a flat average, so the GGX lobe that the micro
  // geometry should have shattered becomes a coherent mirror of the sky dome —
  // that is the wet-looking sheen on the far ground plate. A real fix is
  // Toksvig/LEAN; this is the one-line stand-in that costs a length() the
  // fragment already has. 0.32 at 0 m (inert under ~12 m for any real surface),
  // 0.50 at 30 m, 0.92 at 100 m, capped so nothing goes fully Lambertian.
  s += '\troughnessFactor = max( roughnessFactor, min( 0.94, 0.32 + codViewDist * 0.0060 ) );\n';
  s += `\troughnessFactor = clamp( roughnessFactor + ( codMacro - 0.5 ) * codSurface.w * 1.2, 0.035, 1.0 );
	roughnessFactor = mix( roughnessFactor, 0.97, codGrime * 0.5 );
	roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.42 + 0.05, codWetAmt * 0.9 );
	roughnessFactor = mix( roughnessFactor, 0.035, codPuddle );
`;
  return s;
}

function fragmentMetalness(f) {
  return '\tfloat metalnessFactor = metalness * codMetalTex;\n';
}

function fragmentNormal(f) {
  const detailFade = 'mix( 1.0, 0.42, codFar )';
  if (f.hasNormal && f.triplanar) {
    let s = `\tvec3 codWNormal = codTriNormal( normalMap, codTriP, codWN, codTriW, normalScale.x * ${detailFade} );\n`;
    if (f.detail) {
      s += `\tif ( codSurface.y > 0.0 ) {
		vec3 codWDetail = codTriNormal( normalMap, codTriP * codSurface.x + 5.7, codWN, codTriW, codSurface.y * ( 1.0 - codFar ) );
		codWNormal = normalize( codWNormal + ( codWDetail - codWN ) );
		codRoughLod += codSurface.y * codFar * 0.11;
	}
`;
    }
    s += '\tcodWNormal = normalize( mix( codWNormal, normalize( vec3( codRipple.x, 1.0, codRipple.y ) ), codPuddle ) );\n';
    s += '\tnormal = normalize( ( viewMatrix * vec4( codWNormal, 0.0 ) ).xyz );\n';
    return s;
  }
  if (f.hasNormal) {
    let s = `\tvec3 codMapN = texture2D( normalMap, codUv ).xyz * 2.0 - 1.0;
	codMapN.xy *= normalScale * ${detailFade};
`;
    if (f.detail) {
      // Same normal map re-tiled and rotated 34 degrees: high-frequency break-up
      // for free, reoriented onto the base normal so the base survives.
      s += `\tif ( codSurface.y > 0.0 ) {
		vec2 codDetailUv = COD_DETAIL_ROT * ( codUv * codSurface.x ) + 7.31;
		vec3 codDetailN = texture2D( normalMap, codDetailUv ).xyz * 2.0 - 1.0;
		codDetailN.xy *= codSurface.y * ( 1.0 - codFar );
		codMapN = codRNM( codMapN, codDetailN );
		codRoughLod += codSurface.y * codFar * 0.11;
	}
`;
    }
    s += '\tcodMapN = normalize( mix( codMapN, vec3( codRipple, 1.0 ), codPuddle ) );\n';
    s += '\tnormal = normalize( codTbn * codMapN );\n';
    return s;
  }
  if (f.procedural) {
    // Gradient of the same noise that drives the fallback albedo.
    let s = `\tvec3 codT1 = normalize( abs( codWN.y ) < 0.98 ? cross( codWN, vec3( 0.0, 1.0, 0.0 ) ) : vec3( 1.0, 0.0, 0.0 ) );
	vec3 codT2 = cross( codWN, codT1 );
	vec3 codPp = codWP * codProc.x * 4.7;
	float codPa = codNoise3( codPp + codT1 * 0.42 );
	float codPb = codNoise3( codPp + codT2 * 0.42 );
	vec3 codPn = normalize( codWN - ( codT1 * ( codPa - codProcF ) + codT2 * ( codPb - codProcF ) ) * codProc.y * ( 1.0 - codFar ) );
	normal = normalize( ( viewMatrix * vec4( codPn, 0.0 ) ).xyz );
`;
    s += '\tnormal = normalize( mix( normal, codVN, codPuddle ) );\n';
    return s;
  }
  return '\tnormal = normalize( mix( normal, normalize( codTbn * vec3( codRipple, 1.0 ) ), codPuddle ) );\n';
}

function fragmentAO(f) {
  let s = '\tfloat codAO = codAoTex;\n';
  // Level and prop geometry bakes ambient occlusion into vertex colours; the
  // diffuse multiply happens in color_fragment, this occludes the specular.
  s += `\t#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
		codAO *= mix( 1.0, clamp( dot( vColor.rgb, vec3( 0.3333 ) ), 0.0, 1.0 ), codVertexAO );
	#endif
`;
  if (f.hasHeight || f.procedural) s += '\tcodAO *= mix( 1.0, 0.32 + 0.68 * codHeight, 0.5 );\n';
  s += `\treflectedLight.indirectDiffuse *= codAO;
	#if defined( USE_CLEARCOAT )
		clearcoatSpecularIndirect *= codAO;
	#endif
	#if defined( USE_SHEEN )
		sheenSpecularIndirect *= codAO;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( saturate( dot( geometryNormal, geometryViewDir ) ), codAO, material.roughness );
		// Distance IBL rolloff. Even with the roughness floor, a mip-flattened
		// surface at 200 m still returns a clean sky-dome reflection that reads
		// as wet tarmac. Real aerial perspective would have eaten most of that
		// specular energy before it reached the camera; take 65% of it away.
		reflectedLight.indirectSpecular *= mix( 1.0, 0.35, codFar );
	#endif
`;
  return s;
}

// Specular anti-aliasing: three already folds in the geometric normal's
// screen-space variance, but not the normal map's. Without this every distant
// normal-mapped surface crawls with shimmer.
const SPECULAR_AA = /* glsl */ `
	vec3 codNdxy = max( abs( dFdx( normal ) ), abs( dFdy( normal ) ) );
	float codNvar = max( max( codNdxy.x, codNdxy.y ), codNdxy.z );
	material.roughness = clamp( material.roughness + codRoughLod + codNvar * 0.55 + codFar * 0.22, 0.0525, 1.0 );
`;

const TRANSLUCENCY = /* glsl */ `
void RE_Direct_CodFoliage( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	float codBack = pow( saturate( dot( geometryViewDir, - directLight.direction ) ), 2.5 );
	float codWrap = saturate( ( dot( geometryNormal, directLight.direction ) + 0.6 ) / 1.6 ) * 0.30;
	reflectedLight.directDiffuse += directLight.color * ( codBack * 1.25 + codWrap ) * codTranslucency * material.diffuseColor;
}
#undef RE_Direct
#define RE_Direct RE_Direct_CodFoliage
`;

/**
 * Installs the surface shader on `material`. `uniforms` is a map of live
 * `{ value }` objects; globals (wetness, time) are shared across every
 * material so a single write updates the whole world.
 */
export function applySurfaceShader(material, features, uniforms) {
  const f = makeFeatures(features);
  const key = signature(f);
  material.codUniforms = uniforms;
  material.codSignature = key;
  material.onBeforeCompile = (shader) => {
    for (const k in uniforms) shader.uniforms[k] = uniforms[k];

    let v = shader.vertexShader;
    v = v.replace(ANCHOR.common, ANCHOR.common + '\nvarying vec3 vCodWorldPos;\nvarying vec3 vCodWorldNormal;\n');
    v = v.replace(ANCHOR.projectVertex, ANCHOR.projectVertex + VERTEX_WORLD);
    v = v.replace(ANCHOR.defaultNormal, ANCHOR.defaultNormal + VERTEX_NORMAL);
    shader.vertexShader = v;

    let s = shader.fragmentShader;
    s = s.replace(ANCHOR.common, ANCHOR.common + '\n' + fragmentPars(f));
    s = s.replace(ANCHOR.map, fragmentSurface(f));
    s = s.replace(ANCHOR.roughness, fragmentRoughness(f));
    s = s.replace(ANCHOR.metalness, fragmentMetalness(f));
    s = s.replace(ANCHOR.normalMaps, fragmentNormal(f));
    s = s.replace(ANCHOR.physical, ANCHOR.physical + SPECULAR_AA);
    s = s.replace(ANCHOR.aomap, fragmentAO(f));
    if (f.translucent) s = s.replace(ANCHOR.lightsPars, ANCHOR.lightsPars + TRANSLUCENCY);
    shader.fragmentShader = s;
  };
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
  return key;
}

/** Re-attach the shader hooks lost by `Material.copy()` when cloning. */
export function inheritSurfaceShader(clone, base) {
  clone.onBeforeCompile = base.onBeforeCompile;
  clone.customProgramCacheKey = base.customProgramCacheKey;
  clone.codUniforms = base.codUniforms;
  clone.codSignature = base.codSignature;
  return clone;
}
