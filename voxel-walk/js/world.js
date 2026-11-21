/**
 * world.js
 * ------------------------------------------------------------
 * 128x128x14 のマルチバイオーム（森の渓谷 ＋ 激しい岩山・オーバーハング）＋
 * Minecraft 1.18 風の「スパゲッティ洞窟（3Dノイズ交差チューブ）」＋
 * テラリア式の総量保存・内部64段階/表示8段階・スリープ付き水流を管理します。
 */
(function (global) {
  "use strict";

  const {
    BLOCK_SIZE,
    BLOCK_SLICES,
    BLOCK_AIR,
    BLOCK_DIRT,
    BLOCK_GRASS,
    BLOCK_WOOD,
    BLOCK_LEAVES,
    BLOCK_STONE,
    BLOCK_DARK_STONE,
    BLOCK_LAVA,
    hash3,
    sampleBlockColor24,
    shadePacked24ToABGR,
  } = global.VoxelWalk;

  const WORLD_X = 128;
  const WORLD_Y = 128;
  const WORLD_Z = 14; // 地下スパゲッティ洞窟層 (z=1..4) ＋ 地上 (z=3..6) ＋ 岩山 (z=7..12)

  const WATER_PER_LEVEL = 8;
  const WATER_MAX = BLOCK_SLICES * WATER_PER_LEVEL; // 64

  function waterToVisualLevel(units) {
    if (units <= 0) return 0;
    return Math.min(BLOCK_SLICES, Math.ceil(units / WATER_PER_LEVEL));
  }

  function smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  function valueNoise2D(x, y, seed) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);

    const a = hash3(ix, iy, seed);
    const b = hash3(ix + 1, iy, seed);
    const c = hash3(ix, iy + 1, seed);
    const d = hash3(ix + 1, iy + 1, seed);

    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }

  function fbm2D(x, y, seed) {
    return (
      valueNoise2D(x, y, seed) * 0.54 +
      valueNoise2D(x * 2.05 + 17.3, y * 2.05 + 9.1, seed + 19) * 0.30 +
      valueNoise2D(x * 4.2 + 41.7, y * 4.2 + 23.4, seed + 47) * 0.16
    );
  }

  function valueNoise3D(x, y, z, seed) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fy = y - iy;
    const fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const uz = fz * fz * (3 - 2 * fz);

    const n000 = hash3(ix, iy, iz + seed);
    const n100 = hash3(ix + 1, iy, iz + seed);
    const n010 = hash3(ix, iy + 1, iz + seed);
    const n110 = hash3(ix + 1, iy + 1, iz + seed);
    const n001 = hash3(ix, iy, iz + 1 + seed);
    const n101 = hash3(ix + 1, iy, iz + 1 + seed);
    const n011 = hash3(ix, iy + 1, iz + 1 + seed);
    const n111 = hash3(ix + 1, iy + 1, iz + 1 + seed);

    const x00 = n000 + (n100 - n000) * ux;
    const x10 = n010 + (n110 - n010) * ux;
    const x01 = n001 + (n101 - n001) * ux;
    const x11 = n011 + (n111 - n011) * ux;
    const y0 = x00 + (x10 - x00) * uy;
    const y1 = x01 + (x11 - x01) * uy;
    return y0 + (y1 - y0) * uz;
  }

  function fbm3D(x, y, z, seed) {
    return (
      valueNoise3D(x, y, z, seed) * 0.68 +
      valueNoise3D(x * 2.02 + 11.3, y * 2.02 + 5.7, z * 2.02 + 3.1, seed + 211) * 0.32
    );
  }

  function createWorld(seedInput) {
    const seed = seedInput !== undefined ? seedInput : 104729;
    const cellCount = WORLD_X * WORLD_Y * WORLD_Z;
    const blocks = new Uint8Array(cellCount);
    const water = new Uint8Array(cellCount);
    const falling = new Uint8Array(cellCount);
    const streamWet = new Uint8Array(cellCount);  // 流れる小川が途切れず繋がるための残像タイマー
    const streamFall = new Uint8Array(cellCount); // 段差を落ちる滝・小川カーテンの残像タイマー
    const trailActive = new Uint8Array(cellCount);
    const trailList = new Int32Array(cellCount);
    let trailCount = 0;
    const torches = new Uint8Array(cellCount); // 1 = 松明が置かれている（明るさ15）
    const foliage = new Uint8Array(cellCount); // 0=なし, 1=短い雑草, 2=背の高い雑草, 3=花
    const skyLight = new Uint8Array(cellCount); // 0..15（太陽光）
    const blockLight = new Uint8Array(cellCount); // 0..15（松明・溶岩の光、15ブロック＝半径16マス伝播）
    const surfaceHeight = new Uint8Array(WORLD_X * WORLD_Y);
    const biomeMap = new Float32Array(WORLD_X * WORLD_Y);

    function index(x, y, z) {
      return (z * WORLD_Y + y) * WORLD_X + x;
    }

    function inBounds(x, y, z) {
      return x >= 0 && x < WORLD_X && y >= 0 && y < WORLD_Y && z >= 0 && z < WORLD_Z;
    }

    function getBlock(x, y, z) {
      if (!inBounds(x, y, z)) return BLOCK_AIR;
      return blocks[index(x, y, z)];
    }

    function setBlock(x, y, z, type) {
      if (!inBounds(x, y, z)) return;
      blocks[index(x, y, z)] = type;
    }

    // ============================================================
    // 1. 128x128x14 マルチバイオーム地形 ＋ 3Dスパゲッティ洞窟生成
    // ============================================================
    let spaghettiCarvedCount = 0;

    for (let y = 0; y < WORLD_Y; y++) {
      for (let x = 0; x < WORLD_X; x++) {
        const bNoise = fbm2D(x * 0.022, y * 0.022, seed + 503);
        const eastBias = smoothstep(54, 78, x) * 0.24 - smoothstep(56, 36, x) * 0.16;
        const rockiness = smoothstep(0.42, 0.62, bNoise + eastBias);
        biomeMap[y * WORLD_X + x] = rockiness;

        const nx = (x / (WORLD_X - 1)) * 2 - 1;
        const ny = (y / (WORLD_Y - 1)) * 2 - 1;
        const edgeDist = Math.max(Math.abs(nx), Math.abs(ny));
        const rimBoost = edgeDist > 0.87 ? ((edgeDist - 0.87) / 0.13) * 2.8 : 0;

        // 地下スパゲッティ洞窟の厚みを確保するため、地表ベースを z=3..6 に持ち上げる
        const nForest = fbm2D(x * 0.036, y * 0.036, seed);
        const nDetail = fbm2D(x * 0.11, y * 0.11, seed + 131);
        const forestH = 2.4 + (nForest - 0.18) * 5.2 + (nDetail - 0.5) * 1.0;

        // 岩山バイオームは z=4..12 まで急峻にそびえる
        const ridgeRaw = 1.0 - Math.abs(fbm2D(x * 0.042, y * 0.042, seed + 307) * 2 - 1);
        const ridgeSharp = ridgeRaw * ridgeRaw;
        const canyonRaw = fbm2D(x * 0.065, y * 0.065, seed + 613);
        const rockH = 3.2 + ridgeSharp * 8.4 + (canyonRaw - 0.48) * 2.8;

        let baseH = forestH * (1 - rockiness) + rockH * rockiness + rimBoost;

        // スタート地点 (60, 64) 周辺は歩きやすい草原広場 (z = 4) に整地
        const distSpawn = Math.hypot(x - 60, y - 64);
        if (distSpawn < 5.5) {
          const blend = smoothstep(2.5, 5.5, distSpawn);
          baseH = 4.0 * (1 - blend) + baseH * blend;
        }

        // スタートすぐ東側 (72..86, 55..71) にランドマーク岩山塊
        const distLandmark = Math.hypot((x - 78) * 0.82, (y - 63) * 0.72);
        const landmarkBoost = Math.max(0, 1 - distLandmark / 12.0) * 6.8;
        if (landmarkBoost > 0.2) {
          baseH = Math.max(baseH, 4.2 + landmarkBoost);
          biomeMap[y * WORLD_X + x] = Math.max(rockiness, smoothstep(0.2, 2.0, landmarkBoost));
        }

        const localRock = biomeMap[y * WORLD_X + x];
        let highestZ = 0;

        for (let z = 0; z < WORLD_Z - 1; z++) {
          let density = baseH - z;

          // 岩山バイオームの 3D オーバーハング（張り出し岩棚・アンダーカット）
          if (localRock > 0.25 && z >= 4 && z <= 11) {
            const oh = valueNoise3D(x * 0.095, y * 0.095, z * 0.24, seed + 821) - 0.48;
            const bias = z >= 7 ? 0.16 : -0.14;
            density += (oh + bias) * 3.6 * localRock;
          }

          // ★ Minecraft 1.18 風「スパゲッティ洞窟」(Spaghetti Caves):
          //   2つの独立した 3D ノイズ (nA, nB) のゼロ等値面同士が交差する
          //   細長くうねる 3D チューブ (nA^2 + nB^2 < r^2) を全バイオームの地下〜山腹に生成！
          if (z >= 1 && z <= 8 && edgeDist < 0.92 && distSpawn > 5.5) {
            const nA = fbm3D(x * 0.048, y * 0.048, z * 0.095, seed + 2111) - 0.5;
            const nB = fbm3D(x * 0.048 + 47.2, y * 0.048 + 19.8, z * 0.095 + 13.4, seed + 3499) - 0.5;
            const tubeDistSq = nA * nA + nB * nB;

            // チューブの太さをわずかに揺らがせる（直径3〜5ブロックの歩きやすい洞窟）
            const thicknessVar = 0.0145 + valueNoise3D(x * 0.03, y * 0.03, z * 0.06, seed + 4127) * 0.009;
            if (tubeDistSq < thicknessVar) {
              if (density >= 0) spaghettiCarvedCount++;
              density = -1.0;
            }
          }

          if (z === 0) density = 1.0; // 最下層 z=0 は岩盤床

          if (density >= 0) {
            let type;
            if (z <= 1) {
              type = BLOCK_DARK_STONE;
            } else if (localRock > 0.50) {
              type = z <= 3 || z === 7 ? BLOCK_DARK_STONE : BLOCK_STONE;
            } else if (z <= baseH - 2.0) {
              // 草原の地下も石層にして、洞窟内がしっかり石の洞窟になるようにする
              type = z <= 2 ? BLOCK_DARK_STONE : BLOCK_STONE;
            } else {
              type = BLOCK_DIRT;
            }
            setBlock(x, y, z, type);
            highestZ = z;
          }
        }

        surfaceHeight[y * WORLD_X + x] = highestZ;
      }
    }

    // ============================================================
    // 2. スタート地点からすぐ入れる「歩けるスパゲッティ大洞窟」＆大オーバーハングを彫刻
    // ============================================================
    // 楕円球ブラシで滑らかなうねる洞窟チューブを掘る（1歩ずつ1段以内のスロープで確実に歩ける！）
    function carveCaveSphere(cx, cy, cz, rx, ry, rz) {
      const minX = Math.max(2, Math.floor(cx - rx));
      const maxX = Math.min(WORLD_X - 3, Math.ceil(cx + rx));
      const minY = Math.max(2, Math.floor(cy - ry));
      const maxY = Math.min(WORLD_Y - 3, Math.ceil(cy + ry));
      const minZ = Math.max(1, Math.floor(cz - rz));
      const maxZ = Math.min(WORLD_Z - 2, Math.ceil(cz + rz));
      for (let z = minZ; z <= maxZ; z++) {
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            const dx = (x - cx) / rx;
            const dy = (y - cy) / ry;
            const dz = (z - cz) / rz;
            if (dx * dx + dy * dy + dz * dz <= 1.0) {
              if (getBlock(x, y, z) !== BLOCK_AIR) spaghettiCarvedCount++;
              setBlock(x, y, z, BLOCK_AIR);
            }
          }
        }
      }
    }

    // ランドマーク・スパゲッティ洞窟1: スタート広場すぐ東 (x=65, y=64, z=5) から岩山の地下深く (z=2) へ
    // 大きくS字にうねりながら貫通するメイン洞窟（床も階段状に整えて歩きやすく！）
    const caveSteps = 56;
    for (let s = 0; s <= caveSteps; s++) {
      const t = s / caveSteps;
      const cx = 65 + t * 38;
      const cy = 64 + Math.sin(t * Math.PI * 2.4) * 9.5 + Math.cos(t * Math.PI * 1.2) * 3.0;
      // 入口 z=5 → 地下深く z=2 → 奥の峡谷 z=4 へゆるやかにスロープ
      const cz = 5.0 - Math.sin(t * Math.PI) * 2.8;
      const floorZ = Math.max(1, Math.round(cz - 1.2));

      carveCaveSphere(cx, cy, floorZ + 2.0, 2.2, 2.2, 1.9);
      // 洞窟の床が抜けないように石の床を敷く
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const fx = Math.round(cx) + dx;
          const fy = Math.round(cy) + dy;
          if (inBounds(fx, fy, floorZ)) {
            setBlock(fx, fy, floorZ, BLOCK_STONE);
            if (floorZ > 1 && getBlock(fx, fy, floorZ - 1) === BLOCK_AIR) {
              setBlock(fx, fy, floorZ - 1, BLOCK_DARK_STONE);
            }
          }
        }
      }
    }

    // 枝分かれするスパゲッティ支洞（メイン洞窟の途中から北のオーバーハング下へ抜ける）
    for (let s = 0; s <= 26; s++) {
      const t = s / 26;
      const cx = 77 + Math.sin(t * Math.PI * 1.5) * 4.5;
      const cy = 66 - t * 24;
      const floorZ = Math.max(1, Math.round(2.5 + t * 1.5));
      carveCaveSphere(cx, cy, floorZ + 2.0, 2.0, 2.0, 1.8);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const fx = Math.round(cx) + dx;
          const fy = Math.round(cy) + dy;
          if (inBounds(fx, fy, floorZ)) {
            setBlock(fx, fy, floorZ, BLOCK_STONE);
          }
        }
      }
    }

    // 大オーバーハング岩棚 (x = 71..80, y = 51..56, 空中 z = 8..10 が張り出す)
    for (let x = 71; x <= 80; x++) {
      for (let y = 51; y <= 56; y++) {
        for (let z = 4; z <= 7; z++) {
          setBlock(x, y, z, BLOCK_AIR);
        }
        if (y >= 52 && y <= 56) {
          setBlock(x, y, 8, BLOCK_DARK_STONE);
          setBlock(x, y, 9, BLOCK_STONE);
          if (y >= 53 && x >= 72 && x <= 79) {
            setBlock(x, y, 10, BLOCK_STONE);
          }
        }
      }
    }

    // ============================================================
    // 2.2. 山の上の「湧き水の泉」（ずっと少しずつ水が湧き出して滝・川へ流れる）
    // ============================================================
    const springs = [];

    // ① ランドマーク岩山（大オーバーハング山頂 x=74..76, y=54..55）に天然の石の泉を彫刻
    // z=9 を岩で囲まれた1段深い「泉の池（常に満水）」にし、z=10 から少しずつ湧き出して滝口(75,53->52->51)へ溢れ落とす！
    for (let x = 73; x <= 77; x++) {
      for (let y = 53; y <= 56; y++) {
        const inBasin = x >= 74 && x <= 76 && y >= 54 && y <= 55;
        const inSpillway = x === 75 && y === 53;
        if (inBasin) {
          setBlock(x, y, 8, BLOCK_DARK_STONE); // 泉の底（オーバーハング天井 z=8 を維持）
          setBlock(x, y, 9, BLOCK_AIR);        // 常に満水になる泉の池レイヤー
          setBlock(x, y, 10, BLOCK_AIR);       // 湧き水があふれる水面レイヤー
          for (let cz = 11; cz < WORLD_Z; cz++) setBlock(x, y, cz, BLOCK_AIR);
        } else if (inSpillway) {
          setBlock(x, y, 8, BLOCK_DARK_STONE);
          setBlock(x, y, 9, BLOCK_DARK_STONE); // 堰（せき）：z=9 の池の水を溜めつつ z=10 の溢れ水を流す！
          setBlock(x, y, 10, BLOCK_AIR);
          for (let cz = 11; cz < WORLD_Z; cz++) setBlock(x, y, cz, BLOCK_AIR);
        } else {
          // 泉の岩縁（東・西・南の石垣＋西側 x=73 の見晴らし岩棚）
          setBlock(x, y, 8, BLOCK_DARK_STONE);
          setBlock(x, y, 9, BLOCK_STONE);
          setBlock(x, y, 10, BLOCK_STONE);
          if ((y === 56 && x >= 74 && x <= 76) || (x === 77 && y >= 54 && y <= 55)) {
            setBlock(x, y, 11, BLOCK_DARK_STONE);
            for (let cz = 12; cz < WORLD_Z; cz++) setBlock(x, y, cz, BLOCK_AIR);
          } else {
            for (let cz = 11; cz < WORLD_Z; cz++) setBlock(x, y, cz, BLOCK_AIR);
          }
        }
      }
    }
    // 滝口 (75, 52, 9) の先を空けて、オーバーハングから谷底へ滝が落ちるようにする
    setBlock(75, 52, 8, BLOCK_DARK_STONE);
    setBlock(75, 52, 9, BLOCK_STONE);
    for (let cz = 10; cz < WORLD_Z; cz++) setBlock(75, 52, cz, BLOCK_AIR);
    springs.push({ x: 75, y: 55, z: 10, basinZ: 9, rate: 3, interval: 1 });

    // ② さらにマップ各地の高い山・高台に 4〜5か所の山の泉（くぼんだ池＋湧出）を自動配置
    const peakCandidates = [];
    for (let y = 16; y < WORLD_Y - 16; y += 3) {
      for (let x = 16; x < WORLD_X - 16; x += 3) {
        if (Math.hypot(x - 75, y - 55) < 20) continue;
        if (Math.hypot(x - 60, y - 64) < 12) continue;
        let topZ = 0;
        for (let z = WORLD_Z - 2; z >= 7; z--) {
          if (getBlock(x, y, z) !== BLOCK_AIR) {
            topZ = z;
            break;
          }
        }
        if (topZ >= 9 && topZ <= 12) {
          peakCandidates.push({
            x,
            y,
            z: topZ,
            score: topZ * 2.0 + biomeMap[y * WORLD_X + x] * 1.5 + hash3(x, y, seed + 8811) * 1.8,
          });
        }
      }
    }
    peakCandidates.sort((a, b) => b.score - a.score);

    const extraSpringTarget = 5;
    let extraPlaced = 0;
    for (let k = 0; k < peakCandidates.length && extraPlaced < extraSpringTarget; k++) {
      const cand = peakCandidates[k];
      let tooClose = false;
      for (let s = 0; s < springs.length; s++) {
        if (Math.hypot(cand.x - springs[s].x, cand.y - springs[s].y) < 20) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const sx = cand.x;
      const sy = cand.y;
      const sz = cand.z;
      // 4方向のうち最も地形が低い側へ堰（せき）の切れ目を向ける
      const spillDirs = [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
      ];
      let bestDir = spillDirs[0];
      let lowestNeighbor = 99;
      for (let d = 0; d < 4; d++) {
        const nx = sx + spillDirs[d][0] * 2;
        const ny = sy + spillDirs[d][1] * 2;
        if (!inBounds(nx, ny, 0)) continue;
        let nz = 0;
        for (let z = WORLD_Z - 1; z >= 0; z--) {
          if (getBlock(nx, ny, z) !== BLOCK_AIR) {
            nz = z;
            break;
          }
        }
        if (nz < lowestNeighbor) {
          lowestNeighbor = nz;
          bestDir = spillDirs[d];
        }
      }

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bx = sx + dx;
          const by = sy + dy;
          if (!inBounds(bx, by, sz)) continue;
          if (dx === 0 && dy === 0) {
            setBlock(bx, by, sz - 2, BLOCK_DARK_STONE);
            setBlock(bx, by, sz - 1, BLOCK_AIR); // くぼんだ泉の池（常に満水）
            setBlock(bx, by, sz, BLOCK_AIR);     // 湧出＆溢れ層
            for (let cz = sz + 1; cz < WORLD_Z; cz++) setBlock(bx, by, cz, BLOCK_AIR);
          } else if (dx === bestDir[0] && dy === bestDir[1]) {
            setBlock(bx, by, sz - 1, BLOCK_DARK_STONE); // 低い谷側へ向けた堰
            setBlock(bx, by, sz, BLOCK_AIR);
            for (let cz = sz + 1; cz < WORLD_Z; cz++) setBlock(bx, by, cz, BLOCK_AIR);
          } else {
            setBlock(bx, by, sz - 1, BLOCK_STONE);
            setBlock(bx, by, sz, BLOCK_STONE);
            for (let cz = sz + 1; cz < WORLD_Z; cz++) setBlock(bx, by, cz, BLOCK_AIR);
          }
        }
      }
      springs.push({ x: sx, y: sy, z: sz, basinZ: sz - 1, rate: 2, interval: 1 });
      extraPlaced++;
    }

    // ============================================================
    // 2.5. 溶岩だまり（明るさ15の自然光源）を数カ所生成（洞窟内＋岩山の火口・谷）
    // ============================================================
    const lavaPools = [];

    function placeLavaPool(cx, cy, zLevel, radiusX, radiusY, openSky) {
      let count = 0;
      const rxI = Math.ceil(radiusX) + 1;
      const ryI = Math.ceil(radiusY) + 1;
      for (let dy = -ryI; dy <= ryI; dy++) {
        for (let dx = -rxI; dx <= rxI; dx++) {
          const lx = cx + dx;
          const ly = cy + dy;
          if (!inBounds(lx, ly, zLevel)) continue;
          const norm = (dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY);
          const jitter = (hash3(lx, ly, seed + 555) - 0.5) * 0.35;
          if (norm + jitter <= 1.0) {
            // 溶岩の底は深岩で支える
            if (zLevel > 0) setBlock(lx, ly, zLevel - 1, BLOCK_DARK_STONE);
            setBlock(lx, ly, zLevel, BLOCK_LAVA);
            // 溶岩の直上を空けて光とマグマ模様が見えるようにする
            const clearTop = openSky ? WORLD_Z - 1 : Math.min(WORLD_Z - 2, zLevel + 2);
            for (let cz = zLevel + 1; cz <= clearTop; cz++) {
              setBlock(lx, ly, cz, BLOCK_AIR);
            }
            count++;
          } else if (norm <= 1.65) {
            // 溶岩だまりの縁を深岩の岩縁にして水と混ざりにくくする
            if (getBlock(lx, ly, zLevel) === BLOCK_AIR || getBlock(lx, ly, zLevel) === BLOCK_GRASS) {
              setBlock(lx, ly, zLevel, BLOCK_DARK_STONE);
            }
          }
        }
      }
      if (count > 0) lavaPools.push({ x: cx, y: cy, z: zLevel, blocks: count });
    }

    // ① ランドマーク・スパゲッティ洞窟の奥（歩いていくと赤い溶岩の光が見えてくる！）
    placeLavaPool(84, 71, 2, 2.2, 1.8, false);
    // ② スタート北東の岩山火口・峡谷（夜になると遠くからでも赤く輝く！）
    placeLavaPool(90, 56, 5, 2.6, 2.2, true);
    // ③ さらにマップ内の岩山・地下洞窟に 5カ所の溶岩だまりを点在させる
    const lavaCandidates = [
      { x: 102, y: 84, r: 2.5, open: true },
      { x: 96, y: 32, r: 2.3, open: true },
      { x: 74, y: 98, r: 2.2, open: true },
      { x: 42, y: 38, r: 2.1, open: false }, // 地下スパゲッティ洞窟の溶岩だまり
      { x: 34, y: 92, r: 2.4, open: true },
    ];
    for (const cand of lavaCandidates) {
      let zPick = 2;
      if (cand.open) {
        for (let z = WORLD_Z - 2; z >= 2; z--) {
          if (getBlock(cand.x, cand.y, z) !== BLOCK_AIR) {
            zPick = Math.max(2, Math.min(6, z));
            break;
          }
        }
      }
      placeLavaPool(cand.x, cand.y, zPick, cand.r, cand.r * 0.85, cand.open);
    }

    // 3. 露出している土ブロックの上面を草ブロックへ変換し、surfaceHeight と solidBlockCount を確定
    let solidBlockCount = 0;
    for (let y = 0; y < WORLD_Y; y++) {
      for (let x = 0; x < WORLD_X; x++) {
        let topSolid = 0;
        const localRock = biomeMap[y * WORLD_X + x];
        for (let z = 0; z < WORLD_Z; z++) {
          const b = getBlock(x, y, z);
          if (b === BLOCK_AIR) continue;
          topSolid = z;
          if (b === BLOCK_DIRT && getBlock(x, y, z + 1) === BLOCK_AIR && localRock < 0.45 && z >= 2) {
            setBlock(x, y, z, BLOCK_GRASS);
          }
          solidBlockCount++;
        }
        surfaceHeight[y * WORLD_X + x] = topSolid;
      }
    }

    const spawnX = 60.5;
    const spawnY = 64.5;
    const spawnZ = surfaceHeight[64 * WORLD_X + 60] + 1;

    // ============================================================
    // 4. 森の渓谷バイオームにボクセルの木を生やす
    // ============================================================
    const treePositions = [];
    for (let y = 4; y < WORLD_Y - 4; y += 2) {
      for (let x = 4; x < WORLD_X - 4; x += 2) {
        if (biomeMap[y * WORLD_X + x] > 0.36) continue;
        const topZ = surfaceHeight[y * WORLD_X + x];
        if (topZ < 3 || topZ > 7) continue;
        if (Math.hypot(x - 60, y - 64) < 6.0) continue;
        if (getBlock(x, y, topZ) !== BLOCK_GRASS) continue;
        if (getBlock(x, y, topZ + 1) !== BLOCK_AIR) continue;

        const r = hash3(x, y, seed + 777);
        if (r < 0.915) continue;

        let tooClose = false;
        for (let k = Math.max(0, treePositions.length - 40); k < treePositions.length; k++) {
          const tp = treePositions[k];
          if (Math.hypot(x - tp.x, y - tp.y) < 5.0) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;

        const trunkH = hash3(x, y, seed + 999) > 0.45 ? 3 : 2;
        if (topZ + trunkH + 2 >= WORLD_Z) continue;

        treePositions.push({ x, y, topZ, trunkH });

        for (let dz = 1; dz <= trunkH; dz++) {
          setBlock(x, y, topZ + dz, BLOCK_WOOD);
          solidBlockCount++;
        }

        const canopyZ = topZ + trunkH;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const isCorner = Math.abs(dx) === 1 && Math.abs(dy) === 1;
            if (!(isCorner && hash3(x + dx, y + dy, canopyZ) > 0.65)) {
              if (getBlock(x + dx, y + dy, canopyZ) === BLOCK_AIR) {
                setBlock(x + dx, y + dy, canopyZ, BLOCK_LEAVES);
                solidBlockCount++;
              }
            }
            if (canopyZ + 1 < WORLD_Z) {
              if (!isCorner || hash3(x + dx, y + dy, canopyZ + 1) < 0.72) {
                if (getBlock(x + dx, y + dy, canopyZ + 1) === BLOCK_AIR) {
                  setBlock(x + dx, y + dy, canopyZ + 1, BLOCK_LEAVES);
                  solidBlockCount++;
                }
              }
            }
            if (canopyZ + 2 < WORLD_Z && Math.abs(dx) + Math.abs(dy) <= 1) {
              if (getBlock(x + dx, y + dy, canopyZ + 2) === BLOCK_AIR) {
                setBlock(x + dx, y + dy, canopyZ + 2, BLOCK_LEAVES);
                solidBlockCount++;
              }
            }
          }
        }
      }
    }

    // ============================================================
    // 4.5 木の風揺れ＆プレイヤー衝突バネ振動システム（ブロック単位の剛体揺れ）
    // ============================================================
    // RGBA8: R=swayX, G=swayY, B=(baseBz<<4)|heightBlocks (0=木なし), A=hitEnergy(0..255)
    const treeSwayBytes = new Uint8Array(WORLD_X * WORLD_Y * 4);
    for (let p = 0; p < WORLD_X * WORLD_Y; p++) {
      treeSwayBytes[p * 4] = 128;
      treeSwayBytes[p * 4 + 1] = 128;
      treeSwayBytes[p * 4 + 2] = 0;
      treeSwayBytes[p * 4 + 3] = 0;
    }

    const trees = treePositions.map((tp, idx) => ({
      x: tp.x,
      y: tp.y,
      topZ: tp.topZ,
      trunkH: tp.trunkH,
      baseBz: tp.topZ + 1,
      heightBlocks: tp.trunkH + 2,
      phase: hash3(tp.x, tp.y, seed + 1234 + idx) * Math.PI * 2,
      shakeX: 0,
      shakeY: 0,
      velX: 0,
      velY: 0,
      hitEnergy: 0,
      hitCooldown: 0,
      cells: [],
    }));

    // 各木の 5×5 周辺セルを最も近い木へ割り当て（隣の木と干渉ゼロ）
    const treeOwner = new Int16Array(WORLD_X * WORLD_Y);
    treeOwner.fill(-1);
    const treeOwnerDist = new Float32Array(WORLD_X * WORLD_Y);
    treeOwnerDist.fill(999);
    for (let ti = 0; ti < trees.length; ti++) {
      const t = trees[ti];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const cx = t.x + dx;
          const cy = t.y + dy;
          if (cx < 0 || cy < 0 || cx >= WORLD_X || cy >= WORLD_Y) continue;
          const d2 = dx * dx + dy * dy;
          const p = cy * WORLD_X + cx;
          if (d2 < treeOwnerDist[p]) {
            treeOwnerDist[p] = d2;
            treeOwner[p] = ti;
          }
        }
      }
    }
    for (let p = 0; p < WORLD_X * WORLD_Y; p++) {
      const ti = treeOwner[p];
      if (ti >= 0) {
        const t = trees[ti];
        t.cells.push(p);
        treeSwayBytes[p * 4 + 2] = ((t.baseBz & 15) << 4) | (t.heightBlocks & 15);
        treeSwayBytes[p * 4 + 3] = 0;
      }
    }

    let treeSwayVersion = 0;

    function updateTrees(dt, timeSec, player) {
      const stepDt = Math.min(0.04, Math.max(0.001, dt));
      const pX = player ? player.x : -999;
      const pY = player ? player.y : -999;
      const pZ = player ? player.z : -999;
      const pH = player ? player.height : 1.5;
      const pMoving = player ? player.isMoving : false;
      const pVz = player ? Math.abs(player.vz) : 0;

      for (let i = 0; i < trees.length; i++) {
        const t = trees[i];
        if (t.hitCooldown > 0) {
          t.hitCooldown = Math.max(0, t.hitCooldown - stepDt);
        }

        // プレイヤーとの衝突・接触で幹の反動＋葉ブロック個別ワサワサエネルギーを注入
        if (player) {
          const dx = t.x + 0.5 - pX;
          const dy = t.y + 0.5 - pY;
          const distSq = dx * dx + dy * dy;
          if (distSq < 3.25) {
            const dist = Math.sqrt(distSq);
            const trunkHit =
              dist < 1.08 && pZ + pH >= t.topZ + 0.8 && pZ <= t.topZ + t.trunkH + 0.35;
            const canopyHit =
              dist < 1.78 && pZ + pH >= t.topZ + t.trunkH && pZ <= t.topZ + t.trunkH + 2.4;

            if ((trunkHit || canopyHit) && t.hitCooldown <= 0 && (pMoving || pVz > 0.6 || dist < 0.86)) {
              const invD = dist > 0.05 ? 1 / dist : 1;
              const nx = dist > 0.05 ? dx * invD : Math.cos(player.facing || 0);
              const ny = dist > 0.05 ? dy * invD : Math.sin(player.facing || 0);
              const kick = trunkHit ? (pMoving ? 3.8 : 2.1) : 2.8;
              const perp = (Math.sin(timeSec * 17.0 + t.phase) >= 0 ? 1 : -1) * 1.1;
              t.velX += nx * kick - ny * perp;
              t.velY += ny * kick + nx * perp;
              t.hitEnergy = Math.min(1.0, Math.max(t.hitEnergy, trunkHit ? 1.0 : 0.78));
              t.hitCooldown = trunkHit ? 0.22 : 0.28;
            }
          }
        }

        // 衝撃エネルギーの自然な減衰（約1.1秒かけて落ち着く）
        if (t.hitEnergy > 0) {
          t.hitEnergy = Math.max(0, t.hitEnergy - stepDt * 1.15);
        }

        // 木全体のキレのあるバネ反動（グニャグニャではなくスッと跳ね返る硬めのバネ）
        const ax = -78.0 * t.shakeX - 5.2 * t.velX;
        const ay = -78.0 * t.shakeY - 5.2 * t.velY;
        t.velX += ax * stepDt;
        t.velY += ay * stepDt;
        t.shakeX += t.velX * stepDt;
        t.shakeY += t.velY * stepDt;
        if (Math.abs(t.shakeX) < 0.0004 && Math.abs(t.velX) < 0.001) {
          t.shakeX = 0;
          t.velX = 0;
        }
        if (Math.abs(t.shakeY) < 0.0004 && Math.abs(t.velY) < 0.001) {
          t.shakeY = 0;
          t.velY = 0;
        }

        // 風の向きを画面横〜斜め方向 (+0.86, -0.68) ベース＋ゆるやかな旋回にして縦揺れ偏りを解消
        const gustWave = 0.62 + 0.38 * Math.sin(timeSec * 0.7 - (t.x * 0.09 - t.y * 0.07));
        const swayMain = Math.sin(timeSec * 1.7 + t.phase + t.x * 0.14 - t.y * 0.11);
        const swayCross = Math.cos(timeSec * 1.15 + t.phase * 1.4);
        const windX = swayMain * gustWave * 0.085 + swayCross * 0.035;
        const windY = -swayMain * gustWave * 0.068 + Math.sin(timeSec * 1.35 + t.phase) * 0.038;

        const maxSway = 0.36;
        const totalX = Math.max(-maxSway, Math.min(maxSway, windX + t.shakeX));
        const totalY = Math.max(-maxSway, Math.min(maxSway, windY + t.shakeY));
        const encX = Math.max(1, Math.min(255, Math.round(128 + (totalX / maxSway) * 127)));
        const encY = Math.max(1, Math.min(255, Math.round(128 + (totalY / maxSway) * 127)));
        const encHit = Math.max(0, Math.min(255, Math.round(t.hitEnergy * 255)));

        const cells = t.cells;
        for (let k = 0; k < cells.length; k++) {
          const off = cells[k] * 4;
          treeSwayBytes[off] = encX;
          treeSwayBytes[off + 1] = encY;
          treeSwayBytes[off + 3] = encHit;
        }
      }
      treeSwayVersion++;
    }

    // ============================================================
    // 5. 高速ゼロアロケーション 3D AO ＋ 段差エッジ ＋ 境界天面キャップベイク
    // ============================================================
    const totalSlices = WORLD_Z * BLOCK_SLICES + 1;
    const canvasW = WORLD_X * BLOCK_SIZE;
    const canvasH = WORLD_Y * BLOCK_SIZE;
    const sliceCache = Object.create(null);

    const roofDistTable = new Uint8Array(cellCount);
    function recomputeRoofDistColumn(x, y) {
      let nearestRoofZ = -1;
      for (let z = WORLD_Z - 1; z >= 0; z--) {
        const i = index(x, y, z);
        roofDistTable[i] = nearestRoofZ !== -1 ? nearestRoofZ - z : 0;
        if (blocks[i] !== BLOCK_AIR) {
          nearestRoofZ = z;
        }
      }
    }
    for (let y = 0; y < WORLD_Y; y++) {
      for (let x = 0; x < WORLD_X; x++) {
        recomputeRoofDistColumn(x, y);
      }
    }

    function skyRoofDistance(x, y, z) {
      if (!inBounds(x, y, z)) return 0;
      return roofDistTable[index(x, y, z)];
    }

    function packRGBA(r, g, b, a) {
      return ((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
    }

    const BURIED_COLORS = new Uint32Array(8);
    BURIED_COLORS[BLOCK_DIRT] = packRGBA(74, 50, 32, 255);
    BURIED_COLORS[BLOCK_GRASS] = packRGBA(74, 50, 32, 255);
    BURIED_COLORS[BLOCK_STONE] = packRGBA(82, 86, 94, 255);
    BURIED_COLORS[BLOCK_DARK_STONE] = packRGBA(52, 56, 66, 255);
    BURIED_COLORS[BLOCK_WOOD] = packRGBA(76, 52, 32, 255);
    BURIED_COLORS[BLOCK_LEAVES] = packRGBA(36, 90, 36, 255);
    BURIED_COLORS[BLOCK_LAVA] = packRGBA(230, 76, 16, 255);

    const bakeStartMs = performance.now();

    function getSideAOInfo(bx, by, bz, nx, ny) {
      if (getBlock(bx + nx, by + ny, bz) !== BLOCK_AIR) return null;
      const tx = ny !== 0 ? 1 : 0;
      const ty = nx !== 0 ? 1 : 0;
      const ox = bx + nx;
      const oy = by + ny;
      const roofDist = skyRoofDistance(ox, oy, bz);
      return {
        floorCrease: bz === 0 || getBlock(ox, oy, bz - 1) !== BLOCK_AIR,
        overhang: getBlock(ox, oy, bz + 1) !== BLOCK_AIR,
        cornerNeg: getBlock(ox - tx, oy - ty, bz) !== BLOCK_AIR,
        cornerPos: getBlock(ox + tx, oy + ty, bz) !== BLOCK_AIR,
        skyFactor: roofDist > 0 ? Math.min(0.78, 0.56 + roofDist * 0.025) : 1.0,
      };
    }

    function bakeCellInSlice(buf32, bx, by, sliceZ, enableAO, enableEdge, clearIfEmpty) {
      const bz = Math.floor(sliceZ / BLOCK_SLICES);
      const lz = sliceZ % BLOCK_SLICES;
      const isBoundaryPlane = lz === 0 && bz > 0;
      const basePx = bx * BLOCK_SIZE;
      const basePy = by * BLOCK_SIZE;

      let type = bz < WORLD_Z ? blocks[index(bx, by, bz)] : BLOCK_AIR;
      let drawBz = bz;
      let drawLz = lz;
      let isTopCap = false;

      if (type === BLOCK_AIR) {
        if (isBoundaryPlane) {
          const belowType = blocks[index(bx, by, bz - 1)];
          if (belowType !== BLOCK_AIR) {
            type = belowType;
            drawBz = bz - 1;
            drawLz = BLOCK_SLICES - 1;
            isTopCap = true;
          }
        }
        if (type === BLOCK_AIR) {
          if (clearIfEmpty) {
            for (let ly = 0; ly < BLOCK_SIZE; ly++) {
              const rowOff = (basePy + ly) * canvasW + basePx;
              for (let lx = 0; lx < BLOCK_SIZE; lx++) {
                buf32[rowOff + lx] = 0;
              }
            }
          }
          return;
        }
      }

      if (
        !isTopCap &&
        bx > 0 && bx < WORLD_X - 1 && by > 0 && by < WORLD_Y - 1 &&
        blocks[index(bx - 1, by, drawBz)] !== BLOCK_AIR &&
        blocks[index(bx + 1, by, drawBz)] !== BLOCK_AIR &&
        blocks[index(bx, by - 1, drawBz)] !== BLOCK_AIR &&
        blocks[index(bx, by + 1, drawBz)] !== BLOCK_AIR
      ) {
        const packed = BURIED_COLORS[type] || BURIED_COLORS[BLOCK_STONE];
        for (let ly = 0; ly < BLOCK_SIZE; ly++) {
          const rowOff = (basePy + ly) * canvasW + basePx;
          for (let lx = 0; lx < BLOCK_SIZE; lx++) {
            buf32[rowOff + lx] = packed;
          }
        }
        return;
      }

      const elevLight = enableEdge ? Math.min(1.26, 0.78 + drawBz * 0.052) : 1.0;

      let aoN = false, aoS = false, aoW = false, aoE = false;
      let aoNW = false, aoNE = false, aoSW = false, aoSE = false;
      let topSkyFactor = 1.0;

      let dropN = false, dropS = false, dropW = false, dropE = false;
      let dropNW = false, dropNE = false, dropSW = false, dropSE = false;

      if (enableEdge && isTopCap) {
        dropN = getBlock(bx, by - 1, drawBz) === BLOCK_AIR;
        dropS = getBlock(bx, by + 1, drawBz) === BLOCK_AIR;
        dropW = getBlock(bx - 1, by, drawBz) === BLOCK_AIR;
        dropE = getBlock(bx + 1, by, drawBz) === BLOCK_AIR;
        dropNW = !dropN && !dropW && getBlock(bx - 1, by - 1, drawBz) === BLOCK_AIR;
        dropNE = !dropN && !dropE && getBlock(bx + 1, by - 1, drawBz) === BLOCK_AIR;
        dropSW = !dropS && !dropW && getBlock(bx - 1, by + 1, drawBz) === BLOCK_AIR;
        dropSE = !dropS && !dropE && getBlock(bx + 1, by + 1, drawBz) === BLOCK_AIR;
      }

      let sideN = null, sideS = null, sideW = null, sideE = null;

      if (enableAO) {
        if (isTopCap) {
          aoN = getBlock(bx, by - 1, drawBz + 1) !== BLOCK_AIR;
          aoS = getBlock(bx, by + 1, drawBz + 1) !== BLOCK_AIR;
          aoW = getBlock(bx - 1, by, drawBz + 1) !== BLOCK_AIR;
          aoE = getBlock(bx + 1, by, drawBz + 1) !== BLOCK_AIR;
          aoNW = getBlock(bx - 1, by - 1, drawBz + 1) !== BLOCK_AIR;
          aoNE = getBlock(bx + 1, by - 1, drawBz + 1) !== BLOCK_AIR;
          aoSW = getBlock(bx - 1, by + 1, drawBz + 1) !== BLOCK_AIR;
          aoSE = getBlock(bx + 1, by + 1, drawBz + 1) !== BLOCK_AIR;

          const roofDist = skyRoofDistance(bx, by, drawBz);
          if (roofDist > 0) {
            topSkyFactor = Math.min(0.72, 0.50 + roofDist * 0.03);
          } else {
            let nearRoof = 0;
            if (skyRoofDistance(bx - 1, by, drawBz) > 0) nearRoof++;
            if (skyRoofDistance(bx + 1, by, drawBz) > 0) nearRoof++;
            if (skyRoofDistance(bx, by - 1, drawBz) > 0) nearRoof++;
            if (skyRoofDistance(bx, by + 1, drawBz) > 0) nearRoof++;
            if (nearRoof > 0) topSkyFactor = 1.0 - nearRoof * 0.05;
          }
        } else {
          sideN = getSideAOInfo(bx, by, drawBz, 0, -1);
          sideS = getSideAOInfo(bx, by, drawBz, 0, 1);
          sideW = getSideAOInfo(bx, by, drawBz, -1, 0);
          sideE = getSideAOInfo(bx, by, drawBz, 1, 0);
        }
      }

      const variant = (bx * 31 + by * 17 + drawBz * 13) & 255;

      for (let ly = 0; ly < BLOCK_SIZE; ly++) {
        const rowOff = (basePy + ly) * canvasW + basePx;
        for (let lx = 0; lx < BLOCK_SIZE; lx++) {
          const rgb24 = sampleBlockColor24(type, lx, ly, drawLz, variant, isTopCap);
          let lightMult = elevLight;

          if (enableAO) {
            let ao = 1.0;

            if (isTopCap) {
              ao *= topSkyFactor;
              if (aoN && ly <= 1) ao *= 0.60 + ly * 0.18;
              if (aoS && ly >= BLOCK_SIZE - 2) ao *= 0.60 + (BLOCK_SIZE - 1 - ly) * 0.18;
              if (aoW && lx <= 1) ao *= 0.60 + lx * 0.18;
              if (aoE && lx >= BLOCK_SIZE - 2) ao *= 0.60 + (BLOCK_SIZE - 1 - lx) * 0.18;

              if (aoNW && !aoN && !aoW && lx <= 1 && ly <= 1) ao *= 0.74 + Math.max(lx, ly) * 0.12;
              if (aoNE && !aoN && !aoE && lx >= BLOCK_SIZE - 2 && ly <= 1) ao *= 0.74 + Math.max(BLOCK_SIZE - 1 - lx, ly) * 0.12;
              if (aoSW && !aoS && !aoW && lx <= 1 && ly >= BLOCK_SIZE - 2) ao *= 0.74 + Math.max(lx, BLOCK_SIZE - 1 - ly) * 0.12;
              if (aoSE && !aoS && !aoE && lx >= BLOCK_SIZE - 2 && ly >= BLOCK_SIZE - 2) ao *= 0.74 + Math.max(BLOCK_SIZE - 1 - lx, BLOCK_SIZE - 1 - ly) * 0.12;
            } else {
              const calcFaceAO = (info, tCoord) => {
                let f = info.skyFactor;
                if (info.floorCrease && drawLz <= 2) f *= 0.56 + drawLz * 0.15;
                if (info.overhang && drawLz >= BLOCK_SLICES - 3) f *= 0.52 + (BLOCK_SLICES - 1 - drawLz) * 0.15;
                if (info.cornerNeg && tCoord <= 1) f *= 0.60 + tCoord * 0.18;
                if (info.cornerPos && tCoord >= BLOCK_SIZE - 2) f *= 0.60 + (BLOCK_SIZE - 1 - tCoord) * 0.18;
                return f;
              };

              if (ly <= 1 && sideN) ao = Math.min(ao, calcFaceAO(sideN, lx));
              if (ly >= BLOCK_SIZE - 2 && sideS) ao = Math.min(ao, calcFaceAO(sideS, lx));
              if (lx <= 1 && sideW) ao = Math.min(ao, calcFaceAO(sideW, ly));
              if (lx >= BLOCK_SIZE - 2 && sideE) ao = Math.min(ao, calcFaceAO(sideE, ly));
            }

            lightMult *= Math.max(0.30, ao);
          }

          if (enableEdge && isTopCap) {
            const isOuter =
              (dropN && ly === 0) ||
              (dropS && ly === BLOCK_SIZE - 1) ||
              (dropW && lx === 0) ||
              (dropE && lx === BLOCK_SIZE - 1) ||
              (dropNW && lx === 0 && ly === 0) ||
              (dropNE && lx === BLOCK_SIZE - 1 && ly === 0) ||
              (dropSW && lx === 0 && ly === BLOCK_SIZE - 1) ||
              (dropSE && lx === BLOCK_SIZE - 1 && ly === BLOCK_SIZE - 1);

            if (isOuter) {
              lightMult *= 0.60;
            } else {
              const isBevel =
                (dropN && ly === 1) ||
                (dropS && ly === BLOCK_SIZE - 2) ||
                (dropW && lx === 1) ||
                (dropE && lx === BLOCK_SIZE - 2) ||
                (dropNW && lx <= 1 && ly <= 1) ||
                (dropNE && lx >= BLOCK_SIZE - 2 && ly <= 1) ||
                (dropSW && lx <= 1 && ly >= BLOCK_SIZE - 2) ||
                (dropSE && lx >= BLOCK_SIZE - 2 && ly >= BLOCK_SIZE - 2);
              if (isBevel) lightMult *= 1.15;
            }
          }

          buf32[rowOff + lx] = shadePacked24ToABGR(rgb24, Math.max(0.26, lightMult));
        }
      }
    }

    function bakeSlices(enableAO, enableEdge) {
      const slices = [];
      const bounds = [];

      for (let sliceZ = 0; sliceZ < totalSlices; sliceZ++) {
        const bz = Math.floor(sliceZ / BLOCK_SLICES);
        const lz = sliceZ % BLOCK_SLICES;
        const isBoundaryPlane = lz === 0 && bz > 0;

        let bMinX = WORLD_X;
        let bMaxX = -1;
        let bMinY = WORLD_Y;
        let bMaxY = -1;
        for (let by = 0; by < WORLD_Y; by++) {
          for (let bx = 0; bx < WORLD_X; bx++) {
            const hasCur = bz < WORLD_Z && blocks[index(bx, by, bz)] !== BLOCK_AIR;
            const hasBelow = isBoundaryPlane && blocks[index(bx, by, bz - 1)] !== BLOCK_AIR;
            if (hasCur || hasBelow) {
              if (bx < bMinX) bMinX = bx;
              if (bx > bMaxX) bMaxX = bx;
              if (by < bMinY) bMinY = by;
              if (by > bMaxY) bMaxY = by;
            }
          }
        }
        if (bMaxX < bMinX) {
          slices.push(null);
          bounds.push(null);
          continue;
        }
        bounds.push({ minX: bMinX, maxX: bMaxX + 1, minY: bMinY, maxY: bMaxY + 1 });

        const rawBytes = new Uint8Array(canvasW * canvasH * 4);
        const buf32 = new Uint32Array(rawBytes.buffer);

        for (let by = bMinY; by <= bMaxY; by++) {
          for (let bx = bMinX; bx <= bMaxX; bx++) {
            bakeCellInSlice(buf32, bx, by, sliceZ, enableAO, enableEdge, false);
          }
        }

        slices.push(rawBytes);
      }

      return { slices, bounds };
    }

    const dirtyTerrainSlices = new Uint8Array(totalSlices);
    let terrainTexVersion = 0;

    // 任意の1ブロックを即座に破壊（デブリなし・局所差分ベイク＋水流再起動＋3Dライト即時再計算）
    function destroyBlockAt(bx, by, bz) {
      if (!inBounds(bx, by, bz)) return false;
      const idx = index(bx, by, bz);
      if (blocks[idx] === BLOCK_AIR) return false;

      blocks[idx] = BLOCK_AIR;
      foliage[idx] = 0;
      if (bz + 1 < WORLD_Z) {
        foliage[index(bx, by, bz + 1)] = 0;
      }
      if (torches[idx]) {
        torches[idx] = 0;
        torchCount = Math.max(0, torchCount - 1);
      }

      // 地表高さと空天井距離テーブルをこの列だけ更新
      let topSolid = 0;
      for (let z = WORLD_Z - 1; z >= 0; z--) {
        if (blocks[index(bx, by, z)] !== BLOCK_AIR) {
          topSolid = z;
          break;
        }
      }
      surfaceHeight[by * WORLD_X + bx] = topSolid;
      recomputeRoofDistColumn(bx, by);

      // 影響する 3×3 ブロックと直下カラムだけ超高速に局所再ベイク
      const minBx = Math.max(0, bx - 1);
      const maxBx = Math.min(WORLD_X - 1, bx + 1);
      const minBy = Math.max(0, by - 1);
      const maxBy = Math.min(WORLD_Y - 1, by + 1);
      const maxLocalSl = Math.min(maxUsedSlice - 1, (bz + 2) * BLOCK_SLICES);

      for (const key in sliceCache) {
        const pack = sliceCache[key];
        const parts = key.split("_");
        const eAO = parts[0] === "1";
        const eEdge = parts[1] === "1";

        for (let s = 0; s <= maxLocalSl; s++) {
          let rawBytes = pack.slices[s];
          if (!rawBytes) {
            if (s < Math.max(0, (bz - 1) * BLOCK_SLICES)) continue;
            rawBytes = new Uint8Array(canvasW * canvasH * 4);
            pack.slices[s] = rawBytes;
          }
          const buf32 = new Uint32Array(rawBytes.buffer);
          for (let cy = minBy; cy <= maxBy; cy++) {
            for (let cx = minBx; cx <= maxBx; cx++) {
              bakeCellInSlice(buf32, cx, cy, s, eAO, eEdge, true);
            }
          }
          dirtyTerrainSlices[s] = 1;
        }
      }
      terrainTexVersion++;

      // 水流テクスチャ・落下距離マップを更新し、周囲の水をすぐ新しい穴へ流し込む
      markBlockWaterDirty(bz);
      if (bz > 0) markBlockWaterDirty(bz - 1);
      if (bz + 1 < WORLD_Z) markBlockWaterDirty(bz + 1);
      layerHasWater[bz] = 1;
      if (bz > 0) layerHasWater[bz - 1] = 1;
      if (bz + 1 < WORLD_Z) layerHasWater[bz + 1] = 1;
      waterSettled = false;
      calmStreak = 0;
      recomputeActiveDrops();
      rebuildDirtyWaterSlices();

      // 太陽光（洞窟の天窓）と松明・溶岩の光を即時再計算
      recomputeSkyLight();
      recomputeBlockLight();
      packLightTexture();

      return true;
    }

    function getSlicePack(enableAO, enableEdge) {
      const key = `${enableAO ? 1 : 0}_${enableEdge ? 1 : 0}`;
      if (!sliceCache[key]) {
        sliceCache[key] = bakeSlices(enableAO, enableEdge);
      }
      return sliceCache[key];
    }

    function getSlices(enableAO, enableEdge) {
      return getSlicePack(enableAO, enableEdge).slices;
    }

    const defaultPack = getSlicePack(true, true);
    const defaultSlices = defaultPack.slices;
    const initialBakeMs = performance.now() - bakeStartMs;

    let maxUsedSlice = 0;
    for (let s = totalSlices - 1; s >= 0; s--) {
      if (defaultSlices[s]) {
        maxUsedSlice = s + 1;
        break;
      }
    }

    // ============================================================
    // 6. テラリア式・内部64段階 / 表示8段階・動的落ち口BFS・スリープ付き水流
    // ============================================================
    const distToDrop = new Uint8Array(cellCount);
    distToDrop.fill(255);
    const bfsQueue = new Int32Array(WORLD_X * WORLD_Y);
    const layerHasWater = new Uint8Array(WORLD_Z);

    function recomputeActiveDrops() {
      distToDrop.fill(255);
      for (let z = 1; z < WORLD_Z; z++) {
        if (!layerHasWater[z]) continue;
        let qHead = 0;
        let qTail = 0;

        for (let y = 0; y < WORLD_Y; y++) {
          for (let x = 0; x < WORLD_X; x++) {
            const i = index(x, y, z);
            if (blocks[i] === BLOCK_AIR) {
              const below = index(x, y, z - 1);
              if (blocks[below] === BLOCK_AIR && water[below] < WATER_MAX) {
                distToDrop[i] = 0;
                bfsQueue[qTail++] = y * WORLD_X + x;
              }
            }
          }
        }

        while (qHead < qTail) {
          const xy = bfsQueue[qHead++];
          const cx = xy % WORLD_X;
          const cy = (xy - cx) / WORLD_X;
          const nextDist = distToDrop[index(cx, cy, z)] + 1;
          if (nextDist >= 254) continue;

          if (cx + 1 < WORLD_X) {
            const ni = index(cx + 1, cy, z);
            if (blocks[ni] === BLOCK_AIR && distToDrop[ni] === 255) {
              distToDrop[ni] = nextDist;
              bfsQueue[qTail++] = xy + 1;
            }
          }
          if (cx - 1 >= 0) {
            const ni = index(cx - 1, cy, z);
            if (blocks[ni] === BLOCK_AIR && distToDrop[ni] === 255) {
              distToDrop[ni] = nextDist;
              bfsQueue[qTail++] = xy - 1;
            }
          }
          if (cy + 1 < WORLD_Y) {
            const ni = index(cx, cy + 1, z);
            if (blocks[ni] === BLOCK_AIR && distToDrop[ni] === 255) {
              distToDrop[ni] = nextDist;
              bfsQueue[qTail++] = xy + WORLD_X;
            }
          }
          if (cy - 1 >= 0) {
            const ni = index(cx, cy - 1, z);
            if (blocks[ni] === BLOCK_AIR && distToDrop[ni] === 255) {
              distToDrop[ni] = nextDist;
              bfsQueue[qTail++] = xy - WORLD_X;
            }
          }
        }
      }
    }

    const waterLayerBytes = new Array(WORLD_Z);
    const dirtyWaterLayers = new Uint8Array(WORLD_Z);
    let waterTexVersion = 0;

    for (let z = 0; z < WORLD_Z; z++) {
      waterLayerBytes[z] = new Uint8Array(WORLD_X * WORLD_Y * 2);
      dirtyWaterLayers[z] = 1;
    }

    function markBlockWaterDirty(bz) {
      if (bz >= 0 && bz < WORLD_Z) {
        dirtyWaterLayers[bz] = 1;
      }
    }

    // 7. Minecraft式 3D BFS 光源伝播エンジン（skyLight 0..15 ＋ blockLight 0..15 = 16ブロック到達）
    // ============================================================
    // GPU 3D テクスチャ用バッファ (128x128x14 x RG8 = 458KB): R = blockLight, G = skyLight
    const lightTexBytes = new Uint8Array(cellCount * 2);
    const lightQueue = new Int32Array(cellCount);
    let lightTexVersion = 0;
    let torchCount = 0;

    function recomputeSkyLight() {
      skyLight.fill(0);
      let qHead = 0;
      let qTail = 0;

      // 1. 空から真下へ直射日光 (15) を落とす（葉ブロックは少しだけ減衰して木漏れ日を通す）
      for (let y = 0; y < WORLD_Y; y++) {
        for (let x = 0; x < WORLD_X; x++) {
          let colLight = 15;
          for (let z = WORLD_Z - 1; z >= 0; z--) {
            const i = index(x, y, z);
            const b = blocks[i];
            if (b === BLOCK_AIR) {
              if (water[i] > 0) colLight = Math.max(0, colLight - 1);
              skyLight[i] = colLight;
              if (colLight > 1) lightQueue[qTail++] = i;
            } else if (b === BLOCK_LEAVES) {
              colLight = Math.max(0, colLight - 3);
            } else {
              break;
            }
          }
        }
      }

      // 2. 3D BFS で洞窟の入口やオーバーハングの下へ太陽光が滑らかに回り込む
      const layerStride = WORLD_X * WORLD_Y;
      while (qHead < qTail) {
        const i = lightQueue[qHead++];
        const curL = skyLight[i];
        if (curL <= 1) continue;
        const nextL = curL - 1;

        const z = (i / layerStride) | 0;
        const rem = i - z * layerStride;
        const y = (rem / WORLD_X) | 0;
        const x = rem - y * WORLD_X;

        if (x + 1 < WORLD_X) {
          const ni = i + 1;
          if (blocks[ni] === BLOCK_AIR && skyLight[ni] < nextL) { skyLight[ni] = nextL; lightQueue[qTail++] = ni; }
        }
        if (x > 0) {
          const ni = i - 1;
          if (blocks[ni] === BLOCK_AIR && skyLight[ni] < nextL) { skyLight[ni] = nextL; lightQueue[qTail++] = ni; }
        }
        if (y + 1 < WORLD_Y) {
          const ni = i + WORLD_X;
          if (blocks[ni] === BLOCK_AIR && skyLight[ni] < nextL) { skyLight[ni] = nextL; lightQueue[qTail++] = ni; }
        }
        if (y > 0) {
          const ni = i - WORLD_X;
          if (blocks[ni] === BLOCK_AIR && skyLight[ni] < nextL) { skyLight[ni] = nextL; lightQueue[qTail++] = ni; }
        }
        if (z + 1 < WORLD_Z) {
          const ni = i + layerStride;
          if (blocks[ni] === BLOCK_AIR && skyLight[ni] < nextL) { skyLight[ni] = nextL; lightQueue[qTail++] = ni; }
        }
        if (z > 0) {
          const ni = i - layerStride;
          if (blocks[ni] === BLOCK_AIR && skyLight[ni] < nextL) { skyLight[ni] = nextL; lightQueue[qTail++] = ni; }
        }
      }
    }

    function recomputeBlockLight() {
      blockLight.fill(0);
      let qHead = 0;
      let qTail = 0;

      // 1. すべての光源（松明 = 15、溶岩ブロック = 15）をシード登録
      for (let i = 0; i < cellCount; i++) {
        if (torches[i] || blocks[i] === BLOCK_LAVA) {
          blockLight[i] = 15;
          lightQueue[qTail++] = i;
        }
      }

      // 2. 3D BFS で固体ブロックに遮られながら最大15〜16ブロック先まで光を伝播
      const layerStride = WORLD_X * WORLD_Y;
      while (qHead < qTail) {
        const i = lightQueue[qHead++];
        const curL = blockLight[i];
        if (curL <= 1) continue;
        const nextL = curL - 1;

        const z = (i / layerStride) | 0;
        const rem = i - z * layerStride;
        const y = (rem / WORLD_X) | 0;
        const x = rem - y * WORLD_X;

        if (x + 1 < WORLD_X) {
          const ni = i + 1;
          if (blocks[ni] === BLOCK_AIR && blockLight[ni] < nextL) { blockLight[ni] = nextL; lightQueue[qTail++] = ni; }
        }
        if (x > 0) {
          const ni = i - 1;
          if (blocks[ni] === BLOCK_AIR && blockLight[ni] < nextL) { blockLight[ni] = nextL; lightQueue[qTail++] = ni; }
        }
        if (y + 1 < WORLD_Y) {
          const ni = i + WORLD_X;
          if (blocks[ni] === BLOCK_AIR && blockLight[ni] < nextL) { blockLight[ni] = nextL; lightQueue[qTail++] = ni; }
        }
        if (y > 0) {
          const ni = i - WORLD_X;
          if (blocks[ni] === BLOCK_AIR && blockLight[ni] < nextL) { blockLight[ni] = nextL; lightQueue[qTail++] = ni; }
        }
        if (z + 1 < WORLD_Z) {
          const ni = i + layerStride;
          if (blocks[ni] === BLOCK_AIR && blockLight[ni] < nextL) { blockLight[ni] = nextL; lightQueue[qTail++] = ni; }
        }
        if (z > 0) {
          const ni = i - layerStride;
          if (blocks[ni] === BLOCK_AIR && blockLight[ni] < nextL) { blockLight[ni] = nextL; lightQueue[qTail++] = ni; }
        }
      }
    }

    /**
     * 空気セルの光をそのまま格納し、固体ブロックセルには「隣接する非固体セルの最大光量」を焼き込む。
     * これにより壁を貫通せずに、床・壁・プレイヤー・水面すべてが滑らかなライトマップで照らされる。
     */
    function packLightTexture() {
      const layerStride = WORLD_X * WORLD_Y;
      for (let z = 0; z < WORLD_Z; z++) {
        for (let y = 0; y < WORLD_Y; y++) {
          for (let x = 0; x < WORLD_X; x++) {
            const i = (z * WORLD_Y + y) * WORLD_X + x;
            const b = blocks[i];
            let bL = blockLight[i];
            let sL = skyLight[i];

            if (b === BLOCK_LAVA) {
              bL = 15;
              sL = 15;
            } else if (b !== BLOCK_AIR) {
              // 固体ブロックは周囲6近傍の非固体セルの光量最大値を受け取る
              bL = 0;
              sL = 0;
              if (z + 1 < WORLD_Z && blocks[i + layerStride] === BLOCK_AIR) {
                const nb = blockLight[i + layerStride], ns = skyLight[i + layerStride];
                if (nb > bL) bL = nb;
                if (ns > sL) sL = ns;
              }
              if (z > 0 && blocks[i - layerStride] === BLOCK_AIR) {
                const nb = blockLight[i - layerStride], ns = skyLight[i - layerStride];
                if (nb > bL) bL = nb;
                if (ns > sL) sL = ns;
              }
              if (x + 1 < WORLD_X && blocks[i + 1] === BLOCK_AIR) {
                const nb = blockLight[i + 1], ns = skyLight[i + 1];
                if (nb > bL) bL = nb;
                if (ns > sL) sL = ns;
              }
              if (x > 0 && blocks[i - 1] === BLOCK_AIR) {
                const nb = blockLight[i - 1], ns = skyLight[i - 1];
                if (nb > bL) bL = nb;
                if (ns > sL) sL = ns;
              }
              if (y + 1 < WORLD_Y && blocks[i + WORLD_X] === BLOCK_AIR) {
                const nb = blockLight[i + WORLD_X], ns = skyLight[i + WORLD_X];
                if (nb > bL) bL = nb;
                if (ns > sL) sL = ns;
              }
              if (y > 0 && blocks[i - WORLD_X] === BLOCK_AIR) {
                const nb = blockLight[i - WORLD_X], ns = skyLight[i - WORLD_X];
                if (nb > bL) bL = nb;
                if (ns > sL) sL = ns;
              }
            }

            lightTexBytes[i * 2] = bL * 17; // 0..15 -> 0..255
            lightTexBytes[i * 2 + 1] = sL * 17;
          }
        }
      }
      lightTexVersion++;
    }

    function placeTorchAt(wx, wy, wz) {
      const bx = Math.floor(wx);
      const by = Math.floor(wy);
      const bz = Math.floor(wz);
      if (!inBounds(bx, by, bz)) return false;
      const i = index(bx, by, bz);
      if (blocks[i] !== BLOCK_AIR || torches[i]) return false;
      torches[i] = 1;
      foliage[i] = 0;
      torchCount++;
      markBlockWaterDirty(bz);
      rebuildDirtyWaterSlices();
      recomputeBlockLight();
      packLightTexture();
      return true;
    }

    function removeTorchNear(wx, wy, wz) {
      const cx = Math.floor(wx);
      const cy = Math.floor(wy);
      const cz = Math.floor(wz);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const bx = cx + dx, by = cy + dy, bz = cz + dz;
            if (!inBounds(bx, by, bz)) continue;
            const i = index(bx, by, bz);
            if (torches[i]) {
              torches[i] = 0;
              torchCount--;
              markBlockWaterDirty(bz);
              rebuildDirtyWaterSlices();
              recomputeBlockLight();
              packLightTexture();
              return true;
            }
          }
        }
      }
      return false;
    }

    function getLightAt(wx, wy, wz) {
      const bx = Math.max(0, Math.min(WORLD_X - 1, Math.floor(wx)));
      const by = Math.max(0, Math.min(WORLD_Y - 1, Math.floor(wy)));
      const bz = Math.max(0, Math.min(WORLD_Z - 1, Math.floor(wz)));
      const i = index(bx, by, bz);
      return { block: blockLight[i], sky: skyLight[i] };
    }

    function rebuildDirtyWaterSlices() {
      let anyUpdated = false;
      const layerStride = WORLD_X * WORLD_Y;
      for (let bz = 0; bz < WORLD_Z; bz++) {
        if (!dirtyWaterLayers[bz]) continue;
        const out = waterLayerBytes[bz];
        const baseIdx = bz * layerStride;
        for (let p = 0; p < layerStride; p++) {
          const idx = baseIdx + p;
          const b = blocks[idx];
          let visLevel = waterToVisualLevel(water[idx]);
          let isFall = 0;

          if (b === BLOCK_AIR) {
            const hasFall = falling[idx] !== 0 || streamFall[idx] > 0;
            if (hasFall) {
              isFall = 1;
              // 真上も落下中なら8スライス満タンの滝カーテン、落ち口（段差の上端）なら小川と同じ高さ2で滑らかに接続！
              const aboveFalling =
                bz + 1 < WORLD_Z &&
                (falling[idx + layerStride] !== 0 || streamFall[idx + layerStride] > 0);
              if (aboveFalling) {
                visLevel = Math.max(visLevel, 8);
              } else {
                visLevel = Math.max(visLevel, 2);
              }
            } else if (streamWet[idx] > 0) {
              // 流れる小川が飛び飛びにならないよう、直近で水が通った床面を連続した浅瀬として維持
              const hasSupport =
                bz === 0 ||
                blocks[idx - layerStride] !== BLOCK_AIR ||
                water[idx - layerStride] > 0 ||
                streamFall[idx - layerStride] > 0;
              if (hasSupport) {
                visLevel = Math.max(visLevel, 2);
              }
            }
          }

          // Gチャンネルフラグ: bit0=滝落下, bit1=固体, bit2=溶岩, bit3=松明, bit4=木(幹/葉), bit5=葉, bit6-7=草花
          const flags =
            isFall |
            (b !== BLOCK_AIR ? 2 : 0) |
            (b === BLOCK_LAVA ? 4 : 0) |
            (torches[idx] ? 8 : 0) |
            (b === BLOCK_WOOD || b === BLOCK_LEAVES ? 16 : 0) |
            (b === BLOCK_LEAVES ? 32 : 0) |
            ((foliage[idx] & 3) << 6);
          out[p * 2] = visLevel;
          out[p * 2 + 1] = flags;
        }
        anyUpdated = true;
      }
      if (anyUpdated) {
        waterTexVersion++;
      }
    }

    let totalWaterUnits = 0;
    let waterSettled = false;
    let calmStreak = 0;

    function resetWaterToHighlands() {
      water.fill(0);
      falling.fill(0);
      streamWet.fill(0);
      streamFall.fill(0);
      trailActive.fill(0);
      trailCount = 0;
      layerHasWater.fill(0);
      dirtyWaterLayers.fill(1);
      waterSettled = false;
      calmStreak = 0;

      const highSpots = [];
      for (let y = 4; y < WORLD_Y - 4; y += 2) {
        for (let x = 4; x < WORLD_X - 4; x += 2) {
          const topZ = surfaceHeight[y * WORLD_X + x];
          if (topZ >= 6 && topZ + 1 < WORLD_Z && getBlock(x, y, topZ + 1) === BLOCK_AIR) {
            highSpots.push({ x, y, z: topZ + 1 });
          }
        }
      }

      const targetUnits = 7200 * WATER_PER_LEVEL; // 57,600 単位
      let placed = 0;

      // 山の上の泉の池 (basinZ) を最初から満水にしておき、起動直後からゆっくり溢れて滝になるようにする
      for (let s = 0; s < springs.length; s++) {
        const sp = springs[s];
        const bz = sp.basinZ !== undefined ? sp.basinZ : sp.z;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const bx = sp.x + dx;
            const by = sp.y + dy;
            if (inBounds(bx, by, bz)) {
              const ib = index(bx, by, bz);
              if (blocks[ib] === BLOCK_AIR && water[ib] < WATER_MAX) {
                const add = WATER_MAX - water[ib];
                water[ib] += add;
                layerHasWater[bz] = 1;
                placed += add;
              }
            }
            if (inBounds(bx, by, sp.z)) {
              const i = index(bx, by, sp.z);
              if (blocks[i] === BLOCK_AIR && water[i] < WATER_MAX) {
                const add = Math.min(WATER_MAX - water[i], 20);
                water[i] += add;
                layerHasWater[sp.z] = 1;
                placed += add;
              }
            }
          }
        }
      }

      if (highSpots.length > 0) {
        const stride = Math.max(1, Math.floor(highSpots.length / 750));
        let pass = 0;
        while (placed < targetUnits && pass < 20) {
          for (let k = 0; k < highSpots.length && placed < targetUnits; k += stride) {
            const sp = highSpots[(k + pass * 11) % highSpots.length];
            const z = Math.min(WORLD_Z - 1, sp.z + Math.floor(pass / 5));
            const i = index(sp.x, sp.y, z);
            if (blocks[i] === BLOCK_AIR && water[i] < WATER_MAX) {
              const add = Math.min(WATER_MAX - water[i], targetUnits - placed, 32);
              water[i] += add;
              layerHasWater[z] = 1;
              placed += add;
            }
          }
          pass++;
        }
      }

      totalWaterUnits = placed;
      recomputeActiveDrops();
      rebuildDirtyWaterSlices();
    }

    const DIRS = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    let simTick = 0;

    let lastTotalMoved = 999;

    function stepWater() {
      if (waterSettled && springs.length === 0) return false;
      simTick++;
      falling.fill(0);

      let totalMoved = 0;
      let visualChanged = false;
      const layerStride = WORLD_X * WORLD_Y;

      function touchTrail(idx, wetVal, fallVal) {
        if (wetVal > streamWet[idx]) streamWet[idx] = wetVal;
        if (fallVal > streamFall[idx]) streamFall[idx] = fallVal;
        if (!trailActive[idx]) {
          trailActive[idx] = 1;
          trailList[trailCount++] = idx;
        }
      }

      // 流路トレイルをアクティブな数百マスだけ高速減衰（23万マス全走査を回避！）
      let writeIdx = 0;
      for (let k = 0; k < trailCount; k++) {
        const idx = trailList[k];
        const z = Math.floor(idx / layerStride);
        if (streamWet[idx] > 0) {
          streamWet[idx]--;
          if (streamWet[idx] === 0 && water[idx] === 0) {
            visualChanged = true;
            markBlockWaterDirty(z);
          }
        }
        if (streamFall[idx] > 0) {
          streamFall[idx]--;
          if (streamFall[idx] === 0) {
            visualChanged = true;
            markBlockWaterDirty(z);
            if (z > 0) markBlockWaterDirty(z - 1);
          }
        }
        if (streamWet[idx] > 0 || streamFall[idx] > 0) {
          trailList[writeIdx++] = idx;
        } else {
          trailActive[idx] = 0;
        }
      }
      trailCount = writeIdx;

      // 0. 山の上の泉から少しずつ水が湧き出し続ける（毎ステップ少量ずつ安定湧出）
      for (let s = 0; s < springs.length; s++) {
        const sp = springs[s];
        if (simTick % sp.interval !== 0) continue;
        const si = index(sp.x, sp.y, sp.z);
        if (blocks[si] === BLOCK_AIR && water[si] < WATER_MAX) {
          const prevVis = waterToVisualLevel(water[si]);
          const add = Math.min(sp.rate, WATER_MAX - water[si]);
          water[si] += add;
          touchTrail(si, 14, 0);
          layerHasWater[sp.z] = 1;
          waterSettled = false;
          totalMoved += add;
          if (waterToVisualLevel(water[si]) !== prevVis) {
            visualChanged = true;
            markBlockWaterDirty(sp.z);
          }
        }
      }

      const dropInterval = lastTotalMoved < 250 ? 8 : 4;
      if (simTick % dropInterval === 1) {
        recomputeActiveDrops();
      }

      const xStart = simTick & 1 ? 0 : WORLD_X - 1;
      const xEnd = simTick & 1 ? WORLD_X : -1;
      const xStep = simTick & 1 ? 1 : -1;

      const yStart = simTick & 2 ? 0 : WORLD_Y - 1;
      const yEnd = simTick & 2 ? WORLD_Y : -1;
      const yStep = simTick & 2 ? 1 : -1;

      function transfer(srcIdx, dstIdx, amount, srcZ, dstZ) {
        if (amount <= 0) return;
        const prevSrcVis = waterToVisualLevel(water[srcIdx]);
        const prevDstVis = waterToVisualLevel(water[dstIdx]);
        const wasSrcWet = streamWet[srcIdx] > 0;
        const wasDstWet = streamWet[dstIdx] > 0;
        water[srcIdx] -= amount;
        water[dstIdx] += amount;
        totalMoved += amount;
        layerHasWater[dstZ] = 1;

        // 通過した流路に小川トレイルを刻み、飛び飛びにならない連続した流れにする
        if (dstZ < srcZ) {
          if (streamFall[srcIdx] === 0 || streamFall[dstIdx] === 0) {
            visualChanged = true;
            markBlockWaterDirty(srcZ);
            markBlockWaterDirty(dstZ);
          }
          touchTrail(srcIdx, 14, 14);
          touchTrail(dstIdx, 14, 14);
        } else if (dstZ > 0 && blocks[dstIdx - layerStride] === BLOCK_AIR && water[dstIdx - layerStride] < WATER_MAX) {
          // 段差の落ち口へ流れ込んだ瞬間から滝カーテンを連続させる
          if (streamFall[dstIdx] === 0) {
            visualChanged = true;
            markBlockWaterDirty(dstZ);
          }
          touchTrail(srcIdx, 14, 0);
          touchTrail(dstIdx, 14, 14);
        } else {
          touchTrail(srcIdx, 14, 0);
          touchTrail(dstIdx, 14, 0);
        }

        if (
          waterToVisualLevel(water[srcIdx]) !== prevSrcVis ||
          waterToVisualLevel(water[dstIdx]) !== prevDstVis ||
          !wasSrcWet ||
          !wasDstWet
        ) {
          visualChanged = true;
          markBlockWaterDirty(srcZ);
          if (dstZ !== srcZ) markBlockWaterDirty(dstZ);
        }
      }

      for (let z = 1; z < WORLD_Z; z++) {
        if (!layerHasWater[z]) continue;
        for (let y = yStart; y !== yEnd; y += yStep) {
          for (let x = xStart; x !== xEnd; x += xStep) {
            const i = index(x, y, z);
            const w = water[i];
            if (w === 0) continue;

            const below = index(x, y, z - 1);
            if (blocks[below] === BLOCK_AIR && water[below] < WATER_MAX) {
              const fall = Math.min(w, WATER_MAX - water[below]);
              transfer(i, below, fall, z, z - 1);
              falling[below] = 1;
              if (water[i] > 0) falling[i] = 1;
              markBlockWaterDirty(z);
              markBlockWaterDirty(z - 1);
            }
          }
        }
      }

      const dirStart = simTick & 3;
      const downhillBuf = [0, 0, 0, 0];
      const basinBuf = [0, 0, 0, 0];

      for (let z = 0; z < WORLD_Z; z++) {
        if (!layerHasWater[z]) continue;
        let anyInLayer = 0;

        for (let y = yStart; y !== yEnd; y += yStep) {
          for (let x = xStart; x !== xEnd; x += xStep) {
            const i = index(x, y, z);
            let w = water[i];
            if (w === 0) continue;
            anyInLayer = 1;

            if (z > 0) {
              const below = index(x, y, z - 1);
              if (blocks[below] === BLOCK_AIR && water[below] < WATER_MAX) {
                falling[i] = 1;
                continue;
              }
            }

            const curDist = distToDrop[i];

            if (curDist > 0 && curDist < 255) {
              let bestDist = curDist;
              let bestCount = 0;

              for (let d = 0; d < 4; d++) {
                const dir = DIRS[(dirStart + d) & 3];
                const nx = x + dir[0];
                const ny = y + dir[1];
                if (nx < 0 || nx >= WORLD_X || ny < 0 || ny >= WORLD_Y) continue;
                const ni = index(nx, ny, z);
                if (blocks[ni] !== BLOCK_AIR || water[ni] >= WATER_MAX) continue;

                const nd = distToDrop[ni];
                if (nd >= curDist) continue;

                if (nd < bestDist) {
                  bestDist = nd;
                  downhillBuf[0] = ni;
                  bestCount = 1;
                } else if (nd === bestDist) {
                  downhillBuf[bestCount++] = ni;
                }
              }

              if (bestCount > 0) {
                const pick =
                  bestCount === 1
                    ? 0
                    : Math.floor(hash3(x + simTick * 5, y + simTick * 3, z) * bestCount);
                const dst = downhillBuf[pick];
                const room = WATER_MAX - water[dst];
                // 少量でも一気に空にして飛び飛びにせず、滑らかに送り出しつつ流れが途切れたら綺麗に引き切る
                const want = w <= 2 ? w : Math.max(2, Math.ceil(w * 0.65));
                const flow = Math.min(w, room, want);
                if (flow > 0) {
                  transfer(i, dst, flow, z, z);
                  continue;
                }
              }
            }

            let bCount = 0;
            for (let d = 0; d < 4; d++) {
              const dir = DIRS[(dirStart + d) & 3];
              const nx = x + dir[0];
              const ny = y + dir[1];
              if (nx < 0 || nx >= WORLD_X || ny < 0 || ny >= WORLD_Y) continue;
              const ni = index(nx, ny, z);
              if (blocks[ni] !== BLOCK_AIR) continue;
              if (curDist > 0 && curDist < 255 && distToDrop[ni] > curDist) continue;
              if (water[ni] <= w - 3) {
                basinBuf[bCount++] = ni;
              }
            }

            if (bCount > 0) {
              for (let k = 0; k < bCount && w >= 3; k++) {
                let minIdx = -1;
                let minW = w;
                for (let j = 0; j < bCount; j++) {
                  const ni = basinBuf[j];
                  if (water[ni] < minW) {
                    minW = water[ni];
                    minIdx = ni;
                  }
                }
                if (minIdx === -1 || w - minW < 3) break;
                const flow = Math.max(1, Math.floor((w - minW) / 2));
                transfer(i, minIdx, flow, z, z);
                w = water[i];
              }
            }
          }
        }

        layerHasWater[z] = anyInLayer;
      }

      // マップ最外周に到達した水は世界の外の海へ自然に流れ出て、長時間放置しても溢れ続けないようにする
      for (let z = 0; z < WORLD_Z; z++) {
        if (!layerHasWater[z]) continue;
        for (let x = 0; x < WORLD_X; x++) {
          const iTop = index(x, 0, z);
          if (water[iTop] > 0) {
            const pv = waterToVisualLevel(water[iTop]);
            water[iTop] = Math.max(0, water[iTop] - 4);
            if (waterToVisualLevel(water[iTop]) !== pv) {
              visualChanged = true;
              markBlockWaterDirty(z);
            }
          }
          const iBot = index(x, WORLD_Y - 1, z);
          if (water[iBot] > 0) {
            const pv = waterToVisualLevel(water[iBot]);
            water[iBot] = Math.max(0, water[iBot] - 4);
            if (waterToVisualLevel(water[iBot]) !== pv) {
              visualChanged = true;
              markBlockWaterDirty(z);
            }
          }
        }
        for (let y = 1; y < WORLD_Y - 1; y++) {
          const iL = index(0, y, z);
          if (water[iL] > 0) {
            const pv = waterToVisualLevel(water[iL]);
            water[iL] = Math.max(0, water[iL] - 4);
            if (waterToVisualLevel(water[iL]) !== pv) {
              visualChanged = true;
              markBlockWaterDirty(z);
            }
          }
          const iR = index(WORLD_X - 1, y, z);
          if (water[iR] > 0) {
            const pv = waterToVisualLevel(water[iR]);
            water[iR] = Math.max(0, water[iR] - 4);
            if (waterToVisualLevel(water[iR]) !== pv) {
              visualChanged = true;
              markBlockWaterDirty(z);
            }
          }
        }
      }

      lastTotalMoved = totalMoved;

      if (visualChanged) {
        rebuildDirtyWaterSlices();
      }

      if (springs.length === 0) {
        if (totalMoved === 0) {
          calmStreak += 3;
        } else if (!visualChanged && totalMoved <= 14) {
          calmStreak++;
        } else {
          calmStreak = 0;
        }

        if (calmStreak >= 12) {
          waterSettled = true;
          falling.fill(0);
          dirtyWaterLayers.fill(1);
          rebuildDirtyWaterSlices();
        }
      }

      return totalMoved > 0;
    }

    function computeCurrentTotalWater() {
      let sum = 0;
      for (let i = 0; i < cellCount; i++) {
        sum += water[i];
      }
      return sum;
    }

    function getWaterLevelAt(wx, wy, wz) {
      const bx = Math.floor(wx);
      const by = Math.floor(wy);
      const bz = Math.floor(wz);
      if (!inBounds(bx, by, bz)) return 0;
      return waterToVisualLevel(water[index(bx, by, bz)]);
    }

    function getBiomeNameAt(wx, wy, wz) {
      const bx = Math.max(0, Math.min(WORLD_X - 1, Math.floor(wx)));
      const by = Math.max(0, Math.min(WORLD_Y - 1, Math.floor(wy)));
      const bz = Math.max(0, Math.min(WORLD_Z - 1, Math.floor(wz !== undefined ? wz : 5)));
      if (skyRoofDistance(bx, by, bz) > 0) {
        return "洞窟・地下";
      }
      return biomeMap[by * WORLD_X + bx] > 0.45 ? "岩山・峡谷" : "森の渓谷";
    }

    function findFloorBelow(wx, wy, fromZ) {
      const bx = Math.floor(wx);
      const by = Math.floor(wy);
      const startBz = Math.min(WORLD_Z - 1, Math.floor(fromZ - 0.001));
      for (let bz = startBz; bz >= 0; bz--) {
        const b = getBlock(bx, by, bz);
        if (b !== BLOCK_AIR) {
          return { floorZ: bz + 1, blockType: b };
        }
      }
      return { floorZ: 0, blockType: BLOCK_AIR };
    }

    resetWaterToHighlands();
    // 初期の松明をスタート広場と洞窟入口に1本ずつ置いて、夜や洞窟の雰囲気をすぐ体感できるようにする
    torches[index(62, 64, spawnZ)] = 1;
    torches[index(67, 64, 5)] = 1;
    torchCount = 2;

    // 草ブロックの上に自然な群生で雑草・野花を配置（歩ける装飾レイヤー）
    let foliageCount = 0;
    let flowerCount = 0;
    for (let y = 1; y < WORLD_Y - 1; y++) {
      for (let x = 1; x < WORLD_X - 1; x++) {
        const topZ = surfaceHeight[y * WORLD_X + x];
        const z = topZ + 1;
        if (z >= WORLD_Z) continue;
        if (getBlock(x, y, topZ) !== BLOCK_GRASS) continue;
        const i = index(x, y, z);
        if (blocks[i] !== BLOCK_AIR || torches[i] || water[i] > 0) continue;
        // プレイヤーの初期スポーン地点直下だけ空ける
        if (x === 60 && y === 64) continue;

        const patch = fbm2D(x * 0.13 + 3.7, y * 0.13 + 9.2, seed + 4101);
        const flowerPatch = fbm2D(x * 0.16 + 19.4, y * 0.16 + 5.1, seed + 4201);
        const r = hash3(x, y, seed + 4444);

        if (flowerPatch > 0.62 && r > 0.87) {
          foliage[i] = 3; // 花（赤・黄・白・青・ピンク：草むらの中に約1/3の控えめな割合で点在）
          flowerCount++;
          foliageCount++;
        } else if (patch > 0.44 && r > 0.54) {
          foliage[i] = r > 0.76 ? 2 : 1; // 2=背の高い雑草, 1=短い雑草
          foliageCount++;
        } else if (r > 0.86) {
          foliage[i] = 1; // 草原に点在する小さな草むら
          foliageCount++;
        }
      }
    }

    dirtyWaterLayers.fill(1);
    rebuildDirtyWaterSlices();
    recomputeSkyLight();
    recomputeBlockLight();
    packLightTexture();

    // ============================================================
    // 8.5 白い羊モブのスポーン＆のんびり放牧AI
    // ============================================================
    const sheepList = [];
    function spawnSheep(sx, sy, sz, idx) {
      sheepList.push({
        x: sx + 0.5,
        y: sy + 0.5,
        z: sz,
        vz: 0,
        radius: 0.30,
        height: 1.12,
        facing: hash3(sx, sy, seed + 6100 + idx) * Math.PI * 2,
        targetFacing: hash3(sx, sy, seed + 6100 + idx) * Math.PI * 2,
        state: idx % 2 === 0 ? "walk" : "idle",
        timer: 1.2 + hash3(sx, sy, seed + 6200 + idx) * 3.0,
        isMoving: false,
        onGround: true,
        inWater: false,
        walkCycle: hash3(sx, sy, seed + 6300 + idx) * 10.0,
      });
    }

    function canSpawnSheepAt(x, y) {
      if (x < 6 || y < 6 || x >= WORLD_X - 6 || y >= WORLD_Y - 6) return false;
      const topZ = surfaceHeight[y * WORLD_X + x];
      const z = topZ + 1;
      if (z + 1 >= WORLD_Z) return false;
      if (getBlock(x, y, topZ) !== BLOCK_GRASS) return false;
      if (getBlock(x, y, z) !== BLOCK_AIR || getBlock(x, y, z + 1) !== BLOCK_AIR) return false;
      if (water[index(x, y, z)] > 0) return false;
      for (let i = 0; i < sheepList.length; i++) {
        if (Math.hypot(x + 0.5 - sheepList[i].x, y + 0.5 - sheepList[i].y) < 3.5) return false;
      }
      return true;
    }

    // スタート地点のすぐ近く（4〜14ブロック圏）に3匹スポーンしてすぐ見つけられるように
    for (let attempt = 0; attempt < 260 && sheepList.length < 3; attempt++) {
      const ang = hash3(attempt, 1, seed + 6400) * Math.PI * 2;
      const dist = 4.5 + hash3(attempt, 2, seed + 6400) * 10.0;
      const sx = Math.round(spawnX + Math.cos(ang) * dist);
      const sy = Math.round(spawnY + Math.sin(ang) * dist);
      if (canSpawnSheepAt(sx, sy)) {
        spawnSheep(sx, sy, surfaceHeight[sy * WORLD_X + sx] + 1, sheepList.length);
      }
    }
    // さらに草原バイオーム全体に合計10匹まで配置
    for (let attempt = 0; attempt < 600 && sheepList.length < 10; attempt++) {
      const sx = 10 + Math.floor(hash3(attempt, 3, seed + 6500) * (WORLD_X - 20));
      const sy = 10 + Math.floor(hash3(attempt, 4, seed + 6500) * (WORLD_Y - 20));
      if (canSpawnSheepAt(sx, sy)) {
        spawnSheep(sx, sy, surfaceHeight[sy * WORLD_X + sx] + 1, sheepList.length);
      }
    }

    function sheepHasSolidAtLayer(px, py, r, bz) {
      const minX = Math.floor(px - r);
      const maxX = Math.floor(px + r);
      const minY = Math.floor(py - r);
      const maxY = Math.floor(py + r);
      for (let by = minY; by <= maxY; by++) {
        for (let bx = minX; bx <= maxX; bx++) {
          if (getBlock(bx, by, bz) !== BLOCK_AIR) return true;
        }
      }
      return false;
    }

    function sheepCollidesAt(px, py, pz, r, h) {
      if (px - r < 1 || px + r > WORLD_X - 1 || py - r < 1 || py + r > WORLD_Y - 1) return true;
      const minZ = Math.floor(pz + 0.01);
      const maxZ = Math.floor(pz + h - 0.01);
      for (let bz = minZ; bz <= maxZ; bz++) {
        if (sheepHasSolidAtLayer(px, py, r, bz)) return true;
      }
      return false;
    }

    function updateSheep(dt, player) {
      const stepDt = Math.min(0.05, Math.max(0.001, dt));
      for (let i = 0; i < sheepList.length; i++) {
        const s = sheepList[i];
        const wLv = getWaterLevelAt(s.x, s.y, s.z + 0.1);
        s.inWater = wLv > 0;

        if (player) {
          const pdx = s.x - player.x;
          const pdy = s.y - player.y;
          const pDist = Math.hypot(pdx, pdy);
          if (pDist < 1.1 && pDist > 0.05 && Math.abs(s.z - player.z) < 1.5) {
            s.targetFacing = Math.atan2(pdy, pdx);
            s.state = "walk";
            s.timer = Math.max(s.timer, 1.6);
          }
        }

        s.timer -= stepDt;
        if (s.timer <= 0) {
          if (s.state === "walk") {
            s.state = "idle";
            s.timer = 2.0 + Math.random() * 3.5;
          } else {
            s.state = "walk";
            s.targetFacing = s.facing + (Math.random() - 0.5) * Math.PI * 1.4;
            s.timer = 2.2 + Math.random() * 3.2;
          }
        }

        let diff = s.targetFacing - s.facing;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        s.facing += diff * Math.min(1, stepDt * 5.0);

        s.isMoving = s.state === "walk";
        if (s.isMoving) {
          const speed = s.inWater ? 0.95 : 1.35;
          const vx = Math.cos(s.facing) * speed * stepDt;
          const vy = Math.sin(s.facing) * speed * stepDt;
          const nx = s.x + vx;
          const ny = s.y + vy;

          const aheadX = Math.floor(s.x + Math.cos(s.facing) * 0.85);
          const aheadY = Math.floor(s.y + Math.sin(s.facing) * 0.85);
          const aheadFloor = findFloorBelow(aheadX + 0.5, aheadY + 0.5, s.z + 0.5);
          const dangerous = aheadFloor.blockType === BLOCK_LAVA || s.z - aheadFloor.floorZ > 2.2;

          if (dangerous) {
            s.targetFacing = s.facing + Math.PI * (0.7 + Math.random() * 0.6);
          } else {
            let blocked = false;
            if (!sheepCollidesAt(nx, s.y, s.z, s.radius, s.height)) {
              s.x = nx;
            } else {
              blocked = true;
            }
            if (!sheepCollidesAt(s.x, ny, s.z, s.radius, s.height)) {
              s.y = ny;
            } else {
              blocked = true;
            }

            if (blocked) {
              if (s.onGround && !sheepCollidesAt(nx, ny, s.z + 1.05, s.radius, s.height)) {
                s.vz = 7.4;
                s.onGround = false;
              } else {
                s.targetFacing = s.facing + Math.PI * (0.6 + Math.random() * 0.8);
              }
            }
          }
          s.walkCycle += stepDt;
        }

        if (s.inWater && s.vz < 1.6) {
          s.vz += 18.0 * stepDt;
        }
        const grav = s.inWater ? 9.0 : 20.0;
        s.vz -= grav * stepDt;
        if (s.inWater && s.vz < -2.2) s.vz = -2.2;

        const nextZ = s.z + s.vz * stepDt;
        if (s.vz <= 0) {
          if (nextZ <= 0) {
            s.z = 0;
            s.vz = 0;
            s.onGround = true;
          } else {
            const startBz = Math.floor(s.z - 0.0001);
            const endBz = Math.floor(nextZ);
            let landed = false;
            for (let bz = startBz; bz >= endBz; bz--) {
              if (sheepHasSolidAtLayer(s.x, s.y, s.radius, bz)) {
                s.z = bz + 1;
                s.vz = 0;
                s.onGround = true;
                landed = true;
                break;
              }
            }
            if (!landed) {
              s.z = nextZ;
              s.onGround = false;
            }
          }
        } else {
          const startCeil = Math.floor(s.z + s.height);
          const endCeil = Math.floor(nextZ + s.height);
          let hitCeil = false;
          for (let bz = startCeil; bz <= endCeil; bz++) {
            if (sheepHasSolidAtLayer(s.x, s.y, s.radius, bz)) {
              s.z = bz - s.height - 0.001;
              s.vz = 0;
              hitCeil = true;
              break;
            }
          }
          if (!hitCeil) s.z = nextZ;
          s.onGround = false;
        }
      }
    }

    return {
      seed,
      sizeX: WORLD_X,
      sizeY: WORLD_Y,
      sizeZ: WORLD_Z,
      totalSlices,
      maxUsedSlice,
      canvasW,
      canvasH,
      spawnX,
      spawnY,
      spawnZ,
      caveEntranceX: 66.5,
      caveEntranceY: 64.0,
      caveEntranceZ: 5.0,
      springViewX: 73.5,
      springViewY: 54.5,
      springViewZ: 11.0,
      springCount: springs.length,
      treeCount: treePositions.length,
      foliageCount,
      flowerCount,
      lavaPoolCount: lavaPools.length,
      solidBlockCount,
      spaghettiCarvedCount,
      initialBakeMs,
      getBlock,
      setBlock,
      inBounds,
      skyRoofDistance,
      findFloorBelow,
      getBiomeNameAt,
      getSlices,
      getSlicePack,
      dirtyTerrainSlices,
      getTerrainTexVersion: () => terrainTexVersion,
      destroyBlockAt,
      sheep: sheepList,
      updateSheep,
      waterLayerBytes,
      dirtyWaterLayers,
      getWaterTexVersion: () => waterTexVersion,
      lightTexBytes,
      getLightTexVersion: () => lightTexVersion,
      treeSwayBytes,
      getTreeSwayVersion: () => treeSwayVersion,
      updateTrees,
      placeTorchAt,
      removeTorchNear,
      getTorchCount: () => torchCount,
      getLightAt,
      stepWater,
      resetWaterToHighlands,
      getWaterLevelAt,
      isWaterSettled: () => waterSettled,
      getInitialTotalWater: () => totalWaterUnits,
      computeCurrentTotalWater,
    };
  }

  global.VoxelWalk = global.VoxelWalk || {};
  global.VoxelWalk.createWorld = createWorld;
})(window);
