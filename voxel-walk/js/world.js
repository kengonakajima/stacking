/**
 * world.js
 * ------------------------------------------------------------
 * 3Dボクセルグリッド (X, Y, Z) の生成と、
 * 「世界全体の水平スライス配列 (worldSlices[sliceZ])」への焼き込みを行います。
 *
 * 土ブロックと草ブロックだけで、
 * - ゆるやかな丘と段々畑のようなテラス
 * - 土の露出した小さな谷（採掘跡っぽい地形）
 * - 下をくぐれて、上も歩ける「草つきの土アーチ（橋）」
 * を生成し、ウォークスルーで立体感を存分に体験できるようにしています。
 */
(function (global) {
  "use strict";

  const {
    BLOCK_SIZE,
    BLOCK_SLICES,
    BLOCK_AIR,
    BLOCK_DIRT,
    BLOCK_GRASS,
    sampleBlockColor,
    shadeColor,
  } = global.VoxelWalk;

  const WORLD_X = 20;
  const WORLD_Y = 20;
  const WORLD_Z = 6; // 最大高さ 6ブロック（= 60スライス）

  function createWorld() {
    const blocks = new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z);

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

    // 1. 基本の起伏ある地形を生成（土の上に草が乗るMinecraft方式）
    for (let y = 0; y < WORLD_Y; y++) {
      for (let x = 0; x < WORLD_X; x++) {
        // 北西にゆるやかな丘、南東に小さな高台、中央は歩きやすい広場
        const hillNW = Math.exp(-((x - 4.5) ** 2 + (y - 4.5) ** 2) / 26) * 3.1;
        const hillSE = Math.exp(-((x - 15.5) ** 2 + (y - 15.0) ** 2) / 22) * 2.4;
        const ridgeNE = Math.exp(-((x - 15.0) ** 2 + (y - 4.5) ** 2) / 18) * 1.9;
        const valleySW = Math.exp(-((x - 5.5) ** 2 + (y - 14.5) ** 2) / 14) * 1.4;

        let topZ = Math.round(1.6 + hillNW + hillSE + ridgeNE - valleySW);
        topZ = Math.max(0, Math.min(WORLD_Z - 2, topZ));

        // 中央のスタート付近 (x: 8..12, y: 8..12) はフラットな草広場に
        if (x >= 8 && x <= 12 && y >= 8 && y <= 12) {
          topZ = 1;
        }

        // 南西の小さな土のくぼみ（土ブロックだけで構成された露頭）
        const isDirtPit = x >= 4 && x <= 7 && y >= 13 && y <= 16;

        for (let z = 0; z <= topZ; z++) {
          if (z === topZ && !isDirtPit) {
            setBlock(x, y, z, BLOCK_GRASS);
          } else {
            setBlock(x, y, z, BLOCK_DIRT);
          }
        }
      }
    }

    // 2. 丘へ登りやすい土の階段（1段ずつ登れる小道）
    setBlock(7, 8, 1, BLOCK_DIRT);
    setBlock(7, 7, 2, BLOCK_DIRT);
    setBlock(6, 7, 2, BLOCK_DIRT);
    setBlock(6, 6, 3, BLOCK_DIRT);

    // 2.5. 平らな中央広場の上に「1ブロックだけ突き出た草ブロック」を配置（上側の角の視認性テスト用）
    setBlock(9, 8, 2, BLOCK_GRASS);

    // 3. 中央付近に「下をくぐれて、上も歩ける」立体アーチ橋を作る
    //    (x = 13..14, y = 7..13, 橋桁は z = 4、柱は y=7 と y=13)
    //    下は z=2, z=3 が空洞（2ブロック分の高さがあるのでプレイヤーが通れる！）
    for (let x = 13; x <= 14; x++) {
      // 北側の橋脚 (y = 7)
      setBlock(x, 7, 2, BLOCK_DIRT);
      setBlock(x, 7, 3, BLOCK_DIRT);
      // 南側の橋脚 (y = 13)
      setBlock(x, 13, 2, BLOCK_DIRT);
      setBlock(x, 13, 3, BLOCK_DIRT);
      // 橋の下の通路 (y = 8..12) を確実に開ける
      for (let y = 8; y <= 12; y++) {
        setBlock(x, y, 1, BLOCK_DIRT);
        setBlock(x, y, 2, BLOCK_AIR);
        setBlock(x, y, 3, BLOCK_AIR);
      }
      // 橋の上面（z = 4 に草ブロック）
      for (let y = 7; y <= 13; y++) {
        setBlock(x, y, 4, BLOCK_GRASS);
      }
    }
    // アーチ橋の上へ登るための土ステップ（南側から登れる）
    setBlock(13, 14, 2, BLOCK_DIRT);
    setBlock(14, 14, 2, BLOCK_DIRT);
    setBlock(13, 14, 3, BLOCK_DIRT);
    setBlock(14, 14, 3, BLOCK_GRASS);
    setBlock(12, 14, 2, BLOCK_DIRT);
    setBlock(12, 13, 2, BLOCK_DIRT);

    // 指定カラム (x, y) で z より上空に屋根（遮蔽ブロック）があるか調べる
    function skyRoofDistance(x, y, fromZ) {
      for (let z = fromZ + 1; z < WORLD_Z; z++) {
        if (getBlock(x, y, z) !== BLOCK_AIR) {
          return z - fromZ;
        }
      }
      return 0; // 上空は開けている
    }

    // ワールドの水平断面スライス配列（AO / 段差エッジ強調の組み合わせごとに遅延キャッシュ）
    const totalSlices = WORLD_Z * BLOCK_SLICES;
    const canvasW = WORLD_X * BLOCK_SIZE;
    const canvasH = WORLD_Y * BLOCK_SIZE;
    const sliceCache = Object.create(null);

    function bakeSlices(enableAO, enableEdge) {
      const slices = [];

      // AO有効時、側面1ブロックごとの周囲遮蔽情報（下辺接地・上辺軒下・左右内角・上空影）を計算
      function getSideAOInfo(bx, by, bz, nx, ny) {
        // 隣接ブロックが埋まっているなら非露出面なので計算不要
        if (getBlock(bx + nx, by + ny, bz) !== BLOCK_AIR) {
          return null;
        }
        // 法線 (nx, ny) に対する接線方向 (tx, ty)
        const tx = ny !== 0 ? 1 : 0;
        const ty = nx !== 0 ? 1 : 0;

        const ox = bx + nx;
        const oy = by + ny;
        const roofDist = skyRoofDistance(ox, oy, bz);

        return {
          // 1. 床との接地隅（外側の1段下に床があるか）
          floorCrease: bz === 0 || getBlock(ox, oy, bz - 1) !== BLOCK_AIR,
          // 2. 張り出し・軒下の影（外側の1段上にブロックがあるか）
          overhang: getBlock(ox, oy, bz + 1) !== BLOCK_AIR,
          // 3. L字の内角（接線の -側 / +側 に突き出た壁があるか）
          cornerNeg: getBlock(ox - tx, oy - ty, bz) !== BLOCK_AIR,
          cornerPos: getBlock(ox + tx, oy + ty, bz) !== BLOCK_AIR,
          // 4. 外側カラムの上空遮蔽（アーチ橋の内側など）
          skyFactor: roofDist > 0 ? Math.min(0.74, 0.58 + roofDist * 0.04) : 1.0,
        };
      }

      for (let sliceZ = 0; sliceZ < totalSlices; sliceZ++) {
        const bz = Math.floor(sliceZ / BLOCK_SLICES);
        const lz = sliceZ % BLOCK_SLICES;
        const isTopSlice = lz === BLOCK_SLICES - 1;
        // 標高が高い段ほど明るくして、重なり合う平らな面同士を高さで見分けやすくする
        const elevLight = enableEdge ? 0.80 + bz * 0.095 : 1.0;

        const c = document.createElement("canvas");
        c.width = canvasW;
        c.height = canvasH;
        const ctx = c.getContext("2d");
        const img = ctx.createImageData(canvasW, canvasH);
        const data = img.data;

        let hasAnyPixel = false;

        for (let by = 0; by < WORLD_Y; by++) {
          for (let bx = 0; bx < WORLD_X; bx++) {
            const type = getBlock(bx, by, bz);
            if (type === BLOCK_AIR) continue;
            hasAnyPixel = true;

            // --- 上面 AO / 上空遮蔽の事前判定 ---
            let aoN = false, aoS = false, aoW = false, aoE = false;
            let aoNW = false, aoNE = false, aoSW = false, aoSE = false;
            let topSkyFactor = 1.0;

            // --- 上面の露出段差エッジ（同じ高さ bz の隣が空＝崖のフチ）判定 ---
            let dropN = false, dropS = false, dropW = false, dropE = false;
            let dropNW = false, dropNE = false, dropSW = false, dropSE = false;
            const hasAirAbove = isTopSlice && getBlock(bx, by, bz + 1) === BLOCK_AIR;

            if (enableEdge && hasAirAbove) {
              dropN = getBlock(bx, by - 1, bz) === BLOCK_AIR;
              dropS = getBlock(bx, by + 1, bz) === BLOCK_AIR;
              dropW = getBlock(bx - 1, by, bz) === BLOCK_AIR;
              dropE = getBlock(bx + 1, by, bz) === BLOCK_AIR;
              // L字台地の内角でも輪郭線が途切れないよう対角の落ち込みも判定
              dropNW = !dropN && !dropW && getBlock(bx - 1, by - 1, bz) === BLOCK_AIR;
              dropNE = !dropN && !dropE && getBlock(bx + 1, by - 1, bz) === BLOCK_AIR;
              dropSW = !dropS && !dropW && getBlock(bx - 1, by + 1, bz) === BLOCK_AIR;
              dropSE = !dropS && !dropE && getBlock(bx + 1, by + 1, bz) === BLOCK_AIR;
            }

            // --- 垂直面（東西南北）の 3D AO 事前判定 ---
            let sideN = null, sideS = null, sideW = null, sideE = null;

            if (enableAO) {
              if (isTopSlice) {
                aoN = getBlock(bx, by - 1, bz + 1) !== BLOCK_AIR;
                aoS = getBlock(bx, by + 1, bz + 1) !== BLOCK_AIR;
                aoW = getBlock(bx - 1, by, bz + 1) !== BLOCK_AIR;
                aoE = getBlock(bx + 1, by, bz + 1) !== BLOCK_AIR;
                aoNW = getBlock(bx - 1, by - 1, bz + 1) !== BLOCK_AIR;
                aoNE = getBlock(bx + 1, by - 1, bz + 1) !== BLOCK_AIR;
                aoSW = getBlock(bx - 1, by + 1, bz + 1) !== BLOCK_AIR;
                aoSE = getBlock(bx + 1, by + 1, bz + 1) !== BLOCK_AIR;

                // 真上に屋根（橋など）があれば強い影、隣接に屋根があれば柔らかい入口影
                const roofDist = skyRoofDistance(bx, by, bz);
                if (roofDist > 0) {
                  topSkyFactor = Math.min(0.64, 0.50 + roofDist * 0.035);
                } else {
                  let nearRoof = 0;
                  if (skyRoofDistance(bx - 1, by, bz) > 0) nearRoof++;
                  if (skyRoofDistance(bx + 1, by, bz) > 0) nearRoof++;
                  if (skyRoofDistance(bx, by - 1, bz) > 0) nearRoof++;
                  if (skyRoofDistance(bx, by + 1, bz) > 0) nearRoof++;
                  if (nearRoof > 0) {
                    topSkyFactor = 1.0 - nearRoof * 0.055;
                  }
                }
              } else {
                sideN = getSideAOInfo(bx, by, bz, 0, -1);
                sideS = getSideAOInfo(bx, by, bz, 0, 1);
                sideW = getSideAOInfo(bx, by, bz, -1, 0);
                sideE = getSideAOInfo(bx, by, bz, 1, 0);
              }
            }

            const variant = (bx * 31 + by * 17 + bz * 13) & 255;

            for (let ly = 0; ly < BLOCK_SIZE; ly++) {
              const py = by * BLOCK_SIZE + ly;
              for (let lx = 0; lx < BLOCK_SIZE; lx++) {
                const px = bx * BLOCK_SIZE + lx;
                let [r, g, b] = sampleBlockColor(type, lx, ly, lz, variant);

                let lightMult = elevLight;

                if (enableAO) {
                  let ao = 1.0;

                  if (isTopSlice) {
                    // 上面：上空遮蔽＋4辺の段差接地影＋4隅の対角コーナーAO
                    ao *= topSkyFactor;

                    if (aoN && ly <= 2) ao *= 0.58 + ly * 0.13;
                    if (aoS && ly >= BLOCK_SIZE - 3) ao *= 0.58 + (BLOCK_SIZE - 1 - ly) * 0.13;
                    if (aoW && lx <= 2) ao *= 0.58 + lx * 0.13;
                    if (aoE && lx >= BLOCK_SIZE - 3) ao *= 0.58 + (BLOCK_SIZE - 1 - lx) * 0.13;

                    // 対角コーナー（辺が遮られていない場所でも角の柱から柔らかい影が落ちる）
                    if (aoNW && !aoN && !aoW && lx <= 2 && ly <= 2) {
                      ao *= 0.72 + Math.max(lx, ly) * 0.09;
                    }
                    if (aoNE && !aoN && !aoE && lx >= BLOCK_SIZE - 3 && ly <= 2) {
                      ao *= 0.72 + Math.max(BLOCK_SIZE - 1 - lx, ly) * 0.09;
                    }
                    if (aoSW && !aoS && !aoW && lx <= 2 && ly >= BLOCK_SIZE - 3) {
                      ao *= 0.72 + Math.max(lx, BLOCK_SIZE - 1 - ly) * 0.09;
                    }
                    if (aoSE && !aoS && !aoE && lx >= BLOCK_SIZE - 3 && ly >= BLOCK_SIZE - 3) {
                      ao *= 0.72 + Math.max(BLOCK_SIZE - 1 - lx, BLOCK_SIZE - 1 - ly) * 0.09;
                    }
                  } else {
                    // 垂直面（側面）の 3D AO：床接地隅・軒下・L字内角・上空遮蔽
                    // 凸角で2面分が二重乗算されないよう、各面のAOの最小値を採用する
                    const calcFaceAO = (info, tCoord) => {
                      let f = info.skyFactor;
                      // ① 下辺：床と接する根元 (lz = 0..3) を暗く
                      if (info.floorCrease && lz <= 3) {
                        f *= 0.54 + lz * 0.12;
                      }
                      // ② 上辺：張り出し・橋の下 (lz = 5..8) を暗く
                      if (info.overhang && lz >= 5) {
                        f *= 0.52 + (8 - lz) * 0.12;
                      }
                      // ③ 縦エッジ：L字の凹角 (左右端3px) を暗く
                      if (info.cornerNeg && tCoord <= 2) {
                        f *= 0.56 + tCoord * 0.14;
                      }
                      if (info.cornerPos && tCoord >= BLOCK_SIZE - 3) {
                        f *= 0.56 + (BLOCK_SIZE - 1 - tCoord) * 0.14;
                      }
                      return f;
                    };

                    if (ly <= 1 && sideN) ao = Math.min(ao, calcFaceAO(sideN, lx));
                    if (ly >= BLOCK_SIZE - 2 && sideS) ao = Math.min(ao, calcFaceAO(sideS, lx));
                    if (lx <= 1 && sideW) ao = Math.min(ao, calcFaceAO(sideW, ly));
                    if (lx >= BLOCK_SIZE - 2 && sideE) ao = Math.min(ao, calcFaceAO(sideE, ly));
                  }

                  lightMult *= Math.max(0.28, ao);
                }

                // 段差エッジ強調：突き出たブロックの上面の外周（崖のフチ）に
                // 「1px 暗い輪郭線 ＋ 内側1px 明るいベベル」を入れて背景の平面からくっきり分離させる
                if (enableEdge && hasAirAbove) {
                  const isOuterContour =
                    (dropN && ly === 0) ||
                    (dropS && ly === BLOCK_SIZE - 1) ||
                    (dropW && lx === 0) ||
                    (dropE && lx === BLOCK_SIZE - 1) ||
                    (dropNW && lx === 0 && ly === 0) ||
                    (dropNE && lx === BLOCK_SIZE - 1 && ly === 0) ||
                    (dropSW && lx === 0 && ly === BLOCK_SIZE - 1) ||
                    (dropSE && lx === BLOCK_SIZE - 1 && ly === BLOCK_SIZE - 1);

                  if (isOuterContour) {
                    lightMult *= 0.60;
                  } else {
                    const isInnerBevel =
                      (dropN && ly === 1) ||
                      (dropS && ly === BLOCK_SIZE - 2) ||
                      (dropW && lx === 1) ||
                      (dropE && lx === BLOCK_SIZE - 2) ||
                      (dropNW && lx <= 1 && ly <= 1) ||
                      (dropNE && lx >= BLOCK_SIZE - 2 && ly <= 1) ||
                      (dropSW && lx <= 1 && ly >= BLOCK_SIZE - 2) ||
                      (dropSE && lx >= BLOCK_SIZE - 2 && ly >= BLOCK_SIZE - 2);

                    if (isInnerBevel) {
                      lightMult *= 1.18;
                    }
                  }
                }

                if (Math.abs(lightMult - 1.0) > 0.002) {
                  [r, g, b] = shadeColor(r, g, b, Math.max(0.25, lightMult));
                }

                const idx = (py * canvasW + px) * 4;
                data[idx] = r;
                data[idx + 1] = g;
                data[idx + 2] = b;
                data[idx + 3] = 255;
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

    // 実際にブロックが存在する最上位スライス番号を求める
    let maxUsedSlice = 0;
    for (let s = totalSlices - 1; s >= 0; s--) {
      if (defaultSlices[s]) {
        maxUsedSlice = s + 1;
        break;
      }
    }

    /**
     * 指定 (wx, wy) の足元より下にある最も高い床の天面 Z（影や足元表示に使用）
     */
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

    return {
      sizeX: WORLD_X,
      sizeY: WORLD_Y,
      sizeZ: WORLD_Z,
      totalSlices,
      maxUsedSlice,
      canvasW,
      canvasH,
      getBlock,
      setBlock,
      inBounds,
      findFloorBelow,
      getSlices,
    };
  }

  global.VoxelWalk = global.VoxelWalk || {};
  global.VoxelWalk.createWorld = createWorld;
})(window);
