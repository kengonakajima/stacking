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
    // 4. テラリア式・総量保存の8段階水流シミュレーション & 64x64水スライス
    // ============================================================
    // 各高さ z ごとに「下の段 (z-1) へ落ちられる崖・穴までの最短距離」を BFS で事前計算。
    // これにより、高い平地に薄く残った水(1/8)も壁や木を回り込みながら
    // 低い場所を探し回って完全に流れ落ち、高い地面の上に水が残らなくなる。
    const distToDrop = new Uint8Array(cellCount);
    distToDrop.fill(255);
    const bfsQueue = new Int32Array(WORLD_X * WORLD_Y);

    for (let z = 1; z < WORLD_Z; z++) {
      let qHead = 0;
      let qTail = 0;

      // まず直下 (z-1) が空洞のセルを距離 0（落ち口）としてキューへ登録
      for (let y = 0; y < WORLD_Y; y++) {
        for (let x = 0; x < WORLD_X; x++) {
          const i = index(x, y, z);
          if (blocks[i] === BLOCK_AIR && blocks[index(x, y, z - 1)] === BLOCK_AIR) {
            distToDrop[i] = 0;
            bfsQueue[qTail++] = y * WORLD_X + x;
          }
        }
      }

      // 4近傍 BFS で平地から落ち口までの最短歩数を伝播
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
            // 1. 水の体積スライス（bz のセルに lz + 1 以上の水が入っているか）
            if (bz < WORLD_Z) {
              const idx = index(x, y, bz);
              const w = water[idx];
              if (w >= lz + 1) {
                hasBody = 1;
                if (falling[idx]) {
                  // 滝（落下中）は泡立った明るいシアン
                  bBuf[rowOff + x] = packRGBA(118, 218, 250, 108);
                } else {
                  // 静止・流れ水は半透明の深い青（層を重ねるほど自然に濃くなる）
                  bBuf[rowOff + x] = packRGBA(28, 134, 206, 76);
                }
              }
            }

            // 2. 露出水面キャップ（この高さ sliceZ がちょうど水面の頂上になっているか）
            // ケースA: ブロック内水面 (lz = 1..7) -> bz の水量がちょうど lz
            if (lz > 0 && bz < WORLD_Z) {
              const w = water[index(x, y, bz)];
              if (w === lz) {
                hasSurf = 1;
                sBuf[rowOff + x] = 0xffffffff;
              }
            }
            // ケースB: ブロック境界水面 (lz = 0, bz > 0) -> 下の段 (bz - 1) が満タン (8) かつ 上の段 (bz) に水がない
            else if (lz === 0 && bz > 0) {
              const belowW = water[index(x, y, bz - 1)];
              const curW = bz < WORLD_Z ? water[index(x, y, bz)] : 0;
              const curBlock = bz < WORLD_Z ? blocks[index(x, y, bz)] : BLOCK_AIR;
              if (belowW === BLOCK_SLICES && curW === 0 && curBlock === BLOCK_AIR) {
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

    /**
     * 山頂・高所の複数の水源に一定量の水をまとめて配置する（常に一定の総量でスタート）
     */
    function resetWaterToHighlands() {
      water.fill(0);
      falling.fill(0);
      dirtyWaterSlices.fill(1);

      // 標高が高い場所（topZ >= 4）を見つけて水源として水を溜める
      const highSpots = [];
      for (let y = 3; y < WORLD_Y - 3; y++) {
        for (let x = 3; x < WORLD_X - 3; x++) {
          const topZ = surfaceHeight[y * WORLD_X + x];
          if (topZ >= 4 && getBlock(x, y, topZ + 1) === BLOCK_AIR) {
            highSpots.push({ x, y, z: topZ + 1 });
          }
        }
      }

      // 目標の総水量（64x64の低い谷に綺麗な池ができる程度のボリューム）
      const targetUnits = 3400;
      let placed = 0;

      // 高所の複数エリアから滝のように流れ下るように均等配置
      if (highSpots.length > 0) {
        const stride = Math.max(1, Math.floor(highSpots.length / 420));
        let pass = 0;
        while (placed < targetUnits && pass < 16) {
          for (let k = 0; k < highSpots.length && placed < targetUnits; k += stride) {
            const sp = highSpots[(k + pass * 7) % highSpots.length];
            const z = Math.min(WORLD_Z - 1, sp.z + Math.floor(pass / 4));
            const i = index(sp.x, sp.y, z);
            if (blocks[i] === BLOCK_AIR && water[i] < BLOCK_SLICES) {
              const add = Math.min(BLOCK_SLICES - water[i], targetUnits - placed, 4);
              water[i] += add;
              placed += add;
            }
          }
          pass++;
        }
      }

      // もし高所が少なかった場合は中腹にも補完
      if (placed < targetUnits) {
        for (let y = 4; y < WORLD_Y - 4 && placed < targetUnits; y += 2) {
          for (let x = 4; x < WORLD_X - 4 && placed < targetUnits; x += 2) {
            const z = surfaceHeight[y * WORLD_X + x] + 1;
            if (z < WORLD_Z) {
              const i = index(x, y, z);
              if (blocks[i] === BLOCK_AIR && water[i] < BLOCK_SLICES) {
                const add = Math.min(BLOCK_SLICES - water[i], targetUnits - placed);
                water[i] += add;
                placed += add;
              }
            }
          }
        }
      }

      totalWaterUnits = placed;
      rebuildDirtyWaterSlices();
    }

    // 4方向の隣接オフセット（ステップごとに順番を回して偏りをなくす）
    const DIRS = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    let simTick = 0;

    /**
     * 水シミュレーションを1ステップ進める（厳密な総量保存）
     */
    function stepWater() {
      simTick++;
      falling.fill(0);

      const xStart = simTick & 1 ? 0 : WORLD_X - 1;
      const xEnd = simTick & 1 ? WORLD_X : -1;
      const xStep = simTick & 1 ? 1 : -1;

      const yStart = simTick & 2 ? 0 : WORLD_Y - 1;
      const yEnd = simTick & 2 ? WORLD_Y : -1;
      const yStep = simTick & 2 ? 1 : -1;

      let movedAny = false;

      // --- Pass 1: 重力落下（下から上へ走査し、空いている下のセルへ一気に落ちる） ---
      for (let z = 1; z < WORLD_Z; z++) {
        for (let y = yStart; y !== yEnd; y += yStep) {
          for (let x = xStart; x !== xEnd; x += xStep) {
            const i = index(x, y, z);
            const w = water[i];
            if (w === 0) continue;

            const below = index(x, y, z - 1);
            if (blocks[below] === BLOCK_AIR && water[below] < BLOCK_SLICES) {
              const fall = Math.min(w, BLOCK_SLICES - water[below]);
              water[i] -= fall;
              water[below] += fall;
              falling[below] = 1;
              if (water[i] > 0) falling[i] = 1;
              markBlockWaterDirty(z);
              markBlockWaterDirty(z - 1);
              movedAny = true;
            }
          }
        }
      }

      // --- Pass 2: 水平方向への拡散・低い場所の探索（テラリア式ランダム探索＋排水）・均等化 ---
      const dirStart = simTick & 3;
      const nIdxBuf = [0, 0, 0, 0];
      const nDropBuf = [0, 0, 0, 0];
      const nDistBuf = [255, 255, 255, 255];

      for (let z = 0; z < WORLD_Z; z++) {
        for (let y = yStart; y !== yEnd; y += yStep) {
          for (let x = xStart; x !== xEnd; x += xStep) {
            const i = index(x, y, z);
            let w = water[i];
            if (w === 0) continue;

            // 下にまだ空きがある（落下途中）なら水平拡散をスキップ
            if (z > 0) {
              const below = index(x, y, z - 1);
              if (blocks[below] === BLOCK_AIR && water[below] < BLOCK_SLICES) {
                falling[i] = 1;
                continue;
              }
            }

            const curDist = distToDrop[i];
            const onSolidFloor = z === 0 || blocks[index(x, y, z - 1)] !== BLOCK_AIR;

            // 隣接4方向の通行可能セル情報を集める
            let count = 0;
            let bestDownhillEmpty = -1;
            let bestDownhillDist = curDist;
            let activeFallIdx = -1;
            let wanderIdx = -1;
            let wanderCount = 0;

            for (let d = 0; d < 4; d++) {
              const dir = DIRS[(dirStart + d) & 3];
              const nx = x + dir[0];
              const ny = y + dir[1];
              if (nx < 0 || nx >= WORLD_X || ny < 0 || ny >= WORLD_Y) continue;
              const ni = index(nx, ny, z);
              if (blocks[ni] !== BLOCK_AIR) continue;

              const nw = water[ni];
              const nDist = distToDrop[ni];
              let hasOpenDrop = 0;
              if (z > 0) {
                const nBelow = index(nx, ny, z - 1);
                if (blocks[nBelow] === BLOCK_AIR && water[nBelow] < BLOCK_SLICES) {
                  hasOpenDrop = 1;
                  if (nw < BLOCK_SLICES && activeFallIdx === -1) {
                    activeFallIdx = ni;
                  }
                }
              }

              // 低い場所へ近づく空きマス候補
              if (nw === 0 && nDist < bestDownhillDist) {
                bestDownhillDist = nDist;
                bestDownhillEmpty = ni;
              }
              // テラリア風のランダム探索候補（空きマスで、落ち口から極端に遠ざからない方向）
              if (nw === 0 && curDist < 255 && nDist <= curDist) {
                wanderCount++;
                if (hash3(x + simTick * 7, y + d * 13, z + simTick) * wanderCount < 1) {
                  wanderIdx = ni;
                }
              }

              if (nw < w || hasOpenDrop || (onSolidFloor && curDist > 0 && curDist < 255 && nDist < curDist && nw < BLOCK_SLICES)) {
                nIdxBuf[count] = ni;
                nDropBuf[count] = hasOpenDrop;
                nDistBuf[count] = nDist;
                count++;
              }
            }

            if (count === 0) continue;

            // ★ テラリア式・高所残水ドレイン:
            // 高い平地（落ち口へ到達可能 & 地面の上）に残った薄い水 (w === 1) は、
            // ランダムに低い場所を探しつつ落ち口方向へ移動して、高所に水が残らないようにする
            if (w === 1 && onSolidFloor && curDist > 0 && curDist < 255) {
              // 1. すぐ横に空いている滝落ち口があれば即座に流し落とす
              if (activeFallIdx !== -1 && water[activeFallIdx] < BLOCK_SLICES) {
                water[i] = 0;
                water[activeFallIdx]++;
                falling[activeFallIdx] = 1;
                markBlockWaterDirty(z);
                movedAny = true;
                continue;
              }

              // 2. 低い場所へ近づく空きマスへ進む（たまにランダム探索も混ぜる）
              const rnd = hash3(x * 3 + simTick, y * 5 - simTick, z + 31);
              let target = -1;
              if (rnd < 0.25 && wanderIdx !== -1) {
                target = wanderIdx;
              } else if (bestDownhillEmpty !== -1) {
                target = bestDownhillEmpty;
              } else {
                // 下り方向の隣に既に薄い水 (1..2) があれば合流させて押し流す
                // （満水に近い湖へ逆流させないよう nw <= 2 に限定）
                for (let k = 0; k < count; k++) {
                  const ni = nIdxBuf[k];
                  if (nDistBuf[k] < curDist && water[ni] <= 2) {
                    target = ni;
                    break;
                  }
                }
              }

              if (target !== -1) {
                water[i] = 0;
                water[target]++;
                markBlockWaterDirty(z);
                movedAny = true;
                continue;
              }
            }

            // 通常の水平拡散・均等化（落ち口に近い方向を優先して配分）
            let changed = false;
            for (let pass = 0; pass < 4 && w > 0; pass++) {
              let bestSlot = -1;
              let bestScore = 9999;
              for (let k = 0; k < count; k++) {
                const ni = nIdxBuf[k];
                const nw = water[ni];
                const isCloserToDrop = onSolidFloor && curDist < 255 && nDistBuf[k] < curDist;
                const minDiff = nDropBuf[k] ? 1 : isCloserToDrop ? 1 : 2;
                if (w - nw >= minDiff) {
                  // 落ち口あり → 落ち口に近い → 水位が低い の順で優先
                  const score = nw * 4 - nDropBuf[k] * 20 - (isCloserToDrop ? 8 : 0);
                  if (score < bestScore) {
                    bestScore = score;
                    bestSlot = ni;
                  }
                }
              }
              if (bestSlot === -1) break;
              water[i]--;
              water[bestSlot]++;
              w--;
              changed = true;
            }

            if (changed) {
              markBlockWaterDirty(z);
              movedAny = true;
            }
          }
        }
      }

      if (movedAny) {
        rebuildDirtyWaterSlices();
      }
      return movedAny;
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
      return water[index(bx, by, bz)];
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

    // 初期の水を配置（少しだけ事前シミュレーションせず、開いた瞬間から山から流れ下る様子を見せる！）
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
      getInitialTotalWater: () => totalWaterUnits,
      computeCurrentTotalWater,
    };
  }

  global.VoxelWalk = global.VoxelWalk || {};
  global.VoxelWalk.createWorld = createWorld;
})(window);
