/**
 * world.js
 * ------------------------------------------------------------
 * 64x64x10 のノイズ起伏地形・ボクセルの木（幹＋葉）・
 * テラリア式の総量保存8段階水流シミュレーションを管理します。
 *
 * 【水シミュレーションの特徴】
 * - 各セルは整数 0..8 の水量を持つ（8 = 1ブロック満タン、1 = 1/8の浅い水たまり）
 * - 重力による落下＋隣接セルとの水平均等化＋崖フチの排水を行い、
 *   すべての移動が water[src] -= d; water[dst] += d のみで行われるため
 *   世界全体の水の総量（totalWater）が1単位も増減せず厳密に保存されます。
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
    hash3,
    sampleBlockColor,
    shadeColor,
  } = global.VoxelWalk;

  const WORLD_X = 64;
  const WORLD_Y = 64;
  const WORLD_Z = 10; // 地形は z=0..5、木が z=6..9 まで伸びる

  // テラリア式に内部水量を細かく保持（1ブロック = 64単位、表示は 8段階 = 8単位ごと）
  const WATER_PER_LEVEL = 8;
  const WATER_MAX = BLOCK_SLICES * WATER_PER_LEVEL; // 64

  function waterToVisualLevel(units) {
    if (units <= 0) return 0;
    return Math.min(BLOCK_SLICES, Math.ceil(units / WATER_PER_LEVEL));
  }

  // スムーズな 2D 値ノイズ（多オクターブ FBM 用）
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

  function createWorld(seedInput) {
    const seed = seedInput !== undefined ? seedInput : 104729;
    const cellCount = WORLD_X * WORLD_Y * WORLD_Z;
    const blocks = new Uint8Array(cellCount);
    const water = new Uint8Array(cellCount); // 各セルの水量 0..8
    const falling = new Uint8Array(cellCount); // 滝として落下中フラグ
    const surfaceHeight = new Uint8Array(WORLD_X * WORLD_Y);

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
    // 1. 多オクターブノイズで高低差のある 64x64 盆地地形を生成
    // ============================================================
    for (let y = 0; y < WORLD_Y; y++) {
      for (let x = 0; x < WORLD_X; x++) {
        // 大きな起伏（山と谷）＋細かい起伏
        const nBig = fbm2D(x * 0.055, y * 0.055, seed);
        const nDetail = fbm2D(x * 0.13, y * 0.13, seed + 131);

        // 盆地の外縁 (マップ端付近) を少し高くして水が外へ逃げずに低い谷へ溜まるようにする
        const nx = (x / (WORLD_X - 1)) * 2 - 1;
        const ny = (y / (WORLD_Y - 1)) * 2 - 1;
        const edgeDist = Math.max(Math.abs(nx), Math.abs(ny));
        const rimBoost = edgeDist > 0.78 ? ((edgeDist - 0.78) / 0.22) * 2.4 : 0;

        // 高低差をくっきり強調（低い谷は z=0..1、中腹は z=2..3、山頂は z=5）
        const rawH = (nBig - 0.16) * 7.2 + (nDetail - 0.5) * 1.4 + rimBoost;
        let topZ = Math.round(rawH);
        topZ = Math.max(0, Math.min(5, topZ));

        // スタート地点付近 (32, 32) を歩きやすい中腹の高さ (z=2..3) に軽く整える
        const distCenter = Math.hypot(x - 32, y - 32);
        if (distCenter < 3.5) {
          topZ = Math.max(2, Math.min(3, topZ));
        }

        surfaceHeight[y * WORLD_X + x] = topZ;

        for (let z = 0; z <= topZ; z++) {
          // 最も低い谷底 (topZ === 0) は土露出にして湖底らしさを演出
          const isTop = z === topZ;
          const isDirtShore = topZ === 0 && nDetail < 0.52;
          setBlock(x, y, z, isTop && !isDirtShore ? BLOCK_GRASS : BLOCK_DIRT);
        }
      }
    }

    // スタート位置の安全座標を決定
    const spawnX = 32.5;
    const spawnY = 32.5;
    const spawnZ = surfaceHeight[32 * WORLD_X + 32] + 1;

    // ============================================================
    // 2. ボクセルの木（幹＋葉の樹冠）を草原の丘や中腹に生やす
    // ============================================================
    const treePositions = [];
    for (let y = 4; y < WORLD_Y - 4; y += 2) {
      for (let x = 4; x < WORLD_X - 4; x += 2) {
        const topZ = surfaceHeight[y * WORLD_X + x];
        // 谷底（池になる場所）やスタート地点直上は避ける
        if (topZ < 2 || topZ > 4) continue;
        if (Math.hypot(x - 32, y - 32) < 4.5) continue;
        if (getBlock(x, y, topZ) !== BLOCK_GRASS) continue;

        const r = hash3(x, y, seed + 777);
        if (r < 0.905) continue;

        // 他の木と近すぎないように間隔を空ける
        let tooClose = false;
        for (const tp of treePositions) {
          if (Math.hypot(x - tp.x, y - tp.y) < 4.6) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;

        const trunkH = hash3(x, y, seed + 999) > 0.45 ? 3 : 2;
        if (topZ + trunkH + 2 >= WORLD_Z) continue;

        treePositions.push({ x, y, topZ, trunkH });

        // 幹 (BLOCK_WOOD)
        for (let dz = 1; dz <= trunkH; dz++) {
          setBlock(x, y, topZ + dz, BLOCK_WOOD);
        }

        // 葉の樹冠 (3x3 の下段 ＋ 角を落とした上段)
        const canopyZ = topZ + trunkH;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            // 下段: 幹の頂点の周囲 3x3（四隅をランダムに丸める）
            const isCorner = Math.abs(dx) === 1 && Math.abs(dy) === 1;
            if (!(isCorner && hash3(x + dx, y + dy, canopyZ) > 0.65)) {
              if (getBlock(x + dx, y + dy, canopyZ) === BLOCK_AIR) {
                setBlock(x + dx, y + dy, canopyZ, BLOCK_LEAVES);
              }
            }
            // 中段: 3x3 全面
            if (canopyZ + 1 < WORLD_Z) {
              if (!isCorner || hash3(x + dx, y + dy, canopyZ + 1) < 0.72) {
                setBlock(x + dx, y + dy, canopyZ + 1, BLOCK_LEAVES);
              }
            }
            // 頂上: 十字 (+) の5ブロック
            if (canopyZ + 2 < WORLD_Z && Math.abs(dx) + Math.abs(dy) <= 1) {
              setBlock(x + dx, y + dy, canopyZ + 2, BLOCK_LEAVES);
            }
          }
        }
      }
    }

    // ============================================================
    // 3. 高速 3D AO ＋ 段差エッジ強調 ＋ 境界天面キャップ スライスベイク
    // ============================================================
    const totalSlices = WORLD_Z * BLOCK_SLICES + 1;
    const canvasW = WORLD_X * BLOCK_SIZE;
    const canvasH = WORLD_Y * BLOCK_SIZE;
    const sliceCache = Object.create(null);

    // 上空遮蔽キャッシュ（各 (x, y, z) の直上に屋根ブロックがある距離）
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

    // 32bit リトルエンディアン ABGR パック（高速書き込み）
    function packRGBA(r, g, b, a) {
      return ((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
    }

    function bakeSlices(enableAO, enableEdge) {
      const slices = [];

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
          skyFactor: roofDist > 0 ? Math.min(0.76, 0.60 + roofDist * 0.03) : 1.0,
        };
      }

      for (let sliceZ = 0; sliceZ < totalSlices; sliceZ++) {
        const bz = Math.floor(sliceZ / BLOCK_SLICES);
        const lz = sliceZ % BLOCK_SLICES;
        const isBoundaryPlane = lz === 0 && bz > 0;

        const c = document.createElement("canvas");
        c.width = canvasW;
        c.height = canvasH;
        const ctx = c.getContext("2d");
        const img = ctx.createImageData(canvasW, canvasH);
        const buf32 = new Uint32Array(img.data.buffer);

        let hasAnyPixel = false;

        for (let by = 0; by < WORLD_Y; by++) {
          const basePy = by * BLOCK_SIZE;
          for (let bx = 0; bx < WORLD_X; bx++) {
            let type = bz < WORLD_Z ? getBlock(bx, by, bz) : BLOCK_AIR;
            let drawBz = bz;
            let drawLz = lz;
            let isTopCap = false;

            if (type === BLOCK_AIR) {
              if (isBoundaryPlane) {
                const belowType = getBlock(bx, by, bz - 1);
                if (belowType !== BLOCK_AIR) {
                  type = belowType;
                  drawBz = bz - 1;
                  drawLz = BLOCK_SLICES - 1;
                  isTopCap = true;
                }
              }
              if (type === BLOCK_AIR) continue;
            }
            hasAnyPixel = true;

            const basePx = bx * BLOCK_SIZE;

            // 高速パス：完全に地中に埋まっている側面スライスは単色土で高速塗りつぶし
            if (
              !isTopCap &&
              type === BLOCK_DIRT &&
              getBlock(bx - 1, by, drawBz) !== BLOCK_AIR &&
              getBlock(bx + 1, by, drawBz) !== BLOCK_AIR &&
              getBlock(bx, by - 1, drawBz) !== BLOCK_AIR &&
              getBlock(bx, by + 1, drawBz) !== BLOCK_AIR
            ) {
              const packed = packRGBA(76, 52, 34, 255);
              for (let ly = 0; ly < BLOCK_SIZE; ly++) {
                const rowOff = (basePy + ly) * canvasW + basePx;
                for (let lx = 0; lx < BLOCK_SIZE; lx++) {
                  buf32[rowOff + lx] = packed;
                }
              }
              continue;
            }

            // 標高明暗グラデーション（木の上の葉が白飛びしないよう緩やかにクランプ）
            const elevLight = enableEdge ? Math.min(1.24, 0.80 + drawBz * 0.08) : 1.0;

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
                  // 木の樹冠や橋の真下に柔らかな木陰・屋根影を落とす
                  topSkyFactor = Math.min(0.72, 0.56 + roofDist * 0.03);
                } else {
                  let nearRoof = 0;
                  if (skyRoofDistance(bx - 1, by, drawBz) > 0) nearRoof++;
                  if (skyRoofDistance(bx + 1, by, drawBz) > 0) nearRoof++;
                  if (skyRoofDistance(bx, by - 1, drawBz) > 0) nearRoof++;
                  if (skyRoofDistance(bx, by + 1, drawBz) > 0) nearRoof++;
                  if (nearRoof > 0) topSkyFactor = 1.0 - nearRoof * 0.045;
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
                let [r, g, b] = sampleBlockColor(type, lx, ly, drawLz, variant, isTopCap);
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
                      if (info.overhang && drawLz >= BLOCK_SLICES - 3) f *= 0.54 + (BLOCK_SLICES - 1 - drawLz) * 0.15;
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

                // 段差エッジ強調（1px 暗い輪郭線 ＋ 内側 1px 明るいベベル）
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
                    if (isBevel) lightMult *= 1.16;
                  }
                }

                if (Math.abs(lightMult - 1.0) > 0.002) {
                  [r, g, b] = shadeColor(r, g, b, Math.max(0.25, lightMult));
                }

                buf32[rowOff + lx] = packRGBA(r, g, b, 255);
              }
            }
          }
        }

        if (hasAnyPixel) {
          ctx.putImageData(img, 0, 0);
        }
        slices.push(hasAnyPixel ? c : null);
      }

      return slices;
    }

    function getSlices(enableAO, enableEdge) {
      const key = `${enableAO ? 1 : 0}_${enableEdge ? 1 : 0}`;
      if (!sliceCache[key]) {
        sliceCache[key] = bakeSlices(enableAO, enableEdge);
      }
      return sliceCache[key];
    }

    const defaultSlices = getSlices(true, true);

    let maxUsedSlice = 0;
    for (let s = totalSlices - 1; s >= 0; s--) {
      if (defaultSlices[s]) {
        maxUsedSlice = s + 1;
        break;
      }
    }

    // ============================================================
    // 4. テラリア式・内部64段階 / 表示8段階・動的落ち口BFS・スリープ付き水流
    // ============================================================
    // 各高さ z で「現在まだ満水でない (water < WATER_MAX) 落ち口」までの最短距離を動的 BFS で計算。
    // 下の池が満水になると落ち口が消えて distToDrop=255 になるため、岸辺での往復振動が起きない。
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

        // 直下 (z - 1) が非固体 かつ まだ満水でない (water < WATER_MAX) セルだけを有効落ち口(距離0)にする
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

    const waterBodySlices = new Array(totalSlices);
    const waterSurfaceMasks = new Array(totalSlices);
    const waterBodyCtxs = new Array(totalSlices);
    const waterSurfCtxs = new Array(totalSlices);
    const waterBodyImgs = new Array(totalSlices);
    const waterSurfImgs = new Array(totalSlices);
    const waterSliceHasBody = new Uint8Array(totalSlices);
    const waterSliceHasSurface = new Uint8Array(totalSlices);
    const dirtyWaterSlices = new Uint8Array(totalSlices);

    for (let s = 0; s < totalSlices; s++) {
      const bc = document.createElement("canvas");
      bc.width = WORLD_X;
      bc.height = WORLD_Y;
      const bCtx = bc.getContext("2d");
      waterBodySlices[s] = bc;
      waterBodyCtxs[s] = bCtx;
      waterBodyImgs[s] = bCtx.createImageData(WORLD_X, WORLD_Y);

      const sc = document.createElement("canvas");
      sc.width = WORLD_X;
      sc.height = WORLD_Y;
      const sCtx = sc.getContext("2d");
      waterSurfaceMasks[s] = sc;
      waterSurfCtxs[s] = sCtx;
      waterSurfImgs[s] = sCtx.createImageData(WORLD_X, WORLD_Y);
    }

    function markBlockWaterDirty(bz) {
      const from = bz * BLOCK_SLICES;
      const to = Math.min(totalSlices - 1, (bz + 1) * BLOCK_SLICES);
      for (let s = from; s <= to; s++) {
        dirtyWaterSlices[s] = 1;
      }
    }

    function rebuildDirtyWaterSlices() {
      for (let sliceZ = 0; sliceZ < totalSlices; sliceZ++) {
        if (!dirtyWaterSlices[sliceZ]) continue;
        dirtyWaterSlices[sliceZ] = 0;

        const bz = Math.floor(sliceZ / BLOCK_SLICES);
        const lz = sliceZ % BLOCK_SLICES;

        const bBuf = new Uint32Array(waterBodyImgs[sliceZ].data.buffer);
        const sBuf = new Uint32Array(waterSurfImgs[sliceZ].data.buffer);
        bBuf.fill(0);
        sBuf.fill(0);

        let hasBody = 0;
        let hasSurf = 0;

        for (let y = 0; y < WORLD_Y; y++) {
          const rowOff = y * WORLD_X;
          for (let x = 0; x < WORLD_X; x++) {
            // 1. 水の体積スライス（内部水量 0..64 を表示 8段階 0..8 へ変換）
            if (bz < WORLD_Z) {
              const idx = index(x, y, bz);
              const visLevel = waterToVisualLevel(water[idx]);
              if (visLevel >= lz + 1) {
                hasBody = 1;
                if (falling[idx]) {
                  // 滝（落下中）は泡を含んで少し見えるシアン
                  bBuf[rowOff + x] = packRGBA(82, 198, 240, 64);
                } else {
                  // 水の内部はほぼ透明（1層あたり約8%の深い青）にしてフォグ感をなくし、
                  // 深い場所だけ自然な重なりで澄んだ濃い青になるようにする
                  bBuf[rowOff + x] = packRGBA(10, 92, 174, 20);
                }
              }
            }

            // 2. 露出水面キャップ（表示深さ visLevel の頂上スライスに水面波紋を描く）
            if (lz > 0 && bz < WORLD_Z) {
              const visLevel = waterToVisualLevel(water[index(x, y, bz)]);
              if (visLevel === lz) {
                hasSurf = 1;
                sBuf[rowOff + x] = 0xffffffff;
              }
            } else if (lz === 0 && bz > 0) {
              const belowVis = waterToVisualLevel(water[index(x, y, bz - 1)]);
              const curVis = bz < WORLD_Z ? waterToVisualLevel(water[index(x, y, bz)]) : 0;
              const curBlock = bz < WORLD_Z ? blocks[index(x, y, bz)] : BLOCK_AIR;
              if (belowVis === BLOCK_SLICES && curVis === 0 && curBlock === BLOCK_AIR) {
                hasSurf = 1;
                sBuf[rowOff + x] = 0xffffffff;
              }
            }
          }
        }

        waterSliceHasBody[sliceZ] = hasBody;
        waterSliceHasSurface[sliceZ] = hasSurf;
        if (hasBody) waterBodyCtxs[sliceZ].putImageData(waterBodyImgs[sliceZ], 0, 0);
        if (hasSurf) waterSurfCtxs[sliceZ].putImageData(waterSurfImgs[sliceZ], 0, 0);
      }
    }

    let totalWaterUnits = 0;
    let waterSettled = false;
    let calmStreak = 0;

    /**
     * 山頂・高所の複数の水源に一定量の水をまとめて配置する（常に一定の総量でスタート）
     */
    function resetWaterToHighlands() {
      water.fill(0);
      falling.fill(0);
      layerHasWater.fill(0);
      dirtyWaterSlices.fill(1);
      waterSettled = false;
      calmStreak = 0;

      const highSpots = [];
      for (let y = 3; y < WORLD_Y - 3; y++) {
        for (let x = 3; x < WORLD_X - 3; x++) {
          const topZ = surfaceHeight[y * WORLD_X + x];
          if (topZ >= 4 && getBlock(x, y, topZ + 1) === BLOCK_AIR) {
            highSpots.push({ x, y, z: topZ + 1 });
          }
        }
      }

      // 目標の総水量（内部64単位 × 425ブロック相当 = 27200単位）
      const targetUnits = 3400 * WATER_PER_LEVEL;
      let placed = 0;

      if (highSpots.length > 0) {
        const stride = Math.max(1, Math.floor(highSpots.length / 420));
        let pass = 0;
        while (placed < targetUnits && pass < 16) {
          for (let k = 0; k < highSpots.length && placed < targetUnits; k += stride) {
            const sp = highSpots[(k + pass * 7) % highSpots.length];
            const z = Math.min(WORLD_Z - 1, sp.z + Math.floor(pass / 4));
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

      if (placed < targetUnits) {
        for (let y = 4; y < WORLD_Y - 4 && placed < targetUnits; y += 2) {
          for (let x = 4; x < WORLD_X - 4 && placed < targetUnits; x += 2) {
            const z = surfaceHeight[y * WORLD_X + x] + 1;
            if (z < WORLD_Z) {
              const i = index(x, y, z);
              if (blocks[i] === BLOCK_AIR && water[i] < WATER_MAX) {
                const add = Math.min(WATER_MAX - water[i], targetUnits - placed);
                water[i] += add;
                layerHasWater[z] = 1;
                placed += add;
              }
            }
          }
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

    /**
     * 水シミュレーションを1ステップ進める（内部64段階・厳密総量保存・動的落ち口BFS・スリープ対応）
     */
    function stepWater() {
      if (waterSettled) return false;
      simTick++;
      falling.fill(0);

      // 3ステップごとに「まだ満水でない有効落ち口」BFSを再計算（満水になった池の岸での往復を完全防止）
      if (simTick % 3 === 1) {
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

      // --- Pass 1: 重力落下（下から上へ走査し、空いている下のセルへ一気に落ちる） ---
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

      // --- Pass 2: 後戻りしない下り排水（高所） ＋ 滑らかな湖面均等化（低所） ---
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

            // 下にまだ空きがある（落下途中）なら水平拡散しない
            if (z > 0) {
              const below = index(x, y, z - 1);
              if (blocks[below] === BLOCK_AIR && water[below] < WATER_MAX) {
                falling[i] = 1;
                continue;
              }
            }

            const curDist = distToDrop[i];

            // A) 有効な未満水落ち口へ到達可能なセル (0 < curDist < 255):
            //    厳密に distToDrop が小さくなる方向だけへ流す（単調減少＝往復振動が数学的に不可能！）
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
                // 薄い残水 (<= 10) は一塊で下り方向へ押し出して高所を完全に乾かす
                const want = w <= 10 ? w : Math.max(4, Math.ceil(w * 0.55));
                const flow = Math.min(w, room, want);
                if (flow > 0) {
                  transfer(i, dst, flow, z, z);
                  continue;
                }
              }
            }

            // B) 安定した池・くぼみ内の水平均等化（差が3以上のときだけ素早く均等化 → 収束して完全静止）
            //    ※ 排水路の途中 (0 < curDist < 255) からは上流 (dist > curDist) へ絶対に押し戻さない
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

      // テラリア式スリープ判定：見た目の変化も十分な移動もなくなったら完全静止にする
      if (totalMoved === 0) {
        calmStreak += 3;
      } else if (!visualChanged && totalMoved <= 6) {
        calmStreak++;
      } else {
        calmStreak = 0;
      }

      if (calmStreak >= 12) {
        waterSettled = true;
        // 滝フラグをクリアして静止水色に確定
        falling.fill(0);
        dirtyWaterSlices.fill(1);
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
      getBlock,
      setBlock,
      inBounds,
      findFloorBelow,
      getSlices,
      // 水関連API
      waterBodySlices,
      waterSurfaceMasks,
      waterSliceHasBody,
      waterSliceHasSurface,
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
