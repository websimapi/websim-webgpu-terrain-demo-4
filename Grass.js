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
    const grassHeight = 0.45; // Taller for more flow
    const grassWidth = 0.03;  // Thin but visible
    const segments = 6;       // Smoother bending
    
    const grassGeo = new THREE.PlaneGeometry(grassWidth, grassHeight, 1, segments);
    grassGeo.translate(0, grassHeight / 2, 0); 
    
    // Manual Tapering in JS to create blade shape
    const posAttribute = grassGeo.attributes.position;
    for (let i = 0; i < posAttribute.count; i++) {
      const y = posAttribute.getY(i);
      const hNorm = y / grassHeight;
      
      // Quadratic taper for leaf shape - sharper tip
      const widthScale = 1.0 - Math.pow(hNorm, 2.0);
      
      const x = posAttribute.getX(i);
      posAttribute.setX(i, x * widthScale); 
      
      // Initial curve - bend along Z
      const curve = hNorm * hNorm * 0.15;
      posAttribute.setZ(i, posAttribute.getZ(i) - curve);
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
          float swell = snoise(worldPos.xz * 0.05 + time * 0.4); 
          float flutter = snoise(worldPos.xz * 0.8 + time * 2.0); 
          float windForce = swell * 0.5 + flutter * 0.2;
          
          // Bend factor (zero at bottom, high at top)
          float bend = pow(vHeight, 2.0);
          
          transformed.x += windForce * bend * 0.5;
          transformed.z += windForce * bend * 0.2;
          transformed.y -= abs(windForce) * bend * 0.2; 

          // --- PLAYER INTERACTION ---
          float dist = distance(worldPos.xz, uPlayerPos.xz);
          // Reduced radius to match feet better (0.65)
          float radius = 0.65;
          if(dist < radius){
             float push = 1.0 - smoothstep(0.0, radius, dist);
             push = pow(push, 2.0); // Non-linear falloff for impact feel
             
             vec2 dir = normalize(worldPos.xz - uPlayerPos.xz);
             
             // Strong push away
             transformed.x += dir.x * push * 2.0 * vHeight;
             transformed.z += dir.y * push * 2.0 * vHeight;
             
             // Flatten
             transformed.y *= (1.0 - push * 0.8);
          }

          // --- NORMAL TWEAKING (For fake volume lighting) ---
          // Mix normal with Up vector to simulate light scattering through volume
          // 0.7 mix makes it very soft and "translucent" feeling
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
          // Gradient from dark earth to lush green
          vec3 bottomColor = vec3(0.05, 0.15, 0.02);
          vec3 topColor = vec3(0.3, 0.6, 0.15);
          
          vec3 finalColor = mix(bottomColor, topColor, vHeight);
          
          // Apply instance variation (dry/wet patches)
          finalColor *= vInstanceColor;
          
          // Ambient Occlusion Hack: Darken the very bottom significantly
          finalColor *= smoothstep(-0.05, 0.2, vHeight);

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
    const instanceCount = 800000; // Increased density significantly (800k)
    const mesh = new THREE.InstancedMesh(grassGeo, grassMat, instanceCount);
    mesh.receiveShadow = true;
    mesh.castShadow = false; // Performance optimization

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const range = 220; // Slightly wider range

    let idx = 0;
    while(idx < instanceCount) {
      const x = (Math.random() - 0.5) * range;
      const z = (Math.random() - 0.5) * range;
      
      const y = getTerrainHeight(x, z);
      dummy.position.set(x, y, z);
      
      // Random rotation
      dummy.rotation.y = Math.random() * Math.PI * 2;
      // More random tilt for realistic unkempt look
      dummy.rotation.x = (Math.random() - 0.5) * 0.5;
      dummy.rotation.z = (Math.random() - 0.5) * 0.5;

      // Random scale - Varied height
      const hScale = 0.5 + Math.random() * 0.7; // Height varies
      const wScale = 0.6 + Math.random() * 0.4; // Width varies
      dummy.scale.set(wScale, hScale, wScale);
      
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);
      
      // Color Variation (Patches)
      const colorNoise = noise(x * 0.05, z * 0.05); 
      if (colorNoise > 0.5) {
         color.setHex(0x90a060); // Dryish
      } else {
         // Green variance
         const v = 0.7 + Math.random() * 0.3;
         color.setRGB(v, v + 0.1, v);
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

