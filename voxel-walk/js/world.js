/**
 * world.js
 * ------------------------------------------------------------
 * 128x128x12 のマルチバイオーム（森の渓谷 ＋ 激しい岩山・オーバーハング・トンネル）と、
 * テラリア式の総量保存・内部64段階/表示8段階・スリープ付き水流シミュレーションを管理します。
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
    hash3,
    sampleBlockColor24,
    shadePacked24ToABGR,
  } = global.VoxelWalk;

  const WORLD_X = 128;
  const WORLD_Y = 128;
  const WORLD_Z = 12; // 97スライス (0..96) — 岩山が z=10 までそびえ、トンネルやオーバーハングが立体交差する

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

  function createWorld(seedInput) {
    const seed = seedInput !== undefined ? seedInput : 104729;
    const cellCount = WORLD_X * WORLD_Y * WORLD_Z;
    const blocks = new Uint8Array(cellCount);
    const water = new Uint8Array(cellCount);
    const falling = new Uint8Array(cellCount);
    const surfaceHeight = new Uint8Array(WORLD_X * WORLD_Y);
    const biomeMap = new Float32Array(WORLD_X * WORLD_Y); // 0 = 森の渓谷, 1 = 激しい岩山

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
    // 1. 128x128 マルチバイオーム（森の渓谷 ＋ 激しい岩山・オーバーハング・トンネル）
    // ============================================================
    for (let y = 0; y < WORLD_Y; y++) {
      for (let x = 0; x < WORLD_X; x++) {
        // バイオーム判定：中央付近 (x > 66) が岩山バイオームに接するように軽くバイアス
        const bNoise = fbm2D(x * 0.022, y * 0.022, seed + 503);
        const eastBias = smoothstep(54, 78, x) * 0.24 - smoothstep(56, 36, x) * 0.16;
        const rockiness = smoothstep(0.42, 0.62, bNoise + eastBias);
        biomeMap[y * WORLD_X + x] = rockiness;

        // 外周の盆地リム（水がマップ外へ漏れずに谷へ溜まるようにする）
        const nx = (x / (WORLD_X - 1)) * 2 - 1;
        const ny = (y / (WORLD_Y - 1)) * 2 - 1;
        const edgeDist = Math.max(Math.abs(nx), Math.abs(ny));
        const rimBoost = edgeDist > 0.86 ? ((edgeDist - 0.86) / 0.14) * 3.0 : 0;

        // --- 森・渓谷バイオームの基本高度 (z = 0..4) ---
        const nForest = fbm2D(x * 0.036, y * 0.036, seed);
        const nDetail = fbm2D(x * 0.11, y * 0.11, seed + 131);
        const forestH = (nForest - 0.18) * 6.0 + (nDetail - 0.5) * 1.1;

        // --- 岩山バイオームの険しい尾根 (リッジノイズで切り立った峰 z = 2..10) ---
        const ridgeRaw = 1.0 - Math.abs(fbm2D(x * 0.042, y * 0.042, seed + 307) * 2 - 1);
        const ridgeSharp = ridgeRaw * ridgeRaw;
        const canyonRaw = fbm2D(x * 0.065, y * 0.065, seed + 613);
        const rockH = 1.2 + ridgeSharp * 8.6 + (canyonRaw - 0.48) * 3.2;

        let baseH = forestH * (1 - rockiness) + rockH * rockiness + rimBoost;

        // スタート地点 (60, 64) 周辺は歩きやすい草原広場に整地
        const distSpawn = Math.hypot(x - 60, y - 64);
        if (distSpawn < 5.5) {
          const blend = smoothstep(2.5, 5.5, distSpawn);
          baseH = 2.0 * (1 - blend) + baseH * blend;
        }

        // スタートすぐ東側 (72..84, 56..70) に象徴的な岩山塊を盛り上げる（トンネル＆オーバーハング用）
        const distLandmark = Math.hypot((x - 77) * 0.85, (y - 63) * 0.72);
        const landmarkBoost = Math.max(0, 1 - distLandmark / 11.5) * 6.8;
        if (landmarkBoost > 0.2) {
          baseH = Math.max(baseH, 2.2 + landmarkBoost);
          biomeMap[y * WORLD_X + x] = Math.max(rockiness, smoothstep(0.2, 2.0, landmarkBoost));
        }

        const localRock = biomeMap[y * WORLD_X + x];
        let highestZ = 0;

        // --- 3D密度評価によるオーバーハング＆トンネル生成 ---
        for (let z = 0; z < WORLD_Z - 1; z++) {
          let density = baseH - z;

          // 激しい岩山バイオームでは 3D ノイズで張り出し(オーバーハング)＆えぐれ(アンダーカット)を加える
          if (localRock > 0.25 && z >= 2 && z <= 9) {
            const oh = valueNoise3D(x * 0.095, y * 0.095, z * 0.26, seed + 821) - 0.48;
            // 上層(z>=5)は外へ張り出しやすく、中層(z=2..4)は内側へえぐれやすくして迫力あるオーバーハングを作る
            const bias = z >= 5 ? 0.16 : -0.14;
            density += (oh + bias) * 3.8 * localRock;
          }

          // 岩山内部にうねる3D洞窟・トンネルをくり抜く (z = 2..5)
          if (localRock > 0.42 && z >= 2 && z <= 5 && distSpawn > 8) {
            const tA = Math.abs(valueNoise3D(x * 0.065, y * 0.065, z * 0.12, seed + 1409) - 0.5);
            const tB = Math.abs(valueNoise3D(x * 0.065 + 31, y * 0.065 + 17, z * 0.14, seed + 1801) - 0.5);
            if (tA < 0.088 && tB < 0.125) {
              density = -1.0;
            }
          }

          if (z === 0) density = 1.0; // 最下層 z=0 は必ず床にする

          if (density >= 0) {
            // バイオームと高さに応じてブロック種類を決定
            let type;
            if (localRock > 0.52) {
              // 岩山バイオーム：下部や地層帯に深岩、それ以外は岩ブロック
              type = z <= 2 || z === 5 ? BLOCK_DARK_STONE : BLOCK_STONE;
            } else if (localRock > 0.28 && z >= 4) {
              type = BLOCK_STONE;
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

    // 2. スタート地点東側のランドマーク岩山に「歩いて通り抜けられる大トンネル」と「張り出した大オーバーハング」を彫刻
    //    - 東西貫通トンネル (x = 67..87, y = 62..64, z = 3..5 をくり抜き、z = 2 を岩床、z = 6..9 を岩屋根に)
    for (let x = 66; x <= 88; x++) {
      const curveY = 63 + Math.round(Math.sin((x - 66) * 0.22) * 1.4);
      for (let dy = -1; dy <= 1; dy++) {
        const ty = curveY + dy;
        // しっかりした岩の床
        setBlock(x, ty, 1, BLOCK_DARK_STONE);
        setBlock(x, ty, 2, BLOCK_STONE);
        // 高さ3ブロックの歩きやすいトンネル空間（天井は曲面のアーチ状に）
        const roofClear = Math.abs(dy) === 0 ? 5 : 4;
        for (let z = 3; z <= roofClear; z++) {
          setBlock(x, ty, z, BLOCK_AIR);
        }
      }
    }

    //    - トンネル北側に、空中に4ブロック大きくせり出す「迫力の大オーバーハング岩棚」(x = 71..79, y = 52..57)
    for (let x = 71; x <= 79; x++) {
      for (let y = 52; y <= 57; y++) {
        // 下層 (z = 2..5) を大きくえぐって空洞にする
        for (let z = 2; z <= 5; z++) {
          setBlock(x, y, z, BLOCK_AIR);
        }
        // 上層 (z = 6..8) にせり出した岩のオーバーハングを作る
        if (y >= 53 && y <= 57) {
          setBlock(x, y, 6, BLOCK_DARK_STONE);
          setBlock(x, y, 7, BLOCK_STONE);
          if (y >= 54 && x >= 72 && x <= 78) {
            setBlock(x, y, 8, BLOCK_STONE);
          }
        }
      }
    }

    // 3. 露出している土ブロックの上面を草ブロックへ変換し、surfaceHeight と solidCount を確定
    let solidBlockCount = 0;
    for (let y = 0; y < WORLD_Y; y++) {
      for (let x = 0; x < WORLD_X; x++) {
        let topSolid = 0;
        const localRock = biomeMap[y * WORLD_X + x];
        for (let z = 0; z < WORLD_Z; z++) {
          const b = getBlock(x, y, z);
          if (b === BLOCK_AIR) continue;
          topSolid = z;
          if (b === BLOCK_DIRT && getBlock(x, y, z + 1) === BLOCK_AIR && localRock < 0.45 && z >= 1) {
            setBlock(x, y, z, BLOCK_GRASS);
          }
          solidBlockCount++;
        }
        surfaceHeight[y * WORLD_X + x] = topSolid;
      }
    }

    // スタート地点の安全座標
    const spawnX = 60.5;
    const spawnY = 64.5;
    const spawnZ = surfaceHeight[64 * WORLD_X + 60] + 1;

    // ============================================================
    // 4. 森の渓谷バイオームにボクセルの木を生やす
    // ============================================================
    const treePositions = [];
    for (let y = 4; y < WORLD_Y - 4; y += 2) {
      for (let x = 4; x < WORLD_X - 4; x += 2) {
        if (biomeMap[y * WORLD_X + x] > 0.36) continue; // 岩山には生やさない
        const topZ = surfaceHeight[y * WORLD_X + x];
        if (topZ < 2 || topZ > 5) continue;
        if (Math.hypot(x - 60, y - 64) < 5.5) continue;
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
    // 5. 高速ゼロアロケーション 3D AO ＋ 段差エッジ ＋ 境界天面キャップベイク
    // ============================================================
    const totalSlices = WORLD_Z * BLOCK_SLICES + 1;
    const canvasW = WORLD_X * BLOCK_SIZE; // 768
    const canvasH = WORLD_Y * BLOCK_SIZE; // 768
    const sliceCache = Object.create(null);

    // 上空遮蔽テーブル（トンネル内部やオーバーハング下に深い影を落とす）
    const roofDistTable = new Uint8Array(cellCount);
    for (let y = 0; y < WORLD_Y; y++) {
      for (let x = 0; x < WORLD_X; x++) {
        let nearestRoofZ = -1;
        for (let z = WORLD_Z - 1; z >= 0; z--) {
          const i = index(x, y, z);
          if (nearestRoofZ !== -1) {
            roofDistTable[i] = nearestRoofZ - z;
          }
          if (blocks[i] !== BLOCK_AIR) {
            nearestRoofZ = z;
          }
        }
      }
    }

    function skyRoofDistance(x, y, z) {
      if (!inBounds(x, y, z)) return 0;
      return roofDistTable[index(x, y, z)];
    }

    function packRGBA(r, g, b, a) {
      return ((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
    }

    // 地中埋没ブロック用の高速単色カラー
    const BURIED_COLORS = new Uint32Array(8);
    BURIED_COLORS[BLOCK_DIRT] = packRGBA(74, 50, 32, 255);
    BURIED_COLORS[BLOCK_GRASS] = packRGBA(74, 50, 32, 255);
    BURIED_COLORS[BLOCK_STONE] = packRGBA(82, 86, 94, 255);
    BURIED_COLORS[BLOCK_DARK_STONE] = packRGBA(52, 56, 66, 255);
    BURIED_COLORS[BLOCK_WOOD] = packRGBA(76, 52, 32, 255);
    BURIED_COLORS[BLOCK_LEAVES] = packRGBA(36, 90, 36, 255);

    const bakeStartMs = performance.now();

    function bakeSlices(enableAO, enableEdge) {
      // WebGL2 TEXTURE_2D_ARRAY へ直接転送できる Uint8Array スライス配列を生成（DOM Canvas 不要で超高速）
      const slices = [];
      const bounds = [];

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
          skyFactor: roofDist > 0 ? Math.min(0.76, 0.54 + roofDist * 0.03) : 1.0,
        };
      }

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
          const basePy = by * BLOCK_SIZE;
          for (let bx = bMinX; bx <= bMaxX; bx++) {
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
              if (type === BLOCK_AIR) continue;
            }

            const basePx = bx * BLOCK_SIZE;

            // 高速パス：四方が完全に埋まった地中側面ブロックは単色パック書き込み
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
              continue;
            }

            const elevLight = enableEdge ? Math.min(1.26, 0.78 + drawBz * 0.062) : 1.0;

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
                  // トンネル内部や大オーバーハング下にしっかり濃い影を落とす
                  topSkyFactor = Math.min(0.68, 0.44 + roofDist * 0.035);
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

                  lightMult *= Math.max(0.28, ao);
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

                buf32[rowOff + lx] = shadePacked24ToABGR(rgb24, Math.max(0.24, lightMult));
              }
            }
          }
        }

        slices.push(rawBytes);
      }

      return { slices, bounds };
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

    // WebGL2 3D/Array テクスチャへ直接転送する軽量バイトバッファ（128x128x12 x RG8 = 393KB のみ！）
    // R = 表示水深 (0..8), G = bit0: 落下中(滝) | bit1: 固体ブロックフラグ（岸辺泡シェーダー用）
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

    function rebuildDirtyWaterSlices() {
      let anyUpdated = false;
      for (let bz = 0; bz < WORLD_Z; bz++) {
        if (!dirtyWaterLayers[bz]) continue;
        const out = waterLayerBytes[bz];
        const baseIdx = bz * WORLD_Y * WORLD_X;
        for (let p = 0; p < WORLD_X * WORLD_Y; p++) {
          const idx = baseIdx + p;
          const visLevel = waterToVisualLevel(water[idx]);
          const flags = (falling[idx] ? 1 : 0) | (blocks[idx] !== BLOCK_AIR ? 2 : 0);
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
      layerHasWater.fill(0);
      dirtyWaterLayers.fill(1);
      waterSettled = false;
      calmStreak = 0;

      // 岩山の上や高台（ランドマークのオーバーハング付近含む）から水を流し落とす
      const highSpots = [];
      for (let y = 4; y < WORLD_Y - 4; y += 2) {
        for (let x = 4; x < WORLD_X - 4; x += 2) {
          const topZ = surfaceHeight[y * WORLD_X + x];
          if (topZ >= 4 && topZ + 1 < WORLD_Z && getBlock(x, y, topZ + 1) === BLOCK_AIR) {
            highSpots.push({ x, y, z: topZ + 1 });
          }
        }
      }

      const targetUnits = 7200 * WATER_PER_LEVEL; // 57,600 単位 (900ブロック相当)
      let placed = 0;

      // まずランドマーク岩山（大オーバーハング付近）に滝の水源を少し配置
      for (let x = 73; x <= 77 && placed < targetUnits; x++) {
        for (let y = 54; y <= 57 && placed < targetUnits; y++) {
          const z = surfaceHeight[y * WORLD_X + x] + 1;
          if (z < WORLD_Z && getBlock(x, y, z) === BLOCK_AIR) {
            const i = index(x, y, z);
            const add = Math.min(WATER_MAX - water[i], 48);
            water[i] += add;
            layerHasWater[z] = 1;
            placed += add;
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

    function stepWater() {
      if (waterSettled) return false;
      simTick++;
      falling.fill(0);

      if (simTick % 4 === 1) {
        recomputeActiveDrops();
      }

      const xStart = simTick & 1 ? 0 : WORLD_X - 1;
      const xEnd = simTick & 1 ? WORLD_X : -1;
      const xStep = simTick & 1 ? 1 : -1;

      const yStart = simTick & 2 ? 0 : WORLD_Y - 1;
      const yEnd = simTick & 2 ? WORLD_Y : -1;
      const yStep = simTick & 2 ? 1 : -1;

      let totalMoved = 0;
      let visualChanged = false;

      function transfer(srcIdx, dstIdx, amount, srcZ, dstZ) {
        if (amount <= 0) return;
        const prevSrcVis = waterToVisualLevel(water[srcIdx]);
        const prevDstVis = waterToVisualLevel(water[dstIdx]);
        water[srcIdx] -= amount;
        water[dstIdx] += amount;
        totalMoved += amount;
        layerHasWater[dstZ] = 1;
        if (
          waterToVisualLevel(water[srcIdx]) !== prevSrcVis ||
          waterToVisualLevel(water[dstIdx]) !== prevDstVis
        ) {
          visualChanged = true;
          markBlockWaterDirty(srcZ);
          if (dstZ !== srcZ) markBlockWaterDirty(dstZ);
        }
      }

      // Pass 1: 重力落下
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

      // Pass 2: 単調下り排水 ＋ 湖面均等化
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
                const want = w <= 10 ? w : Math.max(4, Math.ceil(w * 0.55));
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

      if (visualChanged) {
        rebuildDirtyWaterSlices();
      }

      if (totalMoved === 0) {
        calmStreak += 3;
      } else if (!visualChanged && totalMoved <= 12) {
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

    function getBiomeNameAt(wx, wy) {
      const bx = Math.max(0, Math.min(WORLD_X - 1, Math.floor(wx)));
      const by = Math.max(0, Math.min(WORLD_Y - 1, Math.floor(wy)));
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
      treeCount: treePositions.length,
      solidBlockCount,
      initialBakeMs,
      getBlock,
      setBlock,
      inBounds,
      findFloorBelow,
      getBiomeNameAt,
      getSlices,
      getSlicePack,
      waterLayerBytes,
      dirtyWaterLayers,
      getWaterTexVersion: () => waterTexVersion,
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
