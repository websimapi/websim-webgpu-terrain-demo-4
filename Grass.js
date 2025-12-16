import * as THREE from 'three';

// Simplex Noise for wind and variation
function noise(x, z) {
  return Math.sin(x * 0.1) * Math.sin(z * 0.1) + 
         Math.sin(x * 0.3 + 1.2) * Math.cos(z * 0.3 + 2.0) * 0.5;
}

export class GrassSystem {
  constructor(scene, getTerrainHeight, renderer) {
    this.uniforms = { 
      uTime: { value: 0 }, 
      uPlayerPos: { value: new THREE.Vector3(0, -100, 0) },
      uPlayerVel: { value: new THREE.Vector3(0, 0, 0) },
      uTrailMap: { value: null }, // Persistent trail texture
      uTerrainSize: { value: 200.0 } // Size of the terrain square
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
    this.baseMaterial = this.createMaterial();

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

  createMaterial() {
    return new THREE.MeshStandardMaterial({
      color: 0xffffff, 
      roughness: 1.0, 
      metalness: 0.0,
      side: THREE.DoubleSide,
      flatShading: false,
      onBeforeCompile: (shader) => {
        Object.assign(shader.uniforms, this.uniforms);
        
        shader.vertexShader = `
          uniform float uTime;
          uniform vec3 uPlayerPos;
          uniform vec3 uPlayerVel;
          uniform sampler2D uTrailMap;
          uniform float uTerrainSize;
          
          varying float vHeight;
          varying vec3 vInstanceColor;
          varying vec3 vWorldPosition;
        ` + shader.vertexShader;

        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `
          vec3 transformed = vec3( position );
          vHeight = uv.y;
          vInstanceColor = instanceColor;
          
          vec4 instancePosition = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec3 worldPos = (modelMatrix * instancePosition).xyz;
          vWorldPosition = worldPos;

          // --- PLAYER INTERACTION (Calculated first to modulate wind) ---
          
          // 1. Sample Trail Map (Persistent displacement)
          vec2 mapUV = (worldPos.xz + (uTerrainSize * 0.5)) / uTerrainSize;
          mapUV = clamp(mapUV, 0.0, 1.0);
          mapUV.y = 1.0 - mapUV.y; 
          float trailValue = texture2D(uTrailMap, mapUV).r;
          
          // 2. Immediate Interaction
          float dist = distance(worldPos.xz, uPlayerPos.xz);
          float radius = 0.45; 
          float immediatePush = 1.0 - smoothstep(0.0, radius, dist);
          immediatePush = pow(immediatePush, 1.5);
          
          float totalEffect = max(trailValue, immediatePush);
          totalEffect = clamp(totalEffect, 0.0, 1.0);

          // --- WIND ANIMATION (Optimized) ---
          float time = uTime * 0.6;
          // Simple trig for performance with high instance count
          float swell = sin(worldPos.x * 0.05 + worldPos.z * 0.05 + time * 0.5) * 0.5 + 0.5;
          float flutter = sin(worldPos.x * 1.5 + time * 2.0) * cos(worldPos.z * 1.0);
          
          // Dampen wind where grass is trampled so it doesn't slide on ground
          float windDampen = 1.0 - clamp(totalEffect * 1.2, 0.0, 1.0);
          float windForce = (swell * 0.5 + flutter * 0.2) * windDampen;
          
          float bend = pow(vHeight, 2.0); 
          transformed.x += windForce * bend * 0.4; 
          transformed.z += windForce * bend * 0.2;
          
          // --- APPLY INTERACTION DEFORMATION ---
          
          // Flattening
          transformed.y *= (1.0 - totalEffect * 0.95);
          
          // Directional push
          vec2 pushDir = normalize(worldPos.xz - uPlayerPos.xz);
          if (length(worldPos.xz - uPlayerPos.xz) < 0.01) pushDir = vec2(1.0, 0.0);
          
          // Cheap random direction using trig
          vec2 messyDir = vec2(
            sin(worldPos.x * 10.0 + worldPos.z * 3.0), 
            cos(worldPos.x * 7.0 + worldPos.z * 10.0)
          );
          vec2 finalDir = mix(messyDir, pushDir, immediatePush);
          
          float pushStrength = 0.8;
          transformed.x += finalDir.x * totalEffect * pushStrength * vHeight;
          transformed.z += finalDir.y * totalEffect * pushStrength * vHeight;

          objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), 0.7));
          `
        );

        shader.fragmentShader = `
          varying float vHeight;
          varying vec3 vInstanceColor;
        ` + shader.fragmentShader;
        
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `
          vec3 bottomColor = vec3(0.01, 0.08, 0.01);
          vec3 topColor = vec3(0.2, 0.5, 0.1);
          
          vec3 finalColor = mix(bottomColor, topColor, vHeight);
          finalColor *= vInstanceColor;
          
          // AO
          finalColor *= smoothstep(-0.1, 0.3, vHeight);

          diffuseColor.rgb = finalColor;
          `
        );
      }
    });
  }

  initChunks() {
    const terrainSize = 200;
    const chunkSize = 25; // Break into 8x8 grid (64 chunks)
    const density = 250; // High density (approx 2x previous)
    
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
    
    meshBase.castShadow = false;
    meshBase.receiveShadow = true;
    meshDetail.castShadow = false;
    meshDetail.receiveShadow = true;

    this.fillMesh(meshBase, 0, baseCount, startX, startZ, size, dummy, color);
    this.fillMesh(meshDetail, 0, detailCount, startX, startZ, size, dummy, color);

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

  update(time, dt, playerPosition, camera) {
    this.uniforms.uTime.value = time;
    
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

    if (camera) {
      this.updateLOD(camera);
    }
  }

  updateLOD(camera) {
    // LOD Settings
    const distHigh = 32;
    const distLow = 64;
    
    // Reuse vector to prevent garbage collection
    const chunkPos = new THREE.Vector3();
    const camPos = camera.position;

    // Check visibility frustum (optional, InstancedMesh does it too, but we can skip logic)
    // For now, distance based LOD
    
    for (let chunk of this.chunks) {
      chunkPos.copy(chunk.center);
      chunkPos.y = 0; // Ignore height diff for LOD rings
      const dist = chunkPos.distanceTo(new THREE.Vector3(camPos.x, 0, camPos.z));

      if (dist < distHigh) {
        // High Quality: Both meshes visible
        chunk.meshBase.visible = true;
        chunk.meshDetail.visible = true;
      } else if (dist < distLow) {
        // Medium Quality: Only base mesh
        chunk.meshBase.visible = true;
        chunk.meshDetail.visible = false;
      } else {
        // Low Quality: Nothing visible
        chunk.meshBase.visible = false;
        chunk.meshDetail.visible = false;
      }
    }
  }
}

