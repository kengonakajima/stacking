/**
 * blocks.js
 * ------------------------------------------------------------
 * 128x128 ワールド用のボクセルブロック（土 / 草 / 木の幹 / 葉 / 岩 / 深岩 / 水）と
 * プレイヤーキャラクター、周期 Worley/Voronoi 水面コースティクスを生成します。
 *
 * 1ブロック = 6x6 ピクセル（水平） × 8 スライス（高さ）。
 * 描画時に縦横比を補正して完全な 1:1:1 立方体として描きつつ、
 * 水の8段階の深さ (1..8) がそのまま 1..8 スライスに対応します。
 */
(function (global) {
  "use strict";

  const BLOCK_SIZE = 6; // 1ブロックの水平ピクセル幅 (6x6 -> 128ブロックで 768x768)
  const BLOCK_SLICES = 8; // 1ブロックの高さスライス枚数 (0..7) = 水の8段階と一致

  const BLOCK_AIR = 0;
  const BLOCK_DIRT = 1;
  const BLOCK_GRASS = 2;
  const BLOCK_WOOD = 3;
  const BLOCK_LEAVES = 4;
  const BLOCK_STONE = 5;
  const BLOCK_DARK_STONE = 6;
  const BLOCK_LAVA = 7;

  const BLOCK_NAMES = {
    [BLOCK_AIR]: "空中",
    [BLOCK_DIRT]: "土ブロック",
    [BLOCK_GRASS]: "草ブロック",
    [BLOCK_WOOD]: "木の幹",
    [BLOCK_LEAVES]: "葉ブロック",
    [BLOCK_STONE]: "岩ブロック",
    [BLOCK_DARK_STONE]: "深岩ブロック",
    [BLOCK_LAVA]: "溶岩ブロック",
  };

  // 高速な整数ハッシュ
  function hash3(x, y, z) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) * 2.3283064365386963e-10;
  }

  /**
   * 寒色シャドウ付き明暗計算 → 32bit リトルエンディアン ABGR パック（ゼロアロケーション）
   */
  function shadeAndPackABGR(r, g, b, factor) {
    const shadow = factor < 1 ? 1 - factor : 0;
    const rMult = factor * (1 - shadow * 0.14);
    const gMult = factor * (1 - shadow * 0.03);
    const bMult = factor * (1 + shadow * 0.18);
    let cr = (r * rMult + 0.5) | 0;
    let cg = (g * gMult + 0.5) | 0;
    let cb = (b * bMult + 0.5) | 0;
    if (cr < 0) cr = 0; else if (cr > 255) cr = 255;
    if (cg < 0) cg = 0; else if (cg > 255) cg = 255;
    if (cb < 0) cb = 0; else if (cb > 255) cb = 255;
    return (255 << 24) | (cb << 16) | (cg << 8) | cr;
  }

  /**
   * 24bit RGB (0xRRGGBB) に対して明暗を掛け、32bit ABGR を返す（ゼロアロケーション）
   */
  function shadePacked24ToABGR(rgb24, factor) {
    const r = (rgb24 >>> 16) & 255;
    const g = (rgb24 >>> 8) & 255;
    const b = rgb24 & 255;
    return shadeAndPackABGR(r, g, b, factor);
  }

  function pack24(r, g, b, factor) {
    const abgr = shadeAndPackABGR(r, g, b, factor);
    const cr = abgr & 255;
    const cg = (abgr >>> 8) & 255;
    const cb = (abgr >>> 16) & 255;
    return (cr << 16) | (cg << 8) | cb;
  }

  /**
   * ブロック内のローカル座標 (lx, ly, lz) の基本色を 24bit RGB (0xRRGGBB) で返す（高速・配列確保なし）
   */
  function sampleBlockColor24(blockType, lx, ly, lz, variantSeed, isTopFace) {
    const topFace = isTopFace !== undefined ? isTopFace : lz === BLOCK_SLICES - 1;
    const n = hash3(lx + variantSeed * 13, ly + variantSeed * 7, lz + variantSeed * 5);
    const isEdge = lx === 0 || lx === BLOCK_SIZE - 1 || ly === 0 || ly === BLOCK_SIZE - 1;
    const isNearEdge = lx <= 1 || lx >= BLOCK_SIZE - 2 || ly <= 1 || ly >= BLOCK_SIZE - 2;

    // 面の向きによる明暗差
    let faceLight = 1.0;
    if (topFace) {
      faceLight = 1.06;
    } else {
      let sideLight = 0.62;
      if (isNearEdge) {
        const dWest = lx;
        const dEast = BLOCK_SIZE - 1 - lx;
        const dNorth = ly;
        const dSouth = BLOCK_SIZE - 1 - ly;
        let minD = dWest;
        if (dEast < minD) minD = dEast;
        if (dNorth < minD) minD = dNorth;
        if (dSouth < minD) minD = dSouth;

        let dirLight = 1.0;
        if (dWest === minD && 0.50 < dirLight) dirLight = 0.50;
        if (dNorth === minD && 0.58 < dirLight) dirLight = 0.58;
        if (dSouth === minD && 0.68 < dirLight) dirLight = 0.68;
        if (dEast === minD && 0.76 < dirLight) dirLight = 0.76;
        sideLight = dirLight;
      }
      const heightGrad = 0.80 + (Math.min(lz, BLOCK_SLICES - 1) / (BLOCK_SLICES - 1)) * 0.24;
      faceLight = sideLight * heightGrad;
    }

    // ===== 土ブロック =====
    if (blockType === BLOCK_DIRT) {
      let r, g, b;
      if (n > 0.91) { r = 128; g = 120; b = 112; }
      else if (n > 0.66) { r = 148; g = 102; b = 66; }
      else if (n > 0.30) { r = 128; g = 86; b = 54; }
      else { r = 104; g = 68; b = 42; }
      return pack24(r, g, b, faceLight);
    }

    // ===== 草ブロック =====
    if (blockType === BLOCK_GRASS) {
      if (topFace || lz >= BLOCK_SLICES - 2) {
        let r, g, b;
        if (n > 0.78) { r = 116; g = 198; b = 76; }
        else if (n > 0.40) { r = 92; g = 176; b = 62; }
        else if (n > 0.14) { r = 74; g = 152; b = 50; }
        else { r = 62; g = 134; b = 44; }
        return pack24(r, g, b, faceLight);
      }

      if (lz === BLOCK_SLICES - 3 && isNearEdge) {
        const overhang = hash3(lx * 3 + variantSeed, ly * 3 + variantSeed, 99);
        if (overhang > 0.38) {
          return pack24(n > 0.5 ? 82 : 64, n > 0.5 ? 162 : 138, n > 0.5 ? 54 : 45, faceLight);
        }
      }
      if (lz === BLOCK_SLICES - 4 && isEdge) {
        const drip = hash3(lx * 5 + variantSeed, ly * 5 + variantSeed, 77);
        if (drip > 0.74) {
          return pack24(66, 140, 46, faceLight);
        }
      }

      let r, g, b;
      if (n > 0.91) { r = 128; g = 120; b = 112; }
      else if (n > 0.66) { r = 148; g = 102; b = 66; }
      else if (n > 0.30) { r = 128; g = 86; b = 54; }
      else { r = 104; g = 68; b = 42; }
      return pack24(r, g, b, faceLight);
    }

    // ===== 木の幹 =====
    if (blockType === BLOCK_WOOD) {
      if (topFace) {
        const cx = Math.abs(lx - 2.5);
        const cy = Math.abs(ly - 2.5);
        const ring = cx > cy ? cx : cy;
        if (ring >= 2.2) return pack24(98, 66, 40, faceLight);
        if (ring >= 1.2) return pack24(192, 152, 102, faceLight);
        return pack24(154, 114, 70, faceLight);
      }
      const barkStripe = hash3(lx + variantSeed * 3, ly + variantSeed * 5, 11);
      if (barkStripe > 0.66) return pack24(122, 84, 52, faceLight);
      if (barkStripe > 0.30) return pack24(98, 66, 40, faceLight);
      return pack24(74, 48, 28, faceLight);
    }

    // ===== 葉ブロック =====
    if (blockType === BLOCK_LEAVES) {
      let r, g, b;
      if (n > 0.80) { r = 98; g = 178; b = 66; }
      else if (n > 0.48) { r = 68; g = 146; b = 52; }
      else if (n > 0.18) { r = 46; g = 116; b = 42; }
      else { r = 32; g = 86; b = 34; }
      return pack24(r, g, b, faceLight);
    }

    // ===== 岩ブロック（岩山・崖・自然アーチ） =====
    if (blockType === BLOCK_STONE) {
      // 地層っぽいわずかな水平縞＋ごつごつした鉱物ノイズ
      const strata = (lz === 2 || lz === 5) ? -10 : 0;
      let r, g, b;
      if (n > 0.88) { r = 166; g = 170; b = 176; } // 明るい石英粒
      else if (n > 0.56) { r = 138; g = 142; b = 149; } // 標準岩肌
      else if (n > 0.22) { r = 116; g = 121; b = 129; } // 影岩肌
      else { r = 94; g = 99; b = 108; } // ひび割れ暗部
      return pack24(r + strata, g + strata, b + strata, faceLight);
    }

    // ===== 深岩ブロック（崖の根元・トンネル内部・オーバーハング下部） =====
    if (blockType === BLOCK_DARK_STONE) {
      const strata = lz === 3 ? -8 : 0;
      let r, g, b;
      if (n > 0.86) { r = 114; g = 120; b = 132; }
      else if (n > 0.50) { r = 90; g = 96; b = 108; }
      else if (n > 0.18) { r = 72; g = 78; b = 90; }
      else { r = 56; g = 62; b = 74; }
      return pack24(r + strata, g + strata, b + strata, faceLight);
    }

    // ===== 溶岩ブロック（明るさ15の自己発光マグマ） =====
    if (blockType === BLOCK_LAVA) {
      if (n > 0.78) return pack24(255, 224, 92, 1.0);
      if (n > 0.42) return pack24(255, 122, 24, 1.0);
      if (n > 0.16) return pack24(222, 58, 12, 1.0);
      return pack24(142, 28, 10, 1.0);
    }

    return 0xff00ff;
  }

  /**
   * 128x128 ワールドの水面アニメーション用タイルテクスチャ（16フレーム, 512x512）を事前生成。
   * 周期 Worley / Voronoi セルラーノイズ (F2 - F1) で、控えめで上品な水面の網目模様を描く。
   */
  function buildWaterAnimFrames(worldBlocksX, worldBlocksY) {
    const pxPerBlock = 4; // 128 * 4 = 512px
    const w = worldBlocksX * pxPerBlock;
    const h = worldBlocksY * pxPerBlock;
    const tileSize = 32; // 8x8ブロック周期
    const halfTile = tileSize * 0.5;
    const frameCount = 16;
    const frames = [];

    const gridN = 4;
    const cellSpan = tileSize / gridN;
    const basePoints = [];
    for (let gy = 0; gy < gridN; gy++) {
      for (let gx = 0; gx < gridN; gx++) {
        const id = gy * gridN + gx;
        const jx = (hash3(gx, gy, 401) - 0.5) * cellSpan * 0.65;
        const jy = (hash3(gx, gy, 709) - 0.5) * cellSpan * 0.65;
        basePoints.push({
          bx: (gx + 0.5) * cellSpan + jx,
          by: (gy + 0.5) * cellSpan + jy,
          orbitR: 1.1 + hash3(gx, gy, 911) * 0.7,
          phase0: hash3(gx, gy, 1301) * Math.PI * 2,
          dir: id % 2 === 0 ? 1 : -1,
        });
      }
    }

    const TWO_PI = Math.PI * 2;
    const curX = new Float32Array(basePoints.length);
    const curY = new Float32Array(basePoints.length);

    for (let f = 0; f < frameCount; f++) {
      const phase = (f / frameCount) * TWO_PI;

      for (let p = 0; p < basePoints.length; p++) {
        const bp = basePoints[p];
        const a = bp.phase0 + phase * bp.dir;
        let px = bp.bx + Math.cos(a) * bp.orbitR;
        let py = bp.by + Math.sin(a) * bp.orbitR;
        px = ((px % tileSize) + tileSize) % tileSize;
        py = ((py % tileSize) + tileSize) % tileSize;
        curX[p] = px;
        curY[p] = py;
      }

      const tile = document.createElement("canvas");
      tile.width = tileSize;
      tile.height = tileSize;
      const tCtx = tile.getContext("2d");
      const tImg = tCtx.createImageData(tileSize, tileSize);

      for (let y = 0; y < tileSize; y++) {
        for (let x = 0; x < tileSize; x++) {
          let d1 = 9999;
          let d2 = 9999;
          for (let p = 0; p < basePoints.length; p++) {
            let dx = Math.abs(x - curX[p]);
            if (dx > halfTile) dx = tileSize - dx;
            let dy = Math.abs(y - curY[p]);
            if (dy > halfTile) dy = tileSize - dy;
            const dist = Math.hypot(dx, dy);
            if (dist < d1) {
              d2 = d1;
              d1 = dist;
            } else if (dist < d2) {
              d2 = dist;
            }
          }

          const ridge = d2 - d1;
          const web = Math.max(0, 1 - ridge / 1.65);
          const webSharp = web * web;
          const cellEdge = Math.min(1, d1 / 5.5);

          const r = 22 + cellEdge * 20 + webSharp * 72;
          const g = 130 + cellEdge * 26 + webSharp * 62;
          const b = 198 + cellEdge * 18 + webSharp * 32;
          const a = 48 + cellEdge * 22 + webSharp * 68;

          const idx = (y * tileSize + x) * 4;
          tImg.data[idx] = Math.min(255, Math.round(r));
          tImg.data[idx + 1] = Math.min(255, Math.round(g));
          tImg.data[idx + 2] = Math.min(255, Math.round(b));
          tImg.data[idx + 3] = Math.min(255, Math.round(a));
        }
      }
      tCtx.putImageData(tImg, 0, 0);

      const full = document.createElement("canvas");
      full.width = w;
      full.height = h;
      const fCtx = full.getContext("2d");
      fCtx.imageSmoothingEnabled = false;
      const pat = fCtx.createPattern(tile, "repeat");
      fCtx.fillStyle = pat;
      fCtx.fillRect(0, 0, w, h);
      frames.push(full);
    }

    return frames;
  }

  /**
   * プレビュー用の単体ブロックモデル（8枚のCanvas配列）を生成
   */
  function buildPreviewBlockModel(blockType, id, name) {
    const canvases = [];
    for (let lz = 0; lz < BLOCK_SLICES; lz++) {
      const c = document.createElement("canvas");
      c.width = BLOCK_SIZE;
      c.height = BLOCK_SIZE;
      const ctx = c.getContext("2d");
      const img = ctx.createImageData(BLOCK_SIZE, BLOCK_SIZE);
      const isTop = lz === BLOCK_SLICES - 1;

      for (let ly = 0; ly < BLOCK_SIZE; ly++) {
        for (let lx = 0; lx < BLOCK_SIZE; lx++) {
          const rgb24 = sampleBlockColor24(blockType, lx, ly, lz, 3, isTop);
          const idx = (ly * BLOCK_SIZE + lx) * 4;
          img.data[idx] = (rgb24 >>> 16) & 255;
          img.data[idx + 1] = (rgb24 >>> 8) & 255;
          img.data[idx + 2] = rgb24 & 255;
          img.data[idx + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      canvases.push(c);
    }

    return {
      id,
      name,
      width: BLOCK_SIZE,
      height: BLOCK_SIZE,
      layerCount: BLOCK_SLICES,
      canvases,
    };
  }

  function buildPreviewWaterModel() {
    const canvases = [];
    for (let lz = 0; lz < BLOCK_SLICES; lz++) {
      const c = document.createElement("canvas");
      c.width = BLOCK_SIZE;
      c.height = BLOCK_SIZE;
      const ctx = c.getContext("2d");
      const img = ctx.createImageData(BLOCK_SIZE, BLOCK_SIZE);
      const isTop = lz === BLOCK_SLICES - 1;

      for (let ly = 0; ly < BLOCK_SIZE; ly++) {
        for (let lx = 0; lx < BLOCK_SIZE; lx++) {
          const idx = (ly * BLOCK_SIZE + lx) * 4;
          if (isTop) {
            const crest = (lx + ly) % 3 === 0;
            img.data[idx] = crest ? 114 : 44;
            img.data[idx + 1] = crest ? 214 : 158;
            img.data[idx + 2] = crest ? 246 : 218;
            img.data[idx + 3] = crest ? 138 : 76;
          } else {
            img.data[idx] = 10;
            img.data[idx + 1] = 92;
            img.data[idx + 2] = 174;
            img.data[idx + 3] = 22;
          }
        }
      }
      ctx.putImageData(img, 0, 0);
      canvases.push(c);
    }

    return {
      id: "water",
      name: "水ブロック (8段階)",
      width: BLOCK_SIZE,
      height: BLOCK_SIZE,
      layerCount: BLOCK_SLICES,
      canvases,
    };
  }

  // ============================================================
  // プレイヤーキャラクター (8x8 ピクセル × 12 スライス = 1.5ブロック高)
  // ============================================================
  const PLAYER_PALETTE = {
    ".": null,
    "b": "#3b2f2f",
    "p": "#2d4c8a",
    "P": "#223a6b",
    "s": "#22b8cf",
    "S": "#1592a6",
    "k": "#f3c69f",
    "h": "#4a2c18",
    "e": "#111827",
  };

  function makePlayerSliceDefs(stepPose) {
    const bootRows =
      stepPose === 0
        ? [
            "........",
            "..bb....",
            "..bb....",
            "........",
            "........",
            "..bb....",
            "..bb....",
            "........",
          ]
        : stepPose === 1
        ? [
            "........",
            "...bb...",
            "...bb...",
            "........",
            "........",
            ".bb.....",
            ".bb.....",
            "........",
          ]
        : [
            "........",
            ".bb.....",
            ".bb.....",
            "........",
            "........",
            "...bb...",
            "...bb...",
            "........",
          ];

    const legRows =
      stepPose === 0
        ? [
            "........",
            "..pp....",
            "..pp....",
            "........",
            "........",
            "..pp....",
            "..pp....",
            "........",
          ]
        : stepPose === 1
        ? [
            "........",
            "...pp...",
            "...pp...",
            "........",
            "........",
            ".pp.....",
            ".pp.....",
            "........",
          ]
        : [
            "........",
            ".pp.....",
            ".pp.....",
            "........",
            "........",
            "...pp...",
            "...pp...",
            "........",
          ];

    const hipRows = [
      "........",
      "..PP....",
      "..pp....",
      "..pp....",
      "..pp....",
      "..pp....",
      "..PP....",
      "........",
    ];

    const handLowRows =
      stepPose === 0
        ? [
            "..kk....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..kk....",
          ]
        : stepPose === 1
        ? [
            ".kk.....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "...kk...",
          ]
        : [
            "...kk...",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            ".kk.....",
          ];

    const torsoRows = [
      "..SS....",
      "..ss....",
      "..ss....",
      "..ss....",
      "..ss....",
      "..ss....",
      "..ss....",
      "..SS....",
    ];

    const chinRows = [
      "........",
      ".hhkk...",
      ".hkkk...",
      ".hkkk...",
      ".hkkk...",
      ".hkkk...",
      ".hhkk...",
      "........",
    ];

    const eyeRows = [
      "........",
      ".hhkk...",
      ".hhke...",
      ".hhkk...",
      ".hhkk...",
      ".hhke...",
      ".hhkk...",
      "........",
    ];

    const browRows = [
      "........",
      ".hhhk...",
      ".hhkk...",
      ".hhkk...",
      ".hhkk...",
      ".hhkk...",
      ".hhhk...",
      "........",
    ];

    const hairRows = [
      "........",
      ".hhhh...",
      ".hhhh...",
      ".hhhh...",
      ".hhhh...",
      ".hhhh...",
      ".hhhh...",
      "........",
    ];

    return [
      bootRows,
      legRows,
      legRows,
      hipRows,
      handLowRows,
      handLowRows,
      torsoRows,
      torsoRows,
      chinRows,
      eyeRows,
      browRows,
      hairRows,
    ];
  }

  /**
   * プレイヤー各ポーズの生 RGBA ピクセルデータ配列（WebGL2 TEXTURE_2D_ARRAY 転送用）も返す
   */
  function buildPlayerPoseData(stepPose) {
    const sliceDefs = makePlayerSliceDefs(stepPose);
    const size = 8;
    const canvases = [];
    const rawSlices = [];

    for (let z = 0; z < sliceDefs.length; z++) {
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const ctx = c.getContext("2d");
      const raw = new Uint8Array(size * size * 4);
      const rows = sliceDefs[z];
      const shade = 0.82 + (z / (sliceDefs.length - 1)) * 0.22;

      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const hex = PLAYER_PALETTE[rows[y][x]];
          if (!hex) continue;
          const num = parseInt(hex.slice(1), 16);
          const abgr = shadeAndPackABGR((num >> 16) & 255, (num >> 8) & 255, num & 255, shade);
          const r = abgr & 255;
          const g = (abgr >>> 8) & 255;
          const b = (abgr >>> 16) & 255;
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(x, y, 1, 1);

          const idx = (y * size + x) * 4;
          raw[idx] = r;
          raw[idx + 1] = g;
          raw[idx + 2] = b;
          raw[idx + 3] = 255;
        }
      }
      canvases.push(c);
      rawSlices.push(raw);
    }

    return { canvases, rawSlices };
  }

  const poseIdle = buildPlayerPoseData(0);
  const poseStepA = buildPlayerPoseData(1);
  const poseStepB = buildPlayerPoseData(-1);

  const playerPoses = {
    idle: poseIdle.canvases,
    stepA: poseStepA.canvases,
    stepB: poseStepB.canvases,
    rawIdle: poseIdle.rawSlices,
    rawStepA: poseStepA.rawSlices,
    rawStepB: poseStepB.rawSlices,
  };

  // ============================================================
  // 白い羊モブ（10x10 ピクセル × 9スライス、3ポーズ）
  // +X(右)が正面、Yが左右
  // ============================================================
  const SHEEP_PALETTE = {
    w: "#f6f6f2", // ふわふわ白ウール
    c: "#ffffff", // 明るい純白ハイライト
    W: "#dce2eb", // ウール側面・影
    h: "#4a443e", // 蹄（濃い茶灰）
    f: "#e4cbb0", // 顔・脚のクリーム色
    F: "#c9ab8c", // 耳・顔の陰影
    n: "#e4a29b", // ピンクの鼻先
    e: "#1a1c22", // 黒い目
  };

  function makeSheepSliceDefs(stepPose) {
    const hoofRows =
      stepPose === 0
        ? [
            "..........",
            "..........",
            "..h...h...",
            "..h...h...",
            "..........",
            "..........",
            "..h...h...",
            "..h...h...",
            "..........",
            "..........",
          ]
        : stepPose === 1
        ? [
            "..........",
            "..........",
            ".h.....h..",
            ".h.....h..",
            "..........",
            "..........",
            "...h.h....",
            "...h.h....",
            "..........",
            "..........",
          ]
        : [
            "..........",
            "..........",
            "...h.h....",
            "...h.h....",
            "..........",
            "..........",
            ".h.....h..",
            ".h.....h..",
            "..........",
            "..........",
          ];

    const legRows = hoofRows.map((r) => r.replace(/h/g, "f"));

    const bellyRows = [
      "..........",
      "..........",
      ".WWwwwwW..",
      ".WwwwwwW..",
      ".WwwwwwW..",
      ".WwwwwwW..",
      ".WwwwwwW..",
      ".WWwwwwW..",
      "..........",
      "..........",
    ];

    const jawRows = [
      "..........",
      "..WWWWWW..",
      ".WwwwwwwW.",
      ".Wwwwwwwff",
      "WWwwwwwwfn",
      "WWwwwwwwfn",
      ".Wwwwwwwff",
      ".WwwwwwwW.",
      "..WWWWWW..",
      "..........",
    ];

    const faceRows = [
      "..........",
      "..WWWWWW..",
      ".WwwwwwwF.",
      ".Wwwwwwwfe",
      ".Wwwwwwwff",
      ".Wwwwwwwff",
      ".Wwwwwwwfe",
      ".WwwwwwwF.",
      "..WWWWWW..",
      "..........",
    ];

    const upperBodyRows = [
      "..........",
      "..WwwwwW..",
      ".WwwwwwwW.",
      ".WwwwwwwwW",
      ".WwwwwwwwW",
      ".WwwwwwwwW",
      ".WwwwwwwwW",
      ".WwwwwwwW.",
      "..WwwwwW..",
      "..........",
    ];

    const backWoolRows = [
      "..........",
      "..WwwwwW..",
      ".WwwccwwW.",
      ".WwccccwwW",
      ".WwccccwwW",
      ".WwccccwwW",
      ".WwccccwwW",
      ".WwwccwwW.",
      "..WwwwwW..",
      "..........",
    ];

    const topWoolRows = [
      "..........",
      "..........",
      "..Wwwww...",
      "..wcccc.w.",
      "..wccccww.",
      "..wccccww.",
      "..wcccc.w.",
      "..Wwwww...",
      "..........",
      "..........",
    ];

    return [
      hoofRows,
      legRows,
      legRows,
      bellyRows,
      jawRows,
      faceRows,
      upperBodyRows,
      backWoolRows,
      topWoolRows,
    ];
  }

  function buildSheepPoseData(stepPose) {
    const sliceDefs = makeSheepSliceDefs(stepPose);
    const size = 10;
    const rawSlices = [];
    for (let z = 0; z < sliceDefs.length; z++) {
      const raw = new Uint8Array(size * size * 4);
      const rows = sliceDefs[z];
      const shade = 0.84 + (z / (sliceDefs.length - 1)) * 0.20;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const hex = SHEEP_PALETTE[rows[y][x]];
          if (!hex) continue;
          const num = parseInt(hex.slice(1), 16);
          const abgr = shadeAndPackABGR((num >> 16) & 255, (num >> 8) & 255, num & 255, shade);
          const idx = (y * size + x) * 4;
          raw[idx] = abgr & 255;
          raw[idx + 1] = (abgr >>> 8) & 255;
          raw[idx + 2] = (abgr >>> 16) & 255;
          raw[idx + 3] = 255;
        }
      }
      rawSlices.push(raw);
    }
    return rawSlices;
  }

  const sheepPoses = {
    size: 10,
    sliceCount: 9,
    rawIdle: buildSheepPoseData(0),
    rawStepA: buildSheepPoseData(1),
    rawStepB: buildSheepPoseData(-1),
  };

  const previewModels = {
    grass: buildPreviewBlockModel(BLOCK_GRASS, "grass", "草ブロック"),
    stone: buildPreviewBlockModel(BLOCK_STONE, "stone", "岩ブロック"),
    lava: buildPreviewBlockModel(BLOCK_LAVA, "lava", "溶岩ブロック (光15)"),
    wood: buildPreviewBlockModel(BLOCK_WOOD, "wood", "木の幹"),
    water: buildPreviewWaterModel(),
    player: {
      id: "player",
      name: "プレイヤー",
      width: 8,
      height: 8,
      layerCount: playerPoses.idle.length,
      canvases: playerPoses.idle,
    },
  };

  global.VoxelWalk = global.VoxelWalk || {};
  global.VoxelWalk.BLOCK_SIZE = BLOCK_SIZE;
  global.VoxelWalk.BLOCK_SLICES = BLOCK_SLICES;
  global.VoxelWalk.BLOCK_AIR = BLOCK_AIR;
  global.VoxelWalk.BLOCK_DIRT = BLOCK_DIRT;
  global.VoxelWalk.BLOCK_GRASS = BLOCK_GRASS;
  global.VoxelWalk.BLOCK_WOOD = BLOCK_WOOD;
  global.VoxelWalk.BLOCK_LEAVES = BLOCK_LEAVES;
  global.VoxelWalk.BLOCK_STONE = BLOCK_STONE;
  global.VoxelWalk.BLOCK_DARK_STONE = BLOCK_DARK_STONE;
  global.VoxelWalk.BLOCK_LAVA = BLOCK_LAVA;
  global.VoxelWalk.BLOCK_NAMES = BLOCK_NAMES;
  global.VoxelWalk.hash3 = hash3;
  global.VoxelWalk.sampleBlockColor24 = sampleBlockColor24;
  global.VoxelWalk.shadePacked24ToABGR = shadePacked24ToABGR;
  global.VoxelWalk.buildWaterAnimFrames = buildWaterAnimFrames;
  global.VoxelWalk.PLAYER_POSES = playerPoses;
  global.VoxelWalk.SHEEP_POSES = sheepPoses;
  global.VoxelWalk.PREVIEW_MODELS = previewModels;
})(window);
