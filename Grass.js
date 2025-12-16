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
    // 1. Render Target for storing trails (double buffered or just autoClear false)
    // We use a single buffer and draw a semi-transparent black quad to "fade" it over time
    const res = 512; // Resolution of the trail map
    this.trailTarget = new THREE.WebGLRenderTarget(res, res, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RedFormat, // Only need 1 channel for displacement height
      type: THREE.HalfFloatType, // Smoother gradients
    });
    
    this.uniforms.uTrailMap.value = this.trailTarget.texture;

    // 2. Scene for the trail rendering
    this.trailScene = new THREE.Scene();
    
    // 3. Camera covering the terrain (Ortho looking down)
    // Terrain is 200x200, centered at 0,0
    const halfSize = 100;
    this.trailCamera = new THREE.OrthographicCamera(-halfSize, halfSize, halfSize, -halfSize, 0.1, 100);
    this.trailCamera.position.set(0, 50, 0);
    this.trailCamera.lookAt(0, 0, 0);

    // 4. "Brush" - The player's footprint influence
    // A soft gradient circle
    const brushGeo = new THREE.PlaneGeometry(1.2, 1.2); // Small, accurate footprint size
    const brushMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending, // Additive to accumulate steps
      side: THREE.DoubleSide
    });
    
    // Generate soft circular gradient texture for brush
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255, 255, 255, 1.0)'); // Strong center
    grd.addColorStop(0.5, 'rgba(255, 255, 255, 0.5)');
    grd.addColorStop(1, 'rgba(0, 0, 0, 0)'); // Soft edge
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 64, 64);
    
    const brushTex = new THREE.CanvasTexture(canvas);
    brushMat.map = brushTex;
    brushMat.alphaMap = brushTex;
    
    this.brush = new THREE.Mesh(brushGeo, brushMat);
    this.brush.rotation.x = -Math.PI / 2;
    this.trailScene.add(this.brush);
    
    // 5. "Fade" Quad - Diminishes trails over time (Recovery)
    const fadeGeo = new THREE.PlaneGeometry(200, 200);
    const fadeMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.03, // Low opacity = Slow recovery (long persistence)
      side: THREE.DoubleSide
    });
    this.fadeQuad = new THREE.Mesh(fadeGeo, fadeMat);
    this.fadeQuad.rotation.x = -Math.PI / 2;
    this.fadeQuad.position.y = -0.1; // Behind brush
    this.trailScene.add(this.fadeQuad);
  }

  createGrassMesh(getTerrainHeight) {
    // 1. Improved Geometry
    // Thinner, denser, simpler geometry for performance with high count
    const grassHeight = 0.65; // Slightly shorter overall
    const grassWidth = 0.08;  // Thinner blades
    const segments = 4;       // Adequate for bending
    
    const grassGeo = new THREE.PlaneGeometry(grassWidth, grassHeight, 1, segments);
    grassGeo.translate(0, grassHeight / 2, 0); 
    
    // Tapering
    const posAttribute = grassGeo.attributes.position;
    for (let i = 0; i < posAttribute.count; i++) {
      const y = posAttribute.getY(i);
      const hNorm = y / grassHeight;
      const widthScale = 1.0 - Math.pow(hNorm, 1.5); // Sharp taper
      const x = posAttribute.getX(i);
      posAttribute.setX(i, x * widthScale); 
      
      // Pre-bend curve
      const curve = hNorm * hNorm * 0.2;
      posAttribute.setZ(i, posAttribute.getZ(i) - curve);
    }
    grassGeo.computeVertexNormals();

    // 2. Advanced Shader Material
    const grassMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, 
      roughness: 1.0, 
      metalness: 0.0,
      side: THREE.DoubleSide,
      flatShading: false, // Smooth shading for volume feel
      onBeforeCompile: (shader) => {
        Object.assign(shader.uniforms, this.uniforms);
        
        const noiseChunks = `
            // 3D Simplex Noise
            vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
            vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
            vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }
            float snoise(vec2 v){
                const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
                vec2 i  = floor(v + dot(v, C.yy) );
                vec2 x0 = v -   i + dot(i, C.xx);
                vec2 i1;
                i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
                vec4 x12 = x0.xyxy + C.xxzz;
                x12.xy -= i1;
                i = mod289(i);
                vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 )) + i.x + vec3(0.0, i1.x, 1.0 ));
                vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
                m = m*m ;
                m = m*m ;
                vec3 x = 2.0 * fract(p * C.www) - 1.0;
                vec3 h = abs(x) - 0.5;
                vec3 ox = floor(x + 0.5);
                vec3 a0 = x - ox;
                m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
                vec3 g;
                g.x  = a0.x  * x0.x  + h.x  * x0.y;
                g.yz = a0.yz * x12.xz + h.yz * x12.yw;
                return 130.0 * dot(m, g);
            }
        `;

        shader.vertexShader = `
          uniform float uTime;
          uniform vec3 uPlayerPos;
          uniform vec3 uPlayerVel;
          uniform sampler2D uTrailMap;
          uniform float uTerrainSize;
          
          varying float vHeight;
          varying vec3 vInstanceColor;
          varying vec3 vWorldPosition;
          ${noiseChunks}
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

          // --- WIND ANIMATION ---
          float time = uTime * 0.8;
          float swell = snoise(worldPos.xz * 0.05 + time * 0.4); 
          float flutter = snoise(worldPos.xz * 0.8 + time * 2.0); 
          float windForce = swell * 1.0 + flutter * 0.4;
          
          // Bend factor (zero at bottom, high at top)
          float bend = pow(vHeight, 2.0); // Elastic bending
          
          transformed.x += windForce * bend * 0.3; // Gentle wind
          transformed.z += windForce * bend * 0.1;
          
          // --- PLAYER INTERACTION (HYBRID) ---
          
          // 1. Sample Trail Map (Persistent displacement)
          vec2 mapUV = (worldPos.xz + (uTerrainSize * 0.5)) / uTerrainSize;
          // Clamp UV to avoid edge artifacts
          mapUV = clamp(mapUV, 0.0, 1.0);
          float trailValue = texture2D(uTrailMap, mapUV).r;
          
          // 2. Immediate Interaction (Elastic collision)
          float dist = distance(worldPos.xz, uPlayerPos.xz);
          float radius = 0.6; // Small radius for accurate feet
          float immediatePush = 1.0 - smoothstep(0.0, radius, dist);
          immediatePush = pow(immediatePush, 2.0);
          
          vec2 pushDir = normalize(worldPos.xz - uPlayerPos.xz);
          if (length(worldPos.xz - uPlayerPos.xz) < 0.01) pushDir = vec2(1.0, 0.0);

          // Combine Forces
          // Trail creates a "squashed" downward effect
          // Immediate creates a "push away" effect
          
          float totalEffect = max(trailValue * 0.8, immediatePush);
          
          // Apply flattening (Squash)
          // As trailValue increases, y goes to 0
          transformed.y *= (1.0 - totalEffect * 0.8);
          
          // Apply directional bend (Push)
          // Immediate push is directional. Trail is somewhat chaotic/downward.
          // We add random spread for trail to look like trampled mess
          float randAngle = snoise(worldPos.xz) * 6.28;
          vec2 messyDir = vec2(cos(randAngle), sin(randAngle));
          
          vec2 finalDir = mix(messyDir, pushDir, immediatePush); // Immediate overrides chaos
          
          float pushStrength = 0.5;
          transformed.x += finalDir.x * totalEffect * pushStrength * vHeight;
          transformed.z += finalDir.y * totalEffect * pushStrength * vHeight;

          // Fake Volume Normal
          objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), 0.6));
          `
        );

        shader.fragmentShader = `
          varying float vHeight;
          varying vec3 vInstanceColor;
        ` + shader.fragmentShader;
        
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `
          vec3 bottomColor = vec3(0.02, 0.1, 0.01);
          vec3 topColor = vec3(0.25, 0.55, 0.1);
          
          vec3 finalColor = mix(bottomColor, topColor, vHeight);
          finalColor *= vInstanceColor;
          
          // Ambient Occlusion at base
          finalColor *= smoothstep(-0.1, 0.25, vHeight);

          diffuseColor.rgb = finalColor;
          `
        );
        
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            `
            #include <dithering_fragment>
            // Subsurface scattering fake
            gl_FragColor.rgb += vec3(0.1, 0.2, 0.0) * pow(vHeight, 4.0) * 0.5;
            `
        );
      }
    });
    
    // 3. Instancing with High Density
    const instanceCount = 700000; // Increased density
    const mesh = new THREE.InstancedMesh(grassGeo, grassMat, instanceCount);
    mesh.receiveShadow = true;
    mesh.castShadow = false; 

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const range = 200; // Full terrain coverage

    let idx = 0;
    while(idx < instanceCount) {
      const x = (Math.random() - 0.5) * range;
      const z = (Math.random() - 0.5) * range;
      
      const y = getTerrainHeight(x, z);
      dummy.position.set(x, y, z);
      
      // Random rotation
      dummy.rotation.y = Math.random() * Math.PI * 2;
      dummy.rotation.x = (Math.random() - 0.5) * 0.3; // Less tilt initially
      dummy.rotation.z = (Math.random() - 0.5) * 0.3;

      // Region based height
      const region = noise(x * 0.02, z * 0.02); 
      const tallFactor = Math.max(0.0, region);    
      
      // Varied height but always present
      const hScale = 0.6 + Math.random() * 0.6 + (tallFactor * 1.0);
      const wScale = 0.8 + Math.random() * 0.4;
      
      dummy.scale.set(wScale, hScale, wScale);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);
      
      // Color Variation
      const colorNoise = noise(x * 0.05, z * 0.05); 
      if (colorNoise > 0.5) {
         color.setHex(0x8a9a5b); // Dry patches
      } else {
         const v = 0.5 + Math.random() * 0.3;
         color.setRGB(v * 0.8, v, v * 0.6); // Lush green
      }
      mesh.setColorAt(idx, color);
      
      idx++;
    }
    
    return mesh;
  }

  update(time, dt, playerPosition) {
    this.uniforms.uTime.value = time;
    
    if (playerPosition) {
      // 1. Update Brush Position for Trails
      this.brush.position.set(playerPosition.x, playerPosition.z, 0); // Z is up in trail scene (2D)? No, using XZ plane
      // Trail camera is looking down Y. Brush is on XZ plane.
      // Brush needs to be on XZ.
      // Wait, Mesh plane geometry is XY by default, rotated -PI/2 to be XZ.
      // So setting position (x, 0, z) is correct.
      this.brush.position.set(playerPosition.x, 0, playerPosition.z);

      // 2. Render to Trail Map
      if (this.renderer && this.trailTarget) {
        const currentRenderTarget = this.renderer.getRenderTarget();
        const currentAutoClear = this.renderer.autoClear;
        
        this.renderer.setRenderTarget(this.trailTarget);
        this.renderer.autoClear = false; // Don't clear, accumulate
        
        // Render Fade Quad (slowly erases old trails)
        this.renderer.render(this.trailScene, this.trailCamera);
        
        this.renderer.setRenderTarget(currentRenderTarget);
        this.renderer.autoClear = currentAutoClear;
      }
      
      // 3. Update Uniforms
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

