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
    this.lastPlayerPos = new THREE.Vector3(0, -100, 0);
    
    // Initialize the trail persistence system (FBO)
    this.initTrailSystem();
    
    // Create the main grass mesh
    this.mesh = this.createGrassMesh(getTerrainHeight);
    scene.add(this.mesh);
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

  createGrassMesh(getTerrainHeight) {
    // 1. Improved Geometry
    const grassHeight = 0.8; 
    const grassWidth = 0.022; 
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

    // 2. Advanced Shader Material
    const grassMat = new THREE.MeshStandardMaterial({
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
    
    // 3. Instancing with Extreme Density
    const instanceCount = 5000000; 
    const mesh = new THREE.InstancedMesh(grassGeo, grassMat, instanceCount);
    mesh.receiveShadow = true;
    mesh.castShadow = false; 

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const range = 200; 

    let idx = 0;
    while(idx < instanceCount) {
      const x = (Math.random() - 0.5) * range;
      const z = (Math.random() - 0.5) * range;
      
      const y = getTerrainHeight(x, z);
      dummy.position.set(x, y, z);
      
      dummy.rotation.y = Math.random() * Math.PI * 2;
      dummy.rotation.x = (Math.random() - 0.5) * 0.2; 
      dummy.rotation.z = (Math.random() - 0.5) * 0.2;

      // Region based height
      const region = noise(x * 0.015, z * 0.015); 
      // Fix: smoothstep is not global, use THREE.MathUtils
      const tallFactor = THREE.MathUtils.smoothstep(region, 0.0, 0.8);
      
      // Much more height variation
      // Base height 0.4, up to 1.4 in tall regions
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
    
    return mesh;
  }

  update(time, dt, playerPosition) {
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
  }
}

