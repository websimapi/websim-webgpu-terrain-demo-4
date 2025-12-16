import * as THREE from 'three';

// Simplex Noise for wind and variation
function noise(x, z) {
  return Math.sin(x * 0.1) * Math.sin(z * 0.1) + 
         Math.sin(x * 0.3 + 1.2) * Math.cos(z * 0.3 + 2.0) * 0.5;
}

const GRASS_VERTEX_LOGIC = `
  vec3 transformed = vec3( position );
  // Height calculated from position to avoid UV dependency in shadow pass
  vHeight = position.y / 0.8; 

  vec4 instancePosition = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  // Root position of the grass blade for interaction
  vec3 worldPos = (modelMatrix * instancePosition).xyz;
  
  // --- PLAYER INTERACTION ---
  vec2 mapUV = (worldPos.xz + (uTerrainSize * 0.5)) / uTerrainSize;
  mapUV = clamp(mapUV, 0.0, 1.0);
  mapUV.y = 1.0 - mapUV.y; 
  float trailValue = texture2D(uTrailMap, mapUV).r;

  float dist = distance(worldPos.xz, uPlayerPos.xz);
  float radius = 0.5; 
  float immediatePush = 1.0 - smoothstep(0.0, radius, dist);
  // immediatePush = pow(immediatePush, 1.5);

  float totalEffect = max(trailValue, immediatePush);
  totalEffect = clamp(totalEffect, 0.0, 1.0);

  // --- WIND ANIMATION ---
  float windStrength = 1.0 - totalEffect * 0.8; // Reduce wind on crushed grass

  float time = uTime * 0.6;
  float swell = sin(worldPos.x * 0.05 + worldPos.z * 0.05 + time * 0.5) * 0.5 + 0.5;
  float flutter = sin(worldPos.x * 1.5 + time * 2.0) * cos(worldPos.z * 1.0);

  float windForce = (swell * 0.5 + flutter * 0.2) * windStrength;

  // Apply wind bending
  float bend = pow(vHeight, 2.0); 
  float lean = windForce * bend;
  transformed.x += lean * 0.4; 
  transformed.z += lean * 0.2;

  // --- WIND NORMAL ADJUSTMENT ---
  // Tilt normal slightly to match wind direction for correct specular glint
  // Wind dir approx (0.9, 0, 0.4) normalized
  float tilt = lean * 0.5;
  vec3 windAxis = normalize(vec3(-0.2, 0.0, 0.4)); // Perpendicular to wind
  float ct = cos(tilt);
  float st = sin(tilt);
  vec3 nw = objectNormal;
  objectNormal = nw * ct + cross(windAxis, nw) * st + windAxis * dot(windAxis, nw) * (1.0 - ct);

  // --- REALISTIC CRUSHING (Rotation) ---
  // Determine crush direction
  vec2 playerPushDir = normalize(worldPos.xz - uPlayerPos.xz);
  if (length(worldPos.xz - uPlayerPos.xz) < 0.001) playerPushDir = vec2(1.0, 0.0);

  // Stable random direction for old trails
  float randAngle = sin(worldPos.x * 12.9898 + worldPos.z * 78.233) * 43758.5453;
  vec2 noiseDir = vec2(cos(randAngle), sin(randAngle));

  // Blend direction: If immediate interaction, use player dir, else random
  vec2 crushDir2 = mix(noiseDir, playerPushDir, immediatePush);
  vec3 crushDir = normalize(vec3(crushDir2.x, 0.0, crushDir2.y));

  // Rotation Axis (perpendicular to crush direction)
  vec3 rotAxis = normalize(cross(vec3(0.0, 1.0, 0.0), crushDir));

  // Angle
  float crushFactor = smoothstep(0.05, 0.9, totalEffect);
  float angle = crushFactor * 1.4; // Bend up to ~80 degrees

  // Rodrigues Rotation
  float c = cos(angle);
  float s = sin(angle);
  vec3 v = transformed;
  vec3 k = rotAxis;
  vec3 rotated = v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);

  transformed = rotated;

  // Sink slightly to avoid floating base
  transformed.y -= crushFactor * 0.1 * vHeight;

  // Normal adjustment for lighting
  #ifdef USE_SHADOWMAP
     // Shadow pass
  #else
     // Rotate normal for correct lighting
     vec3 n = objectNormal;
     vec3 n_rot = n * c + cross(k, n) * s + k * dot(k, n) * (1.0 - c);
     objectNormal = normalize(n_rot);

     // Mix with Up vector to keep some top-down lighting softness
     objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), 0.2));
  #endif
`;

export class GrassSystem {
  constructor(scene, getTerrainHeight, renderer) {
    this.uniforms = { 
      uTime: { value: 0 }, 
      uPlayerPos: { value: new THREE.Vector3(0, -100, 0) },
      uPlayerVel: { value: new THREE.Vector3(0, 0, 0) },
      uTrailMap: { value: null }, // Persistent trail texture
      uTerrainSize: { value: 200.0 }, // Size of the terrain square
      uSunDir: { value: new THREE.Vector3(0.5, 1.0, 0.5).normalize() }
    };
    
    this.renderer = renderer;
    this.scene = scene;
    this.getTerrainHeight = getTerrainHeight;
    this.lastPlayerPos = new THREE.Vector3(0, -100, 0);
    
    this.group = new THREE.Group();
    scene.add(this.group);

    // Initialize the trail persistence system (FBO)
    this.initTrailSystem();
    
    // Initialize Geometry and Material reused by all chunks
    this.baseGeometry = this.createGeometry();
    this.initMaterials();

    // Create Grass Chunks
    this.chunks = [];
    this.initChunks();
  }

  initTrailSystem() {
    // 1. Render Target for storing trails
    const res = 1024; // Higher resolution for cleaner trails
    this.trailTarget = new THREE.WebGLRenderTarget(res, res, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RedFormat,
      type: THREE.HalfFloatType,
    });
    
    this.uniforms.uTrailMap.value = this.trailTarget.texture;

    // 2. Scene for the trail rendering
    this.trailScene = new THREE.Scene();
    
    // 3. Camera covering the terrain
    // Terrain is 200x200, centered at 0,0
    const halfSize = 100;
    this.trailCamera = new THREE.OrthographicCamera(-halfSize, halfSize, halfSize, -halfSize, 0.1, 100);
    this.trailCamera.position.set(0, 50, 0);
    this.trailCamera.lookAt(0, 0, 0);
    // Orient camera so Top of texture maps to -Z (Standard UV mapping alignment)
    this.trailCamera.up.set(0, 0, -1);

    // 4. "Brush" - The player's footprint influence
    // Smaller brush for accurate feet position
    const brushGeo = new THREE.PlaneGeometry(0.8, 0.8); 
    const brushMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });
    
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255, 255, 255, 1.0)'); 
    grd.addColorStop(0.4, 'rgba(255, 255, 255, 0.8)');
    grd.addColorStop(1, 'rgba(0, 0, 0, 0)'); 
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 64, 64);
    
    const brushTex = new THREE.CanvasTexture(canvas);
    brushMat.map = brushTex;
    brushMat.alphaMap = brushTex;
    
    this.brush = new THREE.Mesh(brushGeo, brushMat);
    this.brush.rotation.x = -Math.PI / 2;
    this.trailScene.add(this.brush);
    
    // 5. "Fade" Quad
    const fadeGeo = new THREE.PlaneGeometry(200, 200);
    const fadeMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.015, // Slower, more natural recovery over time
      side: THREE.DoubleSide
    });
    this.fadeQuad = new THREE.Mesh(fadeGeo, fadeMat);
    this.fadeQuad.rotation.x = -Math.PI / 2;
    this.fadeQuad.position.y = -0.1;
    this.trailScene.add(this.fadeQuad);
  }

  createGeometry() {
    const grassHeight = 0.8; 
    const grassWidth = 0.015; // Thinner as requested
    const segments = 2;       
    
    const grassGeo = new THREE.PlaneGeometry(grassWidth, grassHeight, 1, segments);
    grassGeo.translate(0, grassHeight / 2, 0); 
    
    // Tapering
    const posAttribute = grassGeo.attributes.position;
    for (let i = 0; i < posAttribute.count; i++) {
      const y = posAttribute.getY(i);
      const hNorm = y / grassHeight;
      const widthScale = 1.0 - Math.pow(hNorm, 2.0); // Sharper taper
      const x = posAttribute.getX(i);
      posAttribute.setX(i, x * widthScale); 
      
      const curve = Math.pow(hNorm, 2.0) * 0.3;
      posAttribute.setZ(i, posAttribute.getZ(i) - curve);
    }
    grassGeo.computeVertexNormals();
    return grassGeo;
  }

  initMaterials() {
    const patchShader = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);

      shader.vertexShader = `
        uniform float uTime;
        uniform vec3 uPlayerPos;
        uniform vec3 uPlayerVel;
        uniform sampler2D uTrailMap;
        uniform float uTerrainSize;
        varying float vHeight;
        ${shader.vertexShader}
      `;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        GRASS_VERTEX_LOGIC
      );
    };

    // 1. Visible Material
    this.baseMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, 
      roughness: 0.6, // Variable roughness in shader
      metalness: 0.0,
      side: THREE.DoubleSide,
      flatShading: false,
      onBeforeCompile: (shader) => {
        patchShader(shader);

        shader.fragmentShader = `
          varying float vHeight;
          // vColor is provided by Three.js when USE_INSTANCING_COLOR is active
          // vWorldPosition is provided by MeshStandardMaterial
        ` + shader.fragmentShader;

        // Custom Color & Gradient Mapping
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `
          // AAA Realistic Color Gradient
          vec3 rootColor = vec3(0.01, 0.03, 0.0);   // Dark, soil-occluded base
          vec3 midColor  = vec3(0.12, 0.35, 0.02);  // Rich chlorophyll green
          vec3 tipColor  = vec3(0.45, 0.55, 0.1);   // Translucent, sun-bleached tip
          vec3 dryColor  = vec3(0.5, 0.45, 0.25);   // Dry patches
          
          // Mix based on height
          vec3 gradient = mix(rootColor, midColor, smoothstep(0.0, 0.4, vHeight));
          gradient = mix(gradient, tipColor, smoothstep(0.4, 1.0, vHeight));
          
          // Variation from instance noise (stored in vColor)
          float noise = vColor.r;
          vec3 finalColor = mix(gradient, dryColor, noise * 0.25 + (1.0-vHeight)*0.05);

          // Deep AO at root
          finalColor *= smoothstep(-0.15, 0.2, vHeight);

          diffuseColor.rgb = finalColor;
          `
        );

        // Advanced Roughness (Moisture Response)
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <roughnessmap_fragment>',
          `
          float roughnessFactor = roughness;
          // Base is matte/dusty, Tip is waxy/shiny
          roughnessFactor = mix(0.85, 0.4, vHeight);
          `
        );

        // Custom Lighting: Translucency, Backscattering, Fresnel
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <lights_fragment_end>',
          `
          #include <lights_fragment_end>
          
          // Recover vectors
          vec3 viewDirW = normalize(cameraPosition - vWorldPosition);
          vec3 lightDirW = normalize(uSunDir);
          vec3 normalW = normalize(vNormal); // Interpolated normal
          
          // --- Translucency (Subsurface Scattering) ---
          // Light passing through the thin blade
          // Strongest when looking against the light
          float viewDotLight = max(0.0, dot(viewDirW, -lightDirW));
          float transPower = pow(viewDotLight, 5.0); // Sharp falloff
          
          // Diffusion through thickness (thinner at top)
          float thickness = smoothstep(0.0, 1.0, vHeight); 
          float transIntensity = 2.5 * thickness;
          
          vec3 sssColor = vec3(0.6, 0.8, 0.1); // Inner glow color
          vec3 translucency = sssColor * transPower * transIntensity;
          
          // Only apply translucency if unshadowed (approx) or let it glow slightly in shadow
          // outgoingLight includes direct and indirect. We add emission.
          outgoingLight += translucency * 0.8;

          // --- Fresnel Rim Light ---
          // Grazing angles appear brighter (waxy cuticle)
          float fresnel = pow(1.0 - abs(dot(viewDirW, normalW)), 3.0);
          vec3 fresnelColor = vec3(0.7, 0.9, 0.6) * fresnel * 0.5 * vHeight;
          outgoingLight += fresnelColor;
          
          // --- Wrapped Lighting (Fake GI) ---
          // Soften the harsh black shadows on backfaces
          float wrap = 0.4;
          float NdotL = max(0.0, dot(normalW, lightDirW));
          float wrapLight = max(0.0, (dot(normalW, lightDirW) + wrap) / (1.0 + wrap));
          
          // Boost ambient in shadow areas
          vec3 ambientBoost = vec3(0.05, 0.1, 0.05) * (1.0 - NdotL) * vHeight;
          outgoingLight += ambientBoost;
          `
        );

        // vColor is handled automatically by Three.js for InstancedMesh
        // We just need to inject our height calculation
        shader.vertexShader = shader.vertexShader.replace(
           '#include <begin_vertex>',
           `#include <begin_vertex>
            vHeight = position.y / 0.8;
           `
        );
      }
    });

    // 2. Depth Material (For Shadows)
    this.baseDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      onBeforeCompile: (shader) => {
        patchShader(shader);
      }
    });
  }

  initChunks() {
    const terrainSize = 200;
    const chunkSize = 25; // Break into 8x8 grid (64 chunks)
    const density = 250; 
    
    // Pre-allocate temporary objects
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    
    // Create chunks
    for (let x = -terrainSize/2; x < terrainSize/2; x += chunkSize) {
      for (let z = -terrainSize/2; z < terrainSize/2; z += chunkSize) {
        this.createChunk(x, z, chunkSize, density, dummy, color);
      }
    }
  }

  createChunk(startX, startZ, size, density, dummy, color) {
    const area = size * size;
    const totalInstances = Math.floor(area * density);
    
    // Split into Low LOD (base) and High LOD (detail)
    // Low LOD: 20% of grass, always visible in medium range
    // High LOD: 80% of grass, only visible in close range
    const baseCount = Math.floor(totalInstances * 0.2);
    const detailCount = totalInstances - baseCount;

    const meshBase = new THREE.InstancedMesh(this.baseGeometry, this.baseMaterial, baseCount);
    const meshDetail = new THREE.InstancedMesh(this.baseGeometry, this.baseMaterial, detailCount);
    
    // Enable shadows
    meshBase.castShadow = true;
    meshBase.receiveShadow = true;
    meshDetail.castShadow = true; // Warning: Expensive
    meshDetail.receiveShadow = true;
    
    // Assign custom depth material for correct shadow deformation
    meshBase.customDepthMaterial = this.baseDepthMaterial;
    meshDetail.customDepthMaterial = this.baseDepthMaterial;

    this.fillMesh(meshBase, 0, baseCount, startX, startZ, size, dummy, color);
    this.fillMesh(meshDetail, 0, detailCount, startX, startZ, size, dummy, color);

    meshBase.instanceColor.needsUpdate = true;
    meshDetail.instanceColor.needsUpdate = true;

    this.group.add(meshBase);
    this.group.add(meshDetail);
    
    // Store chunk info for LOD updates
    this.chunks.push({
      center: new THREE.Vector3(startX + size/2, 0, startZ + size/2),
      meshBase: meshBase,
      meshDetail: meshDetail,
      size: size
    });
  }

  fillMesh(mesh, offset, count, startX, startZ, size, dummy, color) {
    let idx = 0;
    while(idx < count) {
      const x = startX + Math.random() * size;
      const z = startZ + Math.random() * size;
      
      const y = this.getTerrainHeight(x, z);
      dummy.position.set(x, y, z);
      
      dummy.rotation.y = Math.random() * Math.PI * 2;
      dummy.rotation.x = (Math.random() - 0.5) * 0.2; 
      dummy.rotation.z = (Math.random() - 0.5) * 0.2;

      // Region based height
      const region = noise(x * 0.015, z * 0.015); 
      const tallFactor = THREE.MathUtils.smoothstep(region, 0.0, 0.8);
      
      // Height variation
      const hScale = 0.4 + Math.random() * 0.4 + (tallFactor * 0.8);
      
      // Thinner stands
      const wScale = 0.5 + Math.random() * 0.5;
      
      dummy.scale.set(wScale, hScale, wScale);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);
      
      // Color Variation
      const colorNoise = noise(x * 0.05, z * 0.05); 
      if (colorNoise > 0.6) {
         color.setHex(0x7a8a4b); 
      } else {
         const v = 0.5 + Math.random() * 0.4;
         color.setRGB(v * 0.6, v * 0.9, v * 0.4); 
      }
      mesh.setColorAt(idx, color);
      
      idx++;
    }
  }

  update(time, dt, playerPosition, camera, sunDirection, lodHigh = 128, lodLow = 256) {
    this.uniforms.uTime.value = time;
    if (sunDirection) this.uniforms.uSunDir.value.copy(sunDirection);
    
    if (playerPosition) {
      this.brush.position.set(playerPosition.x, 0, playerPosition.z);

      if (this.renderer && this.trailTarget) {
        const currentRenderTarget = this.renderer.getRenderTarget();
        const currentAutoClear = this.renderer.autoClear;
        
        this.renderer.setRenderTarget(this.trailTarget);
        this.renderer.autoClear = false; 
        
        this.renderer.render(this.trailScene, this.trailCamera);
        
        this.renderer.setRenderTarget(currentRenderTarget);
        this.renderer.autoClear = currentAutoClear;
      }
      
      this.uniforms.uPlayerPos.value.copy(playerPosition);
      
      if (dt > 0.0001) {
        const vel = new THREE.Vector3()
          .subVectors(playerPosition, this.lastPlayerPos)
          .divideScalar(dt);
        this.uniforms.uPlayerVel.value.copy(vel);
      }
      this.lastPlayerPos.copy(playerPosition);
    }

    if (playerPosition && camera) {
      this.updateLOD(playerPosition, camera, lodHigh, lodLow);
    }
  }

  updateLOD(playerPosition, camera, distHigh, distLow) {
    const px = playerPosition.x;
    const pz = playerPosition.z;

    // Get camera forward direction projected on XZ
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    fwd.y = 0;
    fwd.normalize();
    const fx = fwd.x;
    const fz = fwd.z;

    // Calculate LOD Oval Centers
    // We shift the center of the LOD area forward so the "edge" is just behind the camera
    // and the majority of the detail is projected in front.
    
    // High Detail: Shift significantly forward
    const shiftHigh = distHigh * 0.75; 
    const chx = px + fx * shiftHigh;
    const chz = pz + fz * shiftHigh;

    // Low Detail: Shift moderately
    const shiftLow = distLow * 0.4;
    const clx = px + fx * shiftLow;
    const clz = pz + fz * shiftLow;

    // Aspect ratio > 1.0 compresses the width, making the field an oval
    const aspect = 1.4; 

    for (let chunk of this.chunks) {
      const cx = chunk.center.x;
      const cz = chunk.center.z;

      // --- High LOD Check ---
      const dxH = cx - chx;
      const dzH = cz - chz;
      
      // Project vector onto forward axis
      const fDistH = dxH * fx + dzH * fz;
      
      // Project vector onto right axis (rejection)
      const sxH = dxH - fx * fDistH;
      const szH = dzH - fz * fDistH;
      
      // Elliptical distance: (forward)^2 + (side * aspect)^2
      const dSqH = fDistH*fDistH + (sxH*sxH + szH*szH) * aspect * aspect;
      
      const isHigh = dSqH < (distHigh * distHigh);

      if (isHigh) {
        chunk.meshBase.visible = true;
        chunk.meshDetail.visible = true;
        continue;
      }

      // --- Low LOD Check ---
      const dxL = cx - clx;
      const dzL = cz - clz;
      
      const fDistL = dxL * fx + dzL * fz;
      const sxL = dxL - fx * fDistL;
      const szL = dzL - fz * fDistL;
      
      // Slightly wider oval for low LOD background
      const aspectLow = aspect * 0.8;
      const dSqL = fDistL*fDistL + (sxL*sxL + szL*szL) * aspectLow * aspectLow;
      
      const isLow = dSqL < (distLow * distLow);

      chunk.meshBase.visible = isLow;
      chunk.meshDetail.visible = false;
    }
  }
}

