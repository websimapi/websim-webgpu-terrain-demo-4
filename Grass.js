import * as THREE from 'three';

// Simple distribution noise to create clumps
function noise(x, z) {
  return Math.sin(x * 0.1) * Math.sin(z * 0.1) + 
         Math.sin(x * 0.3 + 1.2) * Math.cos(z * 0.3 + 2.0) * 0.5;
}

export class GrassSystem {
  constructor(scene, getTerrainHeight) {
    this.uniforms = { 
      uTime: { value: 0 }, 
      uPlayerPos: { value: new THREE.Vector3(0, -100, 0) } 
    };
    
    this.mesh = this.createGrassMesh(getTerrainHeight);
    scene.add(this.mesh);
  }

  createGrassMesh(getTerrainHeight) {
    // 1. Improved Geometry
    // Taller grass, more segments for smooth bending (curvature)
    const grassHeight = 0.5;
    const segments = 5; 
    const grassGeo = new THREE.PlaneGeometry(0.12, grassHeight, 1, segments);
    grassGeo.translate(0, grassHeight / 2, 0); 
    
    // Manual Tapering in JS to create blade shape
    const posAttribute = grassGeo.attributes.position;
    for (let i = 0; i < posAttribute.count; i++) {
      const y = posAttribute.getY(i);
      const hNorm = y / grassHeight;
      
      // Quadratic taper for leaf shape
      const widthScale = 1.0 - Math.pow(hNorm, 1.8);
      
      const x = posAttribute.getX(i);
      posAttribute.setX(i, x * widthScale); 
    }
    grassGeo.computeVertexNormals();

    // 2. Advanced Shader Material
    const grassMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, 
      roughness: 0.8, // Rough grass
      metalness: 0.0,
      side: THREE.DoubleSide,
      flatShading: false,
      onBeforeCompile: (shader) => {
        shader.uniforms.uTime = this.uniforms.uTime;
        shader.uniforms.uPlayerPos = this.uniforms.uPlayerPos;
        
        // --- NOISE FUNCTIONS FOR WIND ---
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
          // Combine multiple frequencies for turbulence
          float swell = snoise(worldPos.xz * 0.04 + time * 0.3); // Large waves
          float flutter = snoise(worldPos.xz * 0.6 + time * 1.8); // Small jitters
          float windForce = swell * 0.7 + flutter * 0.3;
          
          // Bend factor (zero at bottom, high at top)
          float bend = pow(vHeight, 1.8);
          
          transformed.x += windForce * bend * 0.4;
          transformed.z += windForce * bend * 0.15;
          transformed.y -= abs(windForce) * bend * 0.15; // Dip down on swing

          // --- PLAYER INTERACTION ---
          float dist = distance(worldPos.xz, uPlayerPos.xz);
          float radius = 1.0;
          if(dist < radius){
             float push = 1.0 - smoothstep(0.0, radius, dist);
             vec2 dir = normalize(worldPos.xz - uPlayerPos.xz);
             
             // Strong push
             transformed.x += dir.x * push * 1.2 * vHeight;
             transformed.z += dir.y * push * 1.2 * vHeight;
             
             // Flatten
             transformed.y *= (1.0 - push * 0.7);
          }

          // --- NORMAL TWEAKING (For fake volume lighting) ---
          // Mix normal with Up vector to simulate light scattering through volume
          // and prevent harsh black backsides
          objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), 0.4));
          `
        );

        shader.fragmentShader = `
          varying float vHeight;
          varying vec3 vInstanceColor;
        ` + shader.fragmentShader;
        
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `
          // Gradient from dark earth to lush green
          vec3 bottomColor = vec3(0.1, 0.2, 0.02);
          vec3 topColor = vec3(0.35, 0.65, 0.1);
          
          vec3 finalColor = mix(bottomColor, topColor, vHeight);
          
          // Apply instance variation (dry/wet patches)
          finalColor *= vInstanceColor;
          
          // Ambient Occlusion Hack: Darken the very bottom significantly
          finalColor *= smoothstep(-0.1, 0.2, vHeight);

          diffuseColor.rgb = finalColor;
          `
        );

        // --- SUBSURFACE SCATTERING FAKE ---
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            `
            #include <dithering_fragment>
            
            // Add a glow to the tips to simulate sun passing through
            gl_FragColor.rgb += vec3(0.1, 0.15, 0.0) * pow(vHeight, 2.0) * 0.4;
            `
        );
      }
    });
    
    // 3. Instancing with Clumping
    const instanceCount = 180000;
    const mesh = new THREE.InstancedMesh(grassGeo, grassMat, instanceCount);
    mesh.receiveShadow = true;
    mesh.castShadow = false; // Performance optimization

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const range = 200;

    let idx = 0;
    while(idx < instanceCount) {
      const x = (Math.random() - 0.5) * range;
      const z = (Math.random() - 0.5) * range;
      
      // Clump distribution using noise
      const n = noise(x, z);
      // Skip some spots to create natural gaps/paths
      if (n < -0.3) continue;

      const y = getTerrainHeight(x, z);
      dummy.position.set(x, y, z);
      
      // Random rotation
      dummy.rotation.y = Math.random() * Math.PI * 2;
      // Slight random tilt
      dummy.rotation.x = (Math.random() - 0.5) * 0.3;
      dummy.rotation.z = (Math.random() - 0.5) * 0.3;

      // Random scale
      const scale = 0.5 + Math.random() * 0.7;
      dummy.scale.set(scale, scale, scale);
      
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);
      
      // Color Variation (Patches of dry grass)
      // Use noise for color patches too
      const colorNoise = noise(x * 0.5, z * 0.5); 
      if (colorNoise > 0.6) {
         color.setHex(0xc0c070); // Drier/Yellowish
      } else {
         // Green variance
         const v = 0.8 + Math.random() * 0.4;
         color.setRGB(v, v, v);
      }
      mesh.setColorAt(idx, color);
      
      idx++;
    }
    
    return mesh;
  }

  update(time, playerPosition) {
    this.uniforms.uTime.value = time;
    if (playerPosition) {
      this.uniforms.uPlayerPos.value.copy(playerPosition);
    }
  }
}

